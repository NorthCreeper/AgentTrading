export const runIntentVersion='btc5m-persisted-run-intent-v1';
const modes=['observe','manual','auto'];
export function restoreRunIntent(saved,mode='observe') {
  if(saved===undefined)return {version:runIntentVersion,running:false,mode:modes.includes(mode)?mode:'observe',paused:true,revision:0,updatedAt:null};
  if(!saved||saved.version!==runIntentVersion||typeof saved.running!=='boolean'||typeof saved.paused!=='boolean'||!modes.includes(saved.mode)||!Number.isSafeInteger(saved.revision)||saved.revision<0||!(saved.updatedAt===null||Number.isFinite(saved.updatedAt)))throw Error('Invalid persisted run intent');
  return structuredClone(saved);
}
export function nextRunIntent(old,{running,mode,paused},now) {
  return restoreRunIntent({version:runIntentVersion,running,mode,paused,revision:old.revision+1,updatedAt:now});
}
export function recoveryReadiness(controller) {
  const intent=controller.runIntent;
  if(!intent?.running)return {status:'stopped-by-user',reason:'用户已停止，保持停止'};
  if(controller.running)return {status:'running',reason:'已恢复原运行状态'};
  if(controller.restoreFailed||controller.engine.halted)return {status:'blocked',reason:controller.engine.halted??'账户恢复校验失败'};
  if(controller.engine.active||controller.engine.busy)return {status:'blocked',reason:'仍有未核对的订单'};
  if(controller.runtimeClock&&!controller.runtimeClock.status().ready)return {status:'waiting-for-clock',reason:'等待独立 UTC 校时通过后恢复原运行状态'};
  return {status:'ready',reason:'账户已恢复，等待恢复原运行状态'};
}
export function createIntentRecovery(controller,{intervalMs=1000}={}) {
  let busy=false,closed=false;
  controller.runtimeRecovery={status:'checking',reason:'核对持久化运行意图'};
  const check=async()=>{
    if(busy||closed)return;busy=true;
    try {
      const state=recoveryReadiness(controller);controller.runtimeRecovery=state;
      if(state.status!=='ready')return;
      const intent=structuredClone(controller.runIntent);
      await controller.command('start',{mode:intent.mode},{expectedIntentRevision:intent.revision,restorePaused:intent.paused});
      controller.runtimeRecovery={status:'recovered',reason:intent.paused?'已恢复暂停开仓，继续管理原仓位':'已恢复原工作流',recoveredAt:controller.clock()};
    }catch(error){controller.runtimeRecovery={status:'blocked',reason:error.message};}
    finally{busy=false;}
  };
  const timer=setInterval(()=>void check(),intervalMs);timer.unref();
  return {check,close(){closed=true;clearInterval(timer);}};
}
