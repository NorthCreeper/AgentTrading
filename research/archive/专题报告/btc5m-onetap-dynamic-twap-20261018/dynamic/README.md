# 动态 TWAP 研究复核

主结论见 `TWAP动态门槛与仓位验证研究-20261018.md`。未认证动态主策略或自动加码；独立研究没有发出交易命令或改变主账户。

固定截止为 2026-10-18 14:06:22 HKT。`source-manifest.json` 注册原始帧的精确字节前缀和 SHA256；之后追加数据不会进入本批研究。`catalog.json` 继承旧历史的来源与覆盖选择，再扫描实际追加前缀；缺失开盘不回填。

现有冻结目录的复核顺序（运行时为 `归档目录/Trade/runtime-tools/node-v24.19.0-win-x64/node.exe`）：

1. `extract-features.mjs`：流式原始帧，输出逐轮 `features.jsonl` 和覆盖；只从当时可得数据生成因果波动。
2. `compare.mjs`：每单位成本的报价诊断，严格原卖一价格保护；它不是主账户或 One-Tap 收益。与下一项的 2 美分保护不可直接混为相同执行情景。
3. `funded-replay.mjs`：冻结 One-Tap 模块、逐档 FAK、2 美分保护、5 份请求、2.5%预算、真实资金占用和原始官方结果时间，输出27个有限资金情景。
4. `verify.mjs`：独立重读原始字节、重新折算滚动方差和逐档费用、现金、曝险、累计额度与官方结果时点。
5. `check-shadow-parity.mjs`：只读导入当前生产动态影子模块，与同一批原始信号比较。生产模块后续合法版本变化可能改变哈希或结果；本次哈希记录于 `shadow-parity.json`。
6. `write-report.mjs`：从机器结果生成报告及明确不通过的强度分层结论。

`one-tap-order.mjs` 与 `paper-broker.mjs` 是研究时冻结的执行副本，不随生产后续编辑变化。原始全历史必须仍在原路径；上述程序不下载或补造缺失数据。运行会重新导出本目录当前结果；首次版本与失败保留在 `frame-knownAt-initial/`、`before-fill-breakdown/`、`verification-first-failed.json`、`study.log`、`extract-features.log` 等文件。

`study.mjs` 为首次目录构建和特征试跑脚本。它已成功生成固定目录和原始来源核验，但在最终整表导出时超过 Node 字符串上限，作为失败证据保留；重算现有冻结目录请使用逐轮 `extract-features.mjs`，不要把首次失败脚本当成当前完整入口。

窗口时效从帧捕获时间改为原始价格接收时间的公开修正在 `research-amendment-v1.1.json`。公式与候选没有按收益选择；后段只是很短的按时间描述对照，尚不构成前瞻盈利证据。自动仓位区间的用户授权不等于10%仓位已获研究验证。
