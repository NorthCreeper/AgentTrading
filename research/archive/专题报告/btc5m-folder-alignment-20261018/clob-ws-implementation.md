# CLOB WebSocket 保守冗余实现

本次仅修改当前 lab 的 `dashboard/diagnostic-public-feed.mjs` 与其测试，新增 `dashboard/clob-market-stream.mjs` 与其测试。未修改 controller、UI、账户/运行状态、冻结 `public-feed.mjs`，没有启动/停止任何账户服务或发送订单。部署由主代理统一处理，本子任务未部署。

原始字节先备份到 `before-source/dashboard/`，清单为 `ws-before-source-manifest.json`。冻结 `public-feed.mjs` 变更前后 SHA256 均为 `2E82AF8BA5660052FBC8C965B00BAAEEF489E4251A192E1BE5F0ADED4DB65520`。

## 行为

- 原 REST 获取请求、1 秒轮询节奏与完整 PublicFeed 配对/时序/换轮校验全部保持。
- 原 REST `/book` 成功时，记录该 token 的实际 tick/minOrderSize 参数锚，不用 Gamma 缓存冒充 WS 参数。
- 额外订阅公开 CLOB market WS，同一轮独立 socket；自动心跳、连接超时、断线重连和换轮/停止隔离。
- WS 只接受带真实源毫秒 timestamp、正确 condition/token、可正常化的完整 book；接收时间与原始墙钟另外保存，重复同时间同内容不刷新收到时刻。
- price_change 使对应完整 book 失效，保留其源时间高水位。之后同时间/更早 book 不可复活旧深度。不无条件应用没有连续序号的增量。
- tick_size_change 另外清空参数锚，等待 REST 核实参数。
- 仅在 REST 失败、clock ready、同轮同 token、完整 WS book 源/收时间均≤3秒、REST 参数锚≤10秒时回退。仍通过原 normalizeBookPair、bookSequenceIssue 及交易新鲜度判断。
- 不新增自动交易触发频率、不提前结算、不改变 TWAP 或开盘参考。WS 不是主要行情源。
- 原 HTTP 错误仍完整记录；另记录订阅、断线缺口、拒绝/失效、回退可用性。真正回退时保存 rawBook 与 transport/parameterBasis，便于区分数据来源。

## 官方协议依据

[Polymarket 官方 Real-Time Data](https://docs.polymarket.com/market-data/realtime-data) 的原生 API market stream：`wss://ws-subscriptions-clob.polymarket.com/ws/market`，订阅 `assets_ids` + `type: market`，应用层每 10 秒 PING/PONG，`book` 含 market/asset_id/source timestamp/完整 levels，price_change 含逐 token 修改。官方 book 示例没有 tick/minOrderSize，故必须保留额外 REST 参数锚，不能凭接收时间制造源时钟。

## 验证

相关 17 项测试全通过，包括原 resolution 调度回归；新增覆盖订阅协议、心跳超时与恢复、停机/换轮隔离、真实时间保留、重复不刷新、源倒退/同时间冲突、delta/tick失效、REST参数锚过期、REST保持主源、回退经过原配对/序列检查、clock/stopped及非book请求不得回退。

另外独立进程只读观测公网 WS 20.4 秒，无账户服务控制：收到完整 book 108 个、price_change 7190 个、last_trade_price 53 个，连接正常。原始样例和计数保存在 `clob-ws-live-observation.json`。观测验证了真实协议字段与源时间格式；结束时回退可用为 false，且该脚本只在起始读取过 REST 参数，20 秒后已超过 10 秒锚定时限。

## 实际限度

这是一项保守的传输冗余，不能声明已经减少了真实行情缺口。公开盘口 delta 很频繁（本次约 350 个事件/秒），完整 book 往往很快被后续 delta 使失效。若要求以 WS 为主要行情且充分重建所有 delta，需要另设数据完整性、断流重建/REST核验、来源和时钟证据协议，并完整端到端验证；本轮没有通过放宽完整性要求提高交易频率。

当前 DiagnosticPublicFeed 构造后，在运行中的首次当前轮 `/book` 请求自动启动这一额外 socket；因此主代理如果部署新源码，该能力随 feed 启用。不要将它描述成“WS主源+REST兜底已完全对齐”。若本轮不希望增加额外连接，应暂缓部署这两个入口源文件，保留实现准备与测试结果。
