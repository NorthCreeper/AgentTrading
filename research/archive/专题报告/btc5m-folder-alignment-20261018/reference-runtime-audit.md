# 桌面参考工作流运行核查

核查目录：`归档用户目录\Desktop\polymarket-btc-5m`。核查时间：2026-10-18 02:23—02:26，香港时间。仅查看源代码、日志、进程与本地 GET 接口，运行自带离线测试；没有启动、停止、修改控件或交易。

## 结论

1. 参考目录目前确实运行，界面位于 http://127.0.0.1:8787/。本机仪表盘与独立 CLI 都从 10 月 17 日 18:26 左右持续运行；最近约八小时的行情记录保持更新。仪表盘 WS 当前未连接，REST 正常供数，TWAP RTDS 已连接。
2. 账户显示从 1000 增至 1090.559843、45 笔 42 胜 3 负、手续费 10.230157。这些都是本机启动前继承的纸面历史，本次本地运行没有新成交。不能把历史收益当作当前本机运行产生的收益，也不能并入 D:\Trade 另一账户。
3. 收益算术能对上账本，但胜负由换轮时 TWAP 相对开盘参考直接判定，没有逐轮官方结果核验。早期约 20 笔缺少当时完整信号日志，因此该账户收益并不构成可完整独立复现的官方结算成绩。
4. 可对齐其策略参数、按权益计算仓位、跳过原因与每轮摘要，但不应照搬双进程共享账户、代理结算、300 秒开盘参考兜底和重启恢复方式。

## 当前运行证据

已保存 `reference-health.json` 与 `reference-state.json`，是已证实本机监听端口 8787 的只读 GET 结果。

| 项目 | 证据 |
|---|---|
| 仪表盘 | Python 主进程 PID 1000，虚拟环境启动器 PID 27012，创建于 10/17 18:26:37；监听 127.0.0.1:8787 |
| 独立 CLI | Python 主进程 PID 26136，虚拟环境启动器 PID 6232，创建于 10/17 18:26:38 |
| CLI 实际命令 | `-m paper_bot --strategy ray --auto-trade --duration-sec 86400 --poll-sec 5` |
| 仪表盘运行 | running=true；最近一次控件启动 started_at=10/17 18:27:20；poll_count=5053；stall_count=0 |
| 行情 | 本次 GET 盘口年龄约 497 ms；source=rest；ws_connected=false；无 last_error |
| TWAP | connected=true、subscribed=true；年龄约 3003 ms；60 秒 Chainlink TWAP 的公共 RTDS relay |
| 本地实时日志 | `window_polls.jsonl` 与 CLI `paper_20261017_182638.jsonl` 均更新至本次核查时间 |
| 当前自动成交 | 仪表盘 fills_count=0、ray_fills_count=0；CLI 完整 4941 条快照全部 skipped |

Windows 对长期打开文件的目录元数据可能滞后。最初目录列表将正在写入的 CLI JSONL 显示为 0 字节，但实际打开读取有 4941 条合法 JSON 快照，不能以那个目录属性判定日志丢失。

## 当前启用参数与启动默认

| 参数 | 8787 当前值 | 实际来源 |
|---|---:|---|
| 策略 | Ray | dashboard.py:126 |
| 自动纸面交易 | 开 | dashboard.py:146-150；load_or_create 会采用本次传入开关，paper_account.py:614-615 |
| 轮询 | 5 秒 | dashboard.py:125；CLI 命令 --poll-sec 5 |
| 资金基数 | 持有账户，原始起点 1000 pUSD | logs/paper_account.json |
| 仓位 | 权益的 2.5%，含费成本计算份额 | dashboard.py:129-131、854-856；sizing.py |
| 单次份额上限 | 100 | dashboard.py:130；signal_late_directional.py:40 |
| 每轮累计份额上限 | 100 | dashboard.py:143；main.py:832-835、965 |
| 最小份额 | 5 | 实时 controls.min_size，sizing.py |
| Ray 最后入场时间 | 最后 120 秒 | 实时 controls.ray_late_sec |
| Ray 价格带 | 0.55—0.85，与 80/20 非对称约束同时满足 | 实时 controls.ray_min_price/max_price/book_asym |
| 时段偏离 | 香港 06—12: 40；12—22: 60；22—06: 80 美元 | 实时 controls |
| 额外 random50 | 关 | 实时 controls.ray_include_random50=false |
| 主动纸面退出 | 关，默认持到换轮 | 实时 controls.paper_exit=false |
| 手续费 | rate=0.07、exponent=1，fee=份额×0.07×p×(1-p) | paper_bot/fees.py:10-23 |

broker 类的裸默认仍是 25 份（paper_broker.py:68），但仪表盘构造器显式传入 100，CLI 默认参数也传入 100。main.py:835 的帮助文字仍写“default 25”，与实际默认不一致，不能据此采用 25。CLI stdout 启动行也确认 late_max_size=100。

