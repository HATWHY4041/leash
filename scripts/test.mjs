// End-to-end contract tests on a local in-memory chain (ganache + viem).
import ganache from 'ganache';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createTestClient, createWalletClient, createPublicClient, custom, parseUnits, encodeFunctionData, decodeErrorResult } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const V = JSON.parse(fs.readFileSync('build/LeashVault.json'));
const T = JSON.parse(fs.readFileSync('build/MockUSD8.json'));

const keys = [0, 1, 2, 3].map(() => generatePrivateKey());
const provider = ganache.provider({
  logging: { quiet: true }, chain: { hardfork: 'merge' },
  wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance: '0x56BC75E2D63100000' })) },
});
const transport = custom(provider);
const pub = createPublicClient({ transport });
const test = createTestClient({ mode: 'ganache', transport });
const accts = keys.map((k) => privateKeyToAccount(k));
const [owner, agent, tunde, stranger] = accts.map((a) => a.address);
const byAddr = Object.fromEntries(accts.map((a) => [a.address, a]));
const w = (addr) => createWalletClient({ account: byAddr[addr], transport });

const u = (n) => parseUnits(String(n), 6);
let passed = 0;
const it = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };

async function deploy(abi, bytecode, args = [], from = owner) {
  const hash = await w(from).deployContract({ abi, bytecode, args, chain: null });
  const r = await pub.waitForTransactionReceipt({ hash });
  return r.contractAddress;
}
async function send(from, address, abi, functionName, args) {
  const hash = await w(from).writeContract({ address, abi, functionName, args, chain: null });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success', functionName + ' failed');
  return r;
}
async function reverts(from, address, abi, functionName, args, errName) {
  const data = encodeFunctionData({ abi, functionName, args });
  try {
    await provider.request({ method: 'eth_call', params: [{ from, to: address, data }, 'latest'] });
  } catch (e) {
    const raw = e.data?.result ?? e.data;
    if (errName) {
      const { errorName } = decodeErrorResult({ abi, data: raw });
      assert.equal(errorName, errName, `${functionName}: expected ${errName}, got ${errorName}`);
    }
    return;
  }
  assert.fail(`${functionName} should revert`);
}
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

const token = await deploy(T.abi, T.bytecode);
const vault = await deploy(V.abi, V.bytecode, [token, owner, agent, u(50), u(20)], agent); // deployed by the agent key, owned by owner
await send(owner, token, T.abi, 'mint', [vault, u(200)]);
const bal = (a) => read(token, T.abi, 'balanceOf', [a]);

console.log('LeashVault');

await it('owner is the passed owner, not the deployer', async () => {
  assert.equal((await read(vault, V.abi, 'owner')).toLowerCase(), owner.toLowerCase());
});

await it('rejects bad limits at deploy (threshold > daily)', async () => {
  await assert.rejects(deploy(V.abi, V.bytecode, [token, owner, agent, u(10), u(20)]));
});

await it('agent cannot pay someone who is not an approved payee', async () => {
  await reverts(agent, vault, V.abi, 'agentPay', [tunde, u(5), 'logo'], 'PayeeNotApproved');
});

await it('only owner can approve payees', async () => {
  await reverts(agent, vault, V.abi, 'setPayee', [tunde, 'Tunde', true], 'NotOwner');
  await send(owner, vault, V.abi, 'setPayee', [tunde, 'Tunde', true]);
  const [addrs, names] = await read(vault, V.abi, 'getPayees');
  assert.equal(addrs.length, 1); assert.equal(names[0], 'Tunde');
});

await it('agent pays instantly when within limits', async () => {
  await send(agent, vault, V.abi, 'agentPay', [tunde, u(15), 'logo design']);
  assert.equal(await bal(tunde), u(15));
  assert.equal(await read(vault, V.abi, 'remainingToday'), u(35));
});

await it('strangers cannot use the agent function', async () => {
  await reverts(stranger, vault, V.abi, 'agentPay', [tunde, u(1), 'x'], 'NotAgent');
  await reverts(owner, vault, V.abi, 'agentPay', [tunde, u(1), 'x'], 'NotAgent');
});

