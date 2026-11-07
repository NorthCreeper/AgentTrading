# C盘空间与原位NTFS压缩：只读前置审查

2026-10-08，香港时间13:34–13:42。没有读取任何原JSONL正文，没有计算原raw文件SHA，没有删、移、复制、压缩、重启或改主策略。本文件与待用wrapper都写在D的新审查目录；wrapper仅语法检查通过，尚未执行。

## 当前最大文件和增长

原生只读metadata递归结果`345d2e` exit0，完整runtime-metadata-inventory.json（原件见项目档案）共8735文件、逻辑合计27,340,266,084字节。旧c6a前缀11文件11,514,641,896字节；旧1052前缀11文件5,349,093,507字节；当前3b2前缀11文件5,431,576,916字节。逻辑大小不是压缩后的物理占用。

| 文件 | 逻辑大小 | 原最后写入香港时间 | 判断 |
|---|---:|---|---|
| c6a…-frames.jsonl | 3,697,319,819 | Oct1 11:42:30 | 旧会话，最大 |
| c6a…-p2-context.jsonl | 2,970,126,191 | Oct1 11:42:30 | 旧会话 |
| c6a…-p0-opportunities.jsonl | 1,858,148,896 | Oct1 11:42:30 | 旧会话 |
| c6a…-decisions.jsonl | 1,844,593,400 | Oct1 11:42:30 | 旧会话 |
| 3b2…-p2-context.jsonl | 1,645,494,495 | Oct8 13:37:13附近 | 正在append，排除 |
| 1052…-p2-context.jsonl | 1,623,299,401 | Oct5 07:53:05 | 旧会话 |
| 3b2…-p0-opportunities.jsonl | 1,481,851,950 | Oct8 13:37:12 | 正在append，排除 |
| 1052…-p0-opportunities.jsonl | 1,443,253,346 | Oct5 07:53:05 | 最小单文件测试候选 |
| 1052…-frames.jsonl | 1,186,736,226 | Oct5 07:53:04 | 当前43源读取域，不选 |
| 1052….jsonl主事件 | 16,055,166 | Oct5 07:53:05 | 并非dominant |

旧1052主事件只有约16MB，不能把当前空间下降归因于该已结束事件文件。38.624秒纯metadata差分`f6f35b` exit0：当前3b2文件合计增加830,110字节；旧1052全部文件增长0，所有inode/birth保持。该短观察只能证明当前append，不能追溯五小时C盘空闲减少约3.25GB的所有来源；本任务没有早期各文件size基线或整个C盘新文件清单，不能伪造完整归因。

## 原生filesystem及物理测量

`74728f`、`30272c`与补充Get-Volume均exit0。C为NTFS、allocation unit4096；香港时间13:37:13.939（UTC05:37:13.939）时C free2,135,810,048字节，略早/晚检查各自不同。PID33328出生仍UTC2026-10-05T14:24:34.7762872Z。参见runtime-native-storage-metadata.json（原件见项目档案）。

只读`GetCompressedFileSizeW`测得候选1052-p0-opportunities实际存储1,443,253,346字节、逻辑相同、属性Archive（未Compressed/未Reparse）；c6a-frames和1052主事件也尚未压缩。当前3b2-p2只读测量，不作修改。无NTFS压缩前后比值，不预估确定节省量。

[Microsoft原生compact说明](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact)及本机完整帮助（原件见项目档案）一致：`/C`原生NTFS压缩指定文件；`/U`可恢复；目录参数会改变未来新文件的默认压缩，所以不能对目录操作。`/EXE`采用另一种优化压缩，本方案排除它，也不使用/S、通配符、/I或/F。

[NTFS透明无损说明](https://learn.microsoft.com/en-us/windows/win32/fileio/file-compression-and-decompression)表示应用仍读取原逻辑数据；是否在这个文件上保持path、dev/ino/birth/mtime和完整SHA必须实际前后核验，文档不是我们的成功凭证。[GetCompressedFileSizeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getcompressedfilesizew)用于测实际存储；同时free-space差受主append及系统其他写入影响，不能单凭C free差声称候选节省多少。

单候选即使节省100%的1.443GB，也不足把当前约2.13GB恢复到原4GiB reserve。因此它只能是最小原位安全测试，不能预先宣称解决了空间；任何后续扩展须再独立核验目标和来源读取集合。

## ctime及审批守卫范围

原生压缩改变Compressed属性；[FILE_BASIC_INFO官方说明](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info)将ChangeTime区别于数据流的LastWriteTime，metadata/属性变化属于ChangeTime范围。因此不能承诺所有原native ctime不变，也不能把它恢复成旧值掩盖变更。

根已扫描代码：唯一显式ctime守卫在`dashboard/history-approval.mjs:115`，签名为approvalPath、三个报告/registration/certificate路径以及registration.sources的源码路径。当前默认`runtime/history-approval.json`1163字节、其registration10796字节，仅选取sources路径字段，24源码keys/28签名路径；没有打开报告、certificate、account或targets。`3c660c` exit0确认精确1052-p0-opportunities不在签名中，详见approval-ctime-scope.json（原件见项目档案）。这不是擅改gate或整个运行时所有binding的审计；原149/8和正在读取43源仍由根最后复核。

候选原native pin：dev2663984570、ino7036874417857832、birthtimeNs1790826188961992200、mtimeNs1791157985010097300、ctimeNs1791157985010097300、bytes1443253346。SHA在此metadata-only阶段未读取，必须由根独立实际流式读取登记，再由wrapper前后完整验证；不能借邻近文件/文件名/旧汇总猜一个SHA。

## 已准备的最小wrapper，未运行

compact-single-inactive-wrapper.mjs（原件见项目档案）只固定上述一个inactive文件，不能接受其他target。根必须创建专门approval JSON，含实际pre-native所有pin和完整逻辑SHA、ctime范围证明SHA、明确不在当前43 read set、允许`compact.exe /C exact-inactive-file`，再显式提供execution flag和新的D proof目录。缺任一项即拒绝。

wrapper步骤：普通路径/无junction/固定size/一小时以上无写入→NTFS/4096 cluster/无加密和reparse/尚未压缩/原D reserve/PID生日→持有原只读fd及before完整逻辑SHA→仅native `compact.exe /C` exact file→保存完整child原生exit/stdout/stderr→fstat/lstat dev/ino/birth/mtime/bytes及after完整逻辑SHA一致→记录Compressed属性、真实ctime变更、实际物理bytes和C free差。失败保留完整proof，不自动重试、/U、删、移或重启；输出每child固定64KiB上限，不改变原256MiB/4GiB预算。

依赖compact-single-native-scalars.ps1（原件见项目档案）仅读取元数据。语法检查`6fd8b7`及修正capture后`d333fb`均exit0；不是实际执行或纯安全完整验证。暂未压缩任何原文件，根拥有最后安全检查和实际stage独占。
