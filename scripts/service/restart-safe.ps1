$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\windows-common.ps1"

$context = Get-BridgeContext

function Get-BooleanEnv {
  param(
    [string]$Name,
    [bool]$DefaultValue
  )

  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $DefaultValue
  }

  return -not ($value -eq '0' -or $value -eq 'false')
}

function Get-IntEnv {
  param(
    [string]$Name,
    [int]$DefaultValue
  )

  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $DefaultValue
  }

  $parsed = 0
  if ([int]::TryParse($value, [ref]$parsed)) {
    return $parsed
  }

  return $DefaultValue
}

function Get-ConfigValue {
  param([string]$Key)

  $processValue = [Environment]::GetEnvironmentVariable($Key, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue
  }

  if ($context.EnvData.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($context.EnvData[$Key])) {
    return [string]$context.EnvData[$Key]
  }

  return $null
}

function Invoke-NodeSnippet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Script,
    [string[]]$Arguments = @(),
    [switch]$IgnoreExitCode
  )

  $output = & $context.NodeBin -e $Script -- @Arguments 2>$null
  $exitCode = Get-NativeExitCode
  if ($exitCode -ne 0 -and -not $IgnoreExitCode) {
    throw "Node helper failed with exit code $exitCode."
  }

  if ($output -is [array]) {
    return (($output -join [Environment]::NewLine).Trim())
  }

  if ($null -eq $output) {
    return ''
  }

  return ([string]$output).Trim()
}

function Normalize-LocaleCode {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return 'en'
  }

  $normalized = $Value.ToLowerInvariant()
  if ($normalized.StartsWith('zh')) {
    return 'zh'
  }
  if ($normalized.StartsWith('fr')) {
    return 'fr'
  }
  return 'en'
}

function Get-MessageText {
  param(
    [string]$Locale,
    [string]$Key
  )

  switch ("$Locale`:$Key") {
    'zh:restart_started' { return '[bridge] restart started' }
    'zh:restart_succeeded' { return '[bridge] restart succeeded' }
    'zh:restart_failed' { return '[bridge] restart failed' }
    'zh:building_bridge' { return 'Building bridge...' }
    'zh:restarting_service' { return 'Restarting service...' }
    'zh:time_label' { return 'time' }
    'zh:run_id_label' { return 'run_id' }
    'zh:commit_label' { return 'commit' }
    'zh:pid_label' { return 'pid' }
    'zh:status_label' { return 'status' }
    'zh:timeout_label' { return 'timeout_sec' }
    'zh:last_status_updated_at_label' { return 'last_status_updated_at' }
    'zh:running_label' { return 'running' }
    'zh:connected_label' { return 'connected' }
    'zh:error_label' { return 'error' }
    'fr:restart_started' { return '[bridge] redemarrage lance' }
    'fr:restart_succeeded' { return '[bridge] redemarrage reussi' }
    'fr:restart_failed' { return '[bridge] redemarrage echoue' }
    'fr:building_bridge' { return 'Construction du bridge...' }
    'fr:restarting_service' { return 'Redemarrage du service...' }
    'fr:time_label' { return 'heure' }
    'fr:run_id_label' { return 'run_id' }
    'fr:commit_label' { return 'commit' }
    'fr:pid_label' { return 'pid' }
    'fr:status_label' { return 'statut' }
    'fr:timeout_label' { return 'timeout_sec' }
    'fr:last_status_updated_at_label' { return 'derniere_mise_a_jour_statut' }
    'fr:running_label' { return 'actif' }
    'fr:connected_label' { return 'connecte' }
    'fr:error_label' { return 'erreur' }
    'en:restart_started' { return '[bridge] restart started' }
    'en:restart_succeeded' { return '[bridge] restart succeeded' }
    'en:restart_failed' { return '[bridge] restart failed' }
    'en:building_bridge' { return 'Building bridge...' }
    'en:restarting_service' { return 'Restarting service...' }
    'en:time_label' { return 'time' }
    'en:run_id_label' { return 'run_id' }
    'en:commit_label' { return 'commit' }
    'en:pid_label' { return 'pid' }
    'en:status_label' { return 'status' }
    'en:timeout_label' { return 'timeout_sec' }
    'en:last_status_updated_at_label' { return 'last_status_updated_at' }
    'en:running_label' { return 'running' }
    'en:connected_label' { return 'connected' }
    'en:error_label' { return 'error' }
    default { return $Key }
  }
}

