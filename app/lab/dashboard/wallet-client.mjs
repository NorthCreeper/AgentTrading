// Browser integration: request public account visibility only, after a user click.
// EIP-1193 account/chain events; EIP-6963 discovery. No signing or transaction methods.
const validAddress = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value);
function account(accounts) {
  if (!Array.isArray(accounts) || !validAddress(accounts[0])) throw new Error('钱包未提供有效账户地址');
  return accounts[0].toLowerCase();
}
function chain(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('钱包网络信息无效');
  const id = Number(BigInt(value));
  if (!Number.isSafeInteger(id)) throw new Error('钱包网络信息无效');
  return id;
}
// EIP-6963 announcements may arrive after the request dispatch. Keep one
// listener and registry for the page lifetime, as required by the standard:
// https://eips.ethereum.org/EIPS/eip-6963#announce-and-request-events
const registries = new WeakMap();
function providerRegistry(target) {
  const cacheable = target && (typeof target === 'object' || typeof target === 'function');
  if (cacheable && registries.has(target)) return registries.get(target);
  const providers = [];
  const add = (provider, name, announced = false) => {
    if (!provider || typeof provider.request !== 'function') return;
    const label = typeof name === 'string' ? name.slice(0, 80) : '浏览器钱包';
    const existing = providers.find(row => row.provider === provider);
    if (existing) { if (announced) existing.name = label; return; }
    providers.push({ provider, name: label });
  };
  const announced = event => add(event?.detail?.provider, event?.detail?.info?.name, true);
  target?.addEventListener?.('eip6963:announceProvider', announced);
  const request = () => {
    const EventCtor = target?.Event ?? globalThis.Event;
    if (EventCtor) target?.dispatchEvent?.(new EventCtor('eip6963:requestProvider'));
    for (const provider of target?.ethereum?.providers ?? []) add(provider, '浏览器钱包');
    add(target?.ethereum, '浏览器钱包');
  };
  const registry = {providers,request};
  if (cacheable) registries.set(target, registry);
  return registry;
}
export function discoverWalletProviders(target = globalThis.window) {
  const registry = providerRegistry(target); registry.request(); return registry.providers.slice();
}
export async function discoverWalletProvidersAsync(target = globalThis.window, {waitMs = 200, signal} = {}) {
  const cancelled = () => Object.assign(new Error('钱包发现已取消'), {name:'AbortError'});
  if (signal?.aborted) throw cancelled();
  const registry = providerRegistry(target); registry.request();
  if (signal?.aborted) throw cancelled();
  const delay = Math.max(0, Math.min(1500, Number(waitMs) || 0));
  if (delay) await new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, delay);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()); };
    signal?.addEventListener('abort', abort, {once:true});
  });
  else await Promise.resolve();
  if (signal?.aborted) throw cancelled();
  return registry.providers.slice();
}
export async function connectInjectedWallet(target = globalThis.window, provider = null) {
  provider ??= (await discoverWalletProvidersAsync(target))[0]?.provider;
  if (!provider || typeof provider.request !== 'function')
    throw new Error('当前浏览器未发现钱包扩展，请使用钱包浏览器，或填写 Polymarket 账户钱包地址进行只读查看');
  const signerAddress = account(await provider.request({ method: 'eth_requestAccounts' }));
  const chainId = chain(await provider.request({ method: 'eth_chainId' }));
  return { provider, signerAddress, chainId, polygon: chainId === 137, readOnly: true };
}
export function watchInjectedWallet(provider, onChange) {
  const accountsChanged = accounts => {
    try { onChange({ kind: 'accounts', signerAddress: account(accounts) }); }
    catch { onChange({ kind: 'disconnected', signerAddress: null }); }
  };
  const chainChanged = value => {
    try { const chainId = chain(value); onChange({ kind: 'chain', chainId, polygon: chainId === 137 }); }
    catch { onChange({ kind: 'invalid-chain', chainId: null, polygon: false }); }
  };
  const disconnected = () => onChange({ kind: 'disconnected', signerAddress: null });
  provider?.on?.('accountsChanged', accountsChanged); provider?.on?.('chainChanged', chainChanged);
  provider?.on?.('disconnect', disconnected);
  return () => {
    provider?.removeListener?.('accountsChanged', accountsChanged); provider?.removeListener?.('chainChanged', chainChanged);
    provider?.removeListener?.('disconnect', disconnected);
  };
}
