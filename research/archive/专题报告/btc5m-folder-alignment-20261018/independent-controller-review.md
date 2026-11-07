# 多次入场与界面独立复审

2026-10-18。只读审查其他负责人正在修改的 controller/UI；未修改其源文件，也未操作现有账户或服务。

## 已发现并沟通的问题

1. **成交批次把失败尝试算入。** 初版 `ray-entry-panel.mjs:23` 用 `entryLots.length` 显示成交次数，但 controller 在提交前添加 lot，失败尝试也留存。已通知主负责人；复读源码确认已改为 `entryLots.filter(l=>l.filled>0).length`。
2. **跨实验继续加仓会将新批次归到旧实验。** align/replace 可保留现有 v2 owner，却清空 experiment；autoRayEntry 原先仅按 token 复用 owner，新增 lot 随旧 owner.experimentId 入账。已通知 controller 负责人；复读确认 `controller.mjs:792–794` 已在存在跨实验或版本 owner 时禁止新增批次，旧 owner 仍按原归属管理至结算。
3. **零成交但尚有执行中订单的 owner 恢复。** 初版 initialize 无条件要求所有 rayOwnedPositions 有非空 managedCashflows；尚未成交但持有 uncertain active intent 的 owner 会在核对撤单前恢复失败。已通知；复读确认 `controller.mjs:143–147` 只对 active intent/lot/id 完整绑定、零持仓且 openedAt=null 的情况作狭窄恢复许可，仍需其集成测试证明恢复后取消/核对，不是一般放宽未知仓位。

## 阅读确认的约束

- `ownedTrades()` 汇总 legacy active、Ray 多仓与 pending 队列；同 token 由一个 owner 合并，同轮反向 token 可独立持有。
- 成交报告按 order.id 覆盖累计值，费用和份额来自 owner 自己的报告，不以全账户现金差归因；lot 另存 intent 关联。未发现由同方向多单天然造成重复扣费的路径。
- `rayRoundFills` 记录每轮每个 buy order 的累计填量，含反向，保存到 state；启动时与 broker.orders、token/slug、100 份总量核对。不是重启清零的内存计数。
- 每个 owner 按原市场身份核对官方结果结算；`paper-settlement:<trade.id>` 去重，现金/库存变更后同步平仓。未发现同轮反向持仓共用一个结果金额的旧目录错误。
- 未知、无归属、成本矛盾、过期未核实估值或缺少本轮新鲜中间价的持仓令 Ray 净值未知；没有回退本金或假设兑付。
- `alignRayFolder` 保留原 config.maxExposure，并以协议版本作重复调用标记；停止状态下重复调用不会清空实验或再次变更参数。运行中先触发“先停止”的前置条件，不宣称运行时重复请求一定返回 duplicate。
- `Lifecycle.start:59–75` 按全部库存成本（含待结算）加新单保守含费预留校验原总曝险；不是把份额上限 100 当作放宽 $25 的授权。

以上为源码审查，控制器负责人仍在完成集成回归。不能仅据本报告宣称全部运行测试通过。
