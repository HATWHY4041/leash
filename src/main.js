import { isAddress, getAddress, parseEther, formatEther, encodeDeployData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  pub, connectOwner, ownerClient, agentClient, waitTx, explainError, hasWallet, ensureAevum, setProvider,
  VAULT_ABI, VAULT_BYTECODE, ERC20_ABI, TUSD8, legacyFees, toUnits, fromUnits, fmt, short, txLink, addrLink, FAUCET,
} from './chain.js';
import { parseIntent } from './parser.js';
import { chooseWallet, restore, forgetWallet } from './wallet.js';

// ---------------------------------------------------------------- tiny helpers
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}
let toastTimer;
function toast(msg, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
}
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(explainError(e), true); console.error(e); report(btn?.dataset?.action || 'action', e); } finally { if (btn) btn.disabled = false; }
}
const STATUS = ['Pending', 'Paid', 'Rejected', 'Expired'];
function report(where, e) {
  try {
    const walk = []; let x = e; for (let i = 0; x && i < 6; i++) { walk.push([x.name, x.code, x.shortMessage || x.message, x.details, typeof x.data === 'string' ? x.data : JSON.stringify(x.data)].filter(Boolean).join(' | ')); x = x.cause; }
    fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ where, msg: walk.join(' <- '), code: e?.code ?? e?.cause?.code ?? null }) });
  } catch {}
}
// Send through the wallet with legacy fees first; if the wallet rejects that, retry letting the wallet pick fees.
async function viaWallet(send) {
  try { return await send(await legacyFees()); }
  catch (e) {
    if (/reject|denied|cancel/i.test(e?.message || '')) throw e;
    report('wallet-legacy', e);
    return await send({});
  }
}

// ---------------------------------------------------------------- state
const S = {
  owner: null,
  vault: null,       // { address, deployBlock }
  agentKey: null,
  d: { balance: 0n, daily: 0n, thr: 0n, left: 0n, paused: false, agent: null, vaultOwner: null, payees: [], requests: [], agentGas: 0n },
};

function loadVault() {
  S.vault = store.get('leash:vault');
  S.agentKey = S.vault ? store.get('leash:agent:' + S.vault.address.toLowerCase()) : null;
}
function saveVault(address, deployBlock) {
  S.vault = { address, deployBlock: deployBlock?.toString() ?? '0' };
  store.set('leash:vault', S.vault);
}
function saveAgentKey(k) {
  S.agentKey = k;
  store.set('leash:agent:' + S.vault.address.toLowerCase(), k);
}

// ---------------------------------------------------------------- reads
const readV = (functionName, args = []) => pub.readContract({ address: S.vault.address, abi: VAULT_ABI, functionName, args });

async function refresh() {
  if (!S.vault) return;
  const [balance, daily, thr, left, paused, agent, vaultOwner, payees, count] = await Promise.all([
    readV('balance'), readV('dailyLimit'), readV('approvalThreshold'), readV('remainingToday'),
    readV('paused'), readV('agent'), readV('owner'), readV('getPayees'), readV('requestCount'),
  ]);
  const n = Number(count);
  const ids = Array.from({ length: Math.min(n, 30) }, (_, i) => n - 1 - i);
  const reqs = await Promise.all(ids.map(async (id) => {
    const [to, amount, memo, status, createdAt] = await readV('getRequest', [BigInt(id)]);
    return { id, to, amount, memo, status: Number(status), createdAt: Number(createdAt) };
  }));
  const agentAddr = S.agentKey ? privateKeyToAccount(S.agentKey).address : null;
  const agentGas = agentAddr ? await pub.getBalance({ address: agentAddr }) : 0n;
  S.d = {
    balance, daily, thr, left, paused, agent, vaultOwner, agentGas, requests: reqs,
    payees: payees[0].map((a, i) => ({ address: a, name: payees[1][i], allowed: payees[2][i] })),
  };
  render();
}

