# 并列研究：合约支付标签与参考价格一致性

版本：verified-binary-label-design-v1。性质：看实际标签之前的设计与纯假例验证；没有实际数据提取、拟合、账户回放、部署或盈利结论。

## 研究判断

本研究有独立的统计价值。持有 Up 合约至正式结算的目标是该合约支付 1 还是 0；它不是“本地记录中的 BTC 数值是否满足某个比较式”。如果官方 API 的身份、最终状态、token 映射和唯一赢家都经原始记录验证，则赢家是直接的合约终局目标。精确复现 eventMetadata 的开盘与最终价格、进一步要求其开盘值与本地原始 TWAP 相差不超过 1e-5，回答的是另一问题：本地参考链能否精确复现官方的参考数值。

把这两个资格取交集可能改变训练人群：例如 API 已明确支付 Up，而本地开盘 TWAP 与官方展示值略有差异；这时支付目标与参考数值复现分别为可用、失败。参考误差可能与波动、记录质量或价格发布状态相关，因此这个交集可能产生选择效应。这里只提出机制上存在的可能性；本研究没有查看真实标签、不知道这种排除是否发生、规模或收益方向，不能以“让模型能运行”为理由修改资格。

官方目前说明，Up/Down 的起点 TWAP 设定基准、终点 TWAP 设定最终价；最终价等于基准时为 Up。文档同时明确，winning token 结算价值为 $1，losing token 为 $0。以上不证明历史本地记录来自相同精确 report，也不把每条 Gamma/CLOB 响应变成链上兑付证据。[Resolution](https://docs.polymarket.com/concepts/resolution)

官方还说明 binary 可能有分摊支付；两个持仓系统经济含义相同但标识及核验路径不同。本候选只允许已核对的传统 CTF 二元 Up/Down 及完整 1/0 支付，不外推到 split、negative-risk 或 Protocol V2 position identifier。[Positions & Tokens](https://docs.polymarket.com/concepts/positions-tokens)

closed 单独表示已解决或已关闭，不能代替最终赢家；condition、slug、token 身份应分别核对。[Market Details](https://docs.polymarket.com/market-data/market-details) 官方采样市场 schema 保留 token_id、outcome、winner、price、closed、is_50_50_outcome 字段。[Get sampling markets](https://docs.polymarket.com/api-reference/markets/get-sampling-markets)

## 三种目标的边界

| 研究层 | 标签意义 | 能支持的结论 | 不能支持的结论 |
| --- | --- | --- | --- |
| S，现 strict | 现有 verifyResolution、精确原始开盘匹配及其可知时间全部通过 | 原 strict 人群的模型诊断 | 全部市场人群、精确链上支付或稳定盈利 |
| P，新的 API 支付候选 | 同一合约的已记录 Gamma 最终结果与 CLOB 唯一赢家一致 | 经以后独立原始证据核验的官方 API 支付标签 | 已核实链上可兑付、API 的真正独立性、精确 TWAP report 复现 |
| C，后续链上支付证据 | 明确 ledger/contract/condition/index-set 的最终 payout vector 与历史 observation | 更强支付核实及其可知时间 | 补齐历史收件时间、提前释放资金或未经确认的兑付 |

官方 Data API 的 /v2/resolutions 支持按 condition 查询 payout、最终状态及结算交易等字段，并可能优先使用 native V2、UMA 或 terminal CTF 生命周期。本次只读取文档，不调用实际市场查询；未来 C 层仍须验证具体 ledger、完整 token 映射及交易/区块最终性，不能从字段名自行推导状态枚举。[Get resolution state](https://docs.polymarket.com/api-reference/markets/get-resolution-state)

## 不改变当前研究

原 external-usd-model-study-20261007 的 S 标签规则、opening 1e-5、financial-onlyNeverTrains、日期、模型、候选对照和失败结果全部保留，不编辑任何已封存来源。这是 NEW 设计，不能替换当前研究的缺失标签，也不能将 current strict 失败更名为成功。

financial-only 记录不在本候选中训练。以后 P 提取器只读取独立注册的原始官方 API 响应，记录新 scope=registered-raw-official-api；不得把 financial-only 包装改名后使用。是否能由原 outcomes 证据产生 P，须在读其内容前另行注册文件、native identity、精确长度、完整 SHA、可读 scope 和所有保护来源。当前没有这样的注册。

## P 标签资格，事前固定

1. 原始 canonical market 的 slug/start/end/conditionId/两枚 token/完整规则/resolutionSource/negRisk 为固定身份，不得依当前官网或结果重新定义。仅 300 秒、非 negRisk、相互不同的两个正十进制 CTF token。没有身份值就未知。Protocol V2 不冒充 CTF。
2. Gamma 与 canonical 的 slug、conditionId、endDate、完整 description、resolutionSource、negRisk 全部精确一致。Gamma 与 CLOB 的 question identifier 如提供，均须完整、相等；本纯假例候选要求它们存在，不用近似匹配补齐。CLOB 的 condition_id、market_slug、end_date_iso、description、neg_risk 同时精确一致。
3. Gamma.closed=true、umaResolutionStatus='resolved' 与 CLOB.closed=true。虽然官方明确 Up/Down 不走 UMA 争议流程，本兼容候选保留既有 Gamma 字段要求，它只是一项 API 状态要求，绝不据此称为 UMA 结算。若历史 API 的合理终态不同，必须另建协议，禁止在结果后自动回退。
4. Gamma 两个 outcomes 恰为 Up/Down、两枚 tokenId 无重复且逐一映射、两个 outcomePrices 严格为 0/1；CLOB 恰有两枚相同 token，winner 类型必须为 boolean，恰一枚 true，price 与 Gamma 0/1 一致；is_50_50_outcome 必须明确 false。缺失、partial、50/50、两个 winner、冲突一律未知；价格 1 单独不是赢家证据。
5. 标签 knownAt 使用原始 API 收件/处理时间及 byte-order release upper bound 中的最大值，不使用 endDate、resolved_at、closedTime 或后补网页信息回填。所有组成证据必须有有效原始时钟，knownAt>=end 且 <= 已固定 source cutoff。训练 knownAt 严格小于固定 validationAt-60s；等于边界也排除。模型真实出生时间另记，不称该模型历史上可用。
6. 若严格标签与 P 赢家或 token 支付矛盾，全部 fail closed。若已显示的官方数字有可区分的反向关系，且该关系与赢家矛盾，也排除 P。多个原始 official wrapper 的身份/赢家/支付/方向冲突保持未知，不挑一个方便结果；坏 wrapper 不能通过较老的正确 wrapper 自动回退。
7. official eventMetadata 缺失、其展示精度不能区分近乎相等、或本地开盘数值与它略不同，记录独立 referenceQuality 项，不补齐/改写任何价格、时钟、TWAP 窗口。这类问题本身不改变已一致的支付赢家。官方真实 tie 应归 Up，但展示 tie 不能认证真实 tie；P 依支付赢家，S 保持原严格处理。

## 事前对照及防止选择效应

在任何实际 P 标签读入前，根任务必须固定同一来源母数据、同一 source-only 7/3/3 日期、相同原始 29 slots、相同 feature eligibility、originalRoundWeight=1/原 static-anchor 数（外部与标签 mask 之前）、完全相同 C/U 模型、正则、支持范围、费用、延迟、成交与有限资金处理。P 不可以加入新特征、换日期、降低训练支持或输出预算。

先报告每一原始轮/slot 的 S/P 状态、独立 referenceQuality 和所有未知原因，记录 source-only 分母及 S∩P、P\S、S\P。S 与 P 各自的 B0/T/C/U 诊断之外，必须在 S∩P 的同一持出集比较两类训练模型；不得把 P 更大人群的平均收益直接与 S 较小人群比较。新增 P\S 单独报告，不能作为替换原 S 的证据。

当前原研究任何已查看标签/持出结果意味着那些结果不再是这个新假设的完全未知确认样本。以后若在同一已使用日期执行 P，只能称 retrospectively reused diagnostic；本设计记录“本子任务未读实际标签”，不保证根任务也未看。下一次 adoption 需要根任务另行事前注册尚未用于选择 P 的后续确认集；当时未记录价格仍未知，不许补造。

实际现金验证继续以扣费、延迟后的完整账户净收益为目标。支付标签更完整、CE/Brier 改善或样本增多均不自动意味着盈利，也不能直接结算主账户。资金只按已核实 settlement/redeem 可知时刻释放；未核实库存和等待占用保持原定义。

## 本次交付与下一门槛

protocol.mjs 和 candidate.mjs 是无文件读取、无网络、无拟合、无账户/下单接口的纯设计函数。即使 synthetic status='candidate'，rawSourcesAuthenticated、actualTrainingAuthorized、chainPaymentVerified、referenceSourceReconstructionVerified、actualOrderPermission、profitCertified 仍为 false。纯检查不能自动注册真实研究，也不能给主策略开仓/平仓权限。

下一步若根任务判断值得执行：独立审阅此设计和纯假例；在真实 label 内容读取前冻结 NEW 源代码及根注册；先做 S/P 资格分解，再按固定时序拟合与完整现金验证。未通过保留为候选对照，现 strict 失败结果不删除。本子任务到此仅完成设计，不运行这些真实阶段。
