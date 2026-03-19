$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

Ensure-ElevatedSession
$context = Get-BridgeContext

if (-not (Test-ServiceInstalled -Context $context)) {
  throw "Windows service is not installed: $($context.ServiceId)"
}

$service = Get-Service -Name $context.ServiceId
if ($service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
  Start-Service -Name $context.ServiceId
} else {
  Restart-Service -Name $context.ServiceId -Force
}

Write-Host "Restarted Windows service: $($context.ServiceId)"
