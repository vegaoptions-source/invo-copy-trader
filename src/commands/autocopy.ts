/**
 * Unattended copy trader.
 *
 * Watches your Invo "Following" feed. When a followed trader opens a verified
 * trade, it opens the same direction on YOUR Hyperliquid account (sized and
 * capped by copy-config.json) and places an exchange-side stop loss. When that
 * trader closes, it closes your copy.
 *
 *   npx tsx src/commands/autocopy.ts            # uses copy-config.json
 *   npx tsx src/commands/autocopy.ts my.json    # custom config file
 *
 * Starts in DRY RUN (logs what it would do, places nothing) until you set
 * "dryRun": false in the config.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';
import { ensureAgent } from '../invo-agent.js';
import { newInvoTx } from '../invo-ids.js';

// ---------- config ----------

interface Config {
  dryRun: boolean;
  mode: 'invo' | 'hyperliquid';   // invo = trade your Invo wallet (key approved via Invo); hyperliquid = your own HL account + HL_AGENT_KEY
  recordOnInvo: boolean;          // invo mode: record opens/closes on Invo so they show in the app
  marginPerTradeUsd: number;      // margin put into each copied trade
  marginPerTradePct: number | null; // if set, % of account value instead of fixed USD
  maxLeverage: number;            // trader's leverage is capped to this
  skipAboveMaxLeverage: boolean;  // true = skip trades above maxLeverage instead of capping
  maxOpenPositions: number;
  stopLossPctOfMargin: number;    // e.g. 50 = stop out after losing 50% of the trade's margin; 0 = off
  traders: string[];              // usernames (without @) to copy; empty = everyone you follow
  allowedCoins: string[];         // empty = any
  blockedCoins: string[];
  copyCloses: boolean;
  maxSignalAgeMinutes: number;    // backstop: never copy trades the trader opened longer ago than this
  maxEntryDriftPct: number;       // skip while the coin price is more than this % better for the trader than their entry (moves against them are always fine)
  pollSeconds: number;
  logFile: string;
}

const DEFAULTS: Config = {
  dryRun: true,
  mode: 'invo',
  recordOnInvo: true,
  marginPerTradeUsd: 5,
  marginPerTradePct: null,
  maxLeverage: 10,
  skipAboveMaxLeverage: false,
  maxOpenPositions: 3,
  stopLossPctOfMargin: 50,
  traders: [],
  allowedCoins: [],
  blockedCoins: [],
  copyCloses: true,
  maxSignalAgeMinutes: 60,
  maxEntryDriftPct: 1.5,
  pollSeconds: 5,
  logFile: 'autocopy.log',
};

const configPath = process.argv[2] ?? 'copy-config.json';
if (!existsSync(configPath)) {
  writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + '\n');
  console.log(`Created ${configPath} with safe defaults (dry run). Edit it, then run again.`);
  process.exit(0);
}
const cfg: Config = { ...DEFAULTS, ...JSON.parse(readFileSync(configPath, 'utf8')) };
const norm = (s: string) => s.replace(/^@/, '').toLowerCase();
const traderFilter = new Set(cfg.traders.map(norm));
const allowed = new Set(cfg.allowedCoins.map(c => c.toUpperCase()));
const blocked = new Set(cfg.blockedCoins.map(c => c.toUpperCase()));

// ---------- state (survives restarts) ----------

interface Held {
  coin: string;
  side: 'long' | 'short';
  size: number;
  leverage: number;
  entryPx: number;
  ownerId: string;
  username: string;
  sourceBaseShortId?: string;
  sourceBaseId?: string;          // source trade id, used to ask Invo whether it is still open
  invoBaseShortId?: string;       // our own Invo position id, needed to record the close
  openedAt: string;
}
const statePath = cfg.dryRun ? 'autocopy-state.dry.json' : 'autocopy-state.json';
let held: Record<string, Held> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const saveState = () => writeFileSync(statePath, JSON.stringify(held, null, 2));
const handledPath = cfg.dryRun ? 'autocopy-handled.dry.json' : 'autocopy-handled.json';
const handled = new Set<string>(existsSync(handledPath) ? JSON.parse(readFileSync(handledPath, 'utf8')) : []);
const markHandled = (id: string) => { handled.add(id); writeFileSync(handledPath, JSON.stringify([...handled].slice(-2000))); };

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE', msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} [${level}]${cfg.dryRun ? ' [DRY]' : ''} ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
  try { appendFileSync(cfg.logFile, line + '\n'); } catch { /* ignore */ }
}

