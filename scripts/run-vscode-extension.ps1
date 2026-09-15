[CmdletBinding()]
param(
  [switch]$SkipSeekDb,
  # Folder to open in the development window. Without it VS Code opens an empty
  # window: no workspace folder means no target project and no folder-scoped
  # settings, so the panel would show neither.
  [string]$Folder,
  # The operator already started the retrieval and adaptation services.
  [switch]$SkipServices
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $repoRoot 'apps/vscode-extension'
$composeFile = Join-Path $repoRoot 'services/retrieval-service/docker-compose.yml'

Set-Location -LiteralPath $repoRoot

function Ensure-VsCodeExtension {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
  )

  $codeCommand = Get-Command code -ErrorAction Stop
  $installed = @(& $codeCommand.Source '--list-extensions') |
    ForEach-Object { $_.Trim().ToLowerInvariant() }

  if ($installed -contains $ExtensionId.ToLowerInvariant()) {
    return
  }

  Write-Host "Installing required VS Code extension: $ExtensionId"
  & $codeCommand.Source '--install-extension' $ExtensionId
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install required VS Code extension: $ExtensionId"
  }
}

Ensure-VsCodeExtension -ExtensionId 'redhat.java'

if (-not $SkipSeekDb) {
  docker compose -f $composeFile up -d
  if ($LASTEXITCODE -ne 0) {
    throw "SeekDB startup failed. Exit code: $LASTEXITCODE"
  }
}

# The extension host loads the already-installed workspace dependencies.
npm run build:extension
if ($LASTEXITCODE -ne 0) {
  throw "Extension build failed. Exit code: $LASTEXITCODE"
}

function Start-DevWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $repoRoot -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    $Command
  ) | Out-Null
}

# One configuration point for the whole dev environment: database, embeddings,
# translation token and the host-side fallback profile. Edit scripts/dev-env.ps1
# instead of passing these around.
. (Join-Path $PSScriptRoot 'dev-env.ps1')

# The adaptation planner is revision-scoped in the rebuilt flow. It receives
# only this loopback SemanticQueryPort and never gets repository paths.
$env:ADAPTATION_SEMANTIC_INDEX_ENABLED = 'true'
$env:SEMANTIC_QUERY_PORT_URL = 'http://127.0.0.1:8790'

if (-not $SkipServices) {
  # Retrieval needs the local embedding (4021) and rerank (4022) servers, which
  # used to be started by hand: a restart without them made every search fail
  # with a bare "fetch failed". Idempotent, so anything already listening stays.
  npm run services:up
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "依赖服务未全部就绪（embedding 4021 / rerank 4022 / SeekDB）：检索会以 'fetch failed' 失败。"
  }
  Start-DevWindow -Command 'npm run dev:retrieval'
  # `npm run dev:adaptation` alone registers no translation endpoint, so the
  # panel's translation always failed. Start the service through the one script
  # that owns the complete environment instead.
  $adaptationScript = Join-Path $PSScriptRoot 'run-adaptation-full.ps1'
  Start-DevWindow -Command ("powershell -ExecutionPolicy Bypass -File '{0}' -Port 8788 -SemanticQueryUrl 'http://127.0.0.1:8790'" -f $adaptationScript)
}

# The extension host reads the token and the fallback profile from its own
# process environment, never from VS Code settings: without both it refuses
# every translation before the service sees a request.
if ($Folder) {
  $folderRoot = (Resolve-Path -LiteralPath $Folder).Path
  if ($folderRoot -ne (Resolve-Path -LiteralPath $env:ADAPTATION_PROJECT_ROOT).Path) {
    Write-Warning "打开的文件夹 ($folderRoot) 不等于适配服务的目标工程 ($env:ADAPTATION_PROJECT_ROOT)：翻译会因工作区不一致被拒绝。"
  }
}

& code (@('--extensionDevelopmentPath={0}' -f $extensionRoot) + $(if ($Folder) { @((Resolve-Path -LiteralPath $Folder).Path) } else { @() }))
