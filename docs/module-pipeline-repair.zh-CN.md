# 模块检索 → 翻译 → 回填修复

基于 `upstream/main@69d720d`，工作目录 `D:/CodeProjects/Weichai-latest-check`，分支 `codex/verify-module-pipeline`。

## 使用流程

1. 在“复用迁移”中选择目标模块，输入需求并检索。
2. 明确点击一个历史模块候选，再点击“准备模块翻译与回填”。检索排名不会自动触发写入。
3. 页面展示源语言、目标语言、目标工作区以及允许修改的完整文件列表。
4. 点击“开始模块翻译并回填”，启动多文件翻译。服务直接写入限定文件，并执行配置的编译与行为验证。
5. 在同一页面查看计划、文件修改前后内容、编译输出、测试输出及运行编号；必要时点击“回滚本次修改”。

该流程同时接入 VS Code 扩展和本地浏览器工作台。任务检索页在仅选中目标模块、尚无证据包时，会引导用户先选择历史模块候选。

## 实现与保护

- 新增共享 `prepareModuleTranslationScope`，两种宿主均从自身保存的目标和明确选中的候选建立翻译范围；网页不能指定写入路径、历史版本或源码。
- 模块路径通过真实路径解析检查，准备时记录每个目标文件的 SHA-256，开始前复核；VS Code 还检查模块内所有未保存的文档。
- 目标、候选或检索结果改变后，旧作用域失效；异步返回后再次检查选择版本，避免旧请求覆盖新选择。
- 模块操作显式携带 `moduleScopeId`，任务证据翻译继续使用原静态配置；两条流程不会隐式借用对方的模块上下文。
- 作用域标识覆盖完整需求、源码上下文、历史版本和文件快照，相同长度的内容变化也会失效。
- 重复启动复用同一个请求。文件预检失败可以重新准备或重试；提交后响应丢失不会自动重发写入请求。
- 模块流程不再要求手填 `FOREXPLORE_TRANSLATION_PROFILE`；宿主根据目标模块生成配置。运行读取、取消、恢复和回滚校验服务工作区，并支持宿主重启后的运行编号恢复。
- VS Code 的模型请求使用现有 `localFetch`，继承用户已保存的模型凭据和模型设置。
- 独立 `retrieval-service` 恢复构建。其索引只保存类和函数，因此明确拒绝模块请求并提示使用 `code-intelligence-service`；产品模块路径始终使用后者，未将模块降级为函数检索。

## 本地运行配置

模块翻译复用现有工作区翻译服务，需要以下配置：

| 配置 | 要求 |
| --- | --- |
| `ADAPTATION_WORKSPACE_TRANSLATION_ENABLED` | 翻译服务设为 `true` |
| `ADAPTATION_PROJECT_ROOT` | 与选中目标仓库的本机根目录相同 |
| `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN` | 服务端和宿主进程环境变量一致，至少 32 字符 |
| `ADAPTATION_WORKSPACE_COMPILE_COMMAND` | 固定编译命令 JSON，按实际目标工程配置 |
| `ADAPTATION_WORKSPACE_VERIFICATION` | 行为测试命令及 `protectedFiles`；未配置时不能得到行为验收通过结论 |
| 模型凭据 | 服务 `.env` 中的模型 Key，或 VS Code 中已保存的模型凭据 |
| `SEMANTIC_QUERY_PORT_URL` | 启用按需历史查询时，指向相应宿主的查询端口；浏览器默认 4041，扩展默认 8790 |

浏览器工作台通过 `--adaptation-url` 连接服务；VS Code 使用已有的 `forexplore.adaptationApiUrl` 设置。服务仍然只接受配置工作区内的写入，选中其他根目录时会给出不一致错误。

服务启动参考现有 README 和 `services/adaptation-service/.env.example`。原有任务证据翻译仍使用 `FOREXPLORE_TRANSLATION_PROFILE`；仅模块流程免去这项重复配置。

## 验证结果

- 全仓 `npm test`：821 项通过、1 项跳过、0 失败；之后新增一项“响应丢失不重复提交”测试及末尾修订，相关定向测试全部通过，当前合计 822 项通过。
- 扩展/Webview 类型检查通过；Webview、VS Code 扩展、独立检索服务构建通过；浏览器服务脚本打包检查通过。
- React 界面测试实际点击任务检索入口、模块候选、准备按钮、开始按钮及回滚按钮，覆盖作用域传递和完成后差异页面，验证重新选择同一目标能建立新流程。该测试使用协议应答替身，不等同于原生 VS Code 窗口手工验收。
- 共享宿主测试覆盖双文件范围、跨语言元数据、静态配置缺省、旧作用域拒绝、非首文件变更、异步选择切换、重复启动和响应丢失。
- 真实 DeepSeek V4 Flash 实测：通过生产使用的同一准备函数和 HTTP 宿主协议，完成 Java → TypeScript 双文件模块，8 轮模型调用，TypeScript `--strict --noEmit` 检查通过，独立行为验证 **222 项断言通过**，两文件回滚成功。未设置静态翻译 profile。

真实模型复跑：

