# 桌面参考工作流对齐设计评审

日期：2026-10-18，香港时间。初始阶段为只读评审；下方另列后续获得实施授权后的变更与隔离验证。全程未调用生产运行、交易、充值、重置或重启接口。本文前述比较行号以修改前源文件为准。

## 结论

应对齐参考目录实际执行的 Ray 信号、2.5% 含费权益预算、整份额、每轮累计上限 100 份及多次 FOK 入场语义；继续使用当前独立托管、严格源时间校验、可靠账务和官方结果核实结算。参考目录的 300 秒开盘替代、失效 TWAP 继续参与信号、换轮按价格方向兑现旧仓、共享账本多写者，不应复制为策略要求。

当前账户约 $103.32，按参考预算只有约 $2.58，在 80–85¢ 区间只能算出 3 份，低于最小 5 份。因此正确对齐后的正常结果是继续记录行情与判断、拒绝此类入场；不能为了维持成交而充值、重置、向上凑 5 份或恢复固定 25 份。

## 实际差异及准确依据

参考根：`归档用户目录\Desktop\polymarket-btc-5m`。

当前实验室根：`归档目录/Trade\CloddsBot-review\CloddsBot-715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8\btc5m-lab`。

| 项目 | 参考实际执行 | 当前执行 | 建议 |
|---|---|---|---|
| 信号方向、时段、价格 | `paper_bot/signal_ray.py:48-53,231-330`；最后 120 秒、40/60/80 美元偏离、80–85¢ 与另一边≤20¢ | `dashboard/ray-strategy.mjs:4-39` 相同 | 保持 |
| 每笔数量 | `paper_bot/sizing.py:26-28,70-163` 按权益 2.5% / (ask+fee) 向下取整，再限深度、max_size，最低 5 份；`dashboard.py:834-856`、`paper_bot/main.py:320-343`实际传权益 | `dashboard/ray-strategy.mjs:37-39` 固定最多 25 份，允许小数 | 改为 2.5% 含费、整数份额，并详细记录 sizing |
| 每笔/每轮上限 | `paper_bot/signal_late_directional.py:40` HARD_SIZE_CAP=100；`dashboard.py:130,143`、`paper_bot/main.py:819-835` 实际默认 100 | `dashboard/ray-strategy.mjs:5` 为25 | 改为100；注意参考CLI帮助文字仍写25，是过时说明 |
| 同轮重复入场 | `paper_bot/paper_broker.py:223-269,333-334` 仅按累计已成交 shares 消耗 room；没有首笔成交即锁轮 | `dashboard/controller.mjs:639,688-690,703` Ray 持仓返回，成功后 attempted 锁轮 | 增加按真实成交消耗的剩余额度，后续5秒格可重试/补单 |
| 第二笔持仓门槛 | 参考 `dashboard.py:834-860` 每次轮询仍评估、调用 broker；`paper_account.py:346-398` 只检查重复 trade_id、金额、现金，没有已有持仓门槛 | 当前 `managedInventory.entryBlocked` 遇 active trade=true，`controller.mjs:583,689` 阻止再买 | 有管理、有账务的 Ray 同轮持仓不应一概阻止 Ray 后续单；未知、冲突和手动持仓仍阻止 |
| 同轮反方向 | 参考没有方向锁，后续信号可买另一 token | 当前整个轮次首笔后锁定 | 如需完整兼容，两个结果必须分别管理；不应覆盖原 owner |
| 最小订单 | 参考 evaluator先检查≥5；但 broker 按 room 截断后只检查≥1 (`paper_broker.py:269-271`) | 当前以市场 minSize 检查 | room 截断后再检查 max(5,市场minSize)，不可复制尾余量1–4份漏洞 |
| 开盘 | `twap_feed.py:38-45,238-261,311-327` 支持 TWAP 代现货及±300秒/接收时间降级 | `dashboard/ray-strategy.mjs:10-13` 与 `ray-opening.mjs:8-14` 严格实际现货±2.5秒或官方PTB | 保留当前；不得把轮中价改名为开盘价 |
| TWAP新鲜度 | `signal_late_directional.py:142-170` 把age带入hint，但 `signal_ray.py` 没有age拒绝；`twap_feed.py:164-165` 极陈旧源时间还可能改用接收年龄 | 当前 `ray-strategy.mjs:24` 同时检查源时间/接收时间≤5秒、window=60 | 保留当前；记录缺测，而不是把陈旧数据视为可交易 |
| 盘口 | 参考Ray仅要求ask存在、无error；dashboard可WS/REST回退 (`dashboard.py:768-777`)，CLI HTTP入库时间也不是源时间 | 当前双边新鲜、有bid/ask且不交叉，metadata/tick已知 | 保留当前源约束；只允许语义一致、带来源/时间的REST回退 |
| 费用 | `paper_bot/fees.py:10-24` 固定0.07、exponent1 | 当前按市场fee metadata计算 | 保留市场费用；当市场参数恰为0.07/1时算术应相等 |
| 结算 | `paper_bot/main.py:254-266`、`dashboard.py:786-796` 用prior TWAP方向；`paper_account.py:521-542` 对所有非当前轮旧仓套同一方向 | 当前 `controller.mjs:773-792` + `managed-position-accounting.mjs:55-83` 核实每轮身份、官方payout、只兑付一次 | 保留当前；参考历史账本收益不能直接视为官方可兑付收益 |
| 权益标记 | `paper_account.py:138-139` cash+mid mark，更新mark发生在本次sizing之后 (`dashboard.py:854,879-885`) | 当前账户净值是扣费可卖价值/官方结算，未知有明确范围 | 不要用新轮报价给旧token估值；应显式标记 sizing equity口径与reference差异 |
| 托管/账本 | 参考CLI和dashboard均可各自打开同一logs/paper_account.json，锁只在各进程内 | 当前单独托管单写者并持久化session/订单/仓位 | 保持当前，不能启动第二份可交易进程共享同一账本 |

