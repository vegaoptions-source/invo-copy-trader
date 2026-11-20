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
import { validateEnv, INVO_TOKEN, INVO_REFRESH_TOKEN, HL_AGENT_KEY, WALLET_ADDRESS } from '../env.js';
import * as invo from '../invo-client.js';
import * as hl from '../hl-client.js';

// ---------- config ----------

interface Config {
  dryRun: boolean;
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
  pollSeconds: number;
  logFile: string;
}

const DEFAULTS: Config = {
  dryRun: true,
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
  openedAt: string;
}
const statePath = cfg.dryRun ? 'autocopy-state.dry.json' : 'autocopy-state.json';
let held: Record<string, Held> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const saveState = () => writeFileSync(statePath, JSON.stringify(held, null, 2));

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE', msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} [${level}]${cfg.dryRun ? ' [DRY]' : ''} ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
  try { appendFileSync(cfg.logFile, line + '\n'); } catch { /* ignore */ }
}

// ---------- signals ----------

interface Signal {
  postId: string;
  action: 'open' | 'close' | 'increase';
  coin: string;
  side: 'long' | 'short';
  leverage: number;
  ownerId: string;
  username: string;
  baseShortId?: string;
  createdAt?: number;
}

function parseSignal(post: any): Signal | null {
  const u = post?.update;
  if (!u?.ticker || !u.verifiedTrade) return null;
  const isOpen = u.isOpen === true;
  const isClosed = u.isOpen === false && u.closingPrice != null;
  const action = isClosed ? 'close' : u.changes?.isAdded !== false ? 'open' : 'increase';
  if (!isOpen && !isClosed) return null;
  const created = Date.parse(post.createdAt ?? post.created_at ?? u.createdAt ?? '');
  return {
    postId: post.id,
    action,
    coin: String(u.ticker).toUpperCase(),
    side: u.directionLong ? 'long' : 'short',
    leverage: Number(u.leverage) || 1,
    ownerId: u.owner?.id ?? post.owner?.id ?? '',
    username: u.owner?.username ?? post.owner?.username ?? '?',
    baseShortId: u.baseShortId,
    createdAt: Number.isFinite(created) ? created : undefined,
  };
}

// ---------- trading ----------

let meta: Map<string, hl.AssetMeta>;

async function refreshMeta() {
  meta = new Map((await hl.getMeta()).universe.map(a => [a.name, a]));
}

async function handleOpen(sig: Signal) {
  const tag = `@${sig.username} ${sig.coin} ${sig.side} ${sig.leverage}x`;
  if (traderFilter.size && !traderFilter.has(norm(sig.username))) return log('INFO', `skip ${tag}: trader not in list`);
  if (allowed.size && !allowed.has(sig.coin)) return log('INFO', `skip ${tag}: coin not allowed`);
  if (blocked.has(sig.coin)) return log('INFO', `skip ${tag}: coin blocked`);
  if (held[sig.coin]) return log('INFO', `skip ${tag}: already holding ${sig.coin}`);
  if (Object.keys(held).length >= cfg.maxOpenPositions) return log('WARN', `skip ${tag}: max open positions (${cfg.maxOpenPositions}) reached`);

  const asset = meta.get(sig.coin);
  if (!asset) return log('WARN', `skip ${tag}: ${sig.coin} not listed on Hyperliquid perps`);
  if (sig.leverage > cfg.maxLeverage && cfg.skipAboveMaxLeverage) return log('INFO', `skip ${tag}: leverage above ${cfg.maxLeverage}x`);
  const lev = Math.max(1, Math.min(sig.leverage, cfg.maxLeverage, asset.maxLeverage));

  const acct = await hl.getAccountState(WALLET_ADDRESS);
  const accountValue = parseFloat(acct.marginSummary?.accountValue ?? '0');
  const withdrawable = parseFloat(acct.withdrawable ?? '0');
  const margin = cfg.marginPerTradePct ? accountValue * cfg.marginPerTradePct / 100 : cfg.marginPerTradeUsd;
  if (!cfg.dryRun && margin > withdrawable) return log('WARN', `skip ${tag}: need $${margin.toFixed(2)} margin, only $${withdrawable.toFixed(2)} available`);

  const mid = parseFloat((await hl.getAllMids())[sig.coin]);
  const size = hl.formatSz((margin * lev) / mid, asset.szDecimals);
  if (size * mid < 10) return log('WARN', `skip ${tag}: order $${(size * mid).toFixed(2)} below Hyperliquid's $10 minimum (raise margin or leverage)`);

  const isLong = sig.side === 'long';
  const slMove = cfg.stopLossPctOfMargin > 0 ? cfg.stopLossPctOfMargin / 100 / lev : 0;
  const slPx = slMove ? (isLong ? mid * (1 - slMove) : mid * (1 + slMove)) : 0;
  const plan = { coin: sig.coin, side: sig.side, size, leverage: lev, margin: +margin.toFixed(2), approxPx: mid, stopLoss: slPx ? +slPx.toPrecision(5) : null };

  if (cfg.dryRun) {
    log('TRADE', `would OPEN copy of ${tag}`, plan);
  } else {
    await hl.setLeverage(sig.coin, lev);
    const out = hl.orderOutcome(await hl.placeMarketOrder(sig.coin, isLong, String(size)));
    if (!out.filled) return log('ERROR', `open failed for ${tag}`, out);
    plan.size = out.totalSz!;
    plan.approxPx = out.avgPx!;
    if (slPx) {
      const sl = hl.orderOutcome(await hl.placeStopLoss(sig.coin, isLong, out.totalSz!, isLong ? out.avgPx! * (1 - slMove) : out.avgPx! * (1 + slMove)));
      // Trigger orders rest instead of filling, so "resting" is success here
      if (sl.error && !/resting/i.test(sl.error)) log('ERROR', `stop loss NOT placed for ${sig.coin} - set one manually!`, sl);
    }
    log('TRADE', `OPENED copy of ${tag}`, plan);
  }

  held[sig.coin] = {
    coin: sig.coin, side: sig.side, size: plan.size, leverage: lev, entryPx: plan.approxPx,
    ownerId: sig.ownerId, username: sig.username, sourceBaseShortId: sig.baseShortId,
    openedAt: new Date().toISOString(),
  };
  saveState();
}

