# ForeXplore VS Code 扩展

ForeXplore 将企业已有实现作为迁移证据：把光标放在 Java 或 C# 类的任意成员中，扩展通过当前语言服务器定位完整类、检索完整类候选、生成目标类，并用 LSP 增量诊断驱动限时修复。

当前写入边界是完整 `class` 或 `record`；`interface` 只作为契约上下文。候选排序分不是正确率或兼容概率。LSP 通过后只会生成 Validator handoff，业务验证通过前仍不能写回。

## 模块迁移计划

模块级迁移计划由 VS Code 扩展宿主负责，不经 Webview 提交源码、计划或写入请求。当前提供六个受信任命令：

- **ForeXplore: 索引模块迁移仓库**：对本地工作区执行 Java/C# 静态分析，并把不可变快照写入 `.forexplore/analysis/<snapshotId>.json`。默认收集可复现的语法证据；只有受信任的 JDK/Roslyn 绑定适配器明确确认的精确边才会标记为语义证据，编译器可用性探测不会提升证据等级。
- **ForeXplore: 审阅模块迁移计划**：只向适配服务发送 `snapshotId`、目标和不可变约束；服务端从自己持有的分析制品读取证据。扩展宿主验证 Agenticodex 提案、确定性生成波次，并在只读文档中展示计划和证据。
- **ForeXplore: 审阅下一迁移波次**：只有整份计划已对同一快照审批后才会展示依赖已提交的下一波次。该命令只显示调度、静态证据和可供后续补丁审阅的范围；它不创建波次审批、不准备补丁，也不提交代码。
- **ForeXplore: 导入并准备下一迁移波次**：从本机文件选择器读取严格的仅补丁 JSON，在隔离 worktree 中运行宿主范围检查和本地联合验证，并生成待审阅的 `preparedHash`。
- **ForeXplore: 审批并提交已准备迁移波次**：把人工审批绑定到已审阅的 `preparedHash`，然后将该波次发布为受管迁移分支上的单个原子 Git 提交。
- **ForeXplore: 恢复模块迁移审阅状态**：从扩展受信任存储和不可变快照恢复审阅状态；它不写入源码，也不把仓库中的摘要当作审批授权。

计划审批绑定快照和计划哈希，并仅保存在扩展的受信任审阅状态中。执行协调器必须先在隔离 worktree 中生成精确补丁、完成波次联合验证并计算 `preparedHash`；人对该制品审批后，协调器才会把代码、`.forexplore/module-summary.json` 和运行清单放入同一个原子 Git 事务。扩展不会单独写入或覆盖摘要。模块计划服务必须将 `ADAPTATION_ANALYSIS_ROOT` 指向当前工作区的 `.forexplore/analysis`，以便 `/v1/module-plan` 只按快照标识读取服务端制品。

### 可信本地波次执行

整份计划已经对当前静态快照审批后，按以下顺序执行每个依赖波次：

1. 运行 **ForeXplore: 审阅下一迁移波次**，确认要准备的依赖已满足波次及其证据。
2. 运行 **ForeXplore: 导入并准备下一迁移波次**，从本机文件选择器导入补丁包。扩展先显示只读补丁包预览；确认后才在隔离 Git worktree 中应用补丁、执行宿主范围检查和本地联合验证，并生成精确的 `preparedHash`。
3. 审阅已准备波次中的补丁、验证记录和 `preparedHash`。运行 **ForeXplore: 审批并提交已准备迁移波次**，输入审批人后，扩展把审批绑定到该精确哈希，再发布单个原子 Git 提交到受管分支 `codex/forexplore-migration/<runId>`。当前工作区不会被直接部分写入。

补丁包只能从本地文件选择器导入，不能由 Webview、浏览器或 HTTP 请求提交。它是非可信的补丁输入，不得包含验证结论；验证必须由本地 VS Code 宿主在隔离 worktree 中重新执行。扩展重启会使内存中的已准备补丁失效。运行 **ForeXplore: 恢复模块迁移审阅状态** 后，放弃旧制品并重新准备、验证和审批该波次。

### 本地补丁包格式

