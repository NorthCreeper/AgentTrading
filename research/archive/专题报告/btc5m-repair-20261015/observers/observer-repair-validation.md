# BTC5分钟旧候选观察增量恢复验证

三个原观察（18791 / 18792 / 18793，合计60个原账户）已完成可部署恢复代码和技术注册。此次未修改原三启动入口、原策略源码、原注册、原父快照或原始输入与资金事件链。恢复账户身份、生日、seed、余额、持仓、待结算和历史；不重置资金，不回补停机期间机会，不重新拟合模型。

- 新入口：归档目录/Trade\恢复BTC研究观察-修复版.ps1
- 验证注册：registered-20261015\repair-registration-validated.json
- 原始注册：registered-20261015\repair-registration.json（完整保留，由新注册引用其哈希）
- 测试证据：validation-1792024958779\validation-proof.json
- 修复前源码备份：归档目录/TradeResearch\btc5m-repair-20261015\source-before\observer-resume-20261015

## 已验证结果

6项测试全部通过，耗时59.85秒。

1. 真实18791原始输入尾项133629，与原观察器完整checkpoint实现逐barrier核对，完整state、38账户、资金事件及最终机器序列化哈希完全相同。原父快照57,482,889字节；此次恢复仅写WAL19,371字节。原始输入尾项已持久化，属于崩溃恢复，未回补停机机会。
2. 三组60账户分别覆盖raw已写但state未写、pre-outbox已写、journal已写但post-outbox未写、post-outbox已写四种重启阶段。最终完整状态逐一相同，journal没有重复事件。
3. 半条写入、fsync失败、链被修改和固定预算耗尽时拒绝继续处理，保留原证据；不截断半条数据。
4. 缩小阈值强制raw/WAL分段，验证跨段sequence/hash连续及完整最终资金状态。存储场景包含部分成交、确认撤单、费用、已验证结算；该合成存储测试不代表发生真实交易。
5. 新raw同时记录实际wall与经校准UTC，原producer/行情源时间原样保留。独立UTC上界存在微小差异时，仅有界等待最多1秒；不改写producer时间。UTC未就绪时先拒绝追加。
6. 严格JSON增量重建与独立codec一致，包含属性顺序及特殊字面键。18793原constructor的两个空诊断callback与属性顺序由技术adapter还原至原快照，原策略文件不变。

## 资源与恢复边界

每worker：raw总量2GiB，WAL总量512MiB，journal总量128MiB；raw与WAL按128MiB分段，journal最大128MiB。三worker累计追加上限7.875GiB，保留至少8GiB磁盘空间。全部新输出单文件均不超过128MiB。

每worker RSS预算1.5GiB、每分钟CPU时间45秒；恢复初始化不计入运行CPU窗口。放行后连续运行最多24小时，重启保留同一放行期限，不自动刷新。资源预算/UTC失效/资金fatal均写出worker-stop.json与status.json，health显示预算及错误。新入口保留受保护停止，不自动重启绕过预算。

增量存储保留每输入pre-outbox与post-outbox两道资金屏障及fsync；状态不再每次整份重写约89MiB。WAL重启采用流式记录读取、严格链校验、最终完整状态哈希，避免每条历史增量都复制整份父快照。

新入口有启动互斥、端口/PID/完整命令行核对，并复用已运行worker。三组原账户完整恢复证明全数通过后才统一放行当前行情。主打开BTC控制台.ps1不在此原观察sources绑定中，可以接入新入口。

## 尚需运行验收

真实启动、持续CPU/RSS/写入速率、API健康与新frame推进，由主任务统一协调。通过代码与恢复测试不等于已经长期稳定运行，也不构成盈利证明。
