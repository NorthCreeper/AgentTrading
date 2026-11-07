# 钱包入口部署后的只读复核

时间：2026-11-06 09:10:42.316 HKT。全部关键检查通过。

- 自动模拟：true；暂停：false；真实交易：false；异常暂停：无。
- 会话、实验和恢复基线：保持一致。钱包状态：disconnected，readOnly=true；本检查没有连接钱包或请求签名。
- 新静态模块HTTP 200；125个登记源码／模型，差异0项。
- 两代校验检查点2份；新段近期日志1056条、解析错误0条，尾部未完成行0条（不把正在追加的半行当作完整记录）。
- 记录器写入130→132，丢弃0，写入失败0；冻结瞬间在途1条。
- D盘可用约48.82GiB；主进程工作集753MiB。

| 组件 | 状态 | 原因 |
|---|---|---|
| process | ok |  |
| clock | ok | verified |
| metadata | ok |  |
| books | ok | 报价有效 |
| reference | ok |  |
| model | ok | outside-last-120-seconds |
| prediction | idle | outside-last-120-seconds |
| recording | ok |  |
| settlement | idle |  |

范围为两个当前快照、校验备份与最多1MiB近期日志；不代表全天外部网络可用率或全历史回测。事故未知区间继续保留。完整证据见post-deploy-scan.json。
