# 单笔净值风险口径只读审查

审查范围为当前Ray v4与现有持久化/界面约束；没有修改生产源码、API、服务、账户、资金或原注册。下列定位是在修改前源码上观察，root正在实施的新版本可能改变行号。

## 直接结论

只把25美元调高并不满足“取消固定总成本上限”。真正拦单发生在`lifecycle.mjs:78`：inventory acquisition cost + original maxSpend > maxExposure；当前现金/净值1003.31777322、2.5%预算向下取美分为25.08，被25拒绝。现金检查、未核实持仓/待结算净值检查、部分成交核对、执行串行化仍应保留。

现有100份单次/每轮约束会在预算不变时缩小请求份额，可能把深度充足的完整订单缩成低于2.5%的实际仓位，且`quote.complete=true`。这与FAK在价格/深度约束下自然部分成交是两件事。

按现有市场费率rate=0.07、exponent=1，tick=.01、minSize=5，卖一=.80且深度100000的纯计算结果：

| 净值 | 已用轮份额 | 含费maxSpend | 实际请求份额 | 深度足够的成本 | 成本/净值 | 当前complete |
|---:|---:|---:|---:|---:|---:|---|
| 1003.31777322 | 0 | 25.08 | 30.91 | 25.07419 | 2.49913% | true |
| 1003.31777322 | 90 | 25.08 | 10 | 8.112 | 0.80852% | true |
| 5000 | 0 | 125 | 100 | 81.12 | 1.62240% | true |

该计算未下订单，未模拟修改主账户。第一行极小差额来自美分本金/份额向下舍入和费用预留，属于金额上限语义；后两行大幅缩小来自人为份额cap。

## 与root确认的修复方案

用户没有明确取消每轮100份。因此保留既有份额保护，先按完整百分比预算调用`oneTapQuote`、不传份额截断；再检查完整请求是否超过配置单次份额/100份/本轮剩余份额。超过就整单等待，不能再次quote缩份额或缩预算去塞剩余额度。将计划maxSpend、完整requestedShares、单次cap与剩余cap一并保留在失败判断中。

FAK仍可因可执行深度、保护价格和费用上限而部分成交。实际成交成本不应被硬凑到2.5%，也不能以最少2.5%为理由二次追单或提高到10%。强度收益映射未验证时，自动比例继续2.5%，必须明确这是有效范围的基线，尚无已认证加码。

这一方案的实际影响需要披露：净值5000美元、0.80价格附近，2.5%完整请求约154份，超过100份时不交易。取消固定美元总成本限制不等于移除所有其他准入条件；保留份额上限意味着大净值账户可能长期等待。更改此限制应另有明确授权。

## 修改点与兼容关系

