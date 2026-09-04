# 多语言代码智能索引与 Agent 解析 SDD（v1 修订版）

## 1. 目标

本 SDD 不承诺支持所有编程语言，也不承诺一次性提供完整调用图或完整语义分析。

v1 只要求已注册的历史仓库和目标工程使用同一条索引链路：

~~~text
前端配置多个仓库路径
  → Repository Registry
  → Scan Coordinator
  → Tree-sitter Structural Index
  → Project / Import Dependency Resolver
  → Java/C# 深度语义增强（可选）
  → Versioned Index Store
  → SeekDB 检索投影
  → SemanticQueryPort
  → Agent 按需取证和模块规划
  → Host 确定性校验、审批和 Summary 发布
  → Webview 展示
~~~

历史仓库和目标工程不能使用两套互不兼容的索引事实。目标工程不能绕过结构索引直接进入 Agent 流程。前端不能把旧的轻量扫描结果当作新的 SeekDB 索引结果展示。

## 2. v1 不做什么

- 不支持未注册 grammar 的语言。
- 不把 Tree-sitter 当作完整语义分析器。
- 不根据语法树猜测唯一的跨文件定义、引用或调用关系。
- 不把动态 import、反射、宏展开或未确认的包关系标记为已解析依赖。
- 不在 Agent 中读取绝对路径、扫描文件系统或直接访问 SeekDB。
- 不允许 Agent 写入 summary、修改索引或决定当前 revision。
- 不在 adaptation-service 中重复实现 Tree-sitter、LSP 或 SeekDB。
- 不保留第二套面向前端的轻量模块索引作为事实源。
- 不把文件系统中的 .forexplore/module-summary.json 作为当前 summary 的唯一来源。
- 不在没有有效 analysisRevision 的情况下返回符号、依赖或 summary 证据。
- 不因为增加 MCP、向量检索或 LSP 抽象而扩大 v1 的验收范围。

## 3. 支持范围

### 3.1 基础结构索引

v1 只支持已经注册 grammar 的语言。首批语言为：

- Java
- C#
- TypeScript
- JavaScript
- Python
- Go
- Rust

语言注册表必须允许后续增加 grammar，但 v1 不宣称“兼容所有语言”。没有 grammar 的文件不能进入 Tree-sitter 结构索引，不能伪造符号结果，并且必须记录为 unsupported 或 skipped。

基础结构索引只输出以下信息：

- 文件和相对路径；
- 文件所属项目；
- 声明、容器和符号；
- import/export；
- AST 源码范围；
- 解析诊断；
- 可追溯的 evidenceId。

### 3.2 项目和依赖分析

ProjectDiscovery 只识别明确的工程边界和 manifest。v1 不要求推断不存在于 manifest 或源码语法中的隐式项目关系。

SyntacticDependencyResolver 只处理显式的：

- import/export；
- project reference；
- manifest 声明的项目依赖。

未解析或存在多个候选项的关系必须标记为 unresolved 或 ambiguous。系统不能把低置信度结果升级为确定依赖，也不能把依赖边扩展成未经证实的调用图。

### 3.3 深度语义

Java/C# 可以使用现有专用分析器或 LSP 提供 definition、references 和 diagnostics。其他语言没有可用 semantic provider 时，只能返回结构证据，不能返回伪造的语义证据。

provider 和 evidenceLevel 必须反映真实来源：

~~~text
tree-sitter              → structural
lsp                      → semantic
java-csharp-specialized  → semantic
~~~

## 4. 统一链路和模块边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| RepositoryRegistry | 管理稳定 repositoryId、显示名、本地路径、历史/目标角色和活动 revision | 不解析源码，不把绝对路径传给 Agent |
| AnalysisCoordinator | 调度全量/增量索引，维护 registered → indexing → ready/degraded/failed 状态 | 不负责语言解析，不负责 Agent 决策 |
| LanguageRegistry | 注册 languageId、扩展名、grammar 和能力等级 | 不解析依赖，不写数据库 |
| TreeSitterStructuralIndexer | 输出文件、声明、容器、import/export、源码范围和解析诊断 | 不猜测跨文件 definition/reference，不生成调用图 |
| ProjectDiscovery | 识别受支持的 manifest 和工程边界 | 不解析业务逻辑，不推断隐式工程关系 |
| SyntacticDependencyResolver | 基于显式语法和 manifest 生成依赖边及证据 | 不把动态依赖伪装成已解析关系 |
| SemanticProvider | 提供真实 LSP 或 Java/C# 专用分析结果 | 不管理 UI，不写 summary |
| IndexStore | 保存版本化仓库、文件、符号、依赖、诊断和模块产物 | 不负责向量检索，不负责源码解析 |
| SeekDbProjection | 将活动 revision 的符号、片段和 summary 投影为检索文档 | 不充当依赖图的唯一事实源 |
| SemanticQueryPort | 提供带 revision 约束的只读查询 | 不接受任意本地路径，不执行写入 |
| ArchitectAgent | 通过工具调用获取证据并提出模块计划 | 不读取文件系统，不审批，不写 summary |
| VS Code Host | 保存配置、启动索引、选择目标项目、校验、审批和发布 summary | 不维护另一套轻量分析事实 |
| semantic-index-mcp-server | 只读代理 SemanticQueryPort | 不拥有 Tree-sitter、LSP、SeekDB 或索引生命周期 |

