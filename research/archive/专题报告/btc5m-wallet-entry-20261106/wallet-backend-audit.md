# 钱包接入口后端及扩展审计

范围：wallet-balance.mjs、wallet-client.mjs、portfolio-panel.mjs与server钱包路由；只读核查后，按主代理分工修复前两模块及对应测试。没有连接生产钱包、修改模拟余额、签署消息或发交易。

## 已确认的隔离

- 钱包余额服务只接受规范0x公开地址，拒绝私钥长度、域名、URL、零地址等输入。
- RPC目标为固定Polygon入口，拒绝重定向；仅使用chainId、blockNumber、eth_call、区块详情与代码读取，没有授权、签名或交易方法。
- 同一查询固定到同一链上区块，校验链、区块号、来源时间和代币精度，精确余额保留字符串；失败不补零，旧值明确stale。
- 浏览器只请求eth_requestAccounts与eth_chainId；签名地址和Polymarket账户余额地址分开，用户确认后者。读取EOA并不证明其是Deposit/Proxy/Safe地址或其余额地址。
- 钱包API受控制令牌保护，但和模拟账户独立；连接/刷新/断开不改变模拟账户、模式或realTrading=false。

## 本轮确认并修复

1. 原EIP-6963发现仅在同步dispatch期间监听，微任务公告能稳定复现丢失。新discoverWalletProvidersAsync(target,{waitMs=200,signal})使用每页单一、全生命周期公告注册表，捕获异步与迟到注入，保留旧同步函数兼容。依据：[EIP-6963官方标准](https://eips.ethereum.org/EIPS/eip-6963#announce-and-request-events)。UI应等待新异步函数，不能把“瞬时无扩展”当作最终结果。
2. 原disconnect只拒绝旧结果写入，旧请求失败后仍可向备用RPC启动两批查询。新实现Abort当前请求，立即结束等待，检查每个读取阶段与备用入口之前的取消/代际；即使注入fetch忽略abort，也不会启动后续阶段。切换地址只取消旧代，不阻止新地址立刻查询。

旧问题复现证据：wallet-audit-repro.json（使用公开虚构地址与本地RPC桩，未调用生产钱包）。原有12项钱包测试通过；修复后16项全部通过，见wallet-backend-tests.log。新增4项覆盖断开取消、地址切换、异步与迟到发现、发现取消且不请求账户。

## 主UI应处理的剩余项

- 原refreshWallet()的GET无超时且无前端代际：迟到旧GET可覆盖新连接/切换/断开界面，挂起请求也会阻止后续刷新。建议请求超时、取消和连接代际校验；这些不在本代理修改范围。
- 连接资料只存在后端内存，重启会清空。若需要方便重新连接，应由用户明确勾选仅在当前浏览器记住公开账户地址；不保存私钥、签名结果或会话授权。重启后重新读取余额，而不是恢复旧ready值。
- 当前钱包资产/合约注记仅核验至2026-09-30，主流程应在部署前按官方最新文档复核。
- 新鲜余额只代表指定地址的链上现金，当前没有真实持仓、成本、交易流水和资金流，不应计算真实胜率/回报率或启用真实交易。

本代理仅修改生产源码wallet-balance.mjs、wallet-client.mjs及wallet-balance.test.mjs；server、portfolio-panel、index与真实账户配置未修改。
