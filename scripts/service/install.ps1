$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

Ensure-ElevatedSession
$context = Get-BridgeContext
Ensure-BuiltBridge -Context $context
Ensure-ServiceWrapperBinary -Context $context
Write-ServiceWrapperConfig -Context $context

if (Test-ServiceInstalled -Context $context) {
  Stop-Service -Name $context.ServiceId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  & $context.ServiceExePath uninstall | Out-Null
}

& $context.ServiceExePath install | Out-Null
Start-Service -Name $context.ServiceId

Write-Host "Installed Windows service: $($context.ServiceId)"
Write-Host "Display name: $($context.ServiceName)"
Write-Host "Config file: $($context.ServiceXmlPath)"
