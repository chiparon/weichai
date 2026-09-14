# 模块检索、翻译与回填验证（2026-09-14）

> 本文记录修复前的检查结果。后续已完成接线修复，当前结果见 [模块链路修复说明](module-pipeline-repair.zh-CN.md)。

结论：**后台组件能够完成真实模型、多文件回填和回滚；最新版界面的模块级操作仍不能完整跑通。** 此次不是完整 SeekDB 生产配置验收。

## 版本与工作目录

- 已执行 `git fetch --all --prune`。
- 最新上游：`upstream/main`，`69d720d`，2026-09-14 18:01:09 +0800。
- 验证目录：`D:/CodeProjects/Weichai-latest-check`，分支 `codex/verify-module-pipeline`。
- 原目录 `D:/CodeProjects/Weichai` 的未提交删除和未跟踪文档均保留。
- 本次仅新增验收脚本与本报告，没有修改产品实现，也没有提交或推送。

## 阻塞与缺口

1. **VS Code 模块候选不能进入适配。** `apps/vscode-extension/src/extension.ts:883` 的 `startAdaptation` 在目标或候选 `kind === 'module'` 时，于第 888 行直接抛出“当前模块检索尚未接通多文件适配。”。因此模块检索后点击翻译无法进入后续补丁回填。后台已有 `buildModuleTranslationScope` 和 `rememberModuleScope`，但这两个接口没有在产品入口中接起来；现有验收脚本自行完成了这些调用。
2. **浏览器的模块检索也未接适配/回填。** `scripts/serve-code-workbench.mts:195` 实现了 `START_SEARCH`，但没有处理模块候选流程的 `SELECT_CANDIDATE`、`START_ADAPT`、`APPLY_CURRENT_RUN`，会进入第 205 行的“此操作需要在 VS Code 扩展中完成。”。工作台另有任务证据的工作区翻译入口，不能据此认为模块候选流程已经接通。
3. **独立 retrieval-service 构建失败。** `npm run build:retrieval` 报 `src/search-engine.ts(36,11): TS2322`：目标类型已包含 `module`，`candidateKinds()` 却把它传给只允许 `class | function` 的 `IndexedCodeDocument['kind'][]`。这和新版 `code-intelligence-service` 的模块检索是不同实现；后者的构建与本次后台实测通过。
4. **本机无法验收完整运行环境。** 初始相关服务端口均未监听。尝试启动 Docker Desktop 后，Docker API 长时间不响应，已中断等待；SeekDB 2881 仍未监听。`dotnet --list-sdks` 为空，C# 模块编译验收缺少 SDK。

## 真实模型后台实测

使用旧目录 `D:/CodeProjects/Weichai-guochuang-implementation/services/adaptation-service/.env` 中配置的 DeepSeek V4 Flash，未复制或输出密钥。

隔离样例：Java `LimitPolicy` → JavaScript 两文件模块（`target.mjs`、`policy.mjs`）。实际执行：

1. 创建源仓库与目标骨架，用真实结构索引器索引 Java 源码。
2. 写入事先定义并校验的模块摘要，通过 `ModuleImplementationSearchService` 检索模块候选。
3. 用 `buildModuleTranslationScope` 限定两文件写入范围；候选仅提供历史版本查询范围，不预先注入候选源码。
4. 通过真实 HTTP 和宿主协议启动 `WorkspaceTranslationRuntime`，实际调用 DeepSeek；模型经语义查询 HTTP 按需获取历史实现。
5. 写回真实目标文件，执行 Node 语法验证、行为测试；脚本在运行结束后再次独立执行行为测试。
6. 重新创建宿主对象，通过回滚接口恢复两个原始骨架，并核对验证脚本未被修改。

| 项目 | 实测结果 |
| --- | --- |
| 模块候选 | 1 个，Top1 为 Limit policy，得分约 0.8889 |
| 模型调用轮数 | 8 |
| 历史证据查询 | 2 次 |
| 写回 | 2 个文件，仅在允许范围内 |
| 编译/语法验证 | 1 次，通过 |
| 服务终态 | `completed` / `behavior-verified` |
| 独立行为验证 | 222 项边界断言通过 |
| 回滚 | 两文件均恢复成功 |

测试明确使用 **InMemoryIndexStore 的词法检索**，没有验证 SeekDB 或真实向量嵌入；模块摘要是固定样例元数据，没有调用模型自动拆分模块。该结果证明后台接线、真实模型调用、按需证据查询、多文件写入、验收和回滚可工作，不代表复杂工程的翻译质量或界面可用性。

复跑命令（在验证目录中）：

```powershell
npx tsx scripts/verify-module-pipeline-smoke.mts --env-file D:/CodeProjects/Weichai-guochuang-implementation/services/adaptation-service/.env --output tmp/pipeline-verification/live-multifile-smoke.json
```

脚本每次创建独立样例目录，不修改用户目标工程。产物保留在 `tmp/pipeline-verification/`，包含完整运行报告、生成源码和日志。

## 自动化与构建

已运行 `npm test`；其在 adaptation-service 失败后停止，随后单独补跑其余 4 个测试入口。合计 **814 通过、1 失败、1 跳过**。

| 测试入口 | 结果 |
| --- | --- |
| workflow-core | 35 通过 |
| code-indexer | 85 通过 |
| adaptation-http-adapter | 5 通过 |
| retrieval-service | 50 通过 |
| code-intelligence-service | 213 通过 |
| adaptation-service | 213 通过、1 失败、1 跳过 |
| adaptation-mcp-server | 7 通过 |
| semantic-index-mcp-server | 18 通过 |
| VS Code 扩展与 Webview | 186 通过 |
| guochuang-handoff 集成测试 | 2 通过 |

失败用例为 `module-patch-preparer.test.ts` 的编译→修复→行为验收测试，最终报 `Unexpected model turn`。该测试使用固定模型工具序列并强依赖 `dotnet build`；本机没有 .NET SDK，因此不能完成其预期编译验收。没有将该失败跳过或改成通过。

- `npm run build`：通过（Webview + 扩展）；esbuild 有两条 `import.meta` / CJS 警告。
- `npm run typecheck --workspace forexplore-vscode`：通过。
- `npm run build:code-intelligence`：通过。
- `npm run build:adaptation`：通过。
- `npm run build:retrieval`：失败，类型契约未覆盖 `module`，见上文。

日志：`tmp/pipeline-verification/test.log`、`test-mcp.log`、`test-semantic-mcp.log`、`test-extension.log`、`test-handoff.log`、`build.log`、`typecheck.log`、`build-services.log`、`live-multifile-smoke.log`。

建议后续先把宿主已验证的模块候选与作用域接入工作区翻译接口，明确多文件预览/回填交互，同时修复 retrieval-service 的类型契约；之后补齐 SeekDB、模型化语料和对应编译器，再执行完整界面端到端验收。
