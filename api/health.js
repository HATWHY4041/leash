// GET /api/health — checks the Aevum RPC and the AI parser are reachable.
import { complete } from './_llm.js';
import { encodeDeployData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import Vault from '../src/generated/LeashVault.json' with { type: 'json' };

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
  if (req.query?.chain === '1') {
    const call = async (method, params) => { try { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); return j.error ? { error: j.error } : j.result; } catch (e) { return { error: String(e) }; } };
    const blk = await call('eth_getBlockByNumber', ['latest', false]);
    out.chain = {
      baseFeePerGas: blk?.baseFeePerGas ?? null, gasLimit: blk?.gasLimit ?? null,
      gasPrice: await call('eth_gasPrice', []),
      maxPriorityFeePerGas: await call('eth_maxPriorityFeePerGas', []),
      feeHistory: await call('eth_feeHistory', ['0x4', 'latest', [25, 50]]),
      clientVersion: await call('web3_clientVersion', []),
    };
  }
  if (req.query?.txtypes === '1') {
    // Sign throwaway txs from an EMPTY random key: the node's rejection reason shows which types it accepts.
    const acct = privateKeyToAccount(generatePrivateKey());
    const send = async (raw) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })).json(); return j.error ? j.error.message : j.result; };
    const base = { to: acct.address, value: 1n, gas: 21000n, nonce: 0, chainId: 44005 };
    out.txtypes = {
      legacy: await send(await acct.signTransaction({ ...base, type: 'legacy', gasPrice: 1100000000n })),
      eip1559: await send(await acct.signTransaction({ ...base, type: 'eip1559', maxFeePerGas: 1100000000n, maxPriorityFeePerGas: 1000000000n })),
    };
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(req.query?.logs || '')) {
    const call = async (method, params) => { const j = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); return j.error ? { error: j.error } : { n: j.result.length }; };
    const latest = parseInt((await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json()).result, 16);
    const hex = (n) => '0x' + n.toString(16);
    out.logs = {
      latest,
      addrOnly10k: await call('eth_getLogs', [{ address: req.query.logs, fromBlock: hex(latest - 9999), toBlock: hex(latest) }]),
      addrOnly1k: await call('eth_getLogs', [{ address: req.query.logs, fromBlock: hex(latest - 999), toBlock: hex(latest) }]),
      orTopics: await call('eth_getLogs', [{ address: req.query.logs, fromBlock: hex(latest - 999), toBlock: hex(latest), topics: [['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)]] }]),
      fromZero: await call('eth_getLogs', [{ address: req.query.logs, fromBlock: '0x0', toBlock: 'latest' }]),
    };
  }
  if (req.query?.deploy === '1') {
    // Dry-run the vault deployment on Aevum (no signature, no funds moved).
    try {
      const from = /^0x[0-9a-fA-F]{40}$/.test(req.query.from || '') ? req.query.from : '0x000000000000000000000000000000000000dEaD';
      const data = encodeDeployData({ abi: Vault.abi, bytecode: Vault.bytecode, args: ['0x456569838f1d43009A91ebA4263147Afd7233483', from, 10_000000n, 3_000000n] });
      const call = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
      const est = await call('eth_estimateGas', [{ from, data }]);
      const bal = await call('eth_getBalance', [from, 'latest']);
      const gp = await call('eth_gasPrice', []);
      out.deploy = { from, estimate: est.result ? parseInt(est.result, 16) : null, error: est.error || null, balanceWei: bal.result ? BigInt(bal.result).toString() : null, gasPriceWei: gp.result ? BigInt(gp.result).toString() : null };
    } catch (e) { out.deploy = { error: String(e.message || e) }; }
  }
  if (req.query?.ai === '1') {
    try {
      const t0 = Date.now();
      const { text, model } = await complete({
        system: 'Return only JSON: {"intent":"pay","payee":string,"amount":number,"memo":string}.',
        prompt: 'Approved payees: ["Tunde","Kemi"]\nUser message: "abeg send tunde 4 bucks for the flyer"',
      });
      out.ai = { ok: !!text.trim(), model, ms: Date.now() - t0, sample: text.trim().slice(0, 200) };
    } catch (e) {
      out.ai = { ok: false, error: String(e.message || e).slice(0, 200) };
    }
  }
  res.setHeader('cache-control', 'no-store');
  res.status(200).json(out);
}