// ---------- signals ----------

interface Signal {
  postId: string;
  isOpen: boolean;
  coin: string;
  side: 'long' | 'short';
  leverage: number;
  ownerId: string;
  username: string;
  baseShortId?: string;
  baseId?: string;
  updateId?: string;
  portfolioId?: string;
  openedAt?: number;              // when the trader opened the trade
  entryPrice?: number;            // trader's entry price
}

function parseSignal(post: any): Signal | null {
  const u = post?.update;
  if (!u?.ticker || !u.verifiedTrade || !u.baseShortId) return null;
  const opened = Date.parse(u.createdAt ?? '');
  return {
    postId: post.id,
    isOpen: u.isOpen === true,
    coin: String(u.ticker).toUpperCase(),
    side: u.directionLong ? 'long' : 'short',
    leverage: Number(u.leverage) || 1,
    ownerId: u.owner?.id ?? post.owner?.id ?? '',
    username: u.owner?.username ?? post.owner?.username ?? '?',
    baseShortId: u.baseShortId,
    baseId: u.baseId,
    updateId: u.id,
    portfolioId: u.portfolio?.id,
    openedAt: Number.isFinite(opened) ? opened : undefined,
    entryPrice: Number(u.entryPrice) > 0 ? Number(u.entryPrice) : undefined,
  };
}

// ---------- trading ----------

let meta: Map<string, hl.AssetMeta>;

async function refreshMeta() {
  meta = new Map((await hl.getMeta()).universe.map(a => [a.name, a]));
}

const driftNoted = new Set<string>();
const capacityNoted = new Set<string>();

