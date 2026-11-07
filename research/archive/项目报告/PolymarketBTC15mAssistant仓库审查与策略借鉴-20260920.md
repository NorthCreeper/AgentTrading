# PolymarketBTC15mAssistant 仓库审查与策略借鉴

审查日期：2026-09-20。结论：适合作为行情观察与候选特征的参考，不适合直接替换当前 5 分钟自动交易策略；没有提供可验证的盈利证据。

## 范围与方法

- 仓库：https://github.com/FrondEnt/PolymarketBTC15mAssistant
- 固定版本：`5955967a594a1498e85da2d627d1f41b27af50f8`，main，最后提交时间 2026-01-29 22:25:30 UTC。
- 逐项阅读该版本全部 21 个跟踪文件，共 2373 行，包括 17 个 JavaScript 文件、README、配置、依赖锁和忽略规则；检查 11 条提交记录，并查看 issue/PR 列表及相关修复提案的状态。不把未合并的分支功能当成 main 已具备的能力。
- 17 个 JavaScript 文件语法检查全部通过；调用无网络副作用的原始计算模块进行数值复核。没有安装依赖、运行主程序或更改当前运行策略。
- 本地只读参考副本：`PolymarketBTC15mAssistant-review/`。
- 文件清单与校验：`PolymarketBTC15mAssistant-review-manifest.json`；复核结果：`PolymarketBTC15mAssistant-review-checks.json`。
- 语法与公式复核不构成完整运行验证、依赖安全审计或收益回测。

## 1. 实际工具与数据流

| 类别 | 实际实现 | 作用及边界 |
|---|---|---|
| 运行与界面 | Node.js、JavaScript ES modules、npm、内置 readline、ANSI 终端渲染 | 终端信息面板；main 无独立网页控制台 |
| WebSocket | ws；锁定 8.19.0 | Binance 逐笔成交、Polymarket BTC 参考价格、可选 Polygon 链上事件 |
| 链上读取 | ethers；锁定 6.16.0 | ABI 编解码、Chainlink latestRoundData/decimals、AnswerUpdated 事件；没有钱包签名与交易执行链路 |
| 网络代理 | undici 6.23.0、https-proxy-agent 7.0.6、socks-proxy-agent 8.0.5 | HTTP(S) 与 WebSocket 代理。HTTP 部分使用 undici ProxyAgent，不能仅凭 README 的 SOCKS 示例就认为所有请求均支持 SOCKS |
| Polymarket 元数据 | Gamma /events、/markets | 以 series_id=10192 发现 15 分钟盘口，或固定 slug |
| Up/Down 行情 | CLOB /price 与 /book；失败回退 Gamma outcomePrices | HTTP 轮询，没有订阅 CLOB 市场订单簿 WebSocket；每组请求都完成后再等待 1 秒，并非严格每秒完成一轮 |
| BTC 参考价 | RTDS crypto_prices_chainlink | 普通 Chainlink 价格主题，不是当前工作流使用的 crypto_prices_twap_sixty |
| BTC 备用参考价 | Polygon HTTP/WSS RPC，默认 Chainlink BTC/USD aggregator | 不应当作当前 60 秒 TWAP 结算价格的等价替代品 |
| Binance | BTCUSDT /api/v3/klines、/api/v3/ticker/price、@trade | 每轮获取 240 根 1 分钟 K 线及 200 根 5 分钟 K 线；后者下载后没有参与策略。成交订阅只保留最新价，未形成成交量差或订单流模型 |
| 指标 | 自写 Heiken Ashi、RSI、MACD、VWAP | 无 TA-Lib、机器学习库或大语言模型调用 |
| 日志 | CSV 信号日志、必要时保存市场 JSON | 不包含完整订单生命周期、成交损益账本、官方结算标签和样本外验证流程 |

文件覆盖：根目录 .gitignore、README.md、package.json、package-lock.json；src/config.js、index.js、utils.js；data 下 binance.js、binanceWs.js、chainlink.js、chainlinkWs.js、polymarket.js、polymarketLiveWs.js；engines 下 edge.js、probability.js、regime.js；indicators 下 heikenAshi.js、macd.js、rsi.js、vwap.js；net/proxy.js。

