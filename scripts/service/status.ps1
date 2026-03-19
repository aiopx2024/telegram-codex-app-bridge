$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

$context = Get-BridgeContext
$service = Get-Service -Name $context.ServiceId -ErrorAction SilentlyContinue
if (-not $service) {
  throw "Windows service is not installed: $($context.ServiceId)"
}

$service | Format-List Name, DisplayName, Status, ServiceType

if (Test-Path $context.StatusFile) {
  Write-Host ''
  Write-Host 'Runtime status:'
  Get-Content -Raw -Path $context.StatusFile
}
