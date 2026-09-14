# 模块级生成流水线

本文记录模块级“生成 → 联合验证 → 审批 → 原子提交”的接线、边界与复现方式。
模块级**检索**与模块计划/波次调度此前已可用；本文补齐的是模块候选到多文件补丁的生成侧。

## 结论（2026-09-13 实测）

- 模块级生成侧已接通：真实模型在**每个模块自己的隔离 worktree**里按现有翻译回路生成补丁，宿主随后在合并 staging worktree 做联合验证，人工审批绑定 `preparedHash` 后原子提交到受管迁移分支。
- 用户工作区全程不被就地修改，提交前 `git status` 保持干净。
- 模块波次只能修改 `writeSet` 内的既有文件；**新建文件目前无法进入波次**（`writeSet` 必须存在于静态分析快照中，见下文“已知限制”）。

## 组件与信任边界

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `ModuleWavePreparationRunner` | `services/adaptation-service/src/module-wave-preparation-runner.ts` | 按 SCC/共享契约分组、每模块一个 detached worktree、并发上限，并拒绝任何改动了自己 checkout 的 preparer |
| `WorkspaceModulePatchPreparer` | `services/adaptation-service/src/module-patch-preparer.ts` | 为每个模块起一个临时 `WorkspaceTranslationRuntime`，跑完把 run 的 before/after 日志转成 `FilePatch[]`，然后**回滚** worktree 并清理记录 |
| `ModuleWaveExecutionCoordinator` | `services/adaptation-service/src/module-wave-execution.ts` | 合并 staging worktree、联合验证、`preparedHash`、计划/运行清单状态机、原子提交 |
| `prepareGeneratedModuleWave` | `apps/vscode-extension/src/module-wave-execution-host.ts` | 宿主入口：写集归属校验、下一波次校验、运行清单、把宿主验证器接进协调器 |
| 命令 `RECAST: 生成并准备下一迁移波次` | `apps/vscode-extension/src/module-migration-host.ts` | 读取已审批计划与静态快照，调用宿主入口，产出待审阅的 `preparedHash` |
| `ModuleGenerationHost` 门配置 | `apps/vscode-extension/src/module-generation-gate.ts` | 只接受本机可信配置的编译/验收命令，禁止绝对路径 |

模型调用留在本地 adaptation service（它已有凭据通道）；仓库、worktree、编译器与 Git 全部留在受信任的扩展宿主进程。两者之间只传有界的对话轮次：

```
POST /v1/module-generation/turn      # 只接受 messages/tools，不接受路径、文件或命令
Authorization: Bearer <ADAPTATION_MODULE_GENERATION_TOKEN>
```

## 配置

后端（`services/adaptation-service/.env` 或宿主进程环境）：

```dotenv
ADAPTATION_MODULE_GENERATION_ENABLED=true
ADAPTATION_MODULE_GENERATION_TOKEN=<至少 32 字符>
```

扩展侧（`settings.json`，`scope: machine`）：

```json
{
  "forexplore.moduleGenerationGate": {
    "enabled": true,
    "compileCommand": { "executable": "dotnet", "args": ["build", "Fixture.csproj", "--nologo", "-v", "q"] },
    "verification": {
      "command": { "executable": "dotnet", "args": ["exec", "bin/Debug/net8.0/Fixture.dll"] },
      "protectedFiles": ["Program.cs"]
    },
    "maxModelTurns": 24
  },
  "forexplore.moduleWaveValidationCommands": [ /* 波次联合验证命令，与生成门相互独立 */ ]
}
```

`compileCommand` / `verification.command` 只在**单个模块的 worktree** 内运行，是生成期的快速反馈，产出的记录一律标为 `required: false` 且注明“非权威”；波次验收仍然是 `forexplore.moduleWaveValidationCommands` 在合并 worktree 中产生的证据。

## 使用顺序

1. `RECAST: 索引模块迁移仓库` → `RECAST: 审阅模块迁移计划` → 审批计划。
2. `RECAST: 审阅下一迁移波次`（只读预览依赖已满足的波次）。
3. `RECAST: 生成并准备下一迁移波次`：按模块隔离生成 + 合并联合验证，产出 `preparedHash`。
4. 审阅补丁与验证证据后运行 `RECAST: 审批并提交已准备迁移波次`，把审批绑定到该 `preparedHash` 并原子提交。
5. `RECAST: 导入并准备下一迁移波次` 仍然保留，作为离线/手工补丁包路径。

## 不变的安全性质

- 生成期任何一步失败都使该模块失败，进而使整个波次不产出 `preparedHash`；**不会返回部分补丁**。
- preparer 只返回补丁证据；协调器复核路径必须落在模块 `writeSet`/`sourceFiles`/`testFiles`/`generatedFiles` 内，且不得写 `.forexplore/`。
- 补丁自带 `expectedOriginalSha256`（或新建文件的 `expectedAbsent`），基线漂移即拒绝。
- 生成不代替人工审批：`preparedHash` 必须由人重新确认后才能提交。

## 已知限制

- **不能新建文件**：`writeSet` 的每一项都必须出现在静态分析快照里（`module-write-set-unknown`），因此当前波次只支持修改既有文件。
- **同波次模块互相看不到对方的新代码**：各模块基于同一 `baseCommit` 生成；跨模块接口变化必须放进同一个 SCC/共享契约组，由调度器串行处理。
- **生成默认串行**：`prepareGeneratedModuleWave` 把并发固定为 1，避免多模块同时打模型。
- 每个模块的运行时是新实例，run 记录写在各自 worktree 的 `.forexplore/workspace-translations/` 下并在返回前删除；不进入用户工作区。

## 复现

```powershell
# 单元测试：真实 dotnet 编译 + 真实行为验收 + worktree 还原；越界与超预算必须失败
npx vitest run src/module-patch-preparer.test.ts --root services/adaptation-service

# 端到端（真实模型 + 真实 dotnet + 真实 Git，直到原子提交）
npm run test:module-pipeline:live
```

端到端脚本会创建临时 C# 仓库、审批模块计划、经宿主入口生成并联合验证、绑定 `preparedHash`、原子提交，并断言：提交只包含 `writeSet` 内文件加托管制品、用户工作区仍为原始内容且 `git status` 干净。报告写在 `tmp/module-pipeline-mvp/live-report-host.json`。