导入文件必须是严格的 JSON 对象，且顶层只能含有 `schemaVersion`、`snapshotId`、`planId`、`planHash`、`waveId` 和 `modules`。`schemaVersion` 固定为 `forexplore-module-wave-patch-bundle/v1`；`snapshotId`、`planId`、`waveId` 和 `moduleId` 是安全标识符。`planHash` 可写为 `sha256:<64 个小写十六进制字符>` 或不带前缀的 64 个小写十六进制字符，宿主会规范化为带前缀的计划哈希；文件的 `expectedOriginalSha256` 可使用两种输入形式，但内部会规范化为裸 SHA-256 摘要以匹配受保护回填契约。

```json
{
  "schemaVersion": "forexplore-module-wave-patch-bundle/v1",
  "snapshotId": "snapshot-20260827",
  "planId": "plan-20260827",
  "planHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "waveId": "wave-01",
  "modules": [
    {
      "moduleId": "orders",
      "files": [
        {
          "path": "src/Orders/OrderService.cs",
          "status": "modified",
          "expectedOriginalSha256": "0000000000000000000000000000000000000000000000000000000000000000",
          "additions": 1,
          "deletions": 1,
          "hunks": [
            {
              "header": "@@ -1 +1 @@",
              "lines": [
                { "type": "remove", "content": "old implementation" },
                { "type": "add", "content": "new implementation" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

每个 `files` 项只能是 `modified` 或 `created`。`modified` 需要 `expectedOriginalSha256`；`created` 必须使用 `expectedAbsent: true` 替代它。两种形式都需要 `path`、`status`、`additions`、`deletions` 和非空 `hunks`。每个 hunk 仅含 `header` 和 `lines`，每行仅含 `type`（`context`、`add` 或 `remove`）及单行 `content`；`additions`、`deletions` 必须与 hunk 行数一致。v1 不支持删除文件。

路径必须是正斜杠的规范仓库相对路径，不能使用绝对路径、`..`、空段或反斜杠。模块和写入路径不能重复，补丁包必须精确覆盖当前下一波次的所有模块，并且每个补丁路径都必须属于相应模块已经审批的源码、测试、生成文件或写集。写集本身只能引用快照中由该模块显式拥有的文件；唯一的例外是具备资源锁、显式排属的 `shared-contract` 模块配置文件。`.forexplore/` 下的摘要和运行制品由协调器生成，补丁包不能写入。未知字段会被拒绝，尤其不能提供 `validation`、`contentHash`、源码全文或任何执行指令；宿主会自行计算内容哈希并产生验证证据。

### 波次联合验证配置

`forexplore.moduleWaveValidationCommands` 是本机用户级 VS Code 配置，不从补丁包、Webview 或工作区 `.vscode/settings.json` 读取。工作区尝试覆盖该值会被拒绝，避免仓库内容变成可执行宿主配置。配置的命令只在隔离波次 worktree 中执行，使用 `shell: false`，因此不能依赖 `&&`、管道、重定向或 shell 变量展开。没有配置时，扩展会产生必需的 `unverified` 记录并阻止波次准备。

```json
{
  "forexplore.moduleWaveValidationCommands": [
    {
      "id": "dotnet-test",
      "label": "Target tests",
      "executable": "dotnet",
      "args": ["test", "tests/Target.Tests/Target.Tests.csproj"],
      "cwd": ".",
      "required": true,
      "timeoutMs": 600000
    }
  ]
}
```

每项只允许 `id`、`label`、`executable`、`args`、`cwd`、`required` 和 `timeoutMs`。`id`、`label`、`executable` 必填；其余分别默认为空数组、`.`、`true` 和 10 分钟。最多配置 32 条命令，`timeoutMs` 必须在 1 秒到 30 分钟之间。`cwd` 必须是 worktree 内的相对路径；`executable` 可以是受 PATH 解析的简单命令名，或使用正斜杠的 worktree 内相对可执行文件，不能是绝对路径或使用反斜杠。任何必需检查失败或未验证都会阻止准备和后续审批提交。

## 运行方式

1. 在仓库根目录运行 `npm run dev:extension`。脚本会启动 SeekDB、两个本地服务，并打开 Extension Development Host。
2. 在开发宿主中打开目标工作区；默认夹具是 Java 工程 `fixtures/target-system/commons-fileupload-java-skeleton`。
3. 在 Java 或 C# 类的任意成员中放置光标，运行 **ForeXplore: 开始代码翻译**；不需要选中方法或类。
4. 输入需求、选择完整类候选，查看 LSP 修复轮次，然后把通过的结果交给 Validator。

类翻译只调用真实 SeekDB 检索服务；Analyzer 和 Translator 在 Extension Host 中直接调用配置的模型 API。没有 mock、HTTP adaptation 或编译器回退。

按目标语言安装对应的 VS Code 语言扩展即可；ForeXplore 本身不依赖某个语言扩展。

## 服务要求

运行插件需要一台具备以下条件的机器：

- SeekDB 检索服务已经建立并加载完整的多语言 `code-corpus` 索引；
- Java/C# 语言扩展提供 document symbols、definition、references 和 diagnostics；
- 使用 **ForeXplore: 配置模型密钥** 将密钥存入 VS Code `SecretStorage`；
- Validator 扩展按需提供 `forexplore.validator.validateHandoff` 命令。

插件默认使用以下 VS Code 配置：

```json
{
  "forexplore.executionMode": "real",
  "forexplore.retrievalApiUrl": "http://127.0.0.1:8787",
  "forexplore.modelApiUrl": "https://api.deepseek.com/v1",
  "forexplore.model": "deepseek-v4-flash",
  "forexplore.translationTimeoutSeconds": 120,
  "forexplore.maxTranslationAttempts": 4,
  "forexplore.repositoryPaths": [
    "E:/CS/devsys/weichai/fixtures/code-corpus"
  ]
}
```

该目录包含 `fixtures/code-corpus` 下的全部语料仓库。`forexplore.repositoryPaths` 仅检查本地目录是否可读；它不等于服务端“已经索引”。真实检索范围由检索服务的已授权索引决定。

## 写回保护

- Webview 只能发送“检索、选择候选、生成、应用”的意图，不能提交路径、候选对象或补丁。
- 扩展宿主保存当前运行的目标语言、候选、原始文件 SHA-256 和适配结果；候选必须由用户明确选择。
- 仅接受工作区内、当前选中目标对应的一个相对路径修改补丁；路径遍历、绝对路径和经符号链接逃逸都会被拒绝。
- 应用前和应用时都会重新校验 SHA-256，hunk 必须精确匹配原始内容。
- 写入建立持久恢复点。可使用 **ForeXplore: 恢复最近一次回填** 恢复；若文件随后又被编辑，恢复会拒绝覆盖该编辑。
- HTTP `POST /v1/backfill` 已禁用。写回只能由经过用户确认的 VS Code 宿主执行。

LSP 通过只代表候选类没有引入新的语言诊断；它不证明业务行为、并发、超时、取消或幂等语义正确。

## 开发与验证

```bash
npm ci
npm run typecheck --workspace forexplore-vscode
npm run test --workspace forexplore-vscode
npm run build:extension
npm run package:extension
```

集成测试需要图形界面 VS Code 运行时：

```bash
npm run test:integration --workspace forexplore-vscode
```

## 消息协议

Webview → 宿主：`READY`、`START_SEARCH`、`SELECT_CANDIDATE`、`START_ADAPT`、`SEND_TO_VALIDATOR`、`APPLY_CURRENT_RUN`、`CHECK_REPOSITORIES`、`OPEN_TARGET`。

宿主 → Webview：`INIT`、`SEARCH_RESULT`、`TRANSLATION_ATTEMPT`、`ADAPT_RESULT`、`APPLY_RESULT`、`REPOSITORY_STATUS`、`SERVICE_STATUS`、`ERROR`。

完整架构、诊断差异和迁移说明见仓库文档 `docs/lsp-class-translation.md`。

共享类型和状态机在 monorepo 的 `@forexplore/contracts`、`@forexplore/workflow-core` 中维护；打包时 Webview 与扩展宿主会将所需代码纳入 VSIX 构建产物。
