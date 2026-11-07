// Read-only pUSD cash observation. No credentials, signatures, approvals or transactions.
// Official references checked 2026-11-06:
// https://docs.polymarket.com/resources/contracts
// https://docs.polymarket.com/concepts/pusd
// https://docs.polygon.technology/pos/reference/rpc-endpoints
export const walletBalanceVersion = 'read-only-pusd-balance-v1';
export const walletNetwork = Object.freeze({ chainId: 137, chainHex: '0x89', name: 'Polygon', asset: 'pUSD',
  contract: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', decimals: 6,
  contractSource: 'https://docs.polymarket.com/resources/contracts',
  assetSource: 'https://docs.polymarket.com/concepts/pusd', verifiedOn: '2026-11-06' });
// The HTTP target is never accepted from browser input; redirects are rejected.
export const walletRpcEndpoints = Object.freeze(['https://polygon.drpc.org', 'https://polygon.publicnode.com']);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const uintPattern = /^0x[0-9a-fA-F]{1,64}$/;
const zeroAddress = '0x0000000000000000000000000000000000000000';
export function validateWalletAddress(value) {
  if (typeof value !== 'string' || !addressPattern.test(value) || value.toLowerCase() === zeroAddress)
    throw new Error('请输入有效的 0x 钱包地址；不支持域名或私钥');
  return value.toLowerCase();
}
function uint(value, name) {
  if (typeof value !== 'string' || !uintPattern.test(value)) throw new Error(`RPC ${name} 数据无效`);
  return BigInt(value);
}
function decimal(value, decimals) {
  const s = value.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
async function rpcBatch(fetchFn, endpoint, calls, signal) {
  const body = calls.map((call, i) => ({ jsonrpc: '2.0', id: i + 1, method: call[0], params: call[1] }));
  const response = await fetchFn(endpoint, { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Polygon RPC 暂时不可用');
  const raw = await response.text();
  if (raw.length > 131072) throw new Error('RPC 响应过大');
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.length !== calls.length) throw new Error('RPC 响应不完整');
  return calls.map((_, i) => {
    const matches = values.filter(row => row?.id === i + 1);
    if (matches.length !== 1 || matches[0].jsonrpc !== '2.0' || matches[0].error || !('result' in matches[0]))
      throw new Error('RPC 查询失败或响应无效');
    return matches[0].result;
  });
}
async function readEndpoint(fetchFn, endpoint, address, now, timeoutMs, parentSignal) {
  if (parentSignal?.aborted) throw new Error('钱包查询已取消');
  const abort = new AbortController();
  let timer, cancel;
  const cancelled = new Promise((_, reject) => {
    cancel = () => { abort.abort(); reject(new Error('钱包查询已取消')); };
    parentSignal?.addEventListener('abort', cancel, {once:true});
  });
  const active = () => { if (abort.signal.aborted) throw new Error('钱包查询已取消'); };
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new Error('Polygon RPC 查询超时')); }, timeoutMs);
  });
  const read = async () => {
    active();
    const [chain, block] = await rpcBatch(fetchFn, endpoint, [['eth_chainId', []], ['eth_blockNumber', []]], abort.signal);
    active();
    if (uint(chain, 'chainId') !== 137n) throw new Error('RPC 网络与 Polygon 不符');
    uint(block, 'blockNumber');
    const data = `0x70a08231${address.slice(2).padStart(64, '0')}`;
    const [rawBalance, rawDecimals, blockInfo, code] = await rpcBatch(fetchFn, endpoint, [
      ['eth_call', [{ to: walletNetwork.contract, data }, block]],
      ['eth_call', [{ to: walletNetwork.contract, data: '0x313ce567' }, block]],
      ['eth_getBlockByNumber', [block, false]], ['eth_getCode', [address, block]]], abort.signal);
    active();
    const balance = uint(rawBalance, 'balance');
    if (uint(rawDecimals, 'decimals') !== 6n) throw new Error('pUSD 代币精度与官方配置不符');
    if (blockInfo?.number?.toLowerCase() !== block.toLowerCase()) throw new Error('RPC 区块不一致');
    const sourceTime = Number(uint(blockInfo?.timestamp, 'timestamp')) * 1000;
    if (!Number.isSafeInteger(sourceTime) || now - sourceTime > 120000 || sourceTime - now > 10000)
      throw new Error('Polygon 区块已过期或时间异常');
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) throw new Error('RPC 地址类型数据无效');
    const balanceText = decimal(balance, 6);
    return { balance: balanceText, balanceNumber: balance <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(balance) / 1e6 : null,
      blockNumber: block, sourceTime, accountType: code === '0x' ? 'eoa' : 'contract', rpc: endpoint };
  };
  try { return await Promise.race([read(), timedOut, cancelled]); }
  finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', cancel); abort.abort(); }
}