`late_sec=90` 与 `late_min_price=.9` 是另一个 late 策略的参数；当前 Ray 使用独立的 120 秒及 .55—.85，不能混为一谈。

## 完整运行路径

- 根目录 `纸面控制台.bat:8-18` 先检测端口 8787，有监听就打开浏览器，没有则启动本地仪表盘；没有验证占用端口的是否正确服务。
- `local-console/start_dashboard.bat:4-22` 切至项目根目录，必要时创建 Python 虚拟环境与依赖，然后启动 dashboard.py。
- `dashboard.py:1283-1291` 在应用启动时启动 TWAP 与引擎。引擎在内存维护策略、broker、控件与近 180 条绘图记录（119-178）；后台线程负责行情与自动纸面交易。
- `local-console/start_paper_loop.bat:20` 另外启动独立 CLI；main.py:1078-1089 跑 86400 秒后正常结束，没有外部守护、自动重启或重复循环。其时限约在 10/18 18:26 到达。
- `local-console/start_all.bat:5-7` 会同时启动上述两套自主交易引擎，二者都使用项目根 logs，账户没有进程间协调。
- 本地控制台中的 `纸面控制台.bat:6、16` 却使用 `%~dp0polymarket-btc-5m\local-console`，在已经位于 local-console 的目录下会拼出不存在的嵌套路径；根目录版本路径正确。当前已有监听时可能被提前返回掩盖。

## 接口与控制范围

接口定义在 dashboard.py:1316-1363：

- GET `/api/health`：行情、TWAP、纸面账户；`ok=true` 是固定返回，不能单独证明数据连续或策略健康。
- GET `/api/state`：控件、最新快照、持仓资金、近期图表与 broker 统计。
- POST `/api/controls`：仪表盘启停、自动交易、策略、仓位、退出开关、起始资金与重置。
- POST `/api/poll-now`：即使引擎 stopped 仍执行一次 poll_once；poll_once 包含自动交易及结算路径，不能把它当作无副作用刷新。

仪表盘 stop 只停止自身后台循环（dashboard.py:194-207），不会关闭独立 CLI。用户同时运行 start_all 后，在页面停止并不代表整个目录停止交易。API 资金设置也只更新仪表盘的内存账户，CLI 不会重新加载，双写风险进一步扩大。上述 POST 在本次核查均未调用。

## 账户、费用与收益复算

固定读取前缀哈希、字节数见 `reference-source-prefix-manifest.json`；统计结果见 `reference-log-summary.json`。

| 指标 | 复算结果 |
|---|---:|
| 账本行数 | 100 |
| 事件 | account_init 1；set_starting_cash 9；buy 45；exit 45 |
| 买入 / 退出唯一 ID | 45 / 45，全部一一成对 |
| 初次买入 | 10/12 08:43:03 HKT |
| 最后退出 | 10/17 07:00:56 HKT |
| 本机 18:26 启动后的买入 / 退出 | 0 / 0 |
| 45 笔合计净盈 | +90.559843 |
| 入场费合计 | 10.230157 |
| 现金复算 | 1000 − 买入含费成本 + 退出收入 = 1090.559843 |
| 账本金额与账户 | 一致至浮点误差 |
| 每笔费率公式复核 | 最大绝对差约 5.6e-17 |
| 胜负 | 42 won / 3 lost，全部 reason=window_roll |

本地 CLI 的启动 stdout 首行账户已为 1090.5598，说明这 45 笔收益是在同步进本地之前已有。SYNC_TO_DESKTOP.md:3、13、21 也明确目录与日志来自 box 镜像。账户文件最后 18:31:30 更新来自 set_starting_cash reset=False，不能视为新的成交。

### 结算真实性边界

- dashboard.py:786-796 与 main.py:254-266 取得当时 TWAP vs open 的方向，调用 `settle_except_window`。
- paper_account.py:478、493-497 直接以传入方向判赢输，赢付 1、输付 0，没有请求官方已决结果。
- paper_account.py:521-544 把同一个 outcome_side 用于所有非当前轮的剩余仓位；如果暂停跨越多轮，可能以同一个后续方向结算不同历史轮。
- 所以这 45 笔是纸面代理结算账本，金额算术一致不等于官方结果已核实。没有把任何推测官方结果填入历史。

## 持久化与重启恢复

有价值的实现：

- 账户保存临时文件后替换正式文件（paper_account.py:217-241）。
- JSONL 与 CSV 追加 buy/exit/资金事件（243-260），费用与现金记录可复核。
- replay 每条 poll 落盘并冲刷（replay_log.py:77-101），40 MiB 轮转（20-23、305-318）。
- 轮摘要含跳过原因、是否交易；中间没有观测的窗口用 dark=true、poll_count=0 标识（149-205），没有伪造行情或成交。
- 4 秒 HTTP、20 秒单轮超时、90 秒无进展 watchdog、45 秒 discovery 缓存（dashboard.py:83-94）有助于避免过去的多分钟静默停滞。

