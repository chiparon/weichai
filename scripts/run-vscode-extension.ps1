[CmdletBinding()]
param(
  [switch]$SkipSeekDb,
  [string]$Folder,
  [switch]$SkipServices
)

# Compatibility wrapper for users who invoke the old Windows path directly.
# The implementation lives in the cross-platform Node launcher used by
# `npm run dev:extension` on every supported host.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'run-vscode-extension.mjs'
$arguments = @()
if ($SkipSeekDb) { $arguments += '--skip-seek-db' }
if ($SkipServices) { $arguments += '--skip-services' }
if ($Folder) { $arguments += @('--folder', $Folder) }

& node $launcher @arguments
exit $LASTEXITCODE