主流程：行情读取 → Binance K 线指标 → 人工权重方向打分 → 时间衰减 → 与归一化盘口价格比较 → ENTER/NO_TRADE 建议 → 屏幕与 CSV。ENTER 仅是字符串建议，没有发送订单。

## 2. 策略具体怎么判断

方向初始各 1 分。价格高于/低于 VWAP 加 2 分，VWAP 斜率同向加 2 分，RSI 高于 55 且走高或低于 45 且走低加 2 分，MACD 柱扩张加 2 分、线的正负加 1 分，连续两根同色 Heiken Ashi 加 1 分。failedVwapReclaim 额外给 Down 加 3 分，没有对称 Up 项。

方向得分转成 `rawUp = Up得分 / (Up得分 + Down得分)`。随后调整为：

`adjustedUp = 0.5 + (rawUp - 0.5) × 剩余分钟 / 15`

盘口价格先除以两侧价格之和，再从模型数值中扣除。

| 剩余时间 | 阶段 | 最低模型与市场差值 | 最低方向数值 |
|---|---|---:|---:|
| 大于 10 分钟 | EARLY | 5 个百分点 | 55% |
| 大于 5、不超过 10 分钟 | MID | 10 个百分点 | 60% |
| 不超过 5 分钟 | LATE | 20 个百分点 | 65% |

市场状态、时区、BTC 相对开盘基准、Binance/Chainlink 差值、Delta 1/3 分钟、成交量及盘口深度都没有作为独立条件进入最终 decide()。市场状态写入日志；成交量仅用于市场状态分类。价差被计算但没有进入建议门槛。部分建议文本变量也未放入最终终端渲染列表。

## 3. 不宜照搬的关键问题

### A. “概率”没有校准，目标也不对应结算事件

模型是人工权重的归一化分数，未用实际结算结果学习或校准。scoreDirection 不输入真实开盘基准、相对基准偏离、结算源价格和未来波动尺度。显示 80% 不表示该方向结算胜率达到 80%。多个指标来自相同的 K 线趋势，简单相加也不代表增加了同等数量的独立证据。

### B. 时间衰减与入场门槛发生确定性冲突

到期时所有输入都被压到 50/50。该公式不能通用地代表一个固定基准二元事件的到期概率：基准偏离和剩余不确定性必须参与计算。

原函数复核：最强 Up 原始分数 11/12=91.67%；最强 Down 原始分数 14/15=93.33%。剩 5 分钟时分别只有 63.89% 和 64.44%，都低于 LATE 的 65% 门槛；此后只会更低。

因此在默认配置下，最后 5 分钟不存在能通过概率门槛的正常输入组合。对两个方向最强组合、剩余 0–300 秒逐秒执行 602 次复核，全部 NO_TRADE。不能把这解释成严格筛选了高质量末段机会。

若移植到 5 分钟：只改市场 slug、仍保留 15 分钟公式，会使全轮都落在此不可入场区域；若同步把分母改成 5，硬编码的阶段阈值仍让全轮归为 LATE，依然不能直接使用。

### C. “优势”未按照可成交成本计算

两侧买入价归一化会消除部分盘口溢价。例如输入 Up=0.60、Down=0.50，假定已校准 Up 概率为 0.62：程序比较的是 0.62−0.60/1.10=0.074545；实际以 0.60 买入持有结算，费用前每份期望只有 0.02。这只是展示公式差异的假设例子，不是市场机会。

还需要实际成交深度、费用、滑点、延迟和未成交处理。当前工作流已有按金额、深度和费用的执行核对，不应退回它的简化口径。

### D. 开盘基准可能错误

index.js:589–597 把进入某盘口后第一次见到的 CURRENT PRICE 固定为 PRICE TO BEAT。中途启动可能把中途价格当成开盘基准。上方虽然写了从市场字段或标题提取基准的函数，但运行链路未调用它。当前工作流必须保留准确开盘采样与缺失标记。

### E. 数据源及过期处理弱于当前工作流

