import fs from 'node:fs';import path from 'node:path';import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
export const vaultFilename='credentials.vault.json';
const privatePattern=/^0x[0-9a-fA-F]{64}$/;
function password(value){if(typeof value!=='string'||value.length<12||value.length>1024)throw Error('解锁密码至少12个字符');return value;}
export function validateCredentials(value){
 if(!value||typeof value!=='object'||!privatePattern.test(value.privateKey??'')||/^0x0{64}$/i.test(value.privateKey))throw Error('请输入有效的专用签名私钥');
 const result={privateKey:value.privateKey};
 if(value.credentials){const c=value.credentials;if(!['key','secret','passphrase'].every(k=>typeof c[k]==='string'&&c[k].length>0&&c[k].length<=2048))throw Error('CLOB凭据格式无效');result.credentials={key:c.key,secret:c.secret,passphrase:c.passphrase};}
 if(value.relayerApiKey){const r=value.relayerApiKey;if(typeof r.key!=='string'||!r.key||!/^0x[0-9a-fA-F]{40}$/.test(r.address??''))throw Error('Relayer凭据格式无效');result.relayerApiKey={key:r.key,address:r.address};}
 return result;
}
export function atomicWrite(filename,value){fs.mkdirSync(path.dirname(filename),{recursive:true});const temp=filename+'.'+randomBytes(8).toString('hex')+'.tmp';let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,filename);}finally{if(fd!==undefined&&fd!==null)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}}
export function saveVault(directory,value,passphrase){const secret=validateCredentials(value),salt=randomBytes(16),iv=randomBytes(12),key=scryptSync(password(passphrase),salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('btc5m-live-vault-v1'));const encrypted=Buffer.concat([cipher.update(JSON.stringify(secret),'utf8'),cipher.final()]);atomicWrite(path.join(directory,vaultFilename),{version:'btc5m-live-vault-v1',kdf:'scrypt-N32768-r8-p1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')});return{exists:true,encrypted:true,locked:true};}finally{key.fill(0);}}
export function openVault(directory,passphrase){let key;try{const file=path.join(directory,vaultFilename);if(fs.statSync(file).size>32768)throw Error();const v=JSON.parse(fs.readFileSync(file,'utf8'));if(v.version!=='btc5m-live-vault-v1'||v.kdf!=='scrypt-N32768-r8-p1')throw Error();
 const salt=Buffer.from(v.salt,'base64'),iv=Buffer.from(v.iv,'base64'),tag=Buffer.from(v.tag,'base64'),data=Buffer.from(v.ciphertext,'base64');if(salt.length!==16||iv.length!==12||tag.length!==16||data.length>16384)throw Error();key=scryptSync(password(passphrase),salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('btc5m-live-vault-v1'));decipher.setAuthTag(tag);const clear=Buffer.concat([decipher.update(data),decipher.final()]);try{return validateCredentials(JSON.parse(clear.toString('utf8')));}finally{clear.fill(0);}
 }catch{throw Error('无法解锁凭据：密码不正确或加密文件损坏');}finally{key?.fill(0);}}
export function vaultStatus(directory){return{exists:fs.existsSync(path.join(directory,vaultFilename)),encrypted:true};}