多次填充已有账本实证：参考 `logs/paper_ledger.jsonl` 中 45 条 Ray buy，`btc-updown-5m-1792057500` 有两条 Down buy，合计25份，trade_id 为 `归档标识-010`、`归档标识-011`。历史25份cap与当前默认100份cap应分版本，不能合并成同一规则的胜率。

## 最小兼容实现

1. 新增纯函数 sizing，输入当时已知权益、ask、实际费用、最优卖价深度、每单cap、同轮真实成交累计；输出 pct、budget、costPerShare、rawShares、depth、remainingRoundShares、finalShares、minSize、clamps、ok、reason。计算每步均检查有限非负数；最终取整后再检查最小份额，不上凑。
2. `controller.evaluate()` (`controller.mjs:556-561`) 当前没给 evaluator 传账户权益/轮累计。新增明确 accountContext；不在 evaluator 中读实时文件或修改账户。对未知权益返回 `sizing_equity_unknown`，预算不足返回 `size_below_min`。与TWAP偏离不达标、盘口缺失分别统计。
3. 新版本 `rayProtocol` 应清楚登记2.5%、100份、整份额、多次FOK、source/settlement约束，旧 `ray-twap-band-v1` 成交、旧实验、旧持仓参数保留。不要覆盖旧交易中的version/parameters。
4. 同轮额度按实际 filled report 汇总；不能按requested size消耗，也不能以当前持仓余量替代累计买入（卖出不能恢复quota）。失败/取消/零填充不消耗；重启后从持久化有效report恢复，重复report不重复消耗。跨方向合计使用同一个round quota。
5. 在每次FOK下发前重新计算，包含当前费用、cash/exposure、round room、最小份额、时间、盘口；`controller.mjs:108-112` 已有beforeSubmit检查，须同时保证新intent没有越过最新sizing/额度。沿用lifecycle的先核实填充再改变现金/库存与去重。
6. `maxExposure=$25` 可作为当前额外保护保留，且新单含费成本+所有未兑付仓位成本都计入。它可能比参考100份cap先触发，UI/报告必须说明此差异。不能因复制参考参数自动扩大资金或风险预算。