- 订阅 crypto_prices_chainlink，而本机实际盘口规则指向 Chainlink 60 秒 TWAP；官方文档也区分不同主题。链上 aggregator、Binance BTCUSDT 和该 TWAP 不可静默混用。
- 参考价回退只看 price 是否非 null，没有检查年龄；一旦主源曾返回价格，即使之后停更，旧值也会持续阻挡回退。
- polymarketLiveWs.js:95–99 把 payload.timestamp 再乘 1000；当前官方 RTDS 示例给的是毫秒，这会把时间放大 1000 倍。
- RTDS 客户端未实现官方要求的 5 秒应用层 PING，也没有静默断流监测。
- 三个 WebSocket 模块都让 error 和 close 共用无防重的重连函数，有重复连接计时器风险。
- CLOB 失败可退回 Gamma 的价格，摘要也不保留原订单簿时间戳，没有当前工作流的身份/源年龄/接收年龄核对。

这不能解决此前 Up/Down 源快照未更新问题；“始终有数字”不等于“始终有新行情”。

### F. 其他已核对问题

- MACD=null 会抛异常，已用原函数复现；可选链后只比较 !==null 未排除 undefined。
- RSI 对完全横盘序列返回 100，已复现；采用窗口简单均值，并非 Wilder 平滑。
- VWAP 是当前拉取的约 240 分钟窗口的典型价加权结果，不是按盘口开始或交易日锚定的 VWAP。
- 订单簿最佳价用 min/max 找到了，但“前五档”深度直接 slice 原始数组，没有先按价格排序。乱序/倒序样本中，会误计远离最优价的深度；已复现。
- 直接给 0–1 价格加 ¢ 后缀，0.70 会显示成 0.70¢，单位应为 70¢ 或 $0.70。
- Binance @trade 用接收时间 Date.now()，不保存交易所原事件时间，不能据此精确研究领先滞后。
- 没有区分未收盘 K 线；若研究时拿最终收盘 K 线回填实时信号，将引入当时未知的数据。
- 交易时段用固定 UTC 范围，只是标签，没有美股交易日历、夏令时或日内波动统计模型。
- 主 HTTP 行情请求多数无超时，串在同一个 Promise.all 里，单接口卡住可拖住全部显示。

