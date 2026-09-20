[CmdletBinding()]
param(
  # Relative paths are resolved from this checkout, not the caller's directory.
  [string]$Dataset = 'results/enterprise-history',
  [switch]$SkipBuild,
  # Prepare and verify everything without opening another VS Code window.
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
  param([string]$Executable, [string[]]$CommandArgs)
  & $Executable @CommandArgs
  if ($LASTEXITCODE -ne 0) {
    throw "$Executable failed (exit $LASTEXITCODE)."
  }
}

try {
  Push-Location -LiteralPath $repoRoot
  try {
    $codeCommand = Get-Command code.cmd -ErrorAction SilentlyContinue
    if (-not $codeCommand) { $codeCommand = Get-Command code -ErrorAction SilentlyContinue }
    if (-not $codeCommand) { throw 'VS Code CLI not found. Install VS Code and add its bin directory to PATH.' }
    $npmCommand = Get-Command npm.cmd -ErrorAction Stop
    Get-Command node -ErrorAction Stop | Out-Null

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules/.bin/vite.cmd'))) {
      Write-Host 'Installing workspace dependencies...'
      Invoke-Checked $npmCommand.Source @('ci', '--ignore-scripts')
    }

    $datasetRoot = if ([System.IO.Path]::IsPathRooted($Dataset)) {
      [System.IO.Path]::GetFullPath($Dataset)
    } else {
      [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Dataset))
    }
    if (-not (Test-Path -LiteralPath (Join-Path $datasetRoot 'manifest.json'))) {
      Write-Host 'Generating the enterprise dataset (existing nonempty directories are protected)...'
      Get-Command python -ErrorAction Stop | Out-Null
      Get-Command git -ErrorAction Stop | Out-Null
      Invoke-Checked 'python' @('experiments/enterprise-history/build.py', '--output', $datasetRoot, '--git-history')
    }

    $manifest = Get-Content -LiteralPath (Join-Path $datasetRoot 'manifest.json') -Raw | ConvertFrom-Json
    if (-not $manifest.repositories -or $manifest.repositories.Count -ne 8) {
      throw 'Expected the eight-repository enterprise dataset manifest.'
    }
    $targetRoot = (Resolve-Path -LiteralPath (Join-Path $datasetRoot 'target')).Path
    $historyPaths = @($manifest.repositories | ForEach-Object {
      if ($_ -notmatch '^[a-z][a-z0-9-]*$') { throw "Invalid repository name: $_" }
      (Resolve-Path -LiteralPath (Join-Path $datasetRoot "repositories/$_")).Path
    })

    if (-not $SkipBuild) {
      Write-Host 'Building the VS Code extension...'
      Invoke-Checked $npmCommand.Source @('run', 'build:extension')
    }
    $extensionRoot = Join-Path $repoRoot 'apps/vscode-extension'
    foreach ($artifact in @('dist/extension/extension.js', 'dist/extension/adaptation-server.cjs', 'dist/extension/workspace-compile.cjs', 'dist/webview/index.html')) {
      if (-not (Test-Path -LiteralPath (Join-Path $extensionRoot $artifact))) {
        throw "Missing build artifact: $artifact. Run again without -SkipBuild."
      }
    }

    $workspacePath = Join-Path $datasetRoot 'enterprise-history.code-workspace'
    if (-not (Test-Path -LiteralPath $workspacePath)) {
      $workspace = @{
        folders = @(@{ name = 'Enterprise Target'; path = $targetRoot })
        settings = @{
          'forexplore.repositoryPaths' = $historyPaths
          'forexplore.targetRepositoryPaths' = @($targetRoot)
          'forexplore.topK' = 10
        }
      }
      $json = $workspace | ConvertTo-Json -Depth 8
      [System.IO.File]::WriteAllText($workspacePath, $json, (New-Object System.Text.UTF8Encoding($false)))
    } else {
      # Keep the user's saved workspace settings and selected repositories.
      Get-Content -LiteralPath $workspacePath -Raw | ConvertFrom-Json | Out-Null
      Write-Host 'Reusing the existing workspace; saved settings are preserved.'
    }

    Write-Host "Workspace: $workspacePath"
    Write-Host "Extension: $extensionRoot"
    Write-Host 'Open RECAST in a trusted workspace to automatically start the packaged model backend. SeekDB and embeddings remain separately configured.'
    Write-Host 'Existing backend environment settings are inherited unchanged.'
    if ($NoLaunch) {
      Write-Host 'Preparation verified. VS Code was not launched (-NoLaunch).'
    } else {
      Invoke-Checked $codeCommand.Source @('--new-window', "--extensionDevelopmentPath=$extensionRoot", $workspacePath)
      Write-Host 'VS Code launch requested. Open RECAST from the activity bar.'
    }
  } finally {
    Pop-Location
  }
} catch {
  Write-Error -Message $_.Exception.Message -ErrorAction Continue
  exit 1
}
