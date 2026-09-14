# 开发环境变量单一配置点。
#
# 这里定义的变量被两个脚本 dot-source 复用：
#   scripts/run-vscode-extension.ps1  —— 启动服务 + 打开 VS Code 开发窗口
#   scripts/run-adaptation-full.ps1   —— 单独启动"语义 + 翻译"完整的适配服务
#
# 为什么需要集中配置：扩展宿主直接读 process.env（不走 VS Code 设置），
# 缺 ADAPTATION_WORKSPACE_TRANSLATION_TOKEN 或 FOREXPLORE_TRANSLATION_PROFILE 时，
# 面板上的翻译会在联系服务之前就被拒绝，服务端连一条日志都不会留下。
#
# 想换目标工程/数据库/端口，只改本文件；已存在的同名进程环境变量优先，不会被覆盖。

$devEnvRepoRoot = Split-Path -Parent $PSScriptRoot

# ---- 代码智能（扩展宿主 + 工作台共用）----
if (-not $env:CODE_INTELLIGENCE_SEEKDB_DATABASE) { $env:CODE_INTELLIGENCE_SEEKDB_DATABASE = 'forexplore_javafileupload_flow_20260913' }
if (-not $env:CODE_INTELLIGENCE_EMBEDDING_URL) { $env:CODE_INTELLIGENCE_EMBEDDING_URL = 'http://127.0.0.1:4021/v1/embeddings' }
if (-not $env:CODE_INTELLIGENCE_EMBEDDING_MODEL) { $env:CODE_INTELLIGENCE_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78' }
if (-not $env:CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS) { $env:CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS = 'false' }
if (-not $env:CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX) { $env:CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX = 'query: ' }
if (-not $env:CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX) { $env:CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX = 'passage: ' }
if (-not $env:CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION) { $env:CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION = '384' }

# ---- 翻译：服务侧与宿主侧必须对齐 ----
$devTranslationProjectRoot = Join-Path $devEnvRepoRoot 'tmp/java-fileupload-flow/target-repo'
if (-not $env:ADAPTATION_PROJECT_ROOT) { $env:ADAPTATION_PROJECT_ROOT = $devTranslationProjectRoot }
if (-not $env:ADAPTATION_WORKSPACE_TRANSLATION_TOKEN) { $env:ADAPTATION_WORKSPACE_TRANSLATION_TOKEN = 'java-fileupload-flow-token-0123456789abcdef' }
if (-not $env:FOREXPLORE_JUNIT_CLASSES) {
  $env:FOREXPLORE_JUNIT_CLASSES = 'org.apache.commons.fileupload.DefaultFileItemTest,org.apache.commons.fileupload.DiskFileItemSerializeTest,org.apache.commons.fileupload.DiskFileUploadTest,org.apache.commons.fileupload.FileItemHeadersTest,org.apache.commons.fileupload.FileUploadTest,org.apache.commons.fileupload.MultipartStreamTest,org.apache.commons.fileupload.ParameterParserTest,org.apache.commons.fileupload.ProgressListenerTest,org.apache.commons.fileupload.SizesTest,org.apache.commons.fileupload.StreamingTest,org.apache.commons.fileupload.portlet.PortletFileUploadTest,org.apache.commons.fileupload.servlet.ServletFileUploadTest'
}
# 宿主侧的兜底 profile：模块级翻译会用模块作用域覆盖它，但宿主在解析阶段仍要求它存在且
# workspaceRoot 与服务一致。单个文件的翻译则需要真实的 workspaceFiles/writeFiles。
if (-not $env:FOREXPLORE_TRANSLATION_PROFILE) {
  $env:FOREXPLORE_TRANSLATION_PROFILE = (@{
    workspaceRoot  = $env:ADAPTATION_PROJECT_ROOT
    sourceLanguage = 'Java'
    targetLanguage = 'Java'
    workspaceFiles = @()
    writeFiles     = @()
  } | ConvertTo-Json -Compress)
}