// ---------------------------------------------------------------- render
function render() {
  const d = S.d;
  $('sBal').textContent = fmt(d.balance);
  $('sLeft').textContent = fmt(d.left);
  const spent = d.daily > d.left ? d.daily - d.left : 0n;
  const pct = d.daily > 0n ? Math.min(100, (fromUnits(spent) / fromUnits(d.daily)) * 100) : 0;
  $('sLimit').textContent = `Spent ${fmt(spent)} of your ${fmt(d.daily)} tUSD8 daily limit. Resets 24 hours after the first payment.`;
  $('sBar').style.width = `${pct}%`;
  $('sBar').parentElement.classList.toggle('hot', pct >= 80);
  $('sThr').textContent = fmt(d.thr);

  const myAgent = S.agentKey ? privateKeyToAccount(S.agentKey).address : null;
  const revoked = !d.agent || /^0x0+$/.test(d.agent);
  const keyMismatch = myAgent && !revoked && d.agent.toLowerCase() !== myAgent.toLowerCase();
  const noKey = !myAgent || keyMismatch;
  $('sStatus').textContent = d.paused ? 'Paused' : revoked ? 'Assistant removed' : noKey ? 'Key not in this browser' : 'Active';
  $('statusStat').className = 'status' + (d.paused || revoked ? ' off' : noKey ? ' warn' : '');
  $('sGas').textContent = myAgent ? `${Number(formatEther(d.agentGas)).toFixed(3)} tQDAY` : 'Replace the key under Rules';
  $('pauseBtn').textContent = d.paused ? 'Resume assistant' : 'Pause assistant';
  $('pauseBtn').className = 'btn ' + (d.paused ? 'btn-primary' : 'btn-danger');

  if (document.activeElement !== $('rDaily')) $('rDaily').value = fromUnits(d.daily);
  if (document.activeElement !== $('rThr')) $('rThr').value = fromUnits(d.thr);

  // payees
  const allowed = d.payees.filter((p) => p.allowed);
  $('payeeList').replaceChildren(...(allowed.length ? allowed.map((p) => el('div', { class: 'item' },
    el('div', {}, el('b', {}, p.name), el('div', { class: 'meta mono' }, p.address)),
    el('button', { class: 'btn btn-quiet btn-sm', onclick: (e) => removePayee(e.target, p) }, 'Remove'),
  )) : [el('div', { class: 'empty' }, 'No payees yet. Add someone below. The assistant can’t pay anyone until you do.')]));

  // requests
  const nameOf = (a) => d.payees.find((p) => p.address.toLowerCase() === a.toLowerCase())?.name || short(a);
  const pending = d.requests.filter((r) => r.status === 0);
  const done = d.requests.filter((r) => r.status !== 0);
  $('pendBadge').textContent = pending.length;
  $('pendBadge').classList.toggle('hidden', !pending.length);
  $('pendingList').replaceChildren(...(pending.length ? pending.map((r) => el('div', { class: 'item' },
    el('div', {}, el('div', { class: 'amt' }, `${fmt(r.amount)} tUSD8 → ${nameOf(r.to)}`),
      el('div', { class: 'meta' }, `${r.memo || 'no memo'} · requested ${new Date(r.createdAt * 1000).toLocaleString()}`)),
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-primary btn-sm', onclick: (e) => decide(e.target, r.id, true) }, 'Approve'),
      el('button', { class: 'btn btn-quiet btn-sm', onclick: (e) => decide(e.target, r.id, false) }, 'Reject')),
  )) : [el('div', { class: 'empty' }, 'Nothing is waiting for you.')]));
  $('doneList').replaceChildren(...(done.length ? done.map((r) => el('div', { class: 'item' },
    el('div', {}, el('div', {}, `${fmt(r.amount)} tUSD8 → ${nameOf(r.to)}`), el('div', { class: 'meta' }, r.memo || '')),
    el('span', { class: 'pill ' + (r.status === 1 ? 'paid' : 'bad') }, STATUS[r.status]),
  )) : [el('div', { class: 'empty' }, 'No decided requests yet.')]));

  $('contractInfo').replaceChildren(
    'Vault: ', el('a', { href: addrLink(S.vault.address), target: '_blank' }, S.vault.address), el('br'),
    'Owner: ', d.vaultOwner || '–', el('br'),
    'Assistant key: ', revoked ? 'revoked' : d.agent, el('br'),
    'tUSD8: ', el('a', { href: addrLink(TUSD8), target: '_blank' }, TUSD8),
  );
  if (S.owner && d.vaultOwner && S.owner.toLowerCase() !== d.vaultOwner.toLowerCase()) {
    toast('This wallet doesn’t own the vault, so approvals and rule changes won’t work.', true);
  }
}

