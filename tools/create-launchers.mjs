import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entries=[['Start','start --open','启动'],['Stop','stop','停止'],['Status','diagnose','诊断'],['Backup','backup','备份'],['Restore','restore','恢复']];
for(const [name,action,chinese]of entries){const cmd='@echo off\r\nchcp 65001 >nul\r\n"%~dp0runtime\\node.exe" "%~dp0service\\cli.mjs" '+action+' %*\r\nif errorlevel 1 pause\r\n'+(name==='Status'||name==='Backup'||name==='Restore'?'pause\r\n':'');
 for(const base of [name,chinese])fs.writeFileSync(path.join(root,base+'.cmd'),cmd,{flag:'wx'});
 const ps='param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)\r\n$ErrorActionPreference="Stop"\r\n& (Join-Path $PSScriptRoot "runtime/node.exe") (Join-Path $PSScriptRoot "service/cli.mjs") '+action+' @Arguments\r\nexit $LASTEXITCODE\r\n';fs.writeFileSync(path.join(root,name+'.ps1'),'\uFEFF'+ps,{flag:'wx'});
}
for(const [name,remove]of [['Install-Autostart',false],['Remove-Autostart',true]]){const cmd='@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\\autostart.ps1"'+(remove?' -Remove':'')+'\r\nif errorlevel 1 pause\r\npause\r\n';fs.writeFileSync(path.join(root,name+'.cmd'),cmd,{flag:'wx'});}
console.log('Created independent launch, stop, diagnose, backup and restore entries.');
