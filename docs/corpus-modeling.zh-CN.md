# 语料建模与前端展示（code-corpus）

**目标**：`fixtures/code-corpus` 下的**每个**仓库都完成模块建模，并在前端显示为**模块树**（而不是退化的"文件视图"）。

## 1. 一条命令拉起整个语料

```bash
CODE_INTELLIGENCE_EMBEDDING_URL=http://127.0.0.1:4021/v1/embeddings \
CODE_INTELLIGENCE_EMBEDDING_MODEL='Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78' \
CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS=false \
CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX='query: ' \
CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX='passage: ' \
CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION=384 \
npx tsx scripts/serve-code-workbench.mts \
  --target <目标工程> --corpus fixtures/code-corpus \
  --port 4042 --semantic-port 4043 --database <库名> \
  --adaptation-url http://127.0.0.1:8788
```

- `--corpus <dir>` 是本次新增：把该目录下**每个子目录**都注册为历史参考工程（等价于逐个 `--reference`）。
- 工作台在启动时默认执行一次 `build()`：**建索引 + 模块建模**（`--register-only` 可跳过；`--rebuild-modules` 只重做建模）。
- 建模需要适配服务在跑（它负责调模型）：`ADAPTATION_SEMANTIC_INDEX_ENABLED=true`、`SEMANTIC_QUERY_PORT_URL=http://127.0.0.1:4043`、`DEEPSEEK_API_KEY`。

## 2. 前端为什么能显示模块

产品树由 `apps/vscode-extension/src/project-explorer.ts` 的 `buildProjectExplorer` 构建，数据来自 `host.explorerData()`：

- 每个仓库条目带 `analysis`（持久化的 `ProjectAnalysisRecord`，即建模结果）；
- `analysis.proposal` 存在 → 用 `indexModuleHierarchy` 按**模块**建树（模块名、描述、purpose、coreApis、层级、refinement 全部来自建模）；
- 不存在 → 退化为 `「<名>（文件视图）」`，`stats.modules = 0`。

所以"前端能不能显示"= "该仓是否建模成功"。工作台与 VS Code 扩展共用这条链路；
扩展侧还需要这些仓在设置 `forexplore.repositoryPaths` 里（或由本次会话注册过），否则它们不在该窗口的可见集合内。

## 3. 验收（可复跑）

```bash
npx tsx scripts/verify-corpus-explorer.mts --corpus fixtures/code-corpus
```

断言与输出：

- 语料目录下的每个仓都出现在前端负载里；
- 每个仓 `analysis.state === 'ready'`、`stats.modules > 0`、且不是"文件视图"；
- 打印逐仓的模块数/文件数/首批模块名，并把明细写到 `--output` 指定的 JSON；
- 任一仓缺失或未建模 → 退出码非 0 并列出名单。

2026-09-14 实测：**20/20 可见，合计 159 个模块**，全部 `strategy=agent`。

## 4. 本次修掉的两个缺陷

`harmony-upload-native`（唯一的纯 C/C++ 语料仓，3 个文件）此前**4/4 次建模失败**，
错误只有一句被脱敏的 `Semantic index query failed.`。定位后是两个独立缺陷：

1. **模型工具参数为空 → 整个模块规划中止**
   `ToolCallingArchitectRuntime` 对模型自己写错的参数（`get_file_structure` 的
   `relativePath` 为空）直接抛错并放弃整次分析。现在这类参数错误作为
   `{ error: 'invalid_arguments', message, instruction }` 回喂给模型，规划继续；
   **越权/走私类仍然中止**：编造未声明的字段、试图切换 repositoryId/analysisRevision、
   绝对路径或越界 limit 都保持 fail-closed（既有测试守着这条边界）。
2. **语义索引对"仓库根"只能给出一句不可解释的错误**
   `SemanticQueryService.getFileStructure` 对空/缺失路径抛普通 Error，被 HTTP 边界统一
   替换成 `Semantic index query failed.`（设计上不泄漏内部细节）。现在抛出
   `SemanticQueryArgumentError`，由 `semantic-query-http-server` **原样转达**该消息——
   它描述的是调用方自己的输入，不是宿主细节；真正的内部错误仍保持脱敏。

其余仓库之所以没暴露这个问题，只是因为模型恰好没以空路径调用该工具（同一对照组
`multipart-shared-kmp` 也复现了 400）。修复后该仓一次建模成功（`state=ready`）。

## 5. 遗留与边界

- `get_file_structure` 仍不支持"仓库根"语义，只是改成**可纠正的明确报错**；
  列文件的需求由 `get_repository_overview` / `list_projects` / `search_symbols` 覆盖。
- 参数错误回喂会消耗原有的工具调用预算（`maxToolCalls`），不会无限重试。
- SeekDB 向量查询的 10 秒上限仍会偶发打断建模（本次 20 个仓中出现 1 次，重试即过）；
  产品路径（工作台/扩展）目前没有自动重试，脚本侧 `scripts/model-corpus.mts --attempts N` 有。
