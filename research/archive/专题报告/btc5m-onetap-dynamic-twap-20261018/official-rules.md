# Polymarket One-Tap Buy 与金额订单规则核查

核查日期：2026-10-18（香港时间）。范围为 Polymarket 国际站；未使用 Polymarket US 规则，未登录、签名或提交订单。网页只读实看与公开开发文档分别记录。

## 官网面板能直接确认的行为

在 [BTC 5 分钟市场官网页面](https://polymarket.com/event/btc-updown-5m-1792303500) 中，交易框显示“1-Tap”“One-tap buy”，先选择 Up/Down，再提供 $5、$25、$100 金额快捷按钮及预计获胜兑付金额。下单类型菜单另列 Market/Limit（中文页面显示“盘口/限价”）。这是按金额表达买入意图的快捷入口，按钮金额不是固定份数。

公开未登录面板未展示底层 FAK/FOK 参数、默认滑点数值、单笔最低金额、费用是否包含于按钮金额、签名前的精确取整。不能声称本地设置完整复刻了官网内部实现。没有点金额按钮，避免触发买入或登录流程。

## 官方 API/SDK 可确认的执行语义

[Place Orders 官方文档](https://docs.polymarket.com/trading/place-orders)：BUY 的 amount 为手续费前 USD 本金；maxSpend 是含平台费用及 builder taker fees 的总支出上限。默认市场订单为 FAK，即立即成交可得部分并取消余量；FOK 要求全额成交。买入可用 maxPrice 保护，并需按盘口深度估算后重核价格。提交被接受或 delayed 不等于已有成交，需按 tradeIds 和成交记录核对。限价请求需满足 book.min_order_size（文档定义为份数）。市场订单构造示例也检查该最低份数。

[Order Lifecycle 官方文档](https://docs.polymarket.com/concepts/order-lifecycle)：底层订单均为限价订单，所谓市场订单是可立即匹配当前挂单的限价单。FAK 可部分成交且余量取消；因此请求最低数量与实际部分成交数量是不同概念。文档没有规定一次部分成交也必须达到请求最低量。

## 精度与费用

以只读 git ls-remote 固定官方 Python SDK 当前 main：`72297f05d6d8137702dad09b43817fbbaf6071ba`。

[SDK market.py，固定版本 L367–423](https://github.com/Polymarket/py-sdk/blob/72297f05d6d8137702dad09b43817fbbaf6071ba/src/polymarket/_internal/actions/orders/market.py#L367-L423)：BUY 本金向下保留两位；股份由本金除保护价格换算，精度随 tick。tick=0.01 时市场 BUY 的输出股份为四位小数，不是限价股份输入的两位小数。当前 SDK 最终向下取 taker amount，并在保护买入构造中检查其不会触及下一个最细价档。当前官网文档相应构造段仍写输出向上取整，与 SDK 存在差异。不能把本地统一两位股份模拟声称为完整链上编码复刻。

[SDK rounding 配置](https://github.com/Polymarket/py-sdk/blob/72297f05d6d8137702dad09b43817fbbaf6071ba/src/polymarket/_internal/actions/orders/context.py)：tick=0.1/0.01/0.005/0.0025/0.001/0.0001，对应 amount precision 为3/4/5/6/5/6；size precision 都为2。market BUY 中输入 amount 使用 size precision，输出 shares 使用 amount precision。

[Fees 官方文档](https://docs.polymarket.com/trading/fees)：费用于匹配时收取；标准曲线为 shares×rate×price×(1-price)，当前类别表 Crypto rate=0.07，公开费用精度五位小数。实际仍应读取每个市场 feeSchedule 的 rate/exponent，不能硬编码类别表改写历史费用。SDK 的预算函数保留通式 rate×[price×(1-price)]^exponent，并预留 builder fee。

[Exchange Upgrade 官方说明](https://help.polymarket.com/en/articles/14762452-polymarket-exchange-upgrade-april-28-2026)：升级后费用从买入扣份额改为以抵押币计费、成交时计算，旧版客户端不兼容新合约。当前部分旧帮助页仍写买入扣股份，不能用于本次新版本费用对齐。

## 已知不确定性与实现边界

- [Market Details 官方文档](https://docs.polymarket.com/market-data/market-details) 将 Gamma orderMinSize/SDK minimumOrderSize 描述为 USDC，而 Place Orders 将 book.min_order_size 描述为 shares。字段不能未经单位验证互换。
- 未找到当前官方一手资料确认“金额 FAK 买入只需 $1，且可一律豁免 book 最低份数”。SDK 参数验证只检查正值也不能证明交易所必接受。保留市场请求最低量是有依据的保守实现；最低预算不足时可在用户授权的2.5%–10%内选择满足最低量的预算，超过10%则不下单。
- 未找到官网 One-Tap 固定 2¢ 滑点规则。若本地仍取2¢，应明确这是本地保护设置，并受策略85¢价格上限约束。
- 费用每个 maker match 还是订单合计取整、具体 ties 规则、官网按钮 all-in 语义未从现有官方公开资料完全确定。真实成交对账仍是最终依据。paper 应记录其模拟约定，保留历史版本费用数据。

结论：能够有依据地对齐“金额快捷买入、带价格保护的即时成交、允许部分成交、余量取消、费用总预算封顶、成交后核对”的语义；不能把未知网页参数或最低订单单位冲突描述为已验证事实。
