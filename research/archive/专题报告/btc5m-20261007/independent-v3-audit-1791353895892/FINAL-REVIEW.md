# 原始历史来源与 v3 无损压缩输出独立核验

全量独审通过，真实进程退出码为 0。该结果认证登记数据、特征重建和压缩输出的一致性；本次没有读取结算标签、盈亏或资金，没有拟合模型，也没有证明策略收益改善。

## 固定范围与真实执行

- 原范围：43 个既有文件前缀，13,739,723,861 bytes；cutoff 为 1791303594758，即 2026-10-07 00:19:54.758 香港时间。后来追加的字节不属于此范围。
- 根 v3 提取：真实 terminal 99223，exit 0，chunk e3b52e；开始 1791353145800，完成 1791353655433。
- 本次独审：真实 terminal 71462，exit 0，chunk ad37f4；原生包装进程开始 1791354016141，完成 1791354370970。
- 完整 native stdout/stderr、实际进程结果以及根授权保留在本目录。stderr 为空。通过文案没有替代真实退出状态。
- 独审代码为 C 盘 NEW v3 目录的 13 个 held 源，closure 为 e97eb7927940d6adee211171b8b929cec314ae7406c92c6c89eac7a4caa59a2e。92/92 合成测试真实 exit 0，chunk 3fef0b。原数学、metadata、重建和 cursor 的七个文件与 held v2 独审版本字节相同；新增部分为透明 gzip 解码与来源登记。

## 全量核验结果

| 核验项 | 结果 |
| --- | ---: |
| 登记原文件前缀 | 43 / 43 |
| 盘口轮数 | 3310 |
| 按原固定时点保留的输出记录 | 95990 / 95990 |
| 从原文件重新构造的字节 witnesses | 456405 |
| 有效原参考锚点 | 74495 |
| 有效 static 特征锚点 | 45671 |
| 有效 Coinbase USD 残差特征锚点 | 26663 |

所有原前缀的 native identity、固定长度与 SHA 均通过核验前后检查；全部 source metadata、canonical round、原始权重、每个有效或缺失时点、原始数字、历史 sigma、context 身份、字段绑定及缺失原因均独立重算并与输出一致。全部父代码及独审代码的 current/copy 检查、原 v1 来源/复制件/报告检查和不可变输出检查通过。独审没有导入作者的 feature/math/reconstruction helper。

实际 gzip 为每条原 JSONL 记录一个 member。95990 个 member 的 header、独立 CRC32、ISIZE、单行边界、行序及解码原字节哈希均通过；独立解码器使用自己的 CRC 算法，没有调用作者的压缩解码 helper。物理输出预算仍为 256 MiB，单 member 原字节上限 8 MiB，总解码上限 1 GiB；没有解压副本或原始文件副本。

| gzip 数据 | bytes | SHA256 |
| --- | ---: | --- |
| 压缩文件 | 133862627 | e7bea7db04e2e5a31e0a3d829cc0b0bf8ba9ed09b67b2548029d2b16072ec5ba |
| 按原顺序解码的 JSONL | 385385883 | 251fa8ca374deb829de997ff5a3af6c8671cd07a20affd8dd98fb8c8076ac78b |

有限 receipt/process 时间倒退按原字节顺序，在已经遇到的最大 receipt/process 时刻之后释放；保留原时间和原字节 cause。当前、opening、历史 aggregate 与 context 的两种 knownAt 坐标均匹配。真正 source-clock 缺陷、malformed 或 unknown 的整前缀 mask 仍是回顾性的来源资格限制，不能解释成当时的实时拒绝或未来因果表现。原记录顺序也不证明物理 UTC 同步或 Coinbase USD 的价格可被实际成交。

## 训练范围的实际限制

原日历上有 13 个已结束日期，但有合法 USD 特征的已结束日期只有 11 个：2026-09-23、09-24、09-25、09-26、09-30、10-01、10-02、10-03、10-04、10-05、10-06。09-22 与 09-27 的有效 USD 特征数为零；10-07 只属于原 cutoff 前的部分日期。

因此原定首次 13 个支持日期的 7/3/3 划分仍不满足，modelSplitRegistered 和 fitPermission 均为 false。本次通过不能用 static 特征日期、部分日期或改动日期门槛来代替缺失的 USD 日期。应在另行登记的新来源范围中补足完整支持日期后，再按预先登记的训练、验证和评分规则继续。11 天也不代表支持强度均衡：09-26 仅 98 个 USD 锚点，10-05 为 315 个；后续仍应报告来源可用性和配对样本限制。

缺失或拒绝不能自动解释成原始数据完全不存在；本次各类原因不是互斥分组，其计数不能直接相加作为唯一缺失总数。source audit 的通过也不提供目标标签真实性、样本外预测优势、成交可达性或账户净收益结论。

## 冻结证据

- input manifest SHA：8b971578d81a85fa3193bee42190e66982fb55ab81297a1c14ce125e50ce2865。
- 根提取登记 SHA：4fc3e17b37aa3fcd2422c5fa1c6c54e6590039643bb1fecce4fda9b8ebb149f4。
- 根完成报告 SHA：9fbb8c69dcf61ee34a759ac4bc2f0512d7f33caeda9dcdaec0dd7d27545efb0e。
- 独审登记 SHA：69bbea3f944208e02264ee802c71b5d838497611c43fd8ff9f6c972e3b97b2f9。
- 根独审授权 SHA：e0f04876544ac865d8b81360866ddaf10a79bd8f87b2c492011ffe86cadc8d24。
- 全量独审 proof.json SHA：0aa905ad43fab40bef6d5cd4771d2df00711c839456c8747a6aab2e887dc55f8。
- native stdout SHA：4ec06967769779b3990f976073614447bce9a4d182d9ee1a8cebb3bdcdae7216。

原 v1 独审通过、v2 物理预算失败、v3 首次 C 盘合成输出因 4 GiB reserve 失败等原证据均保留；此次没有覆盖它们，没有降低预算、移动/删除旧证据或改动生产策略、账目与钱包。