$script:LatestNotifyScopeId = $null
$script:LatestNotifyLocale = $null

function Read-LatestInboundScope {
  if (-not (Test-Path $context.StorePath)) {
    return $null
  }

  $scriptText = @"
const fs = require('node:fs');
const DatabaseSync = require('node:sqlite').DatabaseSync;
const dbPath = process.argv[1];
if (!dbPath || !fs.existsSync(dbPath)) {
  process.exit(0);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare(`
  SELECT chat_id
  FROM audit_logs
  WHERE direction = 'inbound'
    AND event_type IN ('telegram.message', 'telegram.callback')
  ORDER BY created_at DESC, id DESC
  LIMIT 1
`).get();
if (row && row.chat_id !== null && row.chat_id !== undefined) {
  process.stdout.write(String(row.chat_id));
}
db.close();
"@

  return Invoke-NodeSnippet -Script $scriptText -Arguments @($context.StorePath) -IgnoreExitCode
}

function Read-ScopeLocale {
  param([string]$ScopeId)

  if ([string]::IsNullOrWhiteSpace($ScopeId) -or -not (Test-Path $context.StorePath)) {
    return $null
  }

  $scriptText = @"
const fs = require('node:fs');
const DatabaseSync = require('node:sqlite').DatabaseSync;
const dbPath = process.argv[1];
const scopeId = process.argv[2];
if (!dbPath || !scopeId || !fs.existsSync(dbPath)) {
  process.exit(0);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare(`
  SELECT locale
  FROM chat_settings
  WHERE chat_id = ?
  LIMIT 1
`).get(scopeId);
if (row && row.locale !== null && row.locale !== undefined) {
  process.stdout.write(String(row.locale));
}
db.close();
"@

  return Invoke-NodeSnippet -Script $scriptText -Arguments @($context.StorePath, $ScopeId) -IgnoreExitCode
}

function Resolve-NotifyScopeId {
  $explicit = [Environment]::GetEnvironmentVariable('NOTIFY_SCOPE_ID', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    return $explicit
  }

  if ($null -eq $script:LatestNotifyScopeId) {
    $script:LatestNotifyScopeId = Read-LatestInboundScope
  }

  return $script:LatestNotifyScopeId
}

function Resolve-NotifyLocale {
  $explicit = [Environment]::GetEnvironmentVariable('NOTIFY_LOCALE', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    return Normalize-LocaleCode $explicit
  }

  if ($null -eq $script:LatestNotifyLocale) {
    $script:LatestNotifyLocale = Normalize-LocaleCode (Read-ScopeLocale (Resolve-NotifyScopeId))
  }

  return $script:LatestNotifyLocale
}

function Get-ScopeChatId {
  param([string]$ScopeId)

  if ($ScopeId -like '*::*') {
    return $ScopeId.Split('::')[0]
  }

  return $ScopeId
}

function Get-ScopeTopicId {
  param([string]$ScopeId)

  if ($ScopeId -notlike '*::*') {
    return $null
  }

  $topicId = $ScopeId.Split('::')[1]
  if ($topicId -eq 'root' -or [string]::IsNullOrWhiteSpace($topicId)) {
    return $null
  }

  return $topicId
}

function Resolve-NotifyChatId {
  $explicit = [Environment]::GetEnvironmentVariable('NOTIFY_CHAT_ID', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    return $explicit
  }

  $scopeId = Resolve-NotifyScopeId
  if (-not [string]::IsNullOrWhiteSpace($scopeId)) {
    return Get-ScopeChatId $scopeId
  }

  $notifyTarget = [Environment]::GetEnvironmentVariable('NOTIFY_TARGET', 'Process')
  if ([string]::IsNullOrWhiteSpace($notifyTarget)) {
    $notifyTarget = 'auto'
  }

  $allowedChatId = Get-ConfigValue 'TG_ALLOWED_CHAT_ID'
  if (($notifyTarget -eq 'group' -or $notifyTarget -eq 'auto') -and -not [string]::IsNullOrWhiteSpace($allowedChatId)) {
    return $allowedChatId
  }

  return Get-ConfigValue 'TG_ALLOWED_USER_ID'
}

function Resolve-NotifyTopicId {
  $explicit = [Environment]::GetEnvironmentVariable('NOTIFY_TOPIC_ID', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($explicit)) {
    return $explicit
  }

  $scopeId = Resolve-NotifyScopeId
  if (-not [string]::IsNullOrWhiteSpace($scopeId)) {
    return Get-ScopeTopicId $scopeId
  }

  $notifyTarget = [Environment]::GetEnvironmentVariable('NOTIFY_TARGET', 'Process')
  if ([string]::IsNullOrWhiteSpace($notifyTarget) -or $notifyTarget -eq 'group' -or $notifyTarget -eq 'auto') {
    return Get-ConfigValue 'TG_ALLOWED_TOPIC_ID'
  }

  return $null
}

function Send-TelegramMessage {
  param(
    [string]$Text,
    [bool]$Enabled
  )

  if (-not $Enabled) {
    return
  }

  $token = [Environment]::GetEnvironmentVariable('NOTIFY_BOT_TOKEN', 'Process')
  if ([string]::IsNullOrWhiteSpace($token)) {
    $token = Get-ConfigValue 'TG_BOT_TOKEN'
  }

  $chatId = Resolve-NotifyChatId
  $topicId = Resolve-NotifyTopicId
  if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($chatId)) {
    return
  }

  $body = @{
    chat_id = $chatId
    text = $Text
    disable_web_page_preview = 'true'
  }

  if ($topicId -and $chatId.StartsWith('-')) {
    $body['message_thread_id'] = $topicId
  }

  $uri = "https://api.telegram.org/bot$token/sendMessage"
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    try {
      $response = Invoke-RestMethod -Method Post -Uri $uri -Body $body
      if ($response.ok -eq $true) {
        return
      }
    } catch {
      if ($attempt -lt 3) {
        Start-Sleep -Seconds 1
      }
    }
  }
}