相关讨论：[PR #4](https://github.com/FrondEnt/PolymarketBTC15mAssistant/pull/4) 提出重连修复，检查时仍未合并；[PR #6](https://github.com/FrondEnt/PolymarketBTC15mAssistant/pull/6) 提出时间衰减、非对称打分、市场状态和网页等改动，检查时已关闭且未合并。上述结论以 main 源码和本地复核为依据，不以 PR 作者的运行描述证明盈利。问题区的无证据指控不作为技术审查结论。

## 4. 与当前工作流比较

本机已实时核对：auto 运行、未暂停，模型 forward-momentum、exitPolicy=market、paper、每次 $1，stopLossUsd=0、maxLoss=0。

| 能力 | 参考仓库 | 当前工作流 |
|---|---|---|
| PM 入场 | BTC 指标分数减归一化报价 | 同轮 30 秒盘口涨幅、当前往返成本与可成交深度 |
| 外部现货背景 | Binance K 线指标较丰富 | 当前主采集为 PM 订单簿及 Chainlink TWAP；外部现货特征可补充 |
| 退出 | 无持仓退出实现 | 10/30 秒盘口变化、价差/波动自适应阈值、连续确认 |
| 手动 One-Tap | 无执行链路 | 手动买入也自动管理退出 |
| 数据可靠性 | 回退与重连较粗糙 | 原时间戳、过期标记、行情缺口、严格结算源匹配 |
| 研究和记账 | 信号 CSV | 成交账本、官方结算核对、独立对照与事后路径观察 |

当前策略也不是校准后的结算概率模型：历史 30 秒涨幅扣当前成本只是可检验的动量规则。参考仓库不能为该规则或自己的规则提供正期望证明。

## 5. 真正值得借鉴的部分与建议顺序

### 第一步：补充外部现货上下文，先记录证据

加入 Binance 或可用现货交易所的成交及 K 线数据，分别保留 sourceTime 和 receivedAt，标注缺口。现货价作为解释变量，60 秒 TWAP 仍作为当前市场指定参考源。

优先特征：10/30/60 秒现货收益、波动率、相对真实开盘基准的标准化偏离、现货相对 TWAP 差值及变化、成交量变化。研究领先滞后时使用收益/价格增量并剔除过期快照；不能用价格水平相关性或平滑造成的延迟直接声称套利。

此前历史数据没有被记录下来的逐笔现货、接收延迟或订单流，不能事后伪装成已经拥有。可补的历史 K 线只适用于其支持的粒度，订单流及延迟检验需要新的前瞻采集。

### 第二步：少量独立对照，先改善入场质量

保留当前策略为基线，预先固定候选规则后新增独立模拟对照：

1. 多时间尺度一致性：在现有入场信号上，比较 10/30/60 秒动量支持与冲突时的净收益，而不是把 RSI、MACD、HA、VWAP 四次趋势投票当四份独立证据。
2. 市场状态分组：用趋势效率、相对波动的净位移、反复穿越基准次数区分持续趋势与震荡，检验当前追随策略究竟在哪类状态失效。不要直接搬低成交量 0.6、偏离 0.001 等常数。
3. 现货/TWAP 差值：检验差值是否能在控制剩余时间、PM 当前价、价差、波动率后，提供额外的未来信息。差值可能是平滑窗口效应、基差或时钟问题，不一定能成交获利。

入场对照先保持相同退出规则；退出对照使用相同实际入场样本。统计每轮净收益、总净收益、交易数、费用、最大回撤、漏掉的机会与结算回收，不只看胜率或每笔收益。按时间顺序训练/验证/最终保留样本，以轮次或日期作为统计块，不把同轮秒级样本当独立交易。

### 第三步：研究真正的结算价值与持有价值

持有到结算的核心对象是“在当前盘口真实规则下，结算 TWAP 相对开盘基准的结果概率”，输入应包含准确基准、TWAP 路径、剩余时间、未来进入和离开平滑窗口的影响、波动率及现货动态。

对每份到期支付 $1 的合约，买入并持有结算的期望净收益为校准后的胜率减去实际买入成本和费用。已有仓位则比较未来持有价值与现在可卖出的净收入；已支付的买入成本应记录于盈亏，但不是继续持有与卖出的新增现金流。若目标是在结算前多次交易，必须单独预测可执行买一价及退出收益分布，不能用结算胜率直接代替短期转售收益。

使用 Brier score、可靠性分桶和按时间留出的净收益检验来评估概率；成本模型必须按金额、深度、费用与执行延迟计算。只有在这些检验中出现稳定增量，才考虑把新特征用于实际模拟的持有/退出判断。保持不以固定 $0.5/$2 盈亏作为退出依据，也不把 BTC 支持信号直接做成永远阻止盘口退出的否决项。

RSI/MACD/Heiken Ashi 的优先级低于上述三步：可作为消融实验中的候选特征，但该仓库没有证明它们能提供独立增益。

## 6. 交付结论

采用其“多源观察、解释性特征、时段和市场状态分组”的研究思路；不移植其伪概率、时间衰减、归一化价格优势、开盘锁定或回退处理。当前自动模拟策略保持原样。本次交付是完整 main 审查及下一步研究设计，没有把语法通过、公式复现或受欢迎程度当作盈利验证。

源码：[主流程](https://github.com/FrondEnt/PolymarketBTC15mAssistant/blob/5955967a594a1498e85da2d627d1f41b27af50f8/src/index.js)、[概率打分](https://github.com/FrondEnt/PolymarketBTC15mAssistant/blob/5955967a594a1498e85da2d627d1f41b27af50f8/src/engines/probability.js)、[建议门槛](https://github.com/FrondEnt/PolymarketBTC15mAssistant/blob/5955967a594a1498e85da2d627d1f41b27af50f8/src/engines/edge.js)、[行情摘要](https://github.com/FrondEnt/PolymarketBTC15mAssistant/blob/5955967a594a1498e85da2d627d1f41b27af50f8/src/data/polymarket.js)。

当前接口语义：[Polymarket RTDS](https://docs.polymarket.com/market-data/realtime-data)、[Chainlink TWAP 与时间戳](https://docs.polymarket.com/market-data/chainlink-twap)。
