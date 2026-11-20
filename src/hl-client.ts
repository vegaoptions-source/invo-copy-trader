import { Hyperliquid } from 'hyperliquid';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

// Invo's builder fee only works on accounts that approved it through Invo.
// On your own Hyperliquid account it is off unless USE_INVO_BUILDER=true.
const INVO_BUILDER = { address: '0x557edb253b1d7ed5f15b248a5a3fd919fa5d3c81', fee: 35 };
const USE_BUILDER = process.env.USE_INVO_BUILDER === 'true';

// SDK expects "SOL-PERP" format; REST API uses "SOL"
function toSdkCoin(coin: string): string {
  return coin.includes('-') ? coin : `${coin}-PERP`;
}

let sdk: Hyperliquid | null = null;

export async function connect(agentKey: string, walletAddress: string): Promise<Hyperliquid> {
  sdk = new Hyperliquid({
    privateKey: agentKey,
    walletAddress,
    enableWs: false,
  });
  await sdk.connect();
  return sdk;
}

export function getSdk(): Hyperliquid {
  if (!sdk) throw new Error('HL SDK not connected. Call connect() first.');
  return sdk;
}

async function info<T = any>(body: object): Promise<T> {
  const resp = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HL info ${JSON.stringify(body)} -> HTTP ${resp.status}`);
  return (await resp.json()) as T;
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

async function szDecimalsFor(coin: string): Promise<number> {
  const meta = await getMeta();
  const a = meta.universe.find(u => u.name === coin);
  if (!a) throw new Error(`Unknown coin: ${coin}`);
  return a.szDecimals;
}

export async function setLeverage(coin: string, leverage: number) {
  const s = getSdk();
  return s.exchange.updateLeverage(toSdkCoin(coin), 'isolated', leverage);
}

export async function placeMarketOrder(
  coin: string,
  isBuy: boolean,
  size: string,
  slippagePct = 0.02,
  reduceOnly = false,
) {
  const mids = await getAllMids();
  const mid = parseFloat(mids[coin]);
  if (!mid) throw new Error(`No mid price for ${coin}`);
  const szDec = await szDecimalsFor(coin);

  const rawPx = isBuy ? mid * (1 + slippagePct) : mid * (1 - slippagePct);

  const s = getSdk();
  return s.exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: isBuy,
    sz: parseFloat(size),
    limit_px: formatPx(rawPx, szDec),
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: reduceOnly,
    grouping: 'na',
    ...(USE_BUILDER ? { builder: INVO_BUILDER } : {}),
  } as any);
}

/**
 * Exchange-side stop loss (reduce-only, market on trigger). Lives on Hyperliquid,
 * so it protects the position even when this program or the computer is offline.
 */
export async function placeStopLoss(coin: string, isLong: boolean, size: number, triggerPx: number) {
  const szDec = await szDecimalsFor(coin);
  const trig = formatPx(triggerPx, szDec);
  // Worst acceptable fill once triggered: 10% beyond the trigger
  const limit = formatPx(isLong ? trig * 0.9 : trig * 1.1, szDec);
  const s = getSdk();
  return s.exchange.placeOrder({
    coin: toSdkCoin(coin),
    is_buy: !isLong,
    sz: size,
    limit_px: limit,
    order_type: { trigger: { triggerPx: trig, isMarket: true, tpsl: 'sl' } },
    reduce_only: true,
  } as any);
}

export async function cancelOrdersForCoin(coin: string, wallet: string) {
  const orders = (await getOpenOrders(wallet)).filter(o => o.coin === coin);
  if (orders.length === 0) return null;
  const s = getSdk();
  return s.exchange.cancelOrder(orders.map(o => ({ coin: toSdkCoin(coin), o: o.oid })));
}

export async function closePosition(coin: string, wallet: string) {
  const positions = await getPositions(wallet);
  const pos = positions.find((p: any) => p.coin === coin);
  if (!pos) throw new Error(`No open position for ${coin}`);

  const size = Math.abs(parseFloat(pos.szi));
  const isLong = parseFloat(pos.szi) > 0;

  // Close = opposite direction, reduce-only so it can never open a reverse position
  return placeMarketOrder(coin, !isLong, size.toString(), 0.02, true);
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
