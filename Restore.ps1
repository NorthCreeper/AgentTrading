param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference="Stop"
& (Join-Path $PSScriptRoot "runtime/node.exe") (Join-Path $PSScriptRoot "service/cli.mjs") restore @Arguments
exit $LASTEXITCODE