async function renderWallet() {
  if (!S.owner) { $('walletInfo').textContent = 'Connect your wallet to deposit or withdraw.'; return; }
  const [tb, gas] = await Promise.all([
    pub.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: 'balanceOf', args: [S.owner] }),
    pub.getBalance({ address: S.owner }),
  ]);
  $('walletInfo').replaceChildren(`Your wallet ${short(S.owner)}: ${fmt(tb)} tUSD8 · ${Number(formatEther(gas)).toFixed(3)} tQDAY. `,
    el('a', { href: FAUCET, target: '_blank' }, 'Get test tokens'));
}

async function renderActivity() {
  const box = $('activityList');
  box.replaceChildren(el('div', { class: 'empty' }, 'Loading…'));
  try {
    const latest = await pub.getBlockNumber();
    // Aevum (cdk-erigon) caps eth_getLogs at 1,000 blocks per request.
    const STEP = 999n;
    let from = BigInt(S.vault.deployBlock || 0);
    if (latest - from > 60_000n) from = latest - 60_000n;
    const ranges = [];
    for (let start = from; start <= latest; start += STEP + 1n) ranges.push([start, start + STEP > latest ? latest : start + STEP]);
    const logs = [];
    for (let i = 0; i < ranges.length; i += 6) {
      const batch = await Promise.all(ranges.slice(i, i + 6).map(([a, b]) =>
        pub.getContractEvents({ address: S.vault.address, abi: VAULT_ABI, fromBlock: a, toBlock: b })));
      batch.forEach((x) => logs.push(...x));
    }
    const nameOf = (a) => S.d.payees.find((p) => p.address.toLowerCase() === a?.toLowerCase())?.name || short(a);
    const line = (l) => {
      const a = l.args;
      switch (l.eventName) {
        case 'AgentPaid': return ['paid', `AI paid ${fmt(a.amount)} → ${nameOf(a.to)}`, a.memo];
        case 'PaymentRequested': return ['req', `AI asked to pay ${fmt(a.amount)} → ${nameOf(a.to)}`, `${a.reason}${a.memo ? ' · ' + a.memo : ''}`];
        case 'RequestApproved': return ['paid', `You approved #${a.id} (${fmt(a.amount)})`, ''];
        case 'RequestRejected': return ['bad', `You rejected #${a.id}`, ''];
        case 'PayeeSet': return ['', `${a.allowed ? 'Approved' : 'Removed'} payee ${a.name}`, short(a.payee)];
        case 'LimitsChanged': return ['', `Limits: ${fmt(a.dailyLimit)}/day, ask above ${fmt(a.approvalThreshold)}`, ''];
        case 'AgentChanged': return ['', /^0x0+$/.test(a.newAgent) ? 'Assistant revoked' : `Assistant key set ${short(a.newAgent)}`, ''];
        case 'Paused': return ['bad', a.paused ? 'Kill switch ON' : 'Kill switch OFF', ''];
        case 'Withdrawn': return ['', `Withdrew ${fmt(a.amount)}`, short(a.to)];
        default: return ['', l.eventName, ''];
      }
    };
    const rows = logs.reverse().map((l) => {
      const [cls, title, sub] = line(l);
      return el('div', { class: 'item' },
        el('div', {}, el('div', {}, title), el('div', { class: 'meta' }, sub || '')),
        el('a', { class: 'pill ' + cls, href: txLink(l.transactionHash), target: '_blank' }, 'View tx'));
    });
    box.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty' }, 'No activity yet.')]));
  } catch (e) {
    box.replaceChildren(el('div', { class: 'empty' }, 'Could not load events: ' + explainError(e)));
  }
}

// ---------------------------------------------------------------- owner actions
function owner() {
  if (!S.owner) throw new Error('Connect your wallet first.');
  return ownerClient(S.owner);
}
async function ownerWrite(functionName, args) {
  if (!hasWallet()) throw new Error('Connect your wallet first.');
  await ensureAevum();
  const w = owner();
  const { request } = await pub.simulateContract({ account: S.owner, address: S.vault.address, abi: VAULT_ABI, functionName, args });
  const gas = await pub.estimateContractGas({ account: S.owner, address: S.vault.address, abi: VAULT_ABI, functionName, args });
  const hash = await viaWallet((fees) => w.writeContract({ ...request, gas: (gas * 13n) / 10n, ...fees }));
  toast('Submitted… waiting for Aevum');
  await waitTx(hash);
  return hash;
}

