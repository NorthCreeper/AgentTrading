// Transport recovery only: never sends workflow start/stop/order commands.
export function createConsoleConnection({fetcher=fetch,Stream=EventSource,now=Date.now,
  schedule=setTimeout,cancel=clearTimeout,onSnapshot,onStatus=()=>{},pollMs=5000,staleMs=12000}={}) {
  let stream=null,timer=null,stopped=true,lastMessage=-Infinity,lastSuccess=-Infinity,checking=false,generation=0,lastState=null;
  const status=(transport,extra={})=>onStatus({transport,reachable:now()-lastSuccess<staleMs,lastStateAt:Number.isFinite(lastSuccess)?lastSuccess:null,...extra});
  const accept=data=>{if(!data||typeof data.token!=='string'||!data.state||typeof data.state.running!=='boolean')throw Error('后台状态格式错误');
    lastState=data.state;lastSuccess=now();onSnapshot(data.state,data.token);};
  const connectStream=()=>{
    if(stopped)return;const old=stream;stream=null;old?.close();const id=++generation;
    try{stream=new Stream('/api/events');}catch{return;}
    const current=stream;
    current.onmessage=event=>{if(stopped||id!==generation)return;try{const state=JSON.parse(event.data);if(typeof state?.running!=='boolean')throw Error('Invalid state');lastState=state;lastMessage=now();lastSuccess=now();onSnapshot(state);status('stream');}catch{status('reconnecting',{reason:'实时状态解析失败，正在重新取得完整状态'});void refresh();}};
    current.onerror=()=>{if(!stopped&&id===generation){status('reconnecting');void refresh();}};
    current.onopen=()=>{if(!stopped&&id===generation)void refresh();};
  };
  const refresh=async()=>{
    if(stopped||checking)return;checking=true;const epoch=generation;
    try{const response=await fetcher('/api/bootstrap',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('HTTP '+response.status);const data=await response.json();
      if(stopped||epoch!==generation)return;accept(data);status(now()-lastMessage<staleMs?'stream':'polling',{workflowRunning:lastState.running});
    }catch(error){if(!stopped&&epoch===generation)status('offline',{reachable:false,reason:'暂时无法访问后台，正在自动重连'});}
    finally{checking=false;}
  };
  const tick=async()=>{
    if(stopped)return;
    if(now()-lastMessage>=staleMs){await refresh();if(!stream||now()-lastMessage>=staleMs*2)connectStream();}
    if(!stopped)timer=schedule(()=>void tick(),pollMs);
  };
  return {
    async start(){if(!stopped)return;stopped=false;status('connecting',{reachable:false});await refresh();if(stopped)return;connectStream();timer=schedule(()=>void tick(),pollMs);},
    refresh,
    stop(){stopped=true;generation++;if(timer!==null)cancel(timer);timer=null;stream?.close();stream=null;},
  };
}
