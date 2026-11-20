import { randomBytes } from 'crypto';

/**
 * Invo links its records to Hyperliquid orders through the order's cloid.
 * Observed from the Invo web app (one close):
 *   clientTxId "close:f4d0a2fd"  <->  cloid 0x023100280100000855b7667d f4d0a2fd
 * i.e. a fixed-looking 12-byte prefix + the 4-byte random suffix of clientTxId.
 * PROVISIONAL: confirm the prefix against a captured OPEN before going live.
 */
const CLOID_PREFIX = (process.env.INVO_CLOID_PREFIX ?? '0x023100280100000855b7667d').toLowerCase();

export function newInvoTx(kind: 'open' | 'close') {
  const suffix = randomBytes(4).toString('hex');
  return { clientTxId: `${kind}:${suffix}`, cloid: CLOID_PREFIX + suffix };
}