await it('payment above threshold becomes a request, no money moves', async () => {
  await send(agent, vault, V.abi, 'agentPay', [tunde, u(25), 'big job']);
  assert.equal(await bal(tunde), u(15));
  assert.equal(await read(vault, V.abi, 'requestCount'), 1n);
  const r = await read(vault, V.abi, 'getRequest', [0n]);
  assert.equal(r[1], u(25)); assert.equal(r[3], 0); // Pending
});

await it('payment that would break the daily limit becomes a request', async () => {
  await send(agent, vault, V.abi, 'agentPay', [tunde, u(18), 'a']); // 33 spent
  await send(agent, vault, V.abi, 'agentPay', [tunde, u(18), 'b']); // would be 51 > 50
  assert.equal(await bal(tunde), u(33));
  assert.equal(await read(vault, V.abi, 'requestCount'), 2n);
});

await it('owner approves a request and it pays', async () => {
  await reverts(agent, vault, V.abi, 'approve', [0n], 'NotOwner');
  await send(owner, vault, V.abi, 'approve', [0n]);
  assert.equal(await bal(tunde), u(58));
  await reverts(owner, vault, V.abi, 'approve', [0n], 'BadRequest'); // no double pay
});

await it('owner rejects a request and nothing moves', async () => {
  await send(owner, vault, V.abi, 'reject', [1n]);
  await reverts(owner, vault, V.abi, 'approve', [1n], 'BadRequest');
  assert.equal(await bal(tunde), u(58));
});

await it('kill switch stops the agent completely', async () => {
  await send(owner, vault, V.abi, 'setPaused', [true]);
  await reverts(agent, vault, V.abi, 'agentPay', [tunde, u(1), 'x'], 'IsPaused');
  await send(owner, vault, V.abi, 'setPaused', [false]);
});

await it('removing a payee blocks payments and pending approvals to them', async () => {
  await send(agent, vault, V.abi, 'agentPay', [tunde, u(30), 'pending']); // request #2
  await send(owner, vault, V.abi, 'setPayee', [tunde, 'Tunde', false]);
  await reverts(agent, vault, V.abi, 'agentPay', [tunde, u(1), 'x'], 'PayeeNotApproved');
  await reverts(owner, vault, V.abi, 'approve', [2n], 'PayeeNotApproved');
  await send(owner, vault, V.abi, 'setPayee', [tunde, 'Tunde', true]);
  const [addrs] = await read(vault, V.abi, 'getPayees');
  assert.equal(addrs.length, 1); // not duplicated
});

await it('daily window resets after 24h', async () => {
  assert.equal(await read(vault, V.abi, 'remainingToday'), u(17));
  await test.increaseTime({ seconds: 86401 }); await test.mine({ blocks: 1 });
  assert.equal(await read(vault, V.abi, 'remainingToday'), u(50));
  await send(agent, vault, V.abi, 'agentPay', [tunde, u(20), 'new day']);
  assert.equal(await read(vault, V.abi, 'remainingToday'), u(30));
});

await it('pending requests expire after 24h', async () => {
  const r = await read(vault, V.abi, 'getRequest', [2n]);
  assert.equal(r[3], 3); // Expired
  await reverts(owner, vault, V.abi, 'approve', [2n], 'BadRequest');
});

await it('owner can revoke the agent key', async () => {
  await send(owner, vault, V.abi, 'setAgent', ['0x0000000000000000000000000000000000000000']);
  await reverts(agent, vault, V.abi, 'agentPay', [tunde, u(1), 'x'], 'NotAgent');
});

await it('owner can change limits but not to invalid values', async () => {
  await reverts(owner, vault, V.abi, 'setLimits', [u(5), u(10)], 'BadLimits');
  await reverts(agent, vault, V.abi, 'setLimits', [u(100), u(10)], 'NotOwner');
  await send(owner, vault, V.abi, 'setLimits', [u(100), u(10)]);
  assert.equal(await read(vault, V.abi, 'dailyLimit'), u(100));
});

await it('only owner can withdraw', async () => {
  await reverts(agent, vault, V.abi, 'withdraw', [agent, u(1)], 'NotOwner');
  const before = await bal(owner);
  await send(owner, vault, V.abi, 'withdraw', [owner, u(10)]);
  assert.equal(await bal(owner) - before, u(10));
});

console.log(`\n${passed} passing`);
process.exit(0);
