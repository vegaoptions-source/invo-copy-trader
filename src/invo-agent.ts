/**
 * Gets this program its own Hyperliquid trading key ("agent") for your Invo wallet,
 * using the same two calls the Invo web app makes:
 *   1. POST /dex/agent/challenge   { slotName, address }  -> message to sign
 *   2. POST /dex/agent/approve/wallet { challengeId, signature }
 * Invo's servers then authorize the key on your Invo wallet. The key can trade but
 * cannot withdraw. It is saved in agent-key.json (keep that file private) and
 * re-approved automatically before it expires (~90 days).
 *
 * Uses its own slot (default agent_3) so it does not knock out the key your browser
 * or phone uses (agent_1 / agent_2).
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { Wallet } from 'ethers';
import * as invo from './invo-client.js';

const KEY_FILE = process.env.AGENT_KEY_FILE ?? 'agent-key.json';
const SLOT = process.env.INVO_AGENT_SLOT ?? 'agent_3';
const RENEW_BEFORE_MS = 7 * 86_400_000;

export interface AgentKey { slot: string; address: string; privateKey: string; validUntil: number | null; approvedAt: string }

async function hlAgents(wallet: string): Promise<{ name: string; address: string; validUntil: number }[]> {
  const r = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'extraAgents', user: wallet }),
  });
  return r.json();
}

function load(): AgentKey | null {
  if (!existsSync(KEY_FILE)) return null;
  try { return JSON.parse(readFileSync(KEY_FILE, 'utf8')); } catch { return null; }
}

/** Approve a fresh agent key through Invo and save it. */
export async function approveNewAgent(wallet: string, log = console.log): Promise<AgentKey> {
  const agent = Wallet.createRandom();
  const ch = await invo.agentChallenge(SLOT, agent.address);
  const { challengeId, message } = ch?.data ?? {};
  if (!challengeId || !message) throw new Error(`Invo challenge failed: ${JSON.stringify(ch)}`);
  if (!message.toLowerCase().includes(agent.address.toLowerCase())) throw new Error('Challenge message does not mention our agent address - refusing to sign');

  const signature = await agent.signMessage(message); // personal_sign, as the web app does
  const ap = await invo.agentApprove(challengeId, signature);
  if (!ap?.success) throw new Error(`Invo approve failed: ${JSON.stringify(ap)}`);

  // Confirm on Hyperliquid itself (can take a moment to show up)
  let validUntil: number | null = null;
  for (let i = 0; i < 10 && validUntil === null; i++) {
    const found = (await hlAgents(wallet)).find(a => a.address.toLowerCase() === agent.address.toLowerCase());
    if (found) validUntil = found.validUntil;
    else await new Promise(r => setTimeout(r, 1500));
  }
  if (validUntil === null) throw new Error('Invo said approved, but the key is not listed on Hyperliquid yet - try again shortly');

  const key: AgentKey = { slot: SLOT, address: agent.address, privateKey: agent.privateKey, validUntil, approvedAt: new Date().toISOString() };
  writeFileSync(KEY_FILE, JSON.stringify(key, null, 2));
  try { chmodSync(KEY_FILE, 0o600); } catch { /* windows */ }
  log(`Approved trading key ${agent.address} in slot ${SLOT}, valid until ${new Date(validUntil).toISOString()}`);
  return key;
}

/** Return a working agent key, approving or renewing one if needed. */
export async function ensureAgent(wallet: string, log = console.log): Promise<AgentKey> {
  const key = load();
  if (key) {
    const live = (await hlAgents(wallet)).find(a => a.address.toLowerCase() === key.address.toLowerCase());
    if (live && live.validUntil - Date.now() > RENEW_BEFORE_MS) return { ...key, validUntil: live.validUntil };
    log(live ? 'Trading key expires within 7 days - renewing' : 'Saved trading key is no longer approved - approving a new one');
  }
  return approveNewAgent(wallet, log);
}
