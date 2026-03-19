$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

Ensure-ElevatedSession
$context = Get-BridgeContext

if (-not (Test-ServiceInstalled -Context $context)) {
  throw "Windows service is not installed: $($context.ServiceId)"
}

Stop-Service -Name $context.ServiceId -Force
Write-Host "Stopped Windows service: $($context.ServiceId)"