async function handleOpen(sig: Signal): Promise<'retry' | void> {
  const tag = `@${sig.username} ${sig.coin} ${sig.side} ${sig.leverage}x`;
  if (traderFilter.size && !traderFilter.has(norm(sig.username))) return log('INFO', `skip ${tag}: trader not in list`);
  if (allowed.size && !allowed.has(sig.coin)) return log('INFO', `skip ${tag}: coin not allowed`);
  if (blocked.has(sig.coin)) return log('INFO', `skip ${tag}: coin blocked`);
  if (held[sig.coin]) return log('INFO', `skip ${tag}: already holding ${sig.coin}`);
  if (Object.keys(held).length >= cfg.maxOpenPositions) {
    if (!capacityNoted.has(sig.baseShortId!)) { capacityNoted.add(sig.baseShortId!); log('WARN', `waiting on ${tag}: max open positions (${cfg.maxOpenPositions}) reached - will copy if a slot frees up`); }
    return 'retry';
  }

  const asset = meta.get(sig.coin);
  if (!asset) return log('WARN', `skip ${tag}: ${sig.coin} not listed on Hyperliquid perps`);
  if (sig.leverage > cfg.maxLeverage && cfg.skipAboveMaxLeverage) return log('INFO', `skip ${tag}: leverage above ${cfg.maxLeverage}x`);
  const lev = Math.max(1, Math.min(sig.leverage, cfg.maxLeverage, asset.maxLeverage));

  const acct = await hl.getAccountState(WALLET_ADDRESS);
  const existing = (acct.assetPositions ?? []).find((p: any) => p.position?.coin === sig.coin && parseFloat(p.position.szi) !== 0);
  if (existing) return log('INFO', `skip ${tag}: you already have a ${sig.coin} position this program did not open`);
  const accountValue = parseFloat(acct.marginSummary?.accountValue ?? '0');
  const withdrawable = parseFloat(acct.withdrawable ?? '0');
  const margin = cfg.marginPerTradePct ? accountValue * cfg.marginPerTradePct / 100 : cfg.marginPerTradeUsd;
  if (!cfg.dryRun && margin > withdrawable) {
    if (!capacityNoted.has(sig.baseShortId!)) { capacityNoted.add(sig.baseShortId!); log('WARN', `waiting on ${tag}: need $${margin.toFixed(2)} margin, only $${withdrawable.toFixed(2)} available - will copy if margin frees up`); }
    return 'retry';
  }

  const mid = parseFloat((await hl.getAllMids())[sig.coin]);
  if (sig.entryPrice) {
    // + = price moved in the trader's favour (worse for us), - = against them (better entry for us)
    const drift = ((sig.side === 'long' ? mid - sig.entryPrice : sig.entryPrice - mid) / sig.entryPrice) * 100;
    if (drift > cfg.maxEntryDriftPct) {
      if (!driftNoted.has(sig.baseShortId!)) {
        driftNoted.add(sig.baseShortId!);
        log('INFO', `waiting on ${tag}: price is ${drift.toFixed(2)}% past their entry ${sig.entryPrice} (limit ${cfg.maxEntryDriftPct}%) - will copy if it comes back`);
      }
      return 'retry';
    }
    log('INFO', `${tag}: price is ${drift >= 0 ? drift.toFixed(2) + '% past' : Math.abs(drift).toFixed(2) + '% better than'} their entry ${sig.entryPrice} - copying`);
  }
  let size = hl.formatSz((margin * lev) / mid, asset.szDecimals);
  // Rounding down can push coins with big size steps (e.g. ZEC) under the $10 minimum:
  // go up one step if that stays within ~10% of the intended margin.
  if (size * mid < 10) {
    const step = 1 / 10 ** asset.szDecimals;
    const up = Number((size + step).toFixed(asset.szDecimals));
    if (up * mid >= 10 && (up * mid) / lev <= margin * 1.1) size = up;
  }
  if (size * mid < 10) return log('WARN', `skip ${tag}: order $${(size * mid).toFixed(2)} below Hyperliquid's $10 minimum (raise margin or leverage)`);

  const isLong = sig.side === 'long';
  const slMove = cfg.stopLossPctOfMargin > 0 ? cfg.stopLossPctOfMargin / 100 / lev : 0;
  const slPx = slMove ? (isLong ? mid * (1 - slMove) : mid * (1 + slMove)) : 0;
  const plan = { coin: sig.coin, side: sig.side, size, leverage: lev, margin: +margin.toFixed(2), approxPx: mid, stopLoss: slPx ? +slPx.toPrecision(5) : null };

  let invoBaseShortId: string | undefined;
  if (cfg.dryRun) {
    log('TRADE', `would OPEN copy of ${tag}`, plan);
  } else {
    const invoMode = cfg.mode === 'invo';
    const tx = invoMode ? newInvoTx('open') : undefined;
    const posBefore = (await hl.getPositions(WALLET_ADDRESS)).find((p: any) => p.coin === sig.coin);
    await hl.setLeverage(sig.coin, lev);
    const nonceMs = Date.now();
    const resp = await hl.placeMarketOrder(sig.coin, isLong, String(size), 0.02, false, tx?.cloid);
    const out = hl.orderOutcome(resp);
    if (!out.filled) return log('ERROR', `open failed for ${tag}`, out);
    if (invoMode && cfg.recordOnInvo) {
      // Best effort: the position is open on Hyperliquid either way.
      try {
        const rec = await invo.recordOpen({
          clientTxId: tx!.clientTxId, coin: sig.coin, assetIndex: [...meta.keys()].indexOf(sig.coin),
          entry: { side: sig.side, marginMode: 'isolated', leverage: lev, tpPx: null, slPx: null },
          submission: { hlOrder: resp, nonceMs, hlResponse: resp },
          summary: { qtyBefore: posBefore?.szi ?? '0', qtyAfter: String(isLong ? out.totalSz : -out.totalSz!), intendedLeverage: lev },
          mimicMeta: {
            portfolioId: sig.portfolioId ?? '', creatorInvoUserId: sig.ownerId,
            initialSourcePaperUpdateId: sig.updateId ?? '', sourcePaperTradeBaseId: sig.baseId ?? '',
          },
        });
        invoBaseShortId = rec?.data?.baseShortId ?? rec?.baseShortId;
        log('INFO', `recorded open on Invo`, rec?.data ?? rec);
      } catch (e: any) {
        log('WARN', `could not record open on Invo (trade is still open on Hyperliquid): ${e.message}`);
      }
    }
    plan.size = out.totalSz!;
    plan.approxPx = out.avgPx!;
    if (slPx) {
      const sl = hl.orderOutcome(await hl.placeStopLoss(sig.coin, isLong, out.totalSz!, isLong ? out.avgPx! * (1 - slMove) : out.avgPx! * (1 + slMove)));
      // Trigger orders rest instead of filling, so "resting" is success here
      if (sl.error && !/resting|waitingForTrigger/i.test(sl.error)) log('ERROR', `stop loss NOT placed for ${sig.coin} - set one manually!`, sl);
      else log('INFO', `stop loss set for ${sig.coin}`);
    }
    log('TRADE', `OPENED copy of ${tag}`, plan);
  }

  held[sig.coin] = {
    coin: sig.coin, side: sig.side, size: plan.size, leverage: lev, entryPx: plan.approxPx,
    ownerId: sig.ownerId, username: sig.username, sourceBaseShortId: sig.baseShortId, sourceBaseId: sig.baseId, invoBaseShortId,
    openedAt: new Date().toISOString(),
  };
  saveState();
}

