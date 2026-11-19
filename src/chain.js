// Aevum Testnet + contract plumbing.
import {
  createPublicClient, createWalletClient, custom, http, fallback, defineChain,
  parseUnits, formatUnits, decodeErrorResult, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import Vault from './generated/LeashVault.json';

export const VAULT_ABI = Vault.abi;
export const VAULT_BYTECODE = Vault.bytecode;

export const TUSD8 = '0x456569838f1d43009A91ebA4263147Afd7233483';
export const DECIMALS = 6;
export const EXPLORER = 'https://explorer-test.qday.info';
export const FAUCET = 'https://faucet.qday.info/en';
const RPC_URL = 'https://rpc-test.qday.info';

export const aevum = defineChain({
  id: 44005,
  name: 'QDay Aevum Testnet',
  nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Aevum Explorer', url: EXPLORER } },
  testnet: true,
});

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

const rpcTransport = () => fallback([http('/api/rpc'), http(RPC_URL)]);

export const pub = createPublicClient({ chain: aevum, transport: rpcTransport() });

export const toUnits = (n) => parseUnits(String(n), DECIMALS);
export const fromUnits = (v) => Number(formatUnits(v ?? 0n, DECIMALS));
export const fmt = (v) => fromUnits(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

// ------------------------------------------------------------- owner (any EVM wallet)
let eth = null; // the EIP-1193 provider the user picked
export function setProvider(p) { eth = p; }
export function getProvider() { return eth; }
export function hasWallet() { return !!eth; }

export async function connectOwner() {
  if (!eth) throw new Error('Connect a wallet first.');
  const [address] = await eth.request({ method: 'eth_requestAccounts' });
  await ensureAevum();
  return address;
}

export async function ensureAevum() {
  const hex = '0x' + aevum.id.toString(16);
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain|not supported|no chain|4902/i.test(e.message || '')) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex, chainName: aevum.name, nativeCurrency: aevum.nativeCurrency,
          rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER],
        }],
      });
      // Some wallets add the chain without switching to it.
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); } catch {}
    } else if (e.code === 4001) throw e;
    // Other wallets don't support switching at all; carry on and let the chain check below decide.
  }
  const cid = await eth.request({ method: 'eth_chainId' }).catch(() => null);
  if (cid && parseInt(cid, 16) !== aevum.id) {
    throw new Error('Please switch your wallet to the QDay Aevum Testnet network (chain ID 44005, RPC https://rpc-test.qday.info) and try again.');
  }
}

export function ownerClient(address) {
  return createWalletClient({ account: address, chain: aevum, transport: custom(eth) });
}

// ------------------------------------------------------------- agent (local session key)
export function agentClient(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: aevum, transport: rpcTransport() });
}

// ------------------------------------------------------------- fees
// Aevum runs cdk-erigon (Polygon CDK). Legacy (type-0) transactions with an explicit gas price are the
// most compatible choice for both MetaMask and locally signed assistant transactions.
export async function legacyFees() {
  const gasPrice = await pub.getGasPrice();
  return { type: 'legacy', gasPrice: (gasPrice * 11n) / 10n };
}

// ------------------------------------------------------------- helpers
export async function waitTx(hash) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== 'success') throw new Error('Transaction reverted');
  return r;
}

const FRIENDLY = {
  NotOwner: 'Only the vault owner can do that.',
  NotAgent: 'The assistant’s key no longer works on this vault (it was removed or replaced).',
  IsPaused: 'The assistant is paused. Resume it under Rules first.',
  PayeeNotApproved: 'That address isn’t on your payee list.',
  ZeroAmount: 'Amount must be more than zero.',
  BadRequest: 'That request is no longer pending (already handled or expired).',
  TransferFailed: 'The transfer failed. The vault probably doesn’t have enough tUSD8.',
  BadLimits: 'The ask-me amount can’t be higher than the daily limit.',
};

export function explainError(e) {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = rev?.data?.errorName;
    if (name && FRIENDLY[name]) return FRIENDLY[name];
    const raw = e.walk((x) => typeof x?.data === 'string' && x.data.startsWith('0x'))?.data;
    if (raw) {
      try { const d = decodeErrorResult({ abi: VAULT_ABI, data: raw }); if (FRIENDLY[d.errorName]) return FRIENDLY[d.errorName]; } catch {}
    }
    if (/insufficient funds/i.test(e.message)) return 'Not enough tQDAY for gas. Claim some from the faucet.';
    if (/internal error/i.test(e.message)) return 'Your wallet couldn’t prepare this transaction. This usually means it doesn’t have enough tQDAY for gas on the Aevum network.';
    if (/user rejected|denied/i.test(e.message)) return 'You cancelled it in your wallet.';
    return e.shortMessage || e.message;
  }
  return e?.message || String(e);
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const txLink = (h) => `${EXPLORER}/tx/${h}`;
export const addrLink = (a) => `${EXPLORER}/address/${a}`;
