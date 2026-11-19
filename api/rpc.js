// Thin JSON-RPC proxy to QDay Aevum Testnet, so the browser never hits CORS issues.
// Only read + raw-transaction methods are forwarded. It never holds or sees a private key.
const RPC = process.env.AEVUM_RPC_URL || 'https://rpc-test.qday.info';

const ALLOWED = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBalance', 'eth_call', 'eth_estimateGas',
  'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
  'eth_getCode', 'eth_sendRawTransaction',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 20 || calls.some((c) => !ALLOWED.has(c?.method))) {
    return res.status(400).json({ jsonrpc: '2.0', id: calls[0]?.id ?? null, error: { code: -32601, message: 'method not allowed' } });
  }
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    res.setHeader('content-type', 'application/json');
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ jsonrpc: '2.0', id: calls[0]?.id ?? null, error: { code: -32603, message: 'upstream RPC unreachable' } });
  }
}