async function closeHeld(coin: string, reason: string) {
  const h = held[coin];
  if (!h) return;
  if (!cfg.copyCloses) return log('INFO', `${reason}; copyCloses is off, keeping ${coin}`);

  if (cfg.dryRun) {
    log('TRADE', `would CLOSE ${coin} (${reason})`);
  } else {
    try {
      const tx = cfg.mode === 'invo' ? newInvoTx('close') : undefined;
      const nonceMs = Date.now();
      const resp = await hl.closePosition(coin, WALLET_ADDRESS, tx?.cloid);
      const out = hl.orderOutcome(resp);
      if (!out.filled) return log('ERROR', `close failed for ${coin} - will retry`, out);
      log('TRADE', `CLOSED ${coin} (${reason})`, out);
      // Invo records a mimic close against the SOURCE trade's baseShortId (seen in the web app)
      const invoId = h.invoBaseShortId ?? h.sourceBaseShortId;
      if (tx && cfg.recordOnInvo && invoId) {
        await invo.recordClose({
          clientTxId: tx.clientTxId, baseShortId: invoId, assetIndex: [...meta.keys()].indexOf(coin),
          submission: { hlOrder: resp, nonceMs, hlResponse: resp },
          summary: { qtyBefore: String(h.side === 'long' ? h.size : -h.size), qtyAfter: '0' },
        }).then(r => log('INFO', 'recorded close on Invo', r?.data ?? r))
          .catch((e: any) => log('WARN', `could not record close on Invo: ${e.message}`));
      }
    } catch (e: any) {
      if (!/No open position/.test(e.message)) throw e;
      log('INFO', `${coin} already closed on exchange`);
    }
    await hl.cancelOrdersForCoin(coin, WALLET_ADDRESS).catch(() => null);
  }
  delete held[coin];
  saveState();
}

/** Ask Invo whether each copied trade is still open on the trader's side. */
async function checkSourceTrades() {
  for (const h of Object.values(held)) {
    if (!h.sourceBaseId) continue;
    try {
      const r = await invo.getInvestmentStatus(h.sourceBaseId);
      const st = r?.status;
      if (st && (st.isOpen === false || st.exists === false)) {
        await closeHeld(h.coin, `@${h.username} closed their ${h.coin} trade`);
      }
    } catch (e: any) {
      log('WARN', `could not check @${h.username}'s ${h.coin} trade: ${e.message}`);
    }
  }
}