function Get-GitValue {
  param([string[]]$Arguments)

  $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $gitCommand) {
    return 'unknown'
  }

  $output = & $gitCommand.Source -C $context.RootDir @Arguments 2>$null
  if ((Get-NativeExitCode) -ne 0) {
    return 'unknown'
  }

  if ($output -is [array]) {
    return (($output -join [Environment]::NewLine).Trim())
  }

  if ($null -eq $output) {
    return 'unknown'
  }

  return ([string]$output).Trim()
}

function Read-StatusObject {
  if (-not (Test-Path $context.StatusFile)) {
    return $null
  }

  try {
    return Get-Content -Raw -Path $context.StatusFile | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-StatusHealthy {
  param([DateTimeOffset]$RestartStartedAt)

  $status = Read-StatusObject
  if ($null -eq $status) {
    return $false
  }

  $updatedAt = $null
  if ($status.updatedAt) {
    try {
      $updatedAt = [DateTimeOffset]::Parse([string]$status.updatedAt)
    } catch {
      $updatedAt = $null
    }
  }

  if ($status.running -ne $true -or $status.connected -ne $true) {
    return $false
  }

  if ($null -eq $updatedAt) {
    return $false
  }

  return $updatedAt -ge $RestartStartedAt.AddSeconds(-1)
}

function Get-StatusUpdatedAt {
  $status = Read-StatusObject
  if ($null -eq $status -or -not $status.updatedAt) {
    return 'unknown'
  }
  return [string]$status.updatedAt
}

function Get-StatusSummary {
  param([string]$Locale)

  $status = Read-StatusObject
  $runningLabel = Get-MessageText $Locale 'running_label'
  $connectedLabel = Get-MessageText $Locale 'connected_label'

  if ($null -eq $status) {
    return "$runningLabel=unknown $connectedLabel=unknown"
  }

  $running = if ($status.running -eq $true) { 'true' } else { 'false' }
  $connected = if ($status.connected -eq $true) { 'true' } else { 'false' }
  return "$runningLabel=$running $connectedLabel=$connected"
}

function Get-ServicePid {
  try {
    $service = Get-CimInstance Win32_Service -Filter "Name='$($context.ServiceId.Replace("'", "''"))'"
    if ($service -and $service.ProcessId) {
      return [string]$service.ProcessId
    }
  } catch {
  }

  return 'unknown'
}

$buildBeforeRestart = Get-BooleanEnv -Name 'BUILD_BEFORE_RESTART' -DefaultValue $true
$notifyTelegram = Get-BooleanEnv -Name 'NOTIFY_TELEGRAM' -DefaultValue $true
$restartTimeoutSec = Get-IntEnv -Name 'RESTART_TIMEOUT_SEC' -DefaultValue 90
$restartPollSec = Get-IntEnv -Name 'RESTART_POLL_SEC' -DefaultValue 2
$startNotify = Get-BooleanEnv -Name 'START_NOTIFY' -DefaultValue $true
$runId = [Environment]::GetEnvironmentVariable('RUN_ID', 'Process')
if ([string]::IsNullOrWhiteSpace($runId)) {
  $runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))-$(Get-Random -Maximum 100000)"
}

