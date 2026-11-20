/**
 * Minimal Hyperliquid exchange client: signs actions with the agent key and posts
 * them with fetch. Uses the same hashing the official SDK uses (verified against an
 * order signed by the Invo web app), without the SDK's networking.
 */
import { encode } from '@msgpack/msgpack';
import { Wallet, keccak256, concat, Signature } from 'ethers';
import { orderToWire, orderWireToAction } from 'hyperliquid';

const EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' };
const AGENT_TYPES = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };

let wallet: Wallet | null = null;
let lastNonce = 0;

export function setAgentKey(privateKey: string) { wallet = new Wallet(privateKey); }

function nextNonce() { lastNonce = Math.max(Date.now(), lastNonce + 1); return lastNonce; }

async function signAndPost(action: any): Promise<any> {
  if (!wallet) throw new Error('agent key not set');
  const nonce = nextNonce();
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));
  const connectionId = keccak256(concat([encode(action), nonceBytes, new Uint8Array([0])]));
  const sig = Signature.from(await wallet.signTypedData(DOMAIN, AGENT_TYPES, { source: 'a', connectionId }));
  const resp = await fetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null }),
  });
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { status: 'err', response: text }; }
}

export interface OrderSpec {
  asset: number;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  reduceOnly: boolean;
  orderType: { limit?: { tif: 'Ioc' | 'Gtc' | 'Alo' }; trigger?: { triggerPx: number; isMarket: boolean; tpsl: 'tp' | 'sl' } };
  cloid?: string;
}

export async function placeOrder(o: OrderSpec, builder?: { address: string; fee: number }) {
  const wire = orderToWire({
    coin: 'X', is_buy: o.isBuy, sz: o.sz, limit_px: o.limitPx, order_type: o.orderType as any,
    reduce_only: o.reduceOnly, ...(o.cloid ? { cloid: o.cloid } : {}),
  } as any, o.asset);
  return signAndPost(orderWireToAction([wire], 'na', builder as any));
}

export async function updateLeverage(asset: number, leverage: number, isCross = false) {
  return signAndPost({ type: 'updateLeverage', asset, isCross, leverage });
}

export async function cancel(cancels: { asset: number; oid: number }[]) {
  return signAndPost({ type: 'cancel', cancels: cancels.map(c => ({ a: c.asset, o: c.oid })) });
}