不能照搬的局限：

1. 只在启动时 load；RLock 只保护同进程线程，没有多进程锁（paper_account.py:104、188-215）。两引擎会各持一份现金、持仓，写相同 `.tmp` 及账本，可能覆盖或重复。
2. broker 的 per-window 已用份额仅内存（paper_broker.py:67-80、223-224、334），重启后不会由账户重建。可能对已交易轮再次入场；默认逻辑也允许同轮多次买直到累计份额达到 100，而非一轮只成交一次。
3. account JSON 只保留最近 200 条 closed（paper_account.py:232）；累计费用和胜负保留，但 `_booked_ids` 从该截断记录加载，JSON 不能单独作为永久去重事实库。
4. 账户 JSON 损坏时 load 返回 False（188-195），load_or_create 走新账户初始化（600-641），不是显式停机保护。应使用账本重建/报错，不能静默新建覆盖。
5. 写账本在 save 前完成（416-417），两者不是原子事务；崩溃可能造成账本与快照断层，没有启动对账流程。
6. 控件和 running 状态主要在内存；启动默认 Ray、自动交易开启，停止状态不会跨进程重启保留（dashboard.py:122-150、1283-1286）。
7. replay 写失败被静默忽略（dashboard.py:1107-1112），不会停交易也无持久错误标志；与用户“日志完整”要求存在差距。

## 数据与历史日志完整性

本次读取均可解析，没有破损 JSON 行。

| 日志 | 观测范围与结果 |
|---|---|
| window_polls | 31,617 行；10/14 23:55:13—10/18 02:24:39；796 个唯一轮 |
| 历史时间空档 | 303 个相邻 poll 时间差 >60 秒；最长 884.026 秒，10/17 02:54:47—03:09:31 |
| window_summaries | 880 行，867 唯一轮；73 行 dark；摘要有 13 条同轮重复，需按事件/时间区分 |
| 本机仪表盘启动后 | 5067 条 poll，全部 skipped；无 >60 秒空档，最大 9.666 秒 |
| 本机主要跳过 | not_late 3010、twap_dev_below 1170、empty_or_missing_ask 869、discovery_timeout 18 |
| 独立 CLI | 4941 条完整快照，全部 skipped；discovery_failed 22、book_error 22，其余以非末段/偏离不足/缺 ask 为主 |
| TWAP stderr | 本地已有 3 条 stale_twap 超过 45 秒并重连记录；不等于 3 次行情长空档，因为盘口轮询仍继续 |

“没有轮询大空档”与“每轮都有可交易完整盘口”不同：869 条缺 ask 仍需要保留为数据/流动性不足，不能当作纯粹策略拒绝。shared window_polls 没有 process/run 标识，不过源代码只有仪表盘使用 ReplayLogger；独立 CLI 用 paper_*.jsonl/csv。多开仪表盘仍会产生混合写入。

更早的 10/12—10/14 前约 20 笔成交发生在 replay logging 之前；ledger/closed 不含 vs_open、开盘参考来源与当时盘口，只能核对资金流，不能复现完整入场资格。build_poll_row（replay_log.py:374-421）也没有保存 open_source/open_obs_ts_ms/开盘已知时间与完整深度，早期摘要的完整性有限。近实时 CLI 快照信息更全，但其本机运行没有成交，不能弥补早期成交证据。

twap_feed.py:38、45、311-329 显示，尽管优选开盘 ±2.5 秒报价，找不到时可用距开盘 300 秒的 spot 或 TWAP，标记为 near_open。它改变了开盘参考语义，可能把入场后的价格当“开盘”，是与严格版本差异较大的地方，不能仅为看起来同频而降级当前数据要求。

## 测试

以禁用字节码写入的方式运行目录自带离线 `python -B -m tests`，20 项全部通过，耗时约 0.04 秒；测试写临时目录，不触碰运行账户。范围是 Ray 阈值、filters、broker fill、费用、账户买卖持久化与 CLI flags。

这些测试没有覆盖双进程共享账户、应用重启恢复、官方结算核验、控件端到端控制所有引擎、300 秒开盘兜底的因果有效性或完整数据连续性。通过冒烟测试不能作为 7×24 稳定与利润真实性的证明。

## 对齐建议

对齐可落地的业务参数和报告方式：2.5% 权益含费仓位、最大 100 份、5 份起、同样 Ray 筛选、默认关闭 random50/主动退出、保留完整每次决策与每轮摘要。

需要明确列为保留改进的实现差异：当前 D:\Trade 的独立守护与单一写入者、官方结算确认、严格已知开盘参考、费用元数据有效性、完整账本对账、日志错误显式告警。不要移植此目录的账户资金与 45 笔收益；用不同实验/策略版本记录对齐之后的新成交，保证前后比较有边界。