async function createVault(btn) {
  await busy(btn, async () => {
    const daily = Number($('newDaily').value), thr = Number($('newThreshold').value);
    if (!(daily > 0) || !(thr >= 0) || thr > daily) throw new Error('Threshold must be between 0 and the daily limit.');
    await ensureAevum();
    const gasBal = await pub.getBalance({ address: S.owner });
    if (gasBal < parseEther('1.05')) {
      throw new Error(`Your wallet has ${Number(formatEther(gasBal)).toFixed(3)} tQDAY on Aevum. You need about 1.1 tQDAY. Claim some from the QDay faucet, then try again.`);
    }
    // 1) Create the assistant key and keep it until the vault exists.
    let key = store.get('leash:pendingAgent');
    if (!key) { key = generatePrivateKey(); store.set('leash:pendingAgent', key); }
    const agent = privateKeyToAccount(key).address;
    // 2) Your wallet sends the assistant 1 tQDAY (a plain transfer). Skipped if it already has gas.
    if ((await pub.getBalance({ address: agent })) < parseEther('0.05')) {
      toast('Confirm sending 1 tQDAY to your assistant');
      const w = owner();
      const g = await viaWallet((fees) => w.sendTransaction({ to: agent, value: parseEther('1'), gas: 21000n, ...fees }));
      await waitTx(g);
    }
    // 3) The assistant key deploys your vault, with YOU set as owner.
    toast('Deploying your vault on Aevum…');
    const ac = agentClient(key);
    const args = [TUSD8, getAddress(S.owner), agent, toUnits(daily), toUnits(thr)];
    const gas = await pub.estimateGas({ account: ac.account, data: encodeDeployData({ abi: VAULT_ABI, bytecode: VAULT_BYTECODE, args }) });
    const hash = await ac.deployContract({ abi: VAULT_ABI, bytecode: VAULT_BYTECODE, args, gas: (gas * 13n) / 10n, ...(await legacyFees()) });
    const r = await waitTx(hash);
    saveVault(r.contractAddress, r.blockNumber);
    saveAgentKey(key);
    store.del('leash:pendingAgent');
    toast('Vault deployed. You are the owner.');
    showDash();
  });
}

async function loadExisting(btn) {
  await busy(btn, async () => {
    const a = $('loadAddr').value.trim();
    if (!isAddress(a)) throw new Error('That is not a valid address.');
    saveVault(getAddress(a), 0n);
    S.agentKey = store.get('leash:agent:' + a.toLowerCase());
    showDash();
  });
}