/** Drop positions that disappeared on the exchange (stop loss hit, liquidated, closed by hand). */
async function reconcile() {
  if (cfg.dryRun || Object.keys(held).length === 0) return;
  const live = new Set((await hl.getPositions(WALLET_ADDRESS)).map((p: any) => p.coin));
  for (const coin of Object.keys(held)) {
    if (!live.has(coin)) {
      log('WARN', `${coin} no longer open on Hyperliquid (stop loss / liquidation / manual close) - forgetting it`);
      await hl.cancelOrdersForCoin(coin, WALLET_ADDRESS).catch(() => null);
      delete held[coin];
    }
  }
  saveState();
}

// ---------- main loop ----------

async function connectTrading() {
  if (cfg.mode === 'invo') {
    hl.setUseInvoBuilder(true);
    const key = await ensureAgent(WALLET_ADDRESS, m => log('INFO', m));
    await hl.connect(key.privateKey, WALLET_ADDRESS);
  } else {
    if (!HL_AGENT_KEY) throw new Error('hyperliquid mode needs HL_AGENT_KEY');
    await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);
  }
}

async function main() {
  if (!INVO_REFRESH_TOKEN && !INVO_TOKEN) throw new Error('Missing INVO_REFRESH_TOKEN');
  if (!WALLET_ADDRESS) throw new Error('Missing WALLET_ADDRESS (your Invo wallet address in invo mode)');
  if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
  if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);
  if (!cfg.dryRun) await connectTrading();
  await refreshMeta();

  log('INFO', 'autocopy started', { config: configPath, ...cfg, holding: Object.keys(held) });

  const replay = process.env.AUTOCOPY_REPLAY === '1' && cfg.dryRun;
  if (replay) log('INFO', 'REPLAY: treating open trades already in the feed as new (dry run preview)');
  const knownTrades = new Set<string>();
  const seenNotifications = new Set<string>();
  // trades waiting for a better price, free margin or a free slot; saved so a restart keeps them
  const waitingPath = cfg.dryRun ? 'autocopy-waiting.dry.json' : 'autocopy-waiting.json';
  const waiting = new Map<string, Signal>(existsSync(waitingPath) ? JSON.parse(readFileSync(waitingPath, 'utf8')) : []);
  const saveWaiting = () => writeFileSync(waitingPath, JSON.stringify([...waiting]));
  if (waiting.size) log('INFO', `resuming ${waiting.size} waiting trade(s): ${[...waiting.values()].map(w => `@${w.username} ${w.coin}`).join(', ')}`);
  let first = true;
  let loops = 0;
  let failures = 0;

  async function consider(sig: Signal, source: string) {
    const id = sig.baseShortId!;
    if (knownTrades.has(id)) return;
    knownTrades.add(id);
    if (handled.has(id) && !replay) return;           // already copied or deliberately skipped before
    const ageMin = replay ? 0 : sig.openedAt ? (Date.now() - sig.openedAt) / 60_000 : Infinity;
    // At startup only catch up on trades opened within the window (missed during downtime); ignore older ones quietly
    if (first && !replay && !(sig.isOpen && ageMin <= cfg.maxSignalAgeMinutes)) return;
    const desc = `@${sig.username} ${sig.coin} ${sig.side} ${sig.leverage}x`;
    if (!sig.isOpen) return log('INFO', `seen already-closed trade ${desc} - ignoring`);
    if (ageMin > cfg.maxSignalAgeMinutes) return log('INFO', `new post for an older trade ${desc} (opened ${Math.round(ageMin)} min ago) - not copying`);
    if (!driftNoted.has(id) && !capacityNoted.has(id)) log('INFO', `NEW TRADE via ${source}: ${desc} (opened ${ageMin.toFixed(1)} min ago)`);
    try {
      if ((await handleOpen(sig)) === 'retry') { knownTrades.delete(id); waiting.set(id, sig); saveWaiting(); return; }
      if (waiting.delete(id)) saveWaiting();
      markHandled(id);
    } catch (e: any) {
      knownTrades.delete(id); // let the next poll retry while the trade is still fresh
      throw e;
    }
  }

  // Invo's notification list only ever returns its newest item, so it is polled every second
  // (between the slower 5-second cycles) to avoid missing a trade that is quickly followed by another.
  async function pollNotifications() {
    const notes: any[] = ((await invo.getNotifications(1, 20)).items ?? []).slice().reverse();
    for (const n of notes) {
      if (!n?.id || seenNotifications.has(n.id)) continue;
      seenNotifications.add(n.id);
      if (n.notificationType !== 'user_added_investment' || !n.postId) continue;
      try {
        const post = (await invo.getPostById(n.postId))?.post;
        const sig = parseSignal(post);
        if (!sig) { log('INFO', `@${n.notifier?.username} opened ${n.ticker}: not a verified trade - ignoring`); continue; }
        await consider(sig, 'notification');
      } catch (e: any) {
        seenNotifications.delete(n.id); // retry next poll
        log('WARN', `could not load @${n.notifier?.username}'s ${n.ticker} trade: ${e.message}`);
      }
    }
  }

  while (true) {
    try {
      // Closes first: copies whose source trade closed (also after downtime)
      await checkSourceTrades();

      // 0) Re-check waiting trades (better price / free margin / free slot) every 3rd cycle (~15 s) to stay under rate limits
      if (loops % 3 === 0) for (const [id, sig] of [...waiting]) {
        const ageMin = sig.openedAt ? (Date.now() - sig.openedAt) / 60_000 : Infinity;
        if (ageMin > cfg.maxSignalAgeMinutes) { waiting.delete(id); saveWaiting(); markHandled(id); log('INFO', `gave up on @${sig.username} ${sig.coin}: still not copyable after ${cfg.maxSignalAgeMinutes} min`); continue; }
        const st = sig.baseId ? (await invo.getInvestmentStatus(sig.baseId).catch(() => null))?.status : null;
        if (st && st.isOpen === false) { waiting.delete(id); saveWaiting(); markHandled(id); log('INFO', `@${sig.username} closed ${sig.coin} while it was waiting - not copying`); continue; }
        // a failure here (e.g. rate limit) must never block close checks later in the cycle
        try { await consider(sig, 'retry'); } catch (e: any) { log('WARN', `could not recheck @${sig.username} ${sig.coin}: ${e.message}`); }
      }

      // 1) Notifications: instant, and include trades posted without a caption (hidden "shadow" posts)
      await pollNotifications();

      // 2) Following feed: backup source
      const feed = await invo.getFeed('following', null, 30);
      for (const post of (feed.items ?? []).slice().reverse()) {
        const sig = parseSignal(post);
        if (sig) await consider(sig, 'feed');
      }
      if (first) log('INFO', `indexed ${knownTrades.size} trades and ${seenNotifications.size} notifications; now watching for new ones`);
      first = false;
      failures = 0;

      if (++loops % 12 === 0) await reconcile();            // ~every minute
      if (loops % 720 === 0) await refreshMeta();            // ~every hour
      if (!cfg.dryRun && loops % 4320 === 0) await connectTrading(); // ~every 6h: renews the trading key before expiry
      if (knownTrades.size > 5000) { const keep = [...knownTrades].slice(-2000); knownTrades.clear(); keep.forEach(k => knownTrades.add(k)); }
      if (seenNotifications.size > 5000) { const keep = [...seenNotifications].slice(-2000); seenNotifications.clear(); keep.forEach(k => seenNotifications.add(k)); }
    } catch (e: any) {
      failures++;
      log('ERROR', `loop error (${failures} in a row): ${e.message}`);
      if (failures >= 5) await new Promise(r => setTimeout(r, 60_000)); // back off
    }
    const until = Date.now() + cfg.pollSeconds * 1000;
    while (Date.now() < until - 1000) {
      await new Promise(r => setTimeout(r, 1000));
      try { await pollNotifications(); } catch { /* the main cycle reports persistent errors */ }
    }
    await new Promise(r => setTimeout(r, Math.max(0, until - Date.now())));
  }
}

process.on('SIGINT', () => { log('INFO', 'stopped by user'); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', 'stopped'); process.exit(0); });
main().catch(e => { log('ERROR', `fatal: ${e.message}`); process.exit(1); });
