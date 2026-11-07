# BTC 5 分钟订单闭环验证

这一版完成的是工程验证：识别当前盘口 → 读取盘口及 Chainlink 60 秒 TWAP → 本地模拟挂单 → 等待 → 撤单并核对成交 → 只吃剩余数量 → 卖出与对账。

没有钱包、私钥、签名或真实下单入口。无需安装 CloddsBot 的其他依赖。需要 Node.js 24；本机启动脚本也支持使用 Codex 已提供的 Node.js。

## 使用

在本目录打开 PowerShell：

```powershell
# 离线演示：包含挂单部分成交、撤单、吃余量、部分卖出、清仓
.\start.ps1 -Mode demo

# 运行故障场景与记账测试
.\start.ps1 -Mode test

# 观察真实行情六分钟；不产生模拟订单
.\start.ps1 -Mode observe -Seconds 360

# 真实行情驱动本地模拟执行；仍然不会真实下单
.\start.ps1 -Mode paper -Seconds 360

# 从已记录行情重放，不连接网络
.\start.ps1 -Mode replay -InputFile '完整路径\events.jsonl'
```

也可以在仓库根目录使用 `npm run btc5m:test`、`npm run btc5m:demo`、`npm run btc5m:observe`、`npm run btc5m:paper`。无需先执行 `npm install`。直接调用 Node：`node btc5m-lab/run.mjs observe --seconds 360 --paper`。

每次运行在 `sessions/时间-模式/` 生成：

- `报告.md`：本次结果、数据缺口、模拟费用和残余持仓。
- `summary.json`：可自动核对的汇总。
- `events.jsonl`：原始市场参数、盘口、TWAP、模拟请求及累计成交回报。

运行会在指定时长后结束。Ctrl+C 会请求停止，并撤销当前模拟挂单；不会把未卖出的份额假装清零。若停止时存在持仓，它会保留在报告中。不同运行的模拟账户相互独立，不会自动承接旧持仓。

## 与原仓库的关系

基于 CloddsBot `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8`。沿用原项目按五分钟时间槽发现市场、区分 Maker/Taker、配置超时和仓位约束的设计。当前成果位于独立的 `btc5m-lab/`，仓库 `package.json` 增加了四个入口。

**原 `src/strategies/crypto-hft` 和通用交易执行服务尚未被替换，也不能视为已修复或已通过实盘验证。** 独立入口让当前阶段能在没有整套多平台依赖的情况下验证关键行为。后续应把通过验证的生命周期接入官方交易 SDK，再替换旧模块，而不是直接启用旧 `/crypto-hft` 实盘命令。

## 已实现的关键行为

| 场景 | 处理 |
|---|---|
| 盘口识别 | 使用 Gamma 的 `conditionId`、`clobTokenIds`、`outcomes`、`endDate`；与 CLOB token 映射交叉检查 |
| 轮次验证 | 必须是当前 `btc-updown-5m-时间戳`，结束时间必须吻合五分钟窗口 |
| 交易参数 | 从目标 CLOB 市场读取 tick、最小份额、费用系数及指数，不使用旧费用常数 |
| 买入确认 | 提交成功不等于成交；按累计成交的增量更新持仓及现金 |
| Maker | GTC + post-only；等待配置超时 |
| 撤单与替换 | 撤单后读取最终状态及累计成交，再计算剩余数量 |
| Taker | 带限价的 FAK；FOK 模式允许独立验证全成或取消 |
| 不确定结果 | 下单超时或撤单未确认会暂停；不自动重复提交 |
| 卖出部分成交 | 只扣实际成交份额，剩余库存继续显示 |
| 数据断流或换轮 | 停止开仓，撤销当前挂单；不向过期盘口发送替换单 |
| 重复事件 | 同一意图不重复提交，累计成交回报不会重复记账 |
| 风控 | 单一在途意图；模拟最坏损失预算 10；平仓后会话亏损达到 2 时停止买入 |

## 模拟假设与边界

**策略只是执行练习。** 每轮在时间与行情允许时，用市场最小订单量做一次 Up 买入，再尝试卖出。没有预测模型，不代表建议买 Up，不把模拟现金变化当作盈利能力证据。

真实行情采用每秒 REST 盘口快照；参考价格采用 RTDS `crypto_prices_twap_sixty`，保留 Chainlink E18 原始精度与观察时间。参考价只用于数据完整性检查，没有自行重建结算 TWAP、基准价或输赢。发现不认识的结算源时停止该轮处理。

真实行情模拟保守地将 Maker 成交记为零：REST 快照不能证明排队位置或真实成交。挂单等到超时，模拟撤销，再用当时可见深度估算 FAK 成交。离线演示则使用明确的合成成交事件，并先扣除同价位排队量；不能把“碰到挂单价”当作成交。

费用使用该市场的 `rate × size × [price × (1-price)]^exponent`，金额保留八位小数用于对账。这是模拟估算，尚未实现交易所最终收费舍入、净到账份额、链上失败重试和结算费用的逐笔复核。

剩余买入量不足最小订单量时，取消该剩余意图，不会为了凑最小量扩大买入。卖出后的小额残余份额继续显示。市场到期后没有最终结果时不自行结算。

状态日志供审计和回放；缺少真实账户重启恢复、签名认证、真实账户持仓对账及赎回。实盘上线前必须完成这些工作。没有运行完整 CloddsBot 构建或全仓库测试；本入口无第三方依赖，拥有独立测试。

## 实盘接入前的下一个验收门槛

1. 用官方 SDK 实现受限的交易适配层，统一订单状态、精度单位、实际成交均价和净份额。
2. 结合用户成交流与 REST 查询核对订单；处理成交失败、延迟和撤单竞争。
3. 持久化未完成订单及风险预留；启动时先与账户对账，完成前禁止新开仓。
4. 配置用户自己的单笔、总仓位及亏损限额，完成小额挂单/撤单/成交验证。
5. 补齐最终结算、赎回，再评估策略收益。

## 官方接口参考

- [Gamma 按 slug 查市场](https://docs.polymarket.com/api-reference/markets/get-market-by-slug)
- [CLOB 市场参数](https://docs.polymarket.com/api-reference/markets/get-clob-market-info)
- [Chainlink TWAP](https://docs.polymarket.com/market-data/chainlink-twap)
- [交易费用](https://docs.polymarket.com/trading/fees)
- [订单管理](https://docs.polymarket.com/trading/manage-orders)

实时读取仅涉及 `gamma-api.polymarket.com`、`clob.polymarket.com` 的公开 GET，以及 `ws-live-data.polymarket.com` 的公开订阅。
# 本地可视化入口

现已提供独立网页控制台。双击工作空间根目录的「打开BTC控制台.cmd」，访问 http://127.0.0.1:18790 。支持实时行情、订单与持仓、日志、模拟挂单/吃单、暂停、撤单及运行参数。详细用法见工作空间根目录的「BTC控制台使用说明.md」。
