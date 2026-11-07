# 冻结日期门槛研究

结果与限制见 `日期分层盘口证据与TWAP门槛研究-20261018.md`。只读研究没有改变生产账户、资金、服务、源文件或风险上限；模型的所有日期单元都未获采用，实际仍回原40/60/80美元。

入口按依赖顺序：

1. `registration.json`、不可变 `registration-v1.0.json` 与 `registration-v1.1-amendment.json` 固定候选与验收条件。整事件日排除仅严格敏感性。
2. `refresh-catalog.mjs` 继承上轮catalog，逐一校验原前缀、冻结追加前缀及新cutoff，校验本地官方结果。它是首次目录构建入口，`state-cutoff.json` 以排他写入保护，不能在已有冻结目录无声重建。原始文件不移动。
3. `extract-all.mjs` 从冻结catalog流式读取所有canonical完整/不完整轮的原始帧，导出 `round-noise.jsonl`；其中只有完整轮进入统计。另导出真实opening候选的逐帧 `features.jsonl`，旧缺开盘不回填。
4. `analyze-calendar.mjs` 在冻结的官方日历和统一classifier上按纽约日期/香港时段分组、拟合与后段核验；生成noise结果与policy。重新运行会更新模型的生成可用时间与30日有效期，因此数值统计可复算，但模型可用时间属于新一次生成的元数据，不应伪装成原时间。
5. `funded-replay.mjs` 运行36个有限资金场景。`one-tap-order.mjs`、`paper-broker.mjs` 为上轮已验证执行模型的冻结副本。模型用于历史时尚未生成，结果只作post-fit描述。
6. `verify-calendar.mjs` 校验全部原始前缀、抽78轮独立重算noise/RV、逐笔复读所有场景真实信号/执行来源、费用/资金/曝险/官方结算时间；核对final官方日历与policy revision/SHA一致，检查空组不产生伪零噪声。
7. `write-report.mjs` 从机器结果生成报告和 `final-research-manifest.json`。`coverage-date-session.json` 另外列全部完整轮的纽约weekday/weekend和香港时段独立日覆盖。

Node运行时：`归档目录/Trade/runtime-tools/node-v24.19.0-win-x64/node.exe`。脚本路径固定指向本目录，复算前应先保存冻结输出；不可把重新生成的availableAt当成当时已存在的模型。来源仍须位于manifest原始路径；不下载、插值或补造缺数据。

`provisional-calendar-v1/` 保留股权到期时点修正前的日历/结果；`calendar-correction-v2.json` 登记官方date-only修正。`before-empty-ratio-fix/` 保留空组null除法导出问题的旧结果。修正没有放宽判据，周末有样本候选始终未通过。来源审阅与失败均保留。