async function addPayee(btn) {
  await busy(btn, async () => {
    const name = $('pName').value.trim(), addr = $('pAddr').value.trim();
    if (!name) throw new Error('Give the payee a name.');
    if (!isAddress(addr)) throw new Error('That wallet address is not valid.');
    if (S.d.payees.some((p) => p.allowed && p.name.toLowerCase() === name.toLowerCase())) throw new Error('You already have a payee with that name.');
    await ownerWrite('setPayee', [getAddress(addr), name, true]);
    $('pName').value = ''; $('pAddr').value = '';
    toast(`${name} added`); await refresh();
  });
}
async function removePayee(btn, p) {
  await busy(btn, async () => { await ownerWrite('setPayee', [p.address, p.name, false]); toast(`${p.name} removed`); await refresh(); });
}
async function decide(btn, id, yes) {
  await busy(btn, async () => {
    await ownerWrite(yes ? 'approve' : 'reject', [BigInt(id)]);
    toast(yes ? 'Approved and paid' : 'Rejected'); await refresh();
  });
}
async function saveLimits(btn) {
  await busy(btn, async () => {
    await ownerWrite('setLimits', [toUnits($('rDaily').value || 0), toUnits($('rThr').value || 0)]);
    toast('Limits updated'); await refresh();
  });
}
async function togglePause(btn) {
  await busy(btn, async () => { await ownerWrite('setPaused', [!S.d.paused]); toast(S.d.paused ? 'Assistant resumed' : 'Assistant paused'); await refresh(); });
}
async function rotate(btn) {
  await busy(btn, async () => {
    const key = generatePrivateKey();
    const addr = privateKeyToAccount(key).address;
    await ownerWrite('setAgent', [addr]);
    saveAgentKey(key);
    try { await waitTx(await viaWallet((fees) => owner().sendTransaction({ to: addr, value: parseEther('0.5'), gas: 21000n, ...fees }))); } catch (e) { toast('Gas top-up skipped', true); }
    toast('Assistant key replaced. The old key no longer works.'); await refresh();
  });
}
async function revoke(btn) {
  await busy(btn, async () => {
    await ownerWrite('setAgent', ['0x0000000000000000000000000000000000000000']);
    toast('Assistant removed'); await refresh();
  });
}
async function deposit(btn) {
  await busy(btn, async () => {
    const amt = Number($('depAmt').value); if (!(amt > 0)) throw new Error('Enter an amount.');
    await ensureAevum();
    const have = await pub.readContract({ address: TUSD8, abi: ERC20_ABI, functionName: 'balanceOf', args: [S.owner] });
    if (have < toUnits(amt)) throw new Error(`Your wallet has ${fmt(have)} tUSD8. Claim tUSD8 from the faucet’s tUSD8 tab or the QDay Discord, then deposit.`);
    const { request } = await pub.simulateContract({ account: S.owner, address: TUSD8, abi: ERC20_ABI, functionName: 'transfer', args: [S.vault.address, toUnits(amt)] });
    const gas = await pub.estimateContractGas({ account: S.owner, address: TUSD8, abi: ERC20_ABI, functionName: 'transfer', args: [S.vault.address, toUnits(amt)] });
    await waitTx(await viaWallet((fees) => owner().writeContract({ ...request, gas: (gas * 13n) / 10n, ...fees })));
    $('depAmt').value = ''; toast(`Deposited ${amt} tUSD8`); await refresh(); renderWallet();
  });
}
async function withdraw(btn) {
  await busy(btn, async () => {
    const amt = Number($('wdAmt').value); if (!(amt > 0)) throw new Error('Enter an amount.');
    if (S.d.balance < toUnits(amt)) throw new Error(`The vault only holds ${fmt(S.d.balance)} tUSD8.`);
    await ownerWrite('withdraw', [S.owner, toUnits(amt)]);
    $('wdAmt').value = ''; toast(`Withdrew ${amt} tUSD8`); await refresh(); renderWallet();
  });
}
async function topupGas(btn) {
  await busy(btn, async () => {
    if (!S.agentKey) throw new Error('This browser doesn’t have the assistant’s key. Replace the key first.');
    await ensureAevum();
    await waitTx(await viaWallet((fees) => owner().sendTransaction({ to: privateKeyToAccount(S.agentKey).address, value: parseEther('0.5'), gas: 21000n, ...fees })));
    toast('Assistant gas topped up'); await refresh();
  });
}

// ---------------------------------------------------------------- chat
function say(who, ...content) {
  const m = el('div', { class: 'msg ' + who }, ...content);
  $('chatLog').append(m);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return m;
}
const checkBox = (rows) => el('div', { class: 'check' }, ...rows.map(([c, t]) => el('div', { class: c }, t)));

