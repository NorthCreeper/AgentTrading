import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
export const configVersion='btc5m-standalone-config-v1';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function atomicJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{flag:'wx',flush:true,mode:0o600});fs.renameSync(tmp,file);}
export function within(root,target){const rel=path.relative(path.resolve(root),path.resolve(target));return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
export function relativePath(value){
 if(typeof value!=='string'||!value||value.includes('\\')||value.startsWith('/')||value.includes(':')||value.includes('\0'))throw Error('配置路径必须是应用目录内的相对路径');
 const parts=value.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[<>"|?*\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('配置或备份路径无效');return parts.join('/');
}
export function assertNoLinks(root,target){if(!within(root,target))throw Error('路径超出应用目录');let cur=path.resolve(root);for(const part of path.relative(root,target).split(path.sep)){cur=path.join(cur,part);if(fs.existsSync(cur)&&fs.lstatSync(cur).isSymbolicLink())throw Error('不允许通过链接访问应用目录外的数据');}}
export function configPaths(root,config){
 if(config?.version!==configVersion)throw Error('独立版配置版本不受支持');const port=config.server?.port;
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('控制台端口无效');
 const names={data:'data/paper',liveData:'data/live',logs:'logs',backups:'backups',resources:'resources'},result={};
 for(const [key,fallback]of Object.entries(names)){const rel=relativePath(config.paths?.[key]??fallback);result[key]=path.resolve(root,rel);assertNoLinks(root,result[key]);}
 const values=Object.values(result);for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)if(values[i]===values[j]||within(values[i],values[j])||within(values[j],values[i]))throw Error('数据、日志、资源及备份目录不能相互包含');
 for(const value of values)if(['app','runtime','service','tools','config'].some(name=>value===path.join(root,name)||within(path.join(root,name),value)||within(value,path.join(root,name))))throw Error('运行数据不能覆盖应用程序目录');
 return {...result,dataDirectory:result.data,node:path.join(root,'runtime/node.exe'),start:path.join(root,'app/start.mjs'),service:path.join(root,'service'),config:path.join(root,'config/app.json'),instance:path.join(root,'config/instance.json')};
}
function loadInstance(file,create){
 if(!fs.existsSync(file)){if(!create)throw Error('尚未创建本机实例标识');fs.mkdirSync(path.dirname(file),{recursive:true});let fd;
  try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({version:'btc5m-standalone-instance-v1',instanceId:randomUUID(),createdAt:Date.now()},null,2));fs.fsyncSync(fd);}
  catch(e){if(e.code!=='EEXIST')throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}}
 let value;for(let n=0;n<20;n++){try{value=readJson(file);break;}catch(e){if(n===19)throw Error('实例标识损坏；保留原文件，不创建替代身份');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
 if(value?.version!=='btc5m-standalone-instance-v1'||!/^[0-9a-f-]{36}$/i.test(value.instanceId))throw Error('实例标识无效');return value;
}
export function loadStandaloneContext(root,{createIdentity=true}={}){
 root=fs.realpathSync.native(path.resolve(root));const config=readJson(path.join(root,'config/app.json')),paths=configPaths(root,config),instance=loadInstance(paths.instance,createIdentity);
 const identity={version:'btc5m-portable-identity-v1',service:'btc5m-standalone',instanceId:instance.instanceId,rootId:sha256(root.toLowerCase())};
 return {root,config,paths,identity,portableIdentity:identity,api:'http://127.0.0.1:'+config.server.port};
}
export const sameIdentity=(a,b)=>!!a&&!!b&&a.instanceId===b.instanceId&&a.rootId===b.rootId;
export function verifyRuntime(ctx){
 if(!fs.existsSync(ctx.paths.node))throw Error('随附的 Node 运行程序缺失；请重新解压完整应用');
 const manifestPath=path.join(ctx.root,'package-manifest.json');let expected=ctx.config.runtime?.nodeSha256;
 if(!expected&&fs.existsSync(manifestPath)){const m=readJson(manifestPath);expected=m.node?.sha256??m.files?.find(f=>f.path==='runtime/node.exe')?.sha256;}
 if(!expected)throw Error('缺少随附 Node 的校验清单');if(sha256(fs.readFileSync(ctx.paths.node)).toLowerCase()!==expected.toLowerCase())throw Error('随附 Node 校验失败，保持停止');
 return true;
}
