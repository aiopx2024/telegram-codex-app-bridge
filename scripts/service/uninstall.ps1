$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

Ensure-ElevatedSession
$context = Get-BridgeContext

if (Test-ServiceInstalled -Context $context) {
  Stop-Service -Name $context.ServiceId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  & $context.ServiceExePath uninstall | Out-Null
}

foreach ($path in @($context.ServiceExePath, $context.ServiceXmlPath)) {
  if (Test-Path $path) {
    Remove-Item -Force -Path $path
  }
}

Write-Host "Removed Windows service: $($context.ServiceId)"
