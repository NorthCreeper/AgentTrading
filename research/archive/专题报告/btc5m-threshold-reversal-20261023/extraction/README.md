# 本轮原始数据提取接口

- 统一截止时间：`1792687934075`，香港时间 2026-10-23 00:52:14.075。
- 原始主来源为 21 个会话的盘口帧与 21 个会话的价格记录，共 42 个冻结字节前缀。盘口原文 13,916,054,039 字节；价格原文 388,405,144 字节。每个前缀只做了一轮完整流式读取，并在同一轮计算 SHA256。
- `source-manifest.json` 给出各来源路径、冻结字节数、哈希、坏行、截断尾和超过截止时间记录数；`source-registration.json` 是读取前登记。原文没有写入或修改。
- `price-reports.jsonl.gz`：每行 `{report,witness,sessionId}`。`report` 原样保留，`report.time` 是源观察时间，`report.receivedAt` 是当时记录的接收时间。3,156,235 条报告中，2,421,045 条明确为 60 秒 TWAP；735,190 条没有窗口字段，保留为未知，不改标 60 秒。
- `frame-observations.jsonl.gz`：每行 `{slug,sessionId,now,twap,clock,quality,top,bookClocks,witness}`。`top` 顺序为 Up bid、Up ask、Down bid、Down ask。`witness` 提供来源编号、行号和精确字节范围。共 3,060,829 帧。
- `rounds.json`：10,794 个唯一盘口，保留每个会话片段和跨会话并集。1 秒与 5 秒槽位的 `hex` 是 BigInt 位图，第 i 位对应从开盘起第 i 个槽；`count` 为占用槽数量。`union.rawComplete` 要求 60 个 5 秒槽全部有原始记录、捕获间隔不超过 5 秒、边界落在 10 秒内且身份一致；共 9,175 个。单会话满足同一标准的有 9,168 个，另外 7 个由多个真实片段并集补全。旧目录标准单列 `rawCompleteLegacy`，不与新完整性口径混用。
- `union` 的 `*Frames` 计数为各会话原始捕获次数之和，可能含跨会话重复；`uniqueCaptureTimes` 留空。唯一时间覆盖应读取槽位并集和 `maxGapMs`。所有会话原始质量计数均保留。
- `quality.certifiedTwap60Fresh` 与 `strictReadyComplete` 只根据帧中自身明确窗口字段计算。旧帧可能未带窗口，但原始价格行已经明确 60 秒；因果子集应继续与原始报告关联，不能把帧字段下界当全部历史记录的最终分母。
- `openingCandidates` 中包含历史错误的 spot 基准，仅供错配审计；不可直接作为当前策略正确开盘价。正确 K 应来自准确开盘源时间的 60 秒 TWAP 或核实后的官方 priceToBeat。
- 官方标签由另一项独立盘点提供：`../inventory/official-labels.json`。主提取用 `--skip-official` 避免重复扫描，`extraction/labels.json` 因此不作为标签来源。辅助 oracle、wire、桌面来源也由 inventory 单独提供，不应多算同一盘口。
- `audit-proof.json` 已验证所有会话位图与并集一致、完整性约束、42 个来源完成哈希；坏行与截断尾均为 0。`two-witness-proof.json` 抽核了策略替换前和 v7 修复后的两个完整盘口，compact 与原文的时间、TWAP、质量、报价、时钟全部一致；原始盘口复核仅随机读取 9,107 字节。

本层不计算阈值事件、持续时间、收益或策略可执行性；不对缺失区间插值，也不从模拟交易输赢反推官方结算方向。