export class WalletBalance {
  constructor({ fetchFn = globalThis.fetch, clock = Date.now, timeoutMs = 6000, pollMs = 10000, staleMs = 30000 } = {}) {
    this.fetchFn = fetchFn; this.clock = clock;
    this.timeoutMs = Math.max(1, Math.min(Number(timeoutMs) || 6000, 10000));
    this.pollMs = Math.max(1000, Number(pollMs) || 10000); this.staleMs = Math.max(this.pollMs, Number(staleMs) || 30000);
    this.generation = 0; this.inflight = null; this.activeRead = null; this.connection = null; this.value = null;
    this.attemptedAt = null; this.error = null; this.loading = false;
  }
  connect({ address, addressKind = 'account', signerAddress = null } = {}) {
    const normalized = validateWalletAddress(address);
    if (!['account', 'signer'].includes(addressKind)) throw new Error('地址类型无效');
    const signer = signerAddress == null ? null : validateWalletAddress(signerAddress);
    this.activeRead?.abort(); this.activeRead = null;
    this.generation++; this.connection = { address: normalized, addressKind, signerAddress: signer };
    this.value = null; this.attemptedAt = null; this.error = null; this.loading = false; this.inflight = null;
    return this.snapshot();
  }
  disconnect() {
    this.activeRead?.abort(); this.activeRead = null;
    this.generation++; this.connection = null; this.value = null; this.attemptedAt = null;
    this.error = null; this.loading = false; this.inflight = null;
    return this.snapshot();
  }
  snapshot() {
    const now = this.clock();
    const ageMs = this.value ? Math.max(0, now - this.value.observedAt) : null;
    const status = !this.connection ? 'disconnected' : this.error ? (this.value ? 'stale' : 'error') :
      this.value ? (ageMs > this.staleMs ? 'stale' : 'ready') : 'loading';
    return { version: walletBalanceVersion, ...walletNetwork, ...this.connection,
      status, address: this.connection?.address ?? null, addressKind: this.connection?.addressKind ?? null,
      signerAddress: this.connection?.signerAddress ?? null, balance: this.value?.balance ?? null,
      balanceNumber: this.value?.balanceNumber ?? null, accountType: this.value?.accountType ?? null,
      observedAt: this.value?.observedAt ?? null, attemptedAt: this.attemptedAt,
      blockNumber: this.value?.blockNumber ?? null, sourceTime: this.value?.sourceTime ?? null,
      ageMs, error: this.error, refreshing: this.loading, readOnly: true,
      scope: 'specified-address-pusd-cash-only', pollMs: this.pollMs, staleMs: this.staleMs };
  }
  refresh({ force = false } = {}) {
    if (!this.connection) return Promise.resolve(this.snapshot());
    if (this.inflight) return this.inflight;
    const now = this.clock();
    if (!force && this.attemptedAt != null && now - this.attemptedAt < this.pollMs)
      return Promise.resolve(this.snapshot());
    const generation = this.generation, address = this.connection.address;
    const controller = new AbortController(); this.activeRead = controller;
    this.attemptedAt = now; this.loading = true;
    const operation = async () => {
      let result, failure;
      for (const endpoint of walletRpcEndpoints) {
        if (controller.signal.aborted || this.generation !== generation) break;
        try { result = await readEndpoint(this.fetchFn, endpoint, address, this.clock(), this.timeoutMs, controller.signal); break; }
        catch (error) { failure = error; if (controller.signal.aborted || this.generation !== generation) break; }
      }
      if (this.generation === generation) {
        this.loading = false;
        if (result) { this.value = { ...result, observedAt: this.clock() }; this.error = null; }
        else this.error = failure?.message ?? '余额查询失败';
      }
      return this.snapshot();
    };
    const promise = operation(); this.inflight = promise;
    promise.finally(() => {
      if (this.inflight === promise) this.inflight = null;
      if (this.activeRead === controller) this.activeRead = null;
    });
    return promise;
  }
}