async function handleChat(text) {
  say('me', text);
  const thinking = say('bot', '…');
  const names = S.d.payees.filter((p) => p.allowed).map((p) => p.name);
  const it = await parseIntent(text, names);
  thinking.remove();
  const src = el('span', { class: 'src' }, it.source === 'ai' ? 'Read by AI. Checked by your contract.' : 'Read by the built-in parser. Checked by your contract.');
  const d = S.d;

  switch (it.intent) {
    case 'balance': return say('bot', `The vault holds ${fmt(d.balance)} tUSD8.`, src);
    case 'spent': return say('bot', `I can still spend ${fmt(d.left)} of your ${fmt(d.daily)} tUSD8 daily limit. Anything above ${fmt(d.thr)} in one go needs your approval.`, src);
    case 'payees': return say('bot', names.length ? `I can pay: ${names.join(', ')}. Nobody else.` : 'I can’t pay anyone yet. Add people under Payees.', src);
    case 'pending': {
      const p = d.requests.filter((r) => r.status === 0);
      return say('bot', p.length ? `${p.length} payment${p.length > 1 ? 's' : ''} waiting for you in Approvals.` : 'Nothing is waiting for approval.', src);
    }
    case 'pause': {
      const b = el('button', { class: 'btn ' + (d.paused ? 'btn-primary' : 'btn-danger') + ' btn-sm', onclick: (e) => togglePause(e.target) }, d.paused ? 'Resume assistant' : 'Pause assistant');
      return say('bot', d.paused ? 'I’m already paused. Resume me?' : 'Only you can pull the kill switch — tap to sign it in your wallet.', el('div', { class: 'row' }, b), src);
    }
    case 'help': case 'unknown':
      return say('bot', it.intent === 'unknown' ? 'I didn’t understand that. ' : '',
        'Try “pay Tunde 2 for the logo”, “how much is left today?”, “who can you pay?” or “pause”.', src);
    case 'pay': return planPayment(it, src);
  }
}

async function planPayment(it, src) {
  const d = S.d;
  if (!it.payee) {
    return say('bot', it.mentioned
      ? `${it.mentioned} isn’t on your payee list, so I can’t pay them. Only you can add people, under Payees.`
      : 'Who should I pay? Say a name from your Payees list.', src);
  }
  if (!it.amount) return say('bot', `How much should I send ${it.payee}?`, src);

  const p = d.payees.find((x) => x.allowed && x.name === it.payee);
  const amt = toUnits(it.amount);
  const myAgent = S.agentKey ? privateKeyToAccount(S.agentKey).address : null;
  const keyOk = myAgent && d.agent && d.agent.toLowerCase() === myAgent.toLowerCase();
  const rows = [
    ['y', `${it.payee} is on your approved list (${short(p.address)})`],
    d.paused ? ['x', 'Assistant is paused'] : ['y', 'Assistant is not paused'],
    amt <= d.thr ? ['y', `${it.amount} is within your ${fmt(d.thr)} tUSD8 ask-me amount`] : ['n', `${it.amount} is over your ${fmt(d.thr)} tUSD8 ask-me amount, so you’ll need to approve it`],
    amt <= d.left ? ['y', `${fmt(d.left)} of ${fmt(d.daily)} tUSD8 left today`] : ['n', `Only ${fmt(d.left)} tUSD8 left today, so you’ll need to approve it`],
    amt <= d.balance ? ['y', `Vault holds ${fmt(d.balance)} tUSD8`] : ['x', `Vault only holds ${fmt(d.balance)} tUSD8. Deposit first.`],
  ];
  const head = `Pay ${it.amount} tUSD8 to ${it.payee}${it.memo ? ` for “${it.memo}”` : ''}.`;
  if (d.paused) return say('bot', head, checkBox(rows), 'I’m paused, so I won’t send anything.', src);
  if (amt > d.balance) return say('bot', head, checkBox(rows), `The vault doesn’t have enough tUSD8, so I won’t try. Deposit some under Rules first.`, src);
  if (!keyOk) return say('bot', head, checkBox(rows), 'This browser doesn’t have the assistant’s key. Replace the key under Rules to use me here.', src);
  if (d.agentGas < parseEther('0.002')) return say('bot', head, checkBox(rows), 'I’m out of gas. Add gas under Rules.', src);

  const willQueue = amt > d.thr || amt > d.left;
  const go = () => executePay(p, it, amt);
  if ($('confirmFirst').checked || willQueue) {
    const btn = el('button', { class: 'btn btn-primary btn-sm', onclick: (e) => { e.target.disabled = true; go(); } }, willQueue ? 'Send request for approval' : 'Confirm payment');
    return say('bot', head, checkBox(rows), el('div', { class: 'row' }, btn), src);
  }
  say('bot', head, checkBox(rows), 'Every rule passes. Paying now.', src);
  return go();
}

