param([switch]$Remove)
$ErrorActionPreference='Stop'
$portableRoot=Split-Path -Parent $PSScriptRoot
$portableNode=Join-Path $portableRoot 'runtime\node.exe'
$portableCli=Join-Path $PSScriptRoot 'cli.mjs'
$portableIdentityText=& $portableNode $portableCli identity
if($LASTEXITCODE -ne 0){throw '无法核验本应用身份，未修改登录启动项'}
$portableDetails=$portableIdentityText|ConvertFrom-Json
$portableId=$portableDetails.portableIdentity
$portableTaskName='BTC5M-Standalone-'+$portableId.instanceId.Substring(0,12)
$portableDescription='BTC5M standalone '+$portableId.instanceId+' root='+$portableId.rootId
$portableScheduler=New-Object -ComObject 'Schedule.Service'
$portableScheduler.Connect()
$portableFolder=$portableScheduler.GetFolder('\')
$portableExisting=$null
try{$portableExisting=$portableFolder.GetTask($portableTaskName)}catch{}
if($portableExisting -and $portableExisting.Definition.RegistrationInfo.Description -ne $portableDescription){throw '同名启动项属于另一个目录或安装；未覆盖，请先从原目录移除登录启动项'}
if($Remove){if($portableExisting){$portableFolder.DeleteTask($portableTaskName,0)};'已移除此独立版的登录启动项；未关闭正在运行的工作流。';exit 0}
$portableUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$portableTask=$portableScheduler.NewTask(0)
$portableTask.RegistrationInfo.Description=$portableDescription
$portableTask.Principal.UserId=$portableUser
$portableTask.Principal.LogonType=3
$portableTask.Principal.RunLevel=0
$portableTask.Settings.Enabled=$true
$portableTask.Settings.Hidden=$true
$portableTask.Settings.ExecutionTimeLimit='PT0S'
$portableTask.Settings.MultipleInstances=2
$portableTask.Settings.DisallowStartIfOnBatteries=$false
$portableTask.Settings.StopIfGoingOnBatteries=$false
$portableTask.Settings.StartWhenAvailable=$true
$portableTask.Settings.RestartCount=3
$portableTask.Settings.RestartInterval='PT1M'
$portableTrigger=$portableTask.Triggers.Create(9)
$portableTrigger.UserId=$portableUser
$portableTrigger.Delay='PT10S'
$portableTrigger.Enabled=$true
$portableAction=$portableTask.Actions.Create(0)
$portableAction.Path=Join-Path $PSScriptRoot 'headless-host.exe'
$portableLogs=Join-Path $portableRoot $portableDetails.config.paths.logs
$portableAction.Arguments='"'+$portableNode+'" "'+(Join-Path $PSScriptRoot 'autostart.mjs')+'" "'+$portableRoot+'" "'+(Join-Path $portableLogs 'autostart-host')+'"'
$portableAction.WorkingDirectory=$portableRoot
$null=$portableFolder.RegisterTaskDefinition($portableTaskName,$portableTask,6,$portableUser,$null,3)
'已设置当前用户登录后启动此控制台。默认仍保持策略停止；已明确关闭的后台不会被登录启动推翻。'
