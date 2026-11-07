# 历史回测输入可用性审计

截止时间沿用前次统计冻结值 1792687934075；范围为相同的 5,706 个完整盘口，其中包含更换策略前记录。只扫描派生执行深度和canonical TWAP压缩文件，未重扫原始13.9GB，未修改生产或主回测引擎。

最后120秒共 657,767 帧。所有计数以真实保存帧计算，不插值，不将缺失当成已拒绝交易或已确认零成交。

| 条件 | 总帧 | 至少一帧盘口 | 零帧盘口 | 24个5秒格均覆盖盘口 | 最大间隔及边界均≤3秒盘口 | 每轮帧数 最少/中位/最多 |
|---|---:|---:|---:|---:|---:|---:|
| rawFullDepthPair | 657,767 | 5,706 | 0 | 5,706 | 5,267 | 58/117/120 |
| numericClockFreshPair | 628,120 | 5,500 | 206 | 5,471 | 4,860 | 0/116/120 |
| numericFreshTwoSidedPair | 309,982 | 5,177 | 529 | 69 | 41 | 0/58/119 |
| utcReadyClockFreshPair | 158,818 | 1,432 | 4,274 | 1,430 | 1,073 | 0/0/119 |
| utcReadyFreshTwoSidedPair | 75,996 | 1,341 | 4,365 | 15 | 6 | 0/0/119 |

“完整深度书已记录”允许bid或ask数组为空，仅表示保存了原来的完整响应。它不等于两侧均有可成交报价。numericClockFreshPair要求两个token各恰有一份有效深度，同时 source timestamp ≤ transport received ≤ local received ≤ capture now，每项年龄均在0–3000毫秒。numericFreshTwoSidedPair再要求Up和Down两份书各自bid/ask非空且未交叉。UTCready条件另外要求原frame.clock.ready===true。

所有 1,315,534 份末120秒盘口书的源时间语义：unverified-server-timestamp=1,315,534。数值顺序与UTCready均不能证明这个源时间就是已认证的上游事件时间。回放成交是模型结果，不是交易所认证历史成交。

## 开盘基准与会话关联

5706轮中：有exact-start原始报告 5,627；有原始primary witness 5,627；与执行帧canonical session相同 5,627；跨session 0；session未知 79。数值与已核实官方K一致 5,627；primaryKnownAt早于末120秒开始 5,627。

映射使用原price报告primaryWitness.sourceId及冻结源清单，未按事后收益选择会话。跨会话和未知明细、所有逐轮有效帧数和覆盖格、缺陷原因与输入SHA保存在同名JSON中。

另只读核对上一轮冻结的开盘候选记录：79轮primary exact-start缺失盘口共25个原始候选，其中满足官方Gamma来源、明确60秒窗口、exact-start及末120秒前已知的有效候选为0。常规分支保留K未知；策略二独立冲量若仅用已知TWAP之间的差值，不因缺K而整轮删除。详见missing-opening-original-candidate-audit.json。