async function executePay(p, it, amt) {
  const status = say('bot', 'Signing with the assistant key…');
  try {
    const ac = agentClient(S.agentKey);
    const { request, result } = await pub.simulateContract({
      account: ac.account, address: S.vault.address, abi: VAULT_ABI, functionName: 'agentPay',
      args: [p.address, amt, (it.memo || '').slice(0, 60)],
    });
    const hash = await ac.writeContract({ ...request, ...(await legacyFees()) });
    status.textContent = 'Sent to Aevum. Waiting for confirmation…';
    await waitTx(hash);
    const [executed, id] = result;
    status.classList.add(executed ? 'ok' : 'wait');
    status.replaceChildren(
      executed ? `Paid ${it.amount} tUSD8 to ${it.payee}.` : `Filed request #${id}. Approve or reject it under Approvals.`,
      ' ', el('a', { href: txLink(hash), target: '_blank' }, 'View tx'));
    await refresh();
  } catch (e) {
    status.classList.add('err');
    status.textContent = 'Blocked: ' + explainError(e);
  }
}

// ---------------------------------------------------------------- screens
function showSetup() {
  $('setup').classList.remove('hidden'); $('dash').classList.add('hidden');
  $('setupConnect').classList.toggle('hidden', !!S.owner);
  $('setupCreate').classList.toggle('hidden', !S.owner);
}
async function showDash() {
  $('setup').classList.add('hidden'); $('dash').classList.remove('hidden');
  if (!$('chatLog').children.length) {
    say('bot', 'Tell me who to pay and how much, like “pay Tunde 2 for the logo”. I can only pay people on your list, within the limits in your contract.');
  }
  try { await refresh(); } catch (e) { toast('Could not read the vault: ' + explainError(e), true); }
  renderWallet().catch(() => {});
}

function useProvider(p) {
  setProvider(p);
  p.on?.('accountsChanged', (a) => { S.owner = a[0] || null; $('connectBtn').textContent = S.owner ? short(S.owner) : 'Connect wallet'; if (S.vault) refresh(); else showSetup(); });
  p.on?.('disconnect', () => { S.owner = null; $('connectBtn').textContent = 'Connect wallet'; });
}
async function onConnect(btn) {
  await busy(btn, async () => {
    if (S.owner && btn?.id === 'connectBtn') { // tap again to switch wallet
      forgetWallet(); S.owner = null; $('connectBtn').textContent = 'Connect wallet';
    }
    const w = await chooseWallet();
    useProvider(w.provider);
    S.owner = await connectOwner();
    $('connectBtn').textContent = short(S.owner);
    toast(`Connected with ${w.name}`);
    if (S.vault) showDash(); else showSetup();
  });
}

// ---------------------------------------------------------------- wire up
const actions = {
  connect: onConnect, create: createVault, load: loadExisting, addPayee, saveLimits, togglePause, rotate, revoke,
  deposit, withdraw, topupGas,
  forget: () => { if (confirm('Forget this vault in this browser? The assistant key stored here will be deleted.')) { store.del('leash:agent:' + S.vault.address.toLowerCase()); store.del('leash:vault'); location.reload(); } },
};
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]'); if (a && actions[a.dataset.action]) { e.preventDefault(); actions[a.dataset.action](a); }
  const t = e.target.closest('[data-tab]');
  if (t) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === t));
    document.querySelectorAll('.tab').forEach((x) => x.classList.add('hidden'));
    $('tab-' + t.dataset.tab).classList.remove('hidden');
    if (t.dataset.tab === 'activity') renderActivity();
    if (t.dataset.tab === 'rules') renderWallet().catch(() => {});
  }
  const c = e.target.closest('[data-say]'); if (c && S.vault) handleChat(c.dataset.say);
});
$('connectBtn').addEventListener('click', (e) => onConnect(e.target));
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault(); const v = $('chatInput').value.trim(); if (!v) return; $('chatInput').value = ''; handleChat(v);
});

restore().then((w) => {
  if (!w) return;
  useProvider(w.provider);
  return w.provider.request({ method: 'eth_accounts' }).then((a) => {
    if (a[0]) { S.owner = a[0]; $('connectBtn').textContent = short(a[0]); if (!S.vault) showSetup(); renderWallet().catch(() => {}); }
  });
}).catch(() => {});
loadVault();
if (S.vault) showDash(); else showSetup();
setInterval(() => { if (S.vault && !document.hidden) refresh().catch(() => {}); }, 20000);
