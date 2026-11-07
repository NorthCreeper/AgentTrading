# 旧固定审计与新 Ray 独立验证的最小迁移方案

2026-10-18，只读建议；没有修改旧 auditor、注册、pin、status 或历史失败证据。

## 触发原因与禁止误用的维护路径

旧入口：

`归档目录/Trade\CloddsBot-review\CloddsBot-715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8\btc5m-lab\research\strategy-continuation-20261002\automatic-evidence.mjs`

- `sourceHashes():79–84` 固定 13 个源文件哈希；`loadAuditRegistration:86–92` 与 `refreshEvidence:249–250` 严格比较，任一源改变便拒绝更新。
- 当前 active pin：`automatic-audit/active-registration.json` → `归档目录/TradeResearch\btc5m-repair-20261015\automatic-audit\final-registration\audit-registration-1792025263742.json`，SHA256 `d9c10ae2b5af035cd88d6c709bb5de3c2987612ff8b13ca026db896bf1b30624`。
- 本次对比 13 源仅发现 `dashboard/managed-position-accounting.mjs` 不同：旧 `4f14d7435dbeccc0876199a9cc0246566a2279af935fe76cfe693b83321d9da1`，当时新值 `6cc3765cec875055ee487d52f344fa7c4292c94a1802d747760daa1513713ebb`。此新值仍须等最终源码停止改动再登记。
- 旧 `registerAuditMaintenance:122–125` 白名单**不允许改 managed-position-accounting.mjs**，且登记声明 `tradingRulesChanged:false`（139 行）。这次是用户授权的新 Ray 数量/多仓策略，不能扩旧白名单、改登记哈希或伪称只是保持原交易规则的技术维护。
- 旧状态保留 `Registered diagnostic audit sources changed`、最后成功时刻、fullHistory 的 2 项 blocked、最后好的 forwardSegment。它们不属于此次新版本的失败样本，也不能因新版本测试通过而消失。
- 旧 auditor 非 once 模式在错误后仍按 5 分钟循环（352–358 行）；应说“诊断更新因源登记不匹配停止”，不能仅凭 status 断言进程已退出。

## 最小新增范围

新建**独立目录**，不复用旧输出：

`归档目录/TradeResearch\btc5m-folder-alignment-20261018\ray-audit\`

建议产物：

- `migration.json`：写明用户授权策略对齐、旧审计不是被修成通过；引用并固定旧 active pin、实际 registration、当时 status、最后好的 evidence 与 2 项 blocked evidence 的完整路径和 SHA256。保留旧结果范围与旧 registrationId。
- `registration-<timestamp>.json`：新 protocol，例如 `ray-equity-readonly-audit-v1`，限定 `ray-twap-band-equity-v2`、只读 endpoints（state/strategy-trades）、不请求 bootstrap/controls、不下单、不入金、不改原研究门槛。记录注册时间、部署事件与新实验 ID，未来片段以此边界区分，不按结果挑样本。
- `sources/` 与 `source-manifest.json`：在实现稳定后固定新 auditor 自身与 Ray strategy/sizing/controller/managed accounting/lifecycle/broker/官方结算验真及必要展示源闭包。保留源副本；后续 hash 变化令新验证变为未匹配，不能读旧 green 当当前验证。
- `audit.mjs`：独立 GET-only 当前状态/订单/策略交易核对；不导入运行 controller，不启动 reference 程序。捕获一致 cutoff 的快照与日志固定字节前缀及 hash，不写旧目录。
- `latest.json`/`status.json`：只记录新协议实际检验结果、源 hash、snapshot/cutoff/registration 身份、checkedAt、覆盖范围、失败和 unknown。没有完整成交不能声称已验证盈利；一次性检查 completed 与持续监测 healthy 分开。

新核对至少覆盖：所有 owner 的报告份额/费用/成本与库存一致、反向分别归属、订单/结算无重复、现金守恒与资金流分开、roundFills 含反向累计且 <=100、成功批次与尝试批次分开、未知净值不下单、保留 $25 总预算、旧实验/v1结果不混入新版统计。可以整体核对账户现金守恒，但不能据此把旧 P3 历史 2 项错误重判为通过。

## Health 的准确表达

当前读取位置：`dashboard/server.mjs:66`，聚合在 `dashboard/service-health.mjs`。

1. `automaticAudit` 继续返回旧 status、reportedStatus、lastSuccessAt、stale、fullHistory blocked 和 forwardSegment 原范围。可以在 health 响应加仅供说明的 migration 引用；**不写回旧 status**，不让迁移标记覆写 reportedStatus。
2. 新增并列 `rayAudit` 字段，分别给 registration/source 身份是否匹配、实际已验证时间/cutoff、新协议/实验、结果范围、一次性或持续状态、错误/未知及 stale；未完成则显示 not-yet-validated。
3. 主服务 alive/running、行情新鲜、旧研究诊断停止、新 Ray 当前账本验证是不同状态。主服务正常不代表旧研究通过，新 Ray 验证通过也不代表旧全历史验证通过。
4. 只有新 manifest 与当前源一致、registration/protocol/实验绑定正确且结果时效满足所声明的持续监测周期，才可显示新 Ray 当前验证可用；否则明确 mismatch/stale/unavailable。

这比改旧 auditor 的源 hash 白名单更小、更容易核查，也不会洗掉旧失败记录。