```powershell
npx tsx scripts/verify-module-pipeline-smoke.mts --env-file D:/CodeProjects/Weichai-guochuang-implementation/services/adaptation-service/.env --output tmp/pipeline-verification/fix-live-smoke.json
```

上述首轮测试使用固定模块摘要和 `InMemoryIndexStore`。随后已完成下面的 SeekDB 实测。

## SeekDB 全链路复测（2026-09-14）

**结果：通过。** 采用独立库 `forexplore_pipeline_seekdb_20260914`，现有容器 `forexplore-seekdb`，服务版本 `seekdb-v1.3.0.0`。Docker 原先因遗留 socket 无法访问而启动失败，备份临时运行目录后恢复；未删除原有容器或数据卷。

本轮使用真实 `Xenova/multilingual-e5-small` 模型，固定 revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`，384 维、归一化、q8 推理，查询/文档分别使用 E5 的 `query: ` / `passage: ` 前缀。未使用哈希向量或内存索引。

| 环节 | 实测结果 |
| --- | --- |
| 历史 Java、目标 TypeScript 仓库结构索引 | 2 个仓库、3 个文件、4 个符号落库 |
| 真实模型模块分析 | 两个仓库均为 `agent`，各 1 次模型层级决策，覆盖率 100%，摘要投影 ready |
| SeekDB 模块检索 | 召回历史 `LimitPolicy.java` 模块，语义分数约 0.9014 |
| 持久化恢复 | 新建数据库连接与运行时，模块计划哈希及首选候选 ID 保持一致 |
| 按需历史证据 | 模型发出 2 次查询，首次返回 254 字符源码；第二次未返回新片段 |
| 翻译和回填 | DeepSeek V4 Flash 共 10 轮，修改 `policy.ts`、`target.ts`，状态 completed |
| 编译和行为验证 | TypeScript strict/noEmit 通过；独立重跑 222 项边界断言通过；验收为 behavior-verified |
| 回滚 | 重建宿主后按运行编号回滚，两个文件逐字恢复初始内容 |
| 数据库审计 | 19 条检索文档、19 条 384 维向量缓存；FULLTEXT/VECTOR 索引存在，全文查询实际命中 |

验证脚本从真实模型分析树提取完整目标文件清单，并通过生产使用的范围准备函数、宿主协议和鉴权 HTTP 服务完成写入。测试基础设施在源码索引完成后安装，且作为受保护文件参与验收。模型翻译使用原有配置文件中的凭据，报告不保存密钥。

从当前工作目录复跑（保留现有容器与模型缓存）：

```powershell
docker start forexplore-seekdb
# 仅在 4021 尚未运行时启动；单独终端保留此进程。
$env:FOREXPLORE_EMBEDDING_TOOLS = 'D:/CodeProjects/Weichai-latest-check/tmp/embedding-tools'
$env:FOREXPLORE_MODEL_CACHE = 'D:/CodeProjects/Weichai-latest-check/tmp/model-cache'
$env:FOREXPLORE_MODEL_HOST = 'https://hf-mirror.com/'
node scripts/serve-local-embeddings.mjs
```

另一个终端执行；每轮使用新的独立测试库名，保留旧报告：

```powershell
$testDatabase = 'forexplore_pipeline_seekdb_' + (Get-Date -Format yyyyMMddHHmmss)
node --import tsx scripts/verify-module-pipeline-smoke.mts --env-file D:/CodeProjects/Weichai-guochuang-implementation/services/adaptation-service/.env --database $testDatabase --embedding-url http://127.0.0.1:4021/v1/embeddings --embedding-model Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78 --model-analysis --output "tmp/pipeline-verification/$testDatabase.json"
node --import tsx scripts/verify-seekdb-persistence.mts --database $testDatabase --output "tmp/pipeline-verification/$testDatabase-persistence.json"
```

本轮证据：`tmp/pipeline-verification/seekdb-live-smoke.json`、`seekdb-live-smoke.log`、`seekdb-persistence.json`、`seekdb-persistence.log`。生成的两个实现保存在主报告 `root` 指向的目录下；目标工作区已回滚。

验收范围是隔离的跨语言双文件用例，覆盖后台全链路；不代表大型生产语料的召回质量、性能压力测试或原生 VS Code 窗口手工验收。原有界面入口仍由上面的 React 协议测试覆盖。

为执行原有 C# 编译验收，本次在 `tmp/dotnet` 安装了隔离的 .NET SDK 8.0.425，没有修改系统 PATH。复跑全仓测试时可在当前 PowerShell 进程设置：

```powershell
$env:PATH = 'D:/CodeProjects/Weichai-latest-check/tmp/dotnet;' + $env:PATH
$env:DOTNET_ROOT = 'D:/CodeProjects/Weichai-latest-check/tmp/dotnet'
npm test
```

证据位于 `tmp/pipeline-verification/`：`fix-all-tests.log`、`fix-targeted-tests.log`、`fix-build.log`、`fix-typecheck.log`、`fix-workbench-build.log`、`fix-live-smoke.json` 和 `fix-live-smoke.log`。