async function handleClose(sig: Signal) {
  const h = held[sig.coin];
  if (!h || h.ownerId !== sig.ownerId) return; // not a trade we copied
  if (!cfg.copyCloses) return log('INFO', `@${sig.username} closed ${sig.coin}; copyCloses is off, keeping position`);

  if (cfg.dryRun) {
    log('TRADE', `would CLOSE ${sig.coin} (@${sig.username} closed)`);
  } else {
    try {
      const out = hl.orderOutcome(await hl.closePosition(sig.coin, WALLET_ADDRESS));
      if (!out.filled) return log('ERROR', `close failed for ${sig.coin} - will retry next signal/reconcile`, out);
      log('TRADE', `CLOSED ${sig.coin} (@${sig.username} closed)`, out);
    } catch (e: any) {
      if (!/No open position/.test(e.message)) throw e;
      log('INFO', `${sig.coin} already closed on exchange`);
    }
    await hl.cancelOrdersForCoin(sig.coin, WALLET_ADDRESS).catch(() => null);
  }
  delete held[sig.coin];
  saveState();
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

async function main() {
  validateEnv();
  if (INVO_TOKEN) invo.setToken(INVO_TOKEN);
  if (INVO_REFRESH_TOKEN) invo.setRefreshToken(INVO_REFRESH_TOKEN);
  if (!cfg.dryRun) await hl.connect(HL_AGENT_KEY, WALLET_ADDRESS);
  await refreshMeta();

  log('INFO', 'autocopy started', { config: configPath, ...cfg, holding: Object.keys(held) });

  const seen = new Set<string>();
  let first = true;
  let loops = 0;
  let failures = 0;

  while (true) {
    try {
      const feed = await invo.getFeed('following', null, 30);
      const posts: any[] = (feed.items ?? []).slice().reverse(); // oldest first
      for (const post of posts) {
        if (!post?.id || seen.has(post.id)) continue;
        seen.add(post.id);
        const sig = parseSignal(post);
        if (!sig) continue;

        if (first) {
          // Startup: ignore old opens, but catch closes that happened while we were offline
          const h = held[sig.coin];
          if (sig.action === 'close' && h && h.ownerId === sig.ownerId &&
              (sig.createdAt === undefined || sig.createdAt > Date.parse(h.openedAt))) {
            log('INFO', `found close for ${sig.coin} that happened while offline`);
            await handleClose(sig);
          }
          continue;
        }

        log('INFO', `signal: @${sig.username} ${sig.action} ${sig.coin} ${sig.side} ${sig.leverage}x`);
        if (sig.action === 'open') await handleOpen(sig);
        else if (sig.action === 'close') await handleClose(sig);
      }
      if (first) log('INFO', `indexed ${seen.size} existing posts; now watching for new signals`);
      first = false;
      failures = 0;

      if (++loops % 12 === 0) await reconcile();          // ~every minute
      if (loops % 720 === 0) await refreshMeta();          // ~every hour
      if (seen.size > 5000) { const keep = [...seen].slice(-2000); seen.clear(); keep.forEach(k => seen.add(k)); }
    } catch (e: any) {
      failures++;
      log('ERROR', `loop error (${failures} in a row): ${e.message}`);
      if (failures >= 5) await new Promise(r => setTimeout(r, 60_000)); // back off
    }
    await new Promise(r => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

process.on('SIGINT', () => { log('INFO', 'stopped by user'); process.exit(0); });
process.on('SIGTERM', () => { log('INFO', 'stopped'); process.exit(0); });
main().catch(e => { log('ERROR', `fatal: ${e.message}`); process.exit(1); });
