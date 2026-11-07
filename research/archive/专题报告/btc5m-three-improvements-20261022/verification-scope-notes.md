# 隔离验证范围补充

opening/isolated-restoration-verification.json 为真实v6账户副本迁移v7的10步验证。

orderflow/isolated-restoration-verification.json 是额外的隔离再对齐压力检查；对应 check-restoration.mjs 在副本内将 rayAlignmentVersion 清空，刻意触发显式再对齐和新实验，不能用它证明纯影子重启应新建实验。没有修改生产账户。

纯影子部署的准确恢复证据是 orderflow/shadow-restoration-verification.json，由 check-shadow-restoration.mjs 对未改标记的v7真实副本执行10步恢复/重复对齐/启动/暂停/停止/重启，要求实验、会话、财务和盘口锁全部不变。部署脚本也在真实第二、三阶段分别检查实验不变。

首次 opening/runtime-tests.log 的2个失败来自旧runtime fixture仍指向v6；fixture和观察器适配后 opening/runtime-tests-final.log 的839项全过。terminal-exit/runtime-tests.log 是冻结前883项初验，新增一项边界后 runtime-tests-final.log 为884项全过。所有初验和失败记录保留，不据此补写历史数据。
