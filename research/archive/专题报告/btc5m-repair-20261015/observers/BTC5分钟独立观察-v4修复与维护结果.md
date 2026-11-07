# BTC5分钟独立观察 v4 修复与维护结果

2026年10月16日08:19:41（香港时间）完成v4技术维护注册，08:21:19主任务已实际启动三个worker并确认当时全部healthy。随后08:21:19至08:23:38完成约139秒实际CPU/写入验收，三个模块全部通过；本报告不将这个有界窗口称为长期稳定运行。

## 修复结果

- 原三观察18791/18792/18793、合计60账户身份、生日、seed、既有余额/持仓/待结算/已闭合交易与全部历史保留，不重新拟合模型、不重置资金。
- 修复旧整份JSON编码/哈希导致18791每输入约1.3 CPU秒的问题；闭合交易由固定原portfolio.finish在所有库存归零后clone入历史，允许安全结构共享。活跃/部分成交/费用/待结算记录继续可变。
- 增加明确的新协议 registered-observer-two-barrier-merkle-wal-v2 / ordered-json-merkle-sha256-v1。有序Merkle根明确不是旧fullJSON SHA256。初始化、恢复及实证回放保留原encoder全字节一致性检查。
- 每输入继续保留pre-outbox、journal、post-outbox屏障与fsync，保留原资金事件身份与去重路径。
- 滚动数组先按time/id选择候选，再完整递归比较内容和属性顺序；全部相同才共享引用。无损splice+append取代移位数组的逐索引大写入。
- UTC向前quiet epoch、向后catchup时保持服务可见、暂停新处理；ready后同进程继续。跨校准边界的in-flight GET在append前soft pause，不将正常时钟等待变成storageFailed/fatal。其他不可验证UTC继续保护停止。
- 新入口读取稳定active指针并检查登记SHA、PID/入口/登记命令行，避免重复打开界面重启旧写放大模块。

## 实证验证

最新legacy原路径7项、新Merkle4项测试全部通过；archive/migration另13项通过。独立reviewer额外完成2,000轮随机有序JSON/Map/Set/滚动数组与重放检查。

真实原始输入回放共121条：18791为17条；18792/18793各52条，先warm40条再对连续12条逐条检查原encoder、内容与属性顺序、增量重建全字节相同。92/93实际命中无损splice 17/16次。

| 模块 | snapshot+Merkle+diff均值/输入 | delta均值/输入 |
|---|---:|---:|
| 18791 | 65.3毫秒 | 15,461字节 |
| 18792 | 87.4毫秒 | 8,416字节 |
| 18793 | 66.3毫秒 | 6,414字节 |

以上为真实回放的技术处理耗时，包含完整原编码的比对成本被排除出热点计时；完整worker现场结果见下一节，包含运行时采集、处理、持久化与维护。

资金/恢复测试包含真实partial buy→partial sells（费用变化）→verified settlement→重复/晚到label，活跃记录不冻结；60账户四阶段崩溃恢复不重复journal；半写、fsync失败、链篡改、资源预算拒写；原wall和UTC同时保留。

## 实际运行验收（08:21:19—08:23:38）

约139秒窗口内三组全部healthy/paper，进程不变、输入持续推进，CPU/内存/WAL总物理量均在原预算内：

| 模块 | PID | CPU秒/分钟（上限45） | RSS（十进制MB） | 新WAL增长MB/分钟 | 归档+现WAL总MB | 输入推进 |
|---|---:|---:|---:|---:|---:|---:|
| 18791 | 26780 | 10.08 | 414.1 | 2.51 | 8.06 | +138 |
| 18792 | 24908 | 11.17 | 297.0 | 0.94 | 40.64 | +138 |
| 18793 | 10880 | 11.14 | 275.2 | 0.93 | 40.52 | +137 |

RSS上限均为1.5GiB；归档+新WAL上限均为512MiB。磁盘可用30,175,592,448字节，高于8GiB预留。原08:52:20.559截止三组均保持。

