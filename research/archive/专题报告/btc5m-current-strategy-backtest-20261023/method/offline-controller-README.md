# 原生产交易链离线适配器

```js
const c = createOfflineController({
  config, strategyConfig, startingCash:943.53077312,
  clock:()=>at,
  getClockStatus:frame=>frame?.clock ?? {ready:false},
  labelMap, // Map<slug, original verified financial label>
  recordFilter:suffix=>suffix==='' || suffix==='-trades',
  onRecord:(suffix,row)=>saveResearchRecord(suffix,row),
});
at = frame.now;
await c.observe(frame); // native acceptFrame, returns c without full snapshot
// c.acceptFrame(structuredClone(frame)) is also the retained original method.

// At an original received price event, without making a new entry opportunity:
at = price.receivedAt;
c.acceptPrice(price); // original production method

// At verified official label observedAt / a maintenance event:
at = label.observedAt;
await c.advance(); // original sync / park / settle / engine tick; no autoStep

const final = c.snapshotOffline(); // explicit, potentially large
```

调用者必须给出真实冻结的完整config、strategyConfig、明确初始资金、仿真时钟和labelMap；适配器不补策略默认参数。源frame和price的接收顺序、当时开盘是否可知、windowSeconds证据及各类完整性由数据调度器负责，adapter不添加信息。

`getClockStatus` 可传入仿真当前校时状态；未提供时取原frame.clock。缺失明确为ready=false。labelMap可以包含未来证据，真实validManagedSettlement仍要求observedAt<=仿真now，因此不会提前兑付。

`preservedMethods` 列出原型引用保持相同的核心交易方法。只有记录、保存、影子观察和账户统计副作用被隔离，事件中归属、entryLots、订单报告、真实Lifecycle与PaperBroker全部保留。`save()` 会抛错，不能误调用运行时命令持久化。

`recordFilter` 只过滤离线输出的数据复制，原record/event方法调用及财务动作仍运行。`observe` 和 `advance` 默认返回控制器本身；需要完整复制时传第二参数 `{snapshot:true}` 或显式 `snapshotOffline()`。

4项测试与真实构造器副本逐步核对通过。副本会在 `method/parity-runtimes/` 保留原构造器影子文件，未initialize、未启动feed、无网络交易；此目录不应纳入真实历史样本。调度器也不应把副本记录混入正式回测。

适配器当前直接引用实际生产模块，并用源码冻结清单前后核对无漂移。完整静态模块和报告副本在 `production-source/`；另一个top-level JSON资产见 `controller-extra-assets-freeze.json`，已验证该副本Controller可独立import。没有替换生产文件。