$locale = Resolve-NotifyLocale
$branch = Get-GitValue @('rev-parse', '--abbrev-ref', 'HEAD')
$commit = Get-GitValue @('rev-parse', '--short', 'HEAD')

if ($startNotify) {
  $startMessage = @(
    (Get-MessageText $locale 'restart_started'),
    "$(Get-MessageText $locale 'time_label'): $([DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
    "$(Get-MessageText $locale 'run_id_label'): $runId",
    "$(Get-MessageText $locale 'commit_label'): $branch@$commit"
  ) -join [Environment]::NewLine
  Write-Host $startMessage
  Send-TelegramMessage -Text $startMessage -Enabled $notifyTelegram
}

try {
  if ($buildBeforeRestart) {
    Write-Host (Get-MessageText $locale 'building_bridge')
    Push-Location $context.RootDir
    try {
      & $context.NpmCmd run build
      $buildExitCode = Get-NativeExitCode
      if ($buildExitCode -ne 0) {
        throw "npm run build failed with exit code $buildExitCode."
      }
    } finally {
      Pop-Location
    }
  }

  Write-Host (Get-MessageText $locale 'restarting_service')
  $restartStartedAt = [DateTimeOffset]::UtcNow
  $service = Get-Service -Name $context.ServiceId -ErrorAction SilentlyContinue
  if (-not $service) {
    throw "Windows service is not installed: $($context.ServiceId)"
  }
  if ($service.Status -eq 'Stopped') {
    Start-Service -Name $context.ServiceId
  } else {
    Restart-Service -Name $context.ServiceId -Force
  }

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($restartTimeoutSec)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-StatusHealthy -RestartStartedAt $restartStartedAt) {
      $successMessage = @(
        (Get-MessageText $locale 'restart_succeeded'),
        "$(Get-MessageText $locale 'time_label'): $([DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
        "$(Get-MessageText $locale 'run_id_label'): $runId",
        "$(Get-MessageText $locale 'commit_label'): $branch@$commit",
        "$(Get-MessageText $locale 'pid_label'): $(Get-ServicePid)",
        "$(Get-MessageText $locale 'status_label'): $(Get-StatusSummary $locale)"
      ) -join [Environment]::NewLine
      Write-Host $successMessage
      Send-TelegramMessage -Text $successMessage -Enabled $notifyTelegram
      exit 0
    }

    Start-Sleep -Seconds $restartPollSec
  }

  $failureMessage = @(
    (Get-MessageText $locale 'restart_failed'),
    "$(Get-MessageText $locale 'time_label'): $([DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
    "$(Get-MessageText $locale 'run_id_label'): $runId",
    "$(Get-MessageText $locale 'commit_label'): $branch@$commit",
    "$(Get-MessageText $locale 'timeout_label'): $restartTimeoutSec",
    "$(Get-MessageText $locale 'last_status_updated_at_label'): $(Get-StatusUpdatedAt)",
    "$(Get-MessageText $locale 'status_label'): $(Get-StatusSummary $locale)"
  ) -join [Environment]::NewLine
  Write-Error $failureMessage
  Send-TelegramMessage -Text $failureMessage -Enabled $notifyTelegram
  exit 1
} catch {
  $failureMessage = @(
    (Get-MessageText $locale 'restart_failed'),
    "$(Get-MessageText $locale 'time_label'): $([DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
    "$(Get-MessageText $locale 'run_id_label'): $runId",
    "$(Get-MessageText $locale 'commit_label'): $branch@$commit",
    "$(Get-MessageText $locale 'status_label'): $(Get-StatusSummary $locale)",
    "$(Get-MessageText $locale 'error_label'): $($_.Exception.Message)"
  ) -join [Environment]::NewLine
  Write-Error $failureMessage
  Send-TelegramMessage -Text $failureMessage -Enabled $notifyTelegram
  exit 1
}