重复调用主入口验收通过，主服务与三观察四个PID以及放行gate哈希均不变，未重复建worker或重置期限。主health另独立核对active登记SHA、startup维护SHA+port、lock SHA+port与精确入口/登记/端口命令行，真实frame与input均推进。

现场证据：live-v4-acceptance-20261016/resource-window-verification.json；该窗口通过不表示无限运行或盈利。到原截止或资源保护条件触发时仍会明确停止。

## 旧WAL归档与完整恢复

仅对本次修复目录归档目录/TradeResearch\btc5m-repair-20261015\observers产生的旧技术WAL做可逆gzip；D:\Trade原策略历史、原checkpoint、input和journal完全未压缩或改写。

| 模块 | 旧技术WAL字节 | gzip字节 | 原WAL行数 |
|---|---:|---:|---:|
| 18791 | 9,740,544 | 641,669 | 77 |
| 18792 | 536,282,459 | 37,829,958 | 2,625 |
| 18793 | 536,755,706 | 37,794,149 | 2,493 |

11段均完成fsync、逐段解压SHA及长度全等；分别经未压缩旧WAL与gzip两条路径重建，fullJSON、60账户、state、raw/journal游标、outbox全部一致。随后在隔离目录再比较原fullJSON与新Merkle对真实尾项的恢复与重启，最终完整状态及journal字节完全相同，才移除可精确还原的未压缩技术WAL副本。

原技术WAL路径现已移除，这是明确记录的维护变化；原内容由gzip精确还原。manifest记录原路径、原SHA、原长度、gzip路径/SHA与恢复顺序，removal-proof及逐段removal-journal保留。旧注册与三个旧资源stop证据原样保留。

92/93各有1条durable raw未处理尾项，按原observedAt/processingAt恢复一次：255593→255594，229276→229277；没有重打维护时刻、没有回补停机期间机会。18791从133666继续。

## 原预算与期限

每worker压缩归档+新Merkle WAL合计仍≤512MiB；raw总量≤2GiB，journal≤128MiB，新文件分段≤128MiB；磁盘至少保留8GiB。CPU仍≤45秒/分钟，RSS≤1.5GiB，不提高预算。

原release为2026年10月15日08:52:20.559，原截止为2026年10月16日08:52:20.559（香港时间，epoch 1792111940559），此次维护与重新启动不重置或延长。旧gate原样保留并绑定SHA；新gate三字段同时核对登记SHA、原release与原deadline。预算或期限停止均明确写入worker-stop-v4.json，不自动重启绕过。

因此这是原预算/期限内的有界观察恢复；不保证无限运行，也不以本次基础设施验证声称策略盈利。

## 权威入口与证据

- 新入口：归档目录/Trade\恢复BTC研究观察-修复版.ps1
- active指针：归档目录/TradeResearch\btc5m-repair-20261015\observers\active-registration.json
- 登记：registered-20261015\repair-registration-merkle-v4.json，501,718字节，SHA256 85f37b446c976aedd3615537bb96fb2b9fafba5a793267e36eef8b6338f85f4e
- 维护/隔离恢复：registered-20261015\maintenance-v4-1792109915467\maintenance-proof.json 及trial-18791/2/3-proof.json
- 每服务归档/恢复：registered-20261015\<port>\maintenance\archive\manifest.json、migration-proof.json、v4-parent.snapshot.json
- 原路径7项：validation-1792071917974\validation-proof.json
- 新协议/真实回放4项：merkle-validation-1792071917969\merkle-proof.json
- 独立review：independent-final-review.json
- 实际运行验收：live-v4-acceptance-20261016\resource-window-verification.json（约139秒，全部通过）。

每服务新增health-status.json小投影与维护登记SHA/port锁字段，供主health核实实际PID、入口及当前登记身份；原金融registrationHash含义保持。等待UTC时显式clock-wait/recoverable，保护停止与行情未推进另列。