### 多笔持仓不能直接新增同token的owner

当前 `controller.mjs:139-141` 禁止owned token重复；`managed-position-accounting.mjs:94-138` 要求每个token恰好1个owner并且flow.remaining匹配engine整个token库存；`controller.mjs:715-720,778-786` 同样按整个token库存同步/兑付。若每次FOK另造trade塞进pending，就会恢复失败、所有权冲突或重复兑付。

较小可行结构是每个round+token维持1个持仓owner，同方向补单累加该owner的buy `orderReports`；另存 `entryLots`/attempt日志记每次的信号、预算、份额和实际填充。另一结果token作为另一个owner。采用 `rayPositions` 这样的明确活动持仓集合，并让 ownedTrades、managedInventory、save/restore、到期入队、结算、订单报告归属、快照及账户估值遍历它。原 strategyTrade继续管理旧策略/手动仓位，避免把手动持仓也自动加仓。

到期时把各Ray owner移入现有pendingSettlements，继续按官方label逐token兑付。管理中的未到期Ray持仓不可伪装成“已到期结算等待”，因为当前managedInventory对pending要求expired，queue统计/健康检查也依赖此语义。`event()` (`controller.mjs:210-222`) 本来已按token找owner，扩展ownedTrades后可复用，但审计事件的tradeId/experimentId (`226-227`) 也应归正确owner。

聚合owner的完整交易数与参考逐fill交易数不同：应同时公开“FOK成交笔数、成交轮次、已结束方向持仓数”，逐entry lot的盈亏可以按该笔含费现金流和官方payout单独计算，不能把4个fills伪称4轮独立策略机会。当前累计历史收益与旧实验保持原样。

## 权益口径与当前资金的可预见行为

严格复制参考的mid权益时，只能用当时当前token的新鲜mid；所有持仓都必须能正确估值。过期待核实仓位缺值则不能拿本金、0或本轮Up/Down报价填充。当前保守扣费可卖净值可以作为安全兼容实现的权益来源，但应公开这是保留的额外保护，与参考mid口径不完全一致，记录用于 sizing 的实际value/knownAt/source。空仓时两者都等于cash。

空仓 $103.31777322 ×0.025=$2.5829443305。费率0.07、exponent1的示例中：

- 80¢：单份含费0.8112，预算向下取整得到3份；5份最低对应权益$162.24。
- 85¢：单份含费0.858925，向下取整仍3份；5份最低对应权益$171.785。

因此当前账户在整个80–85¢带内都会因预算不足跳过，是预期行为。这里只说明这组已记录费用参数的算术，不宣称其他未来盘口费用不变。

## UI调整

- `dashboard/app.mjs:90,206`、`dashboard/index.html:107` 固定25份/每轮一次描述，改为“按可核实净值2.5%含费预算、向下取整、最少5份、每轮累计100份；另受总持仓成本预算约束”。
- 策略候选显示预算、原始/最终份额、当轮已成交/剩余额度、为何缩小/跳过；不把size_below_min显示成行情不满足。
- 运行参数明确每单上限/每轮累计上限/总账户成本预算的不同含义，避免手动OneTap金额被误以为自动预算；手动原管理退出不变。
- 账户/实验面板区分entry fill数、独立round数与聚合持仓闭环数，呈现所有活动Ray方向和待结算仓位。
- 开盘参考、缺测、结算等待、官方label异常照原样展示；不能为了“全绿”隐藏source failure或改变历史证据。

## 最低必要测试