| 位置 | 修改前行为 | 要求 |
|---|---|---|
| `lifecycle.mjs:18,65–80` | 默认maxExposure10，正数固定总成本+新单预算拒绝；有外部资金才验证现金 | 支持显式禁用总成本的有限JSON可持久化值；保留买单pendingCost有限/非负、现金和原maxLoss逻辑。新增风险口径应确保当前Ray即使异常externalFunds也不获得未注资信用 |
| `dashboard/controller.mjs:42–45,332–338` | maxExposure bounds1–1000，只校验数字 | 如采用0表示禁用则bounds需允许0；不使用Infinity（JSON会变null）。如新增字符串riskMode，显式校验而非一律Number |
| `controller.mjs:110–137` | auto beforeSubmit重算；manual/非strategyManaged直接true | 手动One-Tap与auto都应在提交前复核新鲜可信净值、2.5%–10%预算、现金及价格；不能只依赖最初place校验。避免evaluate(now,request.size)再次截断Ray完整请求 |
| `controller.mjs:139–210,300–313` | 保存恢复config、全部rayowner和roundfills；旧版本allowlist v2/v3/v4 | 新风险/协议版本要被恢复允许，旧owner按原entry版本继续验证/退出。保存风险模式及分配证据，不重置现金、history、roundfills或session |
| `controller.mjs:624–666` | roundfills硬<=100并追溯每个lot；summary最大100 | 保留100份ledger强校验与记账（本方案没有取消份额保护）；fullrequest不够剩余额度时只等待。不得卖出后返还累计配额 |
| `controller.mjs:951–957` | manual One-Tap仅首次按净值范围检查 | 调用共同预算校验，提交时再确认；手动持仓自动退出与统计分离不变 |
| `controller.mjs:1095–1102,1125–1141` | config更新engine.maxExposure；align/replace保留或抬到25 | 新版本显式迁移到已授权的禁用总成本模式，后续align/replace不能悄悄恢复25。新experiment/profile清楚记录风险版本 |
| `dashboard/ray-onetap-sizing.mjs:13–30` | maxShares=min(config,100,remaining)传quote主动缩份额 | 完整百分比quote后才校验份额限制，拒绝不截断。distinct reasonCodes分别解释单次/本轮cap及真正最低请求不足 |
| `one-tap-order.mjs:54–85` | 已支持maxShares=Infinity；maxSpend本金分开，2dp份额，5dp费用；complete按size或本金 | 不必删除通用maxShares能力或改变旧研究；Ray调用时不传truncate。保留金额上限及真实逐档FAK部分成交语义 |
| `dashboard/p0-audit.mjs:47` | exposureBudget永远比较config.maxExposure | 禁用模式不能记录成假“成本预算失败”；当前supportedStrategy=false虽不控制Ray也须避免误报 |
| `dashboard/ray-runtime-check.mjs:54,76–80,146,159,290–309` | 注册必须maxExposure25、size100、总成本<=cap；amount sizing版本v1/100remaining/2.5基线 | 新风险版本独立注册并按版本验证；旧lot限制仍保留，当前总成本禁用检查改为预算上下限/可用现金证据。不能重写旧注册以消除历史失败 |
| `dashboard/server.mjs:18` | 默认指向10/18 calendar注册 | 新source closure采用新不可变注册/正确active路径，保留父注册、测试和原因；否则每次health会degraded |
| `归档目录/Trade/service/service-config.json`, `supervisor.mjs` | 只固定Node、server、dataDirectory、port，supervisor通过recover intent恢复 | 此层没有另一个25美元/100份配置；风险从runtime/state.json恢复。代码编辑不等于worker已加载，需一次受控重启并确认runIntent/新PID/协议/财务身份 |

## 界面需同步

- `dashboard/app.mjs:92,213`、`index.html:37,102,107,108`：移除“总持仓成本预算仍独立生效”；保留100份限制但改为完整请求超限整单等待。明确计划预算与实际FAK成本不同。
- `ray-entry-panel.mjs:36–37`：禁用总成本模式不再显示“预算高于$0上限，必被拒绝”；改为不设置固定总成本上限，仍检查现金和可信净值。份额余量仍显示。
- `app.mjs:403–409`：设置窗逐键直接访问form.elements并Number转换。删除输入或新增字符串风险模式时必须改字段白名单，否则打开设置会undefined异常，保存NaN/null。
- 手动`buy-units`及预设编辑HTML max=1000会在大净值时成为另一个固定单笔金额上限；Ray One-Tap本身没有该1000限制。可按可信净值10%动态设max，旧模型amount入口的1–1000整数限制独立保留。
- 配置`size`目前本来允许1–1000但Ray另取100，因此界面应称完整请求的份额保护，不能称自动入场目标仓位。

推荐一句核心文案：“每笔计划含费最高支出按可核实净值2.5%–10%；当前自动比例2.5%。不设固定美元总持仓成本上限。完整请求超过单次或本轮剩余份额限制时等待，不缩单；FAK部分成交和价格保护可能使实际成本低于计划，可用现金及净值核验仍生效。”

## 本次只读证据

持久化快照观察：mode=auto；config.maxExposure25、size100、maxLoss0；cash1003.31777322、累计fees0.41238179、8历史订单、0持有token，rayAlignmentVersion=ray-twap-calendar-onetap-v4。这些是审查时快照，不代表部署后的当前状态。

以上建议是实现与账务口径审查，没有对收益、信号可靠性或未来风险分布作认证。
