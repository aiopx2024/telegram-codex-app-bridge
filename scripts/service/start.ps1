$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

Ensure-ElevatedSession
$context = Get-BridgeContext

if (-not (Test-ServiceInstalled -Context $context)) {
  throw "Windows service is not installed: $($context.ServiceId)"
}

Start-Service -Name $context.ServiceId
Write-Host "Started Windows service: $($context.ServiceId)"
