// Wallet connection for any EVM wallet.
// 1) EIP-6963: finds every installed browser wallet (MetaMask, Rabby, Coinbase Wallet, OKX, Trust,
//    Phantom, Brave, Rainbow, Zerion, Bitget...) and lets the user pick one.
// 2) Legacy window.ethereum for wallets' in-app browsers that don't announce themselves.
// 3) WalletConnect (QR / mobile deep link) for every other wallet, when a project id is configured.
// 4) "Open in your wallet app" links for phones with no wallet in the current browser.

const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID || '';
const RPC_URL = 'https://rpc-test.qday.info';
const LAST = 'leash:wallet';

const announced = new Map();
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e.detail;
    if (d?.info?.uuid && d.provider) announced.set(d.info.uuid, d);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export async function discover() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((r) => setTimeout(r, 250));
  const list = [...announced.values()].map((d) => ({ id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider }));
  // In-app browsers often only expose window.ethereum.
  if (!list.length && window.ethereum) {
    const e = window.ethereum;
    const name = e.isMetaMask ? 'MetaMask' : e.isCoinbaseWallet ? 'Coinbase Wallet' : e.isTrust || e.isTrustWallet ? 'Trust Wallet'
      : e.isOkxWallet || e.isOKExWallet ? 'OKX Wallet' : e.isRabby ? 'Rabby' : e.isBraveWallet ? 'Brave Wallet' : e.isPhantom ? 'Phantom' : 'Browser wallet';
    list.push({ id: 'injected', name, icon: null, provider: e });
  }
  return list;
}

export const walletConnectEnabled = () => !!WC_PROJECT_ID;

let wcProvider = null;
async function walletConnect() {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  wcProvider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    optionalChains: [44005],
    rpcMap: { 44005: RPC_URL },
    showQrModal: true,
    metadata: {
      name: 'Leash', description: 'AI payments, on a leash. QDay Aevum Testnet.',
      url: location.origin, icons: [location.origin + '/favicon.svg'],
    },
  });
  await wcProvider.connect({ optionalChains: [44005] });
  return wcProvider;
}

export function lastWalletId() { try { return localStorage.getItem(LAST); } catch { return null; } }
function remember(id) { try { localStorage.setItem(LAST, id); } catch {} }
export function forgetWallet() { try { localStorage.removeItem(LAST); } catch {} wcProvider?.disconnect?.().catch?.(() => {}); }

// Silent reconnect to the wallet used last time (no pop-up).
export async function restore() {
  const id = lastWalletId();
  if (!id || id === 'walletconnect') return null;
  const w = (await discover()).find((x) => x.id === id) || (await discover())[0];
  if (!w) return null;
  try { const a = await w.provider.request({ method: 'eth_accounts' }); return a?.[0] ? { provider: w.provider, name: w.name } : null; } catch { return null; }
}

const DEEP = (url) => {
  const host = url.replace(/^https?:\/\//, '');
  const enc = encodeURIComponent(url);
  return [
    ['MetaMask', `https://metamask.app.link/dapp/${host}`],
    ['Trust Wallet', `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}`],
    ['Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${enc}`],
    ['OKX Wallet', `okx://wallet/dapp/url?dappUrl=${enc}`],
    ['Phantom', `https://phantom.app/ul/browse/${enc}?ref=${enc}`],
  ];
};

// Shows a wallet picker when needed and resolves to { provider, name }.
export async function chooseWallet() {
  const list = await discover();
  const last = lastWalletId();
  if (list.length === 1 && !walletConnectEnabled()) { remember(list[0].id); return { provider: list[0].provider, name: list[0].name }; }
  return new Promise((resolve, reject) => {
    const close = () => { overlay.remove(); };
    const overlay = document.createElement('div');
    overlay.className = 'wmodal';
    overlay.innerHTML = `<div class="wbox" role="dialog" aria-label="Connect a wallet">
      <div class="whead"><h3>Connect a wallet</h3><button class="wx" aria-label="Close">✕</button></div>
      <div class="wlist"></div>
      <div class="wmore"></div></div>`;
    const ul = overlay.querySelector('.wlist');
    const item = (label, sub, icon, onClick) => {
      const b = document.createElement('button');
      b.className = 'witem';
      b.innerHTML = `<span class="wicon">${icon ? `<img src="${icon}" alt="">` : '◎'}</span><span><b></b><small></small></span>`;
      b.querySelector('b').textContent = label; b.querySelector('small').textContent = sub || '';
      b.onclick = onClick; ul.append(b);
    };
    list.sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : 0)).forEach((w) =>
      item(w.name, w.id === last ? 'Last used' : 'Detected in this browser', w.icon, () => { remember(w.id); close(); resolve({ provider: w.provider, name: w.name }); }));
    if (walletConnectEnabled()) {
      item('WalletConnect', 'Any wallet: scan a QR code or open on your phone', '/walletconnect.svg', async () => {
        close();
        try { const p = await walletConnect(); remember('walletconnect'); resolve({ provider: p, name: 'WalletConnect' }); } catch (e) { reject(e); }
      });
    }
    const more = overlay.querySelector('.wmore');
    if (!list.length) {
      more.innerHTML = `<p class="hint">No wallet in this browser. On your phone, open Leash inside your wallet app:</p><div class="wdeep"></div>
        <p class="hint">On a computer, install any EVM browser wallet (MetaMask, Rabby, Coinbase Wallet, OKX, Phantom…) and reload.</p>`;
      const dd = more.querySelector('.wdeep');
      DEEP(location.href.split('#')[0]).forEach(([n, href]) => { const a = document.createElement('a'); a.className = 'btn btn-quiet btn-sm'; a.href = href; a.textContent = n; dd.append(a); });
    } else {
      more.innerHTML = '<p class="hint">Leash works with any EVM wallet. It adds the QDay Aevum Testnet network for you.</p>';
    }
    overlay.querySelector('.wx').onclick = () => { close(); reject(Object.assign(new Error('You closed the wallet picker.'), { code: 4001 })); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.querySelector('.wx').click(); });
    document.body.append(overlay);
  });
}
