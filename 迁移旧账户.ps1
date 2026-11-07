param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$ExpectedSourceRoot,[switch]$Execute)
$ErrorActionPreference='Stop'
$legacyArguments=@('--source',$Source,'--expected-source-root',$ExpectedSourceRoot)
if($Execute){$legacyArguments+='--execute'}else{$legacyArguments+='--dry-run'}
& (Join-Path $PSScriptRoot 'runtime/node.exe') (Join-Path $PSScriptRoot 'tools/migrate-legacy.mjs') @legacyArguments
exit $LASTEXITCODE
