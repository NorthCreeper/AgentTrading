import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync,existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardController, ControlError } from './controller.mjs';
import { snapshotWriter } from './snapshot-stream.mjs';
import { WalletBalance } from './wallet-balance.mjs';
import {createRuntimeClock} from './runtime-clock.mjs';
import {launchDashboard} from './process-runtime.mjs';
import {serviceHealth,readAuditStatus} from './service-health.mjs';
import {BusinessHealthMonitor} from './business-health.mjs';
import {createIndependentResearchHealthReader} from './independent-research-health.mjs';
import {createRayRuntimeCheck} from './ray-runtime-check.mjs';
import {writeJsonAtomic} from './atomic-json.mjs';
import {createResearchArchive} from './research-archive.mjs';
import {pipeline} from 'node:stream/promises';
import {annotateTradingSnapshot,annotateTradesExport,annotateSettlementQueue} from './trade-record-annotations.mjs';
import {createTradeLedger} from './trade-ledger.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const portableRoot=resolve(root,'../../..');
export async function createDashboardServer({ directory = join(root, 'runtime'), controller, server:providedServer=null,walletBalance = new WalletBalance(),
  portableIdentity=null,controllerInitialized=false,extensionRouter=null,extensionClose=null,extensionStatus=null,extensionBeforeControl=null,
  archiveAllowedRoots=[join(portableRoot,'archives')],archiveProtectedRoots=[join(portableRoot,'config'),join(portableRoot,'data'),join(portableRoot,'app'),join(portableRoot,'resources'),join(portableRoot,'runtime'),join(portableRoot,'service'),join(portableRoot,'node_modules')],archiveRelativePaths=true,legacyAuditStatusPath=null,
  admissionResearchConfig={stage:3,validationEnabled:true,
    artifactPath:join(portableRoot,'resources/terminal-admission-artifact.json'),
    artifactSha256:'fe5865209d2f25b06fd9a15c27f6a7a99acac232ca351087fcda69303fd821f2',
    directory:join(portableRoot,'data/observations')},
  researchArchive:providedResearchArchive=null,researchArchiveManifest=join(portableRoot,'archives/catalog.json'),
  rayAuditRegistrationPath=process.env.BTC5M_RAY_ALIGNMENT_REGISTRATION??join(portableRoot,'data/audit/ray-registration.json'),
  independentResearchHealthReader,independentResearchManifest=null } = {}) {
  let runtimeClock=controller?.runtimeClock??null;
  if(!controller){runtimeClock=await createRuntimeClock();controller=new DashboardController({directory,clock:runtimeClock.now,admissionResearchConfig});controller.runtimeClock=runtimeClock;}
  if(!controllerInitialized)await controller.initialize();
  const displaySnapshot=()=>({...annotateTradingSnapshot(controller.snapshot()),portableIdentity,liveTrading:extensionStatus?.()??null});
  const tradeLedger=createTradeLedger({directory,getSnapshot:()=>({sessionId:controller.sessionId,realTrading:false,
    experiment:controller.experiment,strategyTrade:controller.strategyTrade,rayOwnedPositions:controller.rayOwnedPositions,
    pendingSettlements:controller.pendingSettlements,orders:controller.broker?.orders?[...controller.broker.orders.values()]:[],
    portfolio:controller.accountMetrics?.saved?.()}),clock:()=>typeof controller.clock==='function'?controller.clock():Date.now()});
  const researchArchive=providedResearchArchive??createResearchArchive({manifestPath:researchArchiveManifest,
    liveRuntimePath:directory,getLiveSessionId:()=>controller.sessionId,allowedRoots:archiveAllowedRoots,protectedRoots:archiveProtectedRoots,relativePaths:archiveRelativePaths});
  const rayAudit=createRayRuntimeCheck({registrationPath:rayAuditRegistrationPath,clock:()=>typeof controller.clock==='function'?controller.clock():Date.now()});
  const checkRay=(state=controller.snapshot())=>{
    let result;
    try{
      const pending=controller.pendingSettlements??[],owned=state.strategy?.rayOwnedPositions??[],closed=controller.experiment?.recentTrades??[];
      const labels=typeof controller.financialLabels==='function'?controller.financialLabels():new Map();
      const slugs=new Set([...pending,...owned,...closed].map(p=>p.slug));
      result=rayAudit.check({...state,rayAuditEvidence:{pendingSettlements:structuredClone(pending),closedTrades:structuredClone(closed),
        financialLabels:Object.fromEntries([...slugs].filter(slug=>labels.has(slug)).map(slug=>[slug,structuredClone(labels.get(slug))]))}});
    }catch(error){result={status:'degraded',scope:'current-ray-runtime-only',allHistoryVerified:false,checkedAt:state.now,errors:[{check:'runtime-observer',message:error.message}]};}
    if(controller.serviceRuntime?.managed&&existsSync(dirname(rayAuditRegistrationPath))){
      try{writeJsonAtomic(join(dirname(rayAuditRegistrationPath),'status.json'),result);}
      catch(error){result={...result,status:'degraded',persistenceError:error.message};}
    }
    return result;
  };
  const rayAuditTimer=setInterval(()=>checkRay(),30000);rayAuditTimer.unref();
  const businessMonitor=new BusinessHealthMonitor({write:row=>controller.admissionResearch?.validation?controller.admissionResearch.record(row):true});
  const businessTimer=setInterval(()=>{try{businessMonitor.observe(controller.snapshot());}catch(error){businessMonitor.error=error.message;}},5000);businessTimer.unref();
  const independentResearch=independentResearchHealthReader??(independentResearchManifest?createIndependentResearchHealthReader({pointerPath:independentResearchManifest}):{snapshot:()=>({status:'not-configured',hasErrors:false,services:[],scope:'Fresh standalone instance does not launch or certify archived independent observers.'}),close(){}});
  const walletTimer = setInterval(() => { void walletBalance.refresh(); }, 10000);
  walletTimer.unref();
  const token = randomBytes(32).toString('hex');
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'],
    '/chart-model.mjs': ['chart-model.mjs', 'text/javascript; charset=utf-8'],
    '/amount-order.mjs': ['../amount-order.mjs', 'text/javascript; charset=utf-8'],
    '/one-tap-order.mjs': ['../one-tap-order.mjs', 'text/javascript; charset=utf-8'],
    '/buy-presets.mjs': ['buy-presets.mjs', 'text/javascript; charset=utf-8'],
    '/book-status.mjs': ['book-status.mjs', 'text/javascript; charset=utf-8'],
    '/portfolio-panel.mjs': ['portfolio-panel.mjs', 'text/javascript; charset=utf-8'],
    '/continuation-panel.mjs': ['continuation-panel.mjs', 'text/javascript; charset=utf-8'],
    '/adaptive-panel.mjs': ['adaptive-panel.mjs', 'text/javascript; charset=utf-8'],
    '/adaptive-account-panel.mjs': ['adaptive-account-panel.mjs', 'text/javascript; charset=utf-8'],
    '/settlement-queue-panel.mjs': ['settlement-queue-panel.mjs', 'text/javascript; charset=utf-8'],
    '/ray-entry-panel.mjs': ['ray-entry-panel.mjs', 'text/javascript; charset=utf-8'],
    '/recovery-baseline-panel.mjs': ['recovery-baseline-panel.mjs', 'text/javascript; charset=utf-8'],
    '/ray-console-panel.mjs': ['ray-console-panel.mjs', 'text/javascript; charset=utf-8'],
    '/archive-panel.mjs': ['archive-panel.mjs', 'text/javascript; charset=utf-8'],
    '/ledger-panel.mjs': ['ledger-panel.mjs', 'text/javascript; charset=utf-8'],
    '/market-time.mjs': ['market-time.mjs', 'text/javascript; charset=utf-8'],
    '/evolution-panel.mjs': ['evolution-panel.mjs', 'text/javascript; charset=utf-8'],
    '/wallet-client.mjs': ['wallet-client.mjs', 'text/javascript; charset=utf-8'],
    '/wallet-entry.mjs': ['wallet-entry.mjs', 'text/javascript; charset=utf-8'],
    '/paper-broker.mjs': ['../paper-broker.mjs', 'text/javascript; charset=utf-8'],
    '/charts.mjs': ['charts.mjs', 'text/javascript; charset=utf-8'],
    '/strategy-comparison.json': ['reports/strategy-comparison.json', 'application/json; charset=utf-8'],
    '/parameter-research.json': ['reports/parameter-research.json', 'application/json; charset=utf-8'],
    '/structure-research.json': ['reports/structure-research.json', 'application/json; charset=utf-8'],
    '/settlement-research.json': ['reports/settlement-research.json', 'application/json; charset=utf-8'],
    '/settlement-forward-research.json': ['reports/settlement-forward-research.json', 'application/json; charset=utf-8'],
    '/p3-value-calibration.json': ['reports/p3-value-calibration.json', 'application/json; charset=utf-8'],
    '/console-connection.mjs':['console-connection.mjs','text/javascript; charset=utf-8'],
    '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const server=providedServer??http.createServer();
  if(providedServer)server.removeAllListeners('request');
  server.on('request',async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.map(h => `http://${h}`).includes(req.headers.origin)))
      return json(res, 403, { error: '仅允许从本机控制台访问' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      const authorizeControl=()=>{const supplied=Buffer.from(String(req.headers['x-control-token']??'')),expected=Buffer.from(token);if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){json(res,403,{error:'控制台会话已变化，请刷新页面'});return false;}return true;};
      const readJsonBody=async()=>{if(!req.headers['content-type']?.startsWith('application/json'))throw new ControlError('请求格式必须为 JSON');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)throw new ControlError('请求过大');}try{const value=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new ControlError('请求内容无效');}};
      if(extensionRouter&&await extensionRouter({req,res,url,controller,json,displaySnapshot,portableIdentity,authorizeControl,readJsonBody}))return;
      if(req.method==='GET'&&url.pathname==='/api/portable-identity')return json(res,200,{portableIdentity});
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(root, file))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {const state=controller.snapshot();return json(res,200,{portableIdentity,liveTrading:extensionStatus?.()??null,...serviceHealth(state,{
        auditStatus:legacyAuditStatusPath?readAuditStatus(legacyAuditStatusPath):{status:'not-configured',message:'独立新实例未导入旧自动审计，未认证旧历史'},
        clock:controller.runtimeClock?.status()??null,independentResearch:independentResearch.snapshot({now:state.now})}),business:businessMonitor.observe(state),rayAudit:checkRay(state)});}
      if(req.method==='GET'&&url.pathname==='/api/admission-validation')return json(res,200,controller.snapshot().strategy?.admissionResearch?.validation??{status:'disabled'});
      if (req.method === 'GET' && url.pathname === '/api/ray-runtime-check') return json(res,200,checkRay());
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, { token, portableIdentity, state: displaySnapshot() });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, displaySnapshot());
      if(req.method==='GET'&&url.pathname==='/api/trade-ledger')return json(res,200,await tradeLedger.query(url.searchParams));
      if(req.method==='GET'&&url.pathname==='/api/trade-ledger/export'){
        const exported=await tradeLedger.export(url.searchParams,url.searchParams.get('format')??'json');
        res.writeHead(200,{'Content-Type':exported.contentType,
          'Content-Disposition':`attachment; filename="${exported.fileName}"`});res.end(exported.body);return;
      }
      if(req.method==='GET'&&url.pathname==='/api/research-archive')return json(res,200,await researchArchive.summary());
      if(req.method==='GET'&&url.pathname==='/api/research-archive/files')return json(res,200,await researchArchive.list({
        groupId:url.searchParams.get('groupId')??'',q:url.searchParams.get('q')??'',
        offset:Number(url.searchParams.get('offset')??0),limit:Number(url.searchParams.get('limit')??30)}));
      if(req.method==='GET'&&url.pathname==='/api/research-archive/preview')return json(res,200,await researchArchive.preview(url.searchParams.get('id')));
      if(req.method==='GET'&&url.pathname==='/api/research-archive/file'){
        const file=await researchArchive.openFile(url.searchParams.get('id'));
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,
          'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`});
        try{await pipeline(file.stream,res);}catch{res.destroy();}return;
      }
      if (req.method === 'GET' && url.pathname === '/api/wallet-balance') return json(res, 200, walletBalance.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/data-audit') return json(res,200,controller.snapshot().dataAudit);
      if (req.method === 'GET' && url.pathname === '/api/settlement-queue') return json(res,200,annotateSettlementQueue(controller.settlementQueueSummary()));
      if (req.method === 'GET' && url.pathname === '/api/strategy-evolution') return json(res,200,{summary:controller.snapshot().strategy.evolution,state:controller.evolutionCoordinator?.state??null});
      if (req.method === 'GET' && url.pathname === '/api/p2-context') return json(res,200,controller.snapshot().strategy.researchP2);
      if (req.method === 'GET' && url.pathname === '/api/p3-study') {
        return json(res,200,{summary:controller.snapshot().strategy.researchP3,state:controller.p3Study?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/p3-confirmation') {
        return json(res,200,{summary:controller.snapshot().strategy.researchP3b,state:controller.p3Confirmation?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/p3-value') {
        return json(res,200,{summary:controller.snapshot().strategy.researchValue,state:controller.valueResearch?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/p3-continuation') {
        return json(res,200,{summary:controller.snapshot().strategy.researchContinuation,state:controller.continuationStudy?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/p3-adaptive') {
        return json(res,200,{summary:controller.snapshot().strategy.researchAdaptive,state:controller.adaptiveResearch?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/p3-adaptive-account') {
        return json(res,200,{summary:controller.snapshot().strategy.researchAdaptiveAccount,state:controller.adaptiveAccountStudy?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/p1-study') {
        res.setHeader('Content-Disposition','attachment; filename="btc5m-p1-study.json"');
        return json(res,200,{summary:controller.snapshot().strategy.researchP1,state:controller.p1Study?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/strategy-observation') {
        res.setHeader('Content-Disposition','attachment; filename="btc5m-strategy-observation.json"');
        return json(res,200,{scope:'Cumulative totals; active entries and latest 80 finished records. Full journal is stored locally.',
          error:controller.observationError??null,state:controller.strategyObservation?.state??null});
      }
      if (req.method === 'GET' && url.pathname === '/api/strategy-trades') {
        res.setHeader('Content-Disposition','attachment; filename="btc5m-strategy-trades.json"');
        return json(res,200,annotateTradesExport(controller.exportStrategyTrades()));
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.setHeader('Content-Disposition', 'attachment; filename="btc5m-session.json"');
        return json(res, 200, displaySnapshot());
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        const writer = snapshotWriter(res), send = state=>writer.send(annotateTradingSnapshot(state));
        send(controller.snapshot());
        const timer = setInterval(() => send(controller.snapshot()), 1000);
        timer.unref();
        res.once('close', () => { clearInterval(timer); writer.close(); }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const supplied = Buffer.from(String(req.headers['x-control-token'] ?? ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 403, { error: '控制台会话已变化，请刷新页面' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '请求格式必须为 JSON' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16_384) return json(res, 413, { error: '请求过大' }); }
        let payload; try { payload = JSON.parse(body); } catch { return json(res, 400, { error: '请求格式错误' }); }
        if (!payload || typeof payload !== 'object') return json(res, 400, { error: '请求内容无效' });
        let beforeControl = extensionBeforeControl?.(payload);
        if (beforeControl?.then) beforeControl = await beforeControl;
        let result;
        if (beforeControl?.handled) result = beforeControl.result;
        else if (payload.action === 'walletConnect') {
          try { walletBalance.connect(payload.input); } catch (error) { throw new ControlError(error.message); }
          void walletBalance.refresh();
          result = { wallet: walletBalance.snapshot() };
        } else if (payload.action === 'walletDisconnect') result = { wallet: walletBalance.disconnect() };
        else if (payload.action === 'walletRefresh') {
          void walletBalance.refresh({ force: true });
          result = { wallet: walletBalance.snapshot() };
        } else result = await controller.command(payload.action, payload.input);
        return json(res, 200, { ...result, state: displaySnapshot() });
      }
      json(res, 404, { error: '页面或接口不存在' });
    } catch (error) {
      if(url.pathname.startsWith('/api/trade-ledger'))return json(res,[400,404,409,503].includes(error.statusCode)?error.statusCode:503,{error:error.statusCode?error.message:'账本暂时不可读，请稍后刷新；交易模块继续独立运行'});
      if(url.pathname.startsWith('/api/research-archive'))return json(res,[400,403,404,409,413,503].includes(error.statusCode)?error.statusCode:503,{error:error.message??'档案暂时不可读'});
      json(res, error instanceof ControlError ? 409 : 500, { error: error instanceof ControlError ? error.message : '操作失败，请查看运行日志' });
    }
  });
  server.requestTimeout = 15_000;
  server.once('close', () => { clearInterval(walletTimer);clearInterval(rayAuditTimer);clearInterval(businessTimer);rayAudit.close();walletBalance.disconnect();runtimeClock?.close();independentResearch.close?.();tradeLedger.close();try{Promise.resolve(extensionClose?.()).catch(()=>{});}catch{} });
  return { server, controller, walletBalance };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.BTC5M_DASHBOARD_PORT ?? 18790);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const directory=resolve(process.env.BTC5M_DATA_DIRECTORY??join(root,'runtime'));
  try {
    const {server}=await launchDashboard({directory,port,factory:createDashboardServer,recoverIntent:process.env.BTC5M_RECOVER_INTENT==='1'});
    server.on('error',error=>{console.error(error.message);process.exitCode=1;});
    console.log('BTC5M 控制台：http://127.0.0.1:'+port+' （模拟模式，单实例保护）');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
