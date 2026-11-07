# 数据来源与记录口径

| 记录 | 来源 | 用途与区分 |
| --- | --- | --- |
| BTC 5 分钟合约元数据与盘口 | Polymarket Gamma 的市场元数据，CLOB 的 REST 盘口与市场 WebSocket。见 [市场查询](../app/lab/dashboard/gamma-market.mjs)和[盘口订阅](../app/lab/dashboard/clob-market-stream.mjs)。 | 识别盘口、方向与报价，保留盘口状态和时间。盘口报价可能变化，不能用来证明某笔订单成交。 |
| BTC 参考价 | Polymarket RTDS 中程序订阅的 BTC/USD TWAP 与 Chainlink 消息。见[行情接入](../app/lab/dashboard/public-feed.mjs)。 | 用于信号、开盘参考与研究。保留源时间、接收时间和缺口。不同主题和回退来源分别记录。 |
| 现货与订单流 | Binance 和 Coinbase 的现货交易或深度。见[现货接入](../app/lab/dashboard/spot-feed.mjs)。 | 提供市场背景与订单流证据。与合约盘口及其结算依据分别统计。 |
| 模拟成交和账户 | 本地模拟成交器，根据当时可用的报价和规则生成成交、费用估计及账本。见[模拟执行](../app/lab/paper-broker.mjs)。 | 自动入场和手动 One-Tap 的来源分开。模拟成交记录只反映该模拟账户。 |
| 真实成交、费用和兑付 | Polymarket 账户认证订单、成交及持仓查询，结合结算或兑付证据核对。见[真实账本](../app/live/live-trading.mjs)。 | 已提交、部分成交、最终成交、费用与兑付分别记录。 |
| 回放、回测和研究 | 历史数据、前瞻采集、固定研究资源及对应版本的假设。见[历史目录逻辑](../app/lab/research/history-optimization-20261002/history-catalog.mjs)。 | 根据数据窗口和策略版本解释。缺失、晚到和无法验证的观察单列，回放成交与已核对的实际成交分开。 |

对比研究结果时，请核对策略版本、采集窗口、市场标识、报价时间、费用口径和结算状态。仓库随附的研究资源用于复现代码行为。每个新安装在本机生成自己的观察记录和账户账本。