现有 Java/C# RepositoryStaticAnalysis 可以继续服务于迁移执行链路的兼容逻辑，但不能继续作为新索引的前端展示来源，也不能与新索引各自生成一份 summary 事实。[repository-analysis.ts](E:/Eproject/weichai/services/code-indexer/src/repository-analysis.ts:2034)

## 5. 前端和仓库生命周期

### 5.1 路径配置

前端必须支持多个历史仓库路径，并且支持添加、修改和删除。保存配置后，Host 必须：

1. 对路径进行规范化和去重；
2. 注册或更新对应的 repositoryId；
3. 为新增或变更路径启动索引；
4. 对已删除路径执行 unregister、retire 或明确的 stale 标记；
5. 不让已删除仓库继续出现在当前历史仓库列表中。

删除路径不能只删除 VS Code 设置而保留 Registry 和 SeekDB 中的活动仓库。配置更新不能只刷新旧模块树而不刷新统一索引。

### 5.2 目标工程

目标工程不能只通过当前 workspace 隐式决定。前端必须从已索引的 ProjectRecord 中展示并选择目标项目，至少显示：

- repositoryId；
- projectId；
- 项目名称和相对路径；
- 当前 analysisRevision；
- 索引状态；
- 语言和语义能力。

选择类、方法或文件只能作为目标项目选择之后的细粒度定位，不能替代项目选择。

### 5.3 前端展示

前端必须展示统一索引产生的状态和结果，包括：

- 历史仓库和目标工程；
- 项目列表；
- revision 和索引状态；
- 支持语言和能力等级；
- 符号、依赖和诊断查询结果；
- 当前有效或已失效的 module summary。

前端不能继续只展示旧 RepositoryStaticAnalysis、启发式模块分组或文件系统 summary，并将其标记为新索引结果。

## 6. 数据模型与一致性

SeekDB 使用以下独立表或等价的数据集合：

~~~text
repositories
analysis_revisions
projects
files
symbols
dependency_edges
module_artifacts
search_documents
~~~

关键约束如下：

- 每个查询必须携带 repositoryId + analysisRevision。
- symbolKey 必须使用限定名、签名和 AST 声明标识；行号不能作为跨 revision 主键。
- 新 revision 未完整完成前，不能切换 activeRevision。
- 构建期间必须继续读取旧的有效 revision，不能暴露半成品。
- Summary 必须绑定 repositoryId + analysisRevision + analysisHash + planHash。
- 文件或符号删除后，必须删除对应检索投影，不能使用全库 clear()。
- revision 更新后，旧 summary 必须自动标记为 stale，不能继续作为当前结果展示。
- SeekDB 检索投影不能替代结构索引和依赖图的事实存储。

现有 code_symbols 只能作为检索投影使用，不能承载依赖图、快照、revision 或审批状态。[seekdb-store.ts](E:/Eproject/weichai/services/retrieval-service/src/seekdb-store.ts:137)

## 7. Agent / MCP 查询接口

新增 SemanticQueryPort，由独立 MCP server 暴露只读工具：

~~~text
list_repositories
get_repository_overview
list_projects
get_file_structure
search_symbols
get_symbol
find_definition
find_references
get_dependencies
get_diagnostics
read_source_excerpt
~~~

每个结果必须统一返回：

~~~yaml
repositoryId
analysisRevision
evidenceId
provider: tree-sitter | lsp | java-csharp-specialized
confidence / evidenceLevel
relativePath
sourceRange
~~~

Agent 只能调用上述只读工具。Agent 不能传绝对路径，不能启动 LSP，不能直接访问 SeekDB，不能修改索引，不能写入 summary，不能跳过 revision 校验。

ArchitectAgent 不能继续把完整快照作为唯一输入。ToolCallingArchitectRuntime 必须通过 SemanticQueryPort 循环取证，并且只能引用同一个 revision 的 evidenceId。

## 8. Summary 发布

Agent 只负责提出模块计划，不负责将计划标记为已批准。Host 必须执行以下校验：

