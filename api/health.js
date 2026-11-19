// GET /api/health — checks the Aevum RPC and the AI parser are reachable.
import { complete } from './_llm.js';

const RPC = process.env.AEVUM_RPC_URL || 'https://rpc-test.qday.info';

export default async function handler(req, res) {
  const out = { rpc: null, ai: null };
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
      ]),
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    const get = (id) => (Array.isArray(j) ? j.find((x) => x.id === id)?.result : null);
    out.rpc = { ok: true, chainId: parseInt(get(1), 16), block: parseInt(get(2), 16) };
  } catch (e) {
    out.rpc = { ok: false, error: String(e.message || e) };
  }
  if (req.query?.ai === '1') {
    try {
      const { text, model } = await complete({ prompt: 'Reply with the single word: ok', maxTokens: 5 });
      out.ai = { ok: true, model, reply: text.trim() };
    } catch (e) {
      out.ai = { ok: false, error: String(e.message || e).slice(0, 200) };
    }
  }
  res.setHeader('cache-control', 'no-store');
  res.status(200).json(out);
}
