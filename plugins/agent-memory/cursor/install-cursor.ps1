<#
.SYNOPSIS
  Connects Cursor to Agent Memory: the memory MCP tools, plus hooks that save every turn
  and load your agent's memory when a chat starts.

.DESCRIPTION
  Adds an "agent-memory" entry to ~/.cursor/mcp.json and three hooks to ~/.cursor/hooks.json
  (user level, so they apply to every project). Existing files are backed up and other entries
  are kept. Run it again to change the settings; run with -Uninstall to remove them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install-cursor.ps1
  powershell -ExecutionPolicy Bypass -File install-cursor.ps1 -Url https://weaverai-api.platform.weaversoft.io/api/mcp-proxy/memory-mcp -PlatformToken <WAIP token>
#>
param(
  [string]$Url = "https://weaverai-api.platform.weaversoft.io/api/mcp-proxy/memory-mcp",
  [string]$Key,
  [string]$AgentId = "",
  [string]$PlatformToken = "",
  [switch]$Uninstall,
  [string]$CursorDir = (Join-Path $HOME ".cursor")
)

$ErrorActionPreference = "Stop"
$cursorDir = $CursorDir
$mcpPath = Join-Path $cursorDir "mcp.json"
$hooksPath = Join-Path $cursorDir "hooks.json"
$marker = "/hooks/cursor"
$events = @("sessionStart", "beforeSubmitPrompt", "afterAgentResponse")
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-JsonFile([string]$path, $empty) {
  if (-not (Test-Path $path)) { return $empty }
  $raw = [IO.File]::ReadAllText($path)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $empty }
  Copy-Item $path "$path.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  return $raw | ConvertFrom-Json
}

function Write-JsonFile([string]$path, $obj) {
  [IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 20), $utf8)
}

function Set-Prop($obj, [string]$name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

if (-not (Test-Path $cursorDir)) { New-Item -ItemType Directory -Path $cursorDir | Out-Null }

# ── MCP server ──────────────────────────────────────────────────────────────
$mcp = Read-JsonFile $mcpPath ([pscustomobject]@{ mcpServers = [pscustomobject]@{} })
if (-not $mcp.PSObject.Properties["mcpServers"]) { Set-Prop $mcp "mcpServers" ([pscustomobject]@{}) }

# ── Hooks ───────────────────────────────────────────────────────────────────
$hooks = Read-JsonFile $hooksPath ([pscustomobject]@{ version = 1; hooks = [pscustomobject]@{} })
if (-not $hooks.PSObject.Properties["version"]) { Set-Prop $hooks "version" 1 }
if (-not $hooks.PSObject.Properties["hooks"]) { Set-Prop $hooks "hooks" ([pscustomobject]@{}) }
foreach ($ev in $events) {
  $kept = @()
  if ($hooks.hooks.PSObject.Properties[$ev]) {
    $kept = @($hooks.hooks.$ev | Where-Object { -not ($_.command -like "*$marker*") })
  }
  Set-Prop $hooks.hooks $ev $kept
}

if ($Uninstall) {
  $mcp.mcpServers.PSObject.Properties.Remove("agent-memory")
  Write-JsonFile $mcpPath $mcp
  Write-JsonFile $hooksPath $hooks
  Write-Host "Removed Agent Memory from Cursor. Restart Cursor to apply."
  exit 0
}

# Typed secrets are not echoed to the screen.
function Read-Secret([string]$prompt) {
  $secure = Read-Host -AsSecureString $prompt
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$base = $Url.TrimEnd("/")
$local = $base -match "://(localhost|127\.0\.0\.1)"
# Production identifies you by your WAIP token; only a local server needs the memory key.
if ($local -and -not $Key) { $Key = Read-Secret "Your memory key (sk-mem-..., from the WeaverAI Memory Fabric panel's API Key page)" }
if ($Key -and $Key -notlike "sk-mem-*") { throw "That doesn't look like a memory key; it should start with sk-mem-." }
if (-not $local -and -not $PlatformToken) {
  $PlatformToken = Read-Secret "Your WAIP token (from the memory-mcp entry's Connection tab in the WAIP MCP store)"
}

$headers = [ordered]@{}
if ($Key) { $headers["X-Memory-User-Key"] = $Key }
if ($AgentId) { $headers["X-Memory-Agent-Id"] = $AgentId }
if ($PlatformToken) { $headers["Authorization"] = "Bearer $PlatformToken" }
Set-Prop $mcp.mcpServers "agent-memory" ([pscustomobject]@{ url = "$base/mcp"; headers = [pscustomobject]$headers })

# curl.exe ships with Windows 10 and later. "@-" sends the hook's JSON input (stdin) as the body.
$headerArgs = ($headers.GetEnumerator() | ForEach-Object { "-H `"$($_.Key): $($_.Value)`"" }) -join " "
$command = "curl.exe -s -m 15 -X POST -H `"Content-Type: application/json`" $headerArgs --data-binary `"@-`" `"$base$marker`""
foreach ($ev in $events) {
  $list = @($hooks.hooks.$ev) + @([pscustomobject]@{ command = $command; timeout = 20 })
  Set-Prop $hooks.hooks $ev $list
}

Write-JsonFile $mcpPath $mcp
Write-JsonFile $hooksPath $hooks
Write-Host "Agent Memory is set up for Cursor:"
Write-Host "  MCP server : $base/mcp   ($mcpPath)"
Write-Host "  Hooks      : $($events -join ', ')   ($hooksPath)"
Write-Host "Restart Cursor, then check Settings > MCP shows agent-memory as connected."
