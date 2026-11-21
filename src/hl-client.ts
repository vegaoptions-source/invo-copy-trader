import * as ex from './hl-exchange.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

// Invo's builder fee only works on accounts that approved it through Invo.
// On your own Hyperliquid account it is off unless USE_INVO_BUILDER=true.
const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };
let useBuilder = process.env.USE_INVO_BUILDER === 'true';
/** Invo-wallet mode: attach Invo's builder fee (already approved on Invo wallets). */
export function setUseInvoBuilder(on: boolean) { useBuilder = on; }

/** Set the agent key used to sign orders (no network call). */
export async function connect(agentKey: string, _walletAddress: string): Promise<void> {
  ex.setAgentKey(agentKey);
}

async function info<T = any>(body: object): Promise<T> {
  // Hyperliquid answers 429 when rate-limited: back off briefly and retry instead of failing the cycle
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (!resp.ok) throw new Error(`HL info ${JSON.stringify(body)} -> HTTP ${resp.status}`);
    return (await resp.json()) as T;
  }
}

export type AssetMeta = { name: string; szDecimals: number; maxLeverage: number };

export async function getMeta() {
  return info<{ universe: AssetMeta[] }>({ type: 'meta' });
}

export async function getAllMids(): Promise<Record<string, string>> {
  return info({ type: 'allMids' });
}

export async function getAccountState(wallet: string) {
  return info<any>({ type: 'clearinghouseState', user: wallet });
}

export async function getPositions(wallet: string) {
  const data = await getAccountState(wallet);
  return data.assetPositions
    .filter((p: any) => parseFloat(p.position.szi) !== 0)
    .map((p: any) => p.position);
}

export async function getOpenOrders(wallet: string): Promise<{ coin: string; oid: number }[]> {
  return info({ type: 'openOrders', user: wallet });
}

/** Hyperliquid perp prices: max 5 significant figures and max (6 - szDecimals) decimals. */
export function formatPx(px: number, szDecimals: number): number {
  const sig = Number(px.toPrecision(5));
  return Number(sig.toFixed(Math.max(0, 6 - szDecimals)));
}

/** Round a size DOWN to the asset's allowed decimals. */
export function formatSz(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(sz * f) / f;
}

async function assetInfo(coin: string): Promise<{ index: number; szDecimals: number }> {
  const meta = await getMeta();
  const index = meta.universe.findIndex(u => u.name === coin);
  if (index < 0) throw new Error(`Unknown coin: ${coin}`);
  return { index, szDecimals: meta.universe[index].szDecimals };
}

export async function setLeverage(coin: string, leverage: number) {
  const { index } = await assetInfo(coin);
  const r = await ex.updateLeverage(index, leverage, false);
  if (r?.status !== 'ok') throw new Error(`set leverage failed: ${JSON.stringify(r)}`);
  return r;
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct = 0.02,
  reduceOnly = false,
  cloid?: string,
) {
  const mids = await getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);
  const { index, szDecimals } = await assetInfo(coin);
  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);
  return ex.placeOrder({
    asset: index, isBuy, sz: parseFloat(size), limitPx: formatPx(rawPx, szDecimals),
    reduceOnly, orderType: { limit: { tif: 'Ioc' } }, cloid,
  }, useBuilder ? INVO_BUILDER : undefined);
}

/**
 * Exchange-side stop loss (reduce-only, market on trigger). Lives on Hyperliquid,
 * so it protects the position even when this program or the computer is offline.
 */
export async function placeStopLoss(coin: string, isLong: boolean, size: number, triggerPx: number) {
  const { index, szDecimals } = await assetInfo(coin);
  const trig = formatPx(triggerPx, szDecimals);
  // Worst acceptable fill once triggered: 10% beyond the trigger
  const limit = formatPx(isLong ? trig * 0.9 : trig * 1.1, szDecimals);
  return ex.placeOrder({
    asset: index, isBuy: !isLong, sz: size, limitPx: limit, reduceOnly: true,
    orderType: { trigger: { triggerPx: trig, isMarket: true, tpsl: 'sl' } },
  }, useBuilder ? INVO_BUILDER : undefined);
}

export async function cancelOrdersForCoin(coin: string, wallet: string) {
  const orders = (await getOpenOrders(wallet)).filter(o => o.coin === coin);
  if (orders.length === 0) return null;
  const { index } = await assetInfo(coin);
  return ex.cancel(orders.map(o => ({ asset: index, oid: o.oid })));
}

export async function closePosition(coin: string, wallet: string, cloid?: string) {
  const positions = await getPositions(wallet);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const size = Math.abs(parseFloat(pos.szi));
  const isLong = parseFloat(pos.szi) > 0;

  // Close = opposite direction, reduce-only so it can never open a reverse position
  return placeMarketOrder(coin, !isLong, size.toString(), 0.02, true, cloid);
}

/** Pull fill info / error out of an order response. */
export function orderOutcome(resp: any): { filled: boolean; totalSz?: number; avgPx?: number; error?: string } {
  const st = resp?.response?.data?.statuses?.[0];
  if (resp?.status !== 'ok') return { filled: false, error: JSON.stringify(resp) };
  if (st?.filled) return { filled: true, totalSz: parseFloat(st.filled.totalSz), avgPx: parseFloat(st.filled.avgPx) };
  if (st?.error) return { filled: false, error: st.error };
  return { filled: false, error: `unexpected status ${JSON.stringify(st)}` };
}

export { INVO_BUILDER };