1. 固定离线样例与参考 `compute_equity_size` 在同费用下逐项对照：整份额、depth、cap、min5、2.5%、NaN/Infinity/未知。
2. $103.31777322在80/85¢均3份并拒绝，cash/session/history完全不变。
3. 同轮连续5秒格可多次买入，sum(actual fills)≤100；中间失败不耗额，同一格不能多次提交。
4. 最后一段room=1–4不下单；room=5且depth足够才允许；两方向共享quota。
5. 同token补单的唯一owner与累计orderReports/库存成本一致；另一方向owner互不串账。
6. 同方向、双方向、还有旧轮待结算的混合情景，保存/重启后额度、现金、费用、持仓、实验统计不变。
7. 官方结果只兑付一次，重复label/report/restart不重复加钱；未知/错轮/未来label不得入账。
8. 新规则不更改已在持仓的旧版本/manual退出政策；手动和自动entry统计继续分开。
9. 当前开盘±2.5秒、缺开盘、陈旧TWAP/盘口、错轮、校时未就绪测试全部保持；不要通过修改期望来接受参考缺陷。
10. 源异常/日志写盘失败/未知提交状态仍停开仓并保留证据；启动/停止/暂停/恢复与后台独立运行回归。
11. UI说明、配置显示、真实拒绝原因与服务端一致；无自动充值、账户重置、实盘入口变更。
12. 原 `ray-strategy.test.mjs:66-74` “成功不能scale in”只对旧版本保留，新增版本测试验证后续格按quota多填充，且不要重写旧历史样例的版本。

## 验收边界

可以验收为“参考规则已对齐，账务和源保护已保留”，不能称“逐字复制了参考目录”或“参考盈利已迁移”。参考账本使用模拟方向结算且可能多进程并发写，历史净收益必须另按官方结果/完整cashflows验证后才能比较。部署前后保存账户与持仓指纹、日志连续性、协议版本及可回滚代码；当前账户不足最小订单的空仓运行也属于有效验收结果。

## 后续实施与隔离验证结果

依父任务授权，已完成当前独立托管代码中的控制器与所有权部分；实际部署、运行状态操作由父任务统一执行。

- 修改 `dashboard/controller.mjs`、`dashboard/managed-position-accounting.mjs`，新增 `dashboard/ray-alignment-controller.test.mjs`；`dashboard/ray-strategy.test.mjs` 只适配控制器集成用例（纯策略与数量函数由另一子任务实现）。
- `rayOwnedPositions` 每个token唯一owner；同方向多个FOK合并cashflows，每次 `entryLots` 保留signal、sizing、requested/filled及原始reports，反方向token有独立owner。
- `rayRoundFills` 记录实际累计buy reports，重复报告替换累计值；保存与恢复校验实际broker orders、当前持仓与已结束交易证据；`rayDecisionSlot` 同样持久化。
- 官方结算、成本/份额所有权一致性、原maxExposure、手动管理政策继续有效。手动卖出仅减少匹配owner，不增加当轮quota。过期未知持仓使 sizing equity 未知，不按本金或新盘口回填。
- 旧Ray v1持仓不会被新版本加仓；保留owner的原experimentId，在新实验中只管理到结算，不混入新lot。
- 新增 `alignRayFolder` 显式幂等动作，参数 `protocolVersion:'ray-twap-band-equity-v2'`。要求停止、无未完成订单/busy/halt，封存旧实验并清空当前实验引用、size=100，保留cash/session/history/maxExposure。重复对齐返回duplicate，不再次归档。后续start创建带 `rayProtocolVersion` 的新实验；本子任务未调用该动作。
- 快照 `strategy.rayOwnedPositions`、`strategy.rayRoundFills`、`strategy.rayEntrySummary` 与完整交易导出均包含新结构。统计明确 `countingUnit='completed-round-token-position'` 与 `entryCountingUnit='filled-fok-order'`。

隔离回归：**76项通过，0失败**，覆盖新增11项控制器情景、Ray纯策略/开盘/集成、原控制器、所有权现金流、待结算队列与账务不变量。包含当前小账户3份拒绝、同/反方向多单、100份上限与失败FOK不耗额、重启、配对官方兑付、错误quota恢复拒绝、手动部分卖出、旧v1保持、跨实验不混单、未知提交保持halt和原owner。

证据文件：`controller-verification.txt`；改前原字节在 `before-source/`；涉及文件改前/改后SHA256在 `controller-source-manifest.json`。生产账户、生产state、资金和现有历史记录均未被本子任务改写。