1. 所有 evidenceId 均属于请求中的 repositoryId 和 analysisRevision；
2. 所有引用的文件、符号和依赖仍存在；
3. 计划哈希和索引哈希匹配；
4. 用户完成审批；
5. 只有校验和审批成功后，才写入 module_artifacts 并更新 SeekDB summary 投影。

校验失败时不能发布 summary。索引 revision 变化时不能继续发布旧计划，也不能把旧 summary 当作当前结果。

文件系统 summary 可以作为兼容导出，但不能成为 SeekDB summary 的唯一写入路径或唯一展示来源。

## 9. 推荐代码落点

~~~text
packages/contracts/src/code-intelligence.ts
packages/workflow-core/src/semantic-query-port.ts

services/code-indexer/src/
  repository-scan.ts
  language-registry.ts
  project-discovery.ts
  tree-sitter-indexer.ts
  tree-sitter-languages/<language>.ts
  syntactic-dependency-resolver.ts
  deep-analysis-adapters.ts
  structural-index.ts

services/code-intelligence-service/
  repository-registry.ts
  analysis-coordinator.ts
  index-store.ts
  seekdb-projection.ts
  lsp-session-manager.ts
  semantic-query-service.ts

services/semantic-index-mcp-server/
~~~

adaptation-service 只能调用 SemanticQueryPort。它不能拥有第二套索引、解析器或 summary 存储。VS Code Host 不能绕过统一查询端口调用旧的快照式 Agent 接口。

## 10. 分期施工

### 阶段一：索引底座

新增 contracts、仓库注册、扫描、revision 和 Tree-sitter 索引。首批只验收七种已注册语言，不验收“所有语言”。

### 阶段二：项目与依赖

实现工程识别、import/export 解析、项目引用、依赖边、SeekDB 持久化和增量投影。保留 Java/C# 专用分析器，但不让它们分叉出另一套仓库索引事实。

### 阶段三：语义查询层

实现 SemanticQueryPort、MCP facade 和 LSP session manager。Java/C# 先接入现有 compiler probe；其他语言没有 semantic provider 时不能返回 semantic 证据。

### 阶段四：Agent 改造

将 VS Code Host 从旧 /v1/module-plan 切换到 revision-scoped 的工具调用流程。没有这一步，Agent 解析和 SeekDB summary 不能视为完成。

### 阶段五：前端闭环

实现历史仓库批量刷新、目标项目选择、索引状态、能力等级、符号/依赖查询、模块 summary、revision 切换和失效提示。没有项目选择和统一结果展示，前端闭环不能验收通过。

## 11. 验收条件

- 用户添加两个历史仓库后，两个仓库都能独立索引、检索和展示，且不会清空另一仓库的数据。
- 用户删除或替换历史路径后，旧仓库不会继续作为活动仓库展示，也不会继续被误选为当前结果。
- 修改一个仓库的单个文件后，不会无条件重建所有仓库；系统至少能增量重解析受影响文件和依赖边。
- 每种已注册 grammar 的语言至少能得到文件、声明、import/export、源码范围和诊断信息。
- 未注册 grammar 的语言不会被伪造成已解析结果。
- find_definition 和 find_references 只有在 LSP 或专用分析器可用时才能标记为 semantic evidence。
- Agent 的全部证据来自同一个 analysisRevision，不能混用不同 revision 的结果。
- Agent 不能直接读取绝对路径、访问 SeekDB 或写 summary。
- 审批前不能发布 summary；审批后的 summary 必须写入 module_artifacts 和 SeekDB 投影。
- revision 更新后，旧 summary 自动标记过期，不能继续作为当前结果展示。
- 目标工程必须与历史仓库使用相同的索引链路；差异只能存在于角色、权限和执行/写回阶段。
- 前端展示的符号、依赖和 summary 必须能够追溯到统一索引的 repositoryId、analysisRevision 和 evidenceId。

## 12. PR28 对本 SDD 的最低补齐要求

PR28 不能仅以测试通过作为闭环完成的依据。至少还必须补齐以下连接：

1. VS Code Host 必须调用新的 semantic module plan 入口，不能继续只调用旧 /v1/module-plan。
2. SemanticQuery HTTP server 必须有明确的生产启动路径，不能只提供未被调用的 factory。
3. Agent 计划审批后必须调用 publishModuleSummary，不能只写 .forexplore/module-summary.json。
4. 前端必须展示并选择 ProjectRecord，不能只选择类、方法或文件目标。
5. 删除历史路径时必须注销、废弃或明确隐藏对应的 Registry 和 SeekDB 数据。
6. 新索引结果必须成为模块树、依赖展示和 summary 展示的唯一事实来源。

在上述连接完成前，PR28 只能称为“多语言结构索引和语义查询基础设施”，不能称为“历史仓库、目标工程、Agent、SeekDB 和前端展示的完整实现”。
