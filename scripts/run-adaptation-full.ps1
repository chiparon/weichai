# 启动"功能完整"的适配服务：语义模块规划 + 工作区翻译。
#
# `npm run dev:adaptation` 只开语义规划，翻译端点（/v1/workspace-translations）
# 不会注册，面板上的"翻译"必然不可用。本脚本把两者一起开起来。
#
#   powershell -ExecutionPolicy Bypass -File scripts/run-adaptation-full.ps1
#
# 默认值来自 scripts/dev-env.ps1（单一配置点）；下面的参数只在需要覆盖时传。
# 端口约定（与 scripts/run-vscode-extension.ps1 一致）：
#   8788  适配服务（本脚本）
#   8790  扩展宿主自己的语义查询端口（本服务用 SEMANTIC_QUERY_PORT_URL 指向它）
[CmdletBinding()]
param(
  # 目标工程；留空则用 dev-env 的 ADAPTATION_PROJECT_ROOT。
  [string]$ProjectRoot = '',
  [int]$Port = 8788,
  [string]$SemanticQueryUrl = 'http://127.0.0.1:8790',
  # 必须与宿主环境里的 ADAPTATION_WORKSPACE_TRANSLATION_TOKEN 一致；留空则用 dev-env 的值。
  [string]$TranslationToken = '',
  [string]$JunitClasses = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'dev-env.ps1')

if ($ProjectRoot) { $env:ADAPTATION_PROJECT_ROOT = (Resolve-Path -LiteralPath (Join-Path $repoRoot $ProjectRoot)).Path }
if ($TranslationToken) { $env:ADAPTATION_WORKSPACE_TRANSLATION_TOKEN = $TranslationToken }
if ($JunitClasses) { $env:FOREXPLORE_JUNIT_CLASSES = $JunitClasses }
$resolvedProjectRoot = (Resolve-Path -LiteralPath $env:ADAPTATION_PROJECT_ROOT).Path

# 服务进程自己读 services/adaptation-service/.env（server.ts 首行 dotenv），
# 所以 shell 里没有 DEEPSEEK_API_KEY 并不代表调用模型会失败。
$envFile = Join-Path $repoRoot 'services/adaptation-service/.env'
if (-not $env:DEEPSEEK_API_KEY -and -not (Test-Path $envFile)) {
  Write-Warning 'DEEPSEEK_API_KEY 既不在环境变量里，也没有 services/adaptation-service/.env：模型调用会失败。'
}
if ($env:ADAPTATION_WORKSPACE_TRANSLATION_TOKEN.Length -lt 32) { throw 'TranslationToken 至少 32 个字符（服务端强制校验）。' }

$env:ADAPTATION_PORT = "$Port"
$env:ADAPTATION_PROJECT_ROOT = $resolvedProjectRoot
$env:ADAPTATION_SEMANTIC_INDEX_ENABLED = 'true'
$env:SEMANTIC_QUERY_PORT_URL = $SemanticQueryUrl
$env:ADAPTATION_WORKSPACE_TRANSLATION_ENABLED = 'true'
$env:ADAPTATION_WORKSPACE_MAX_TURNS = '40'
$env:ADAPTATION_WORKSPACE_COMPILE_COMMAND = '{"executable":"node","args":["tools/compile.mjs"],"timeoutMs":900000}'
$env:ADAPTATION_WORKSPACE_VERIFICATION = '{"command":{"executable":"node","args":["tools/verify.mjs"],"timeoutMs":900000},"protectedFiles":["tools/verify.mjs","tools/compile.mjs","tools/jdk.mjs"]}'

Write-Host "适配服务（完整）：端口 $Port，目标工程 $resolvedProjectRoot，语义查询 $SemanticQueryUrl，翻译已启用"
Set-Location -LiteralPath $repoRoot
npm run start --workspace @forexplore/adaptation-service
