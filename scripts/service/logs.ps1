param(
  [int]$Lines = 200,
  [switch]$Follow
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

$context = Get-BridgeContext
Ensure-BridgeDirectories -Context $context

$logFiles = Get-ChildItem -Path $context.AppLogDir -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime

if (-not $logFiles) {
  Write-Host "No log files found under $($context.AppLogDir)"
  exit 0
}

$paths = @($logFiles | ForEach-Object { $_.FullName })
if ($Follow) {
  Get-Content -Path $paths -Tail $Lines -Wait
} else {
  Get-Content -Path $paths -Tail $Lines
}
