# 企业数据集链路检查（2026-09-20）

检查基于本任务工作区的 `05f2806` 及本地新增的数据集/启动/评测脚本，没有声称覆盖其他分支。检查期间仅 8790 查询端口在运行，默认 8788 adaptation、4021 embedding、4022 rerank、2881 SeekDB 端口均未监听。VS Code 设置文件未覆盖默认 adaptation 地址。没有读取或导出面板的密钥。

## 1. 全范围查询超过接口上限（P1，已复现）

`apps/vscode-extension/src/code-intelligence-host.ts:611` 先加入目标 scope，再在 `scope=all` 时加入全部历史仓库。
本集配置为一个目标、八个历史，得到九个 scope。
`services/code-intelligence-service/src/task-retrieval.ts:93` 只允许 1..8 个，宿主 HTTP 边界也有相同限制。
以当前九个 ready revision 调用 8790 的 `/v1/task-search`，实际返回 HTTP 400，消息为 `Semantic index query failed.`。

此前基线仅使用八个历史仓库，未经过目标 + 历史的 UI 范围组装路径，因此没有验证这条交互。
需要统一范围协议、路由策略与 UI 预检，不能通过静默丢弃一个历史仓库修复。

## 2. Agent 无法沿跨仓库依赖继续取证（P1，代码路径确认）

`apps/vscode-extension/src/module-translation-handoff.ts:24` 将单个选中候选传给 scope builder。
`module-translation-scope.ts:155` 只从这些候选构造 `evidenceScopes`，不扩展跨仓库依赖。
`services/adaptation-service/src/workspace-translation-runtime.ts:198` 的 `query_evidence` 始终使用该固定 scope 列表。

例如选中 case-services 的质保模块后，Agent 可以按需查该仓库，却不能通过此工具获取 finance-ledger、identity-access 等仓库的实现。
用户额外预先传入的片段可能部分补足上下文，但不会扩大按需查询范围。
这不是越权保护本身有错，而是宿主缺少经授权、可追溯的依赖范围组装。尚未运行模型迁移，不能声称它已导致某次生成失败。

## 3. 设置中的 Key 与检索重排分属不同配置路径（P1，已确认）

`apps/vscode-extension/src/model-credential.ts` 的 provider 仅为白名单内的分析/翻译路由注入凭据；检索服务不走该路由。
`services/code-intelligence-service/src/task-reranker.ts` 默认使用 local provider，LLM 模式另读环境配置。
当前重跑的 24 道题中有 16 道返回 `CONTEXT_RERANK_UNAVAILABLE`；具体消息标明 local 重排失败并回退融合顺序。
不能把这些请求标作模型重排成功。需要统一 provider 配置并明确展示实际执行的 provider、模型和降级原因。

## 4. 当前启动入口没有启动模型后端（P1，环境/交付缺口）

本次新增的 `scripts/start-enterprise-extension.ps1:88` 明确只打开开发宿主，没有启动 adaptation、embedding、rerank、SeekDB。
`ServiceManager.ensureStarted()` 只是健康探测，并不启动进程。
因此即使保存 Key，默认 8788 上也没有服务承接模块建模和翻译。这是本次一键启动交付范围不完整，不能归因于模型 API Key 无效。
下一步应补齐面向本数据集的服务编排和逐项就绪检查。

## 5. 企业数据集的翻译/行为验收尚未接入 UI（P1，配置与路径确认）

`WorkspaceTranslationHost.handle()` 要求独立的 `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN`，并检查服务 workspaceRoot 与所选目标一致。模型 API Key 不能替代这个宿主/服务鉴权 token。
旧 `scripts/dev-env.ps1:25` 默认目标是 `tmp/java-fileupload-flow/target-repo`，不是企业数据集的 Python target。
旧 `scripts/run-adaptation-full.ps1:46` 固定执行 `node tools/compile.mjs` 和 `node tools/verify.mjs`；企业 target 中不存在这些文件。

本次 `experiments/enterprise-history/acceptance.py` 已作为独立 CLI 验收入口验证过，但没有配置到扩展翻译服务的 compile/verification 路径。
不能把 CLI 的 18 项参考实现断言通过等同于扩展翻译链路可用。
应提供 Python 目标专用的配置、受保护的验收入口和正确的依赖环境，再做“生成—验证—写回—回滚”的完整验收。

## 6. 健康状态不足以证明检索可用（P2，代码确认）

`apps/vscode-extension/src/service-manager.ts:46` 在 refresh 中直接设置 `retrieval: connected`，没有检查对应索引、embedding 或 reranker；其 presentation 中 provider 名称也是静态值。
另有 codeIntelligence 状态和 ContextPacket gaps 提供部分信息，因此不能说界面完全没有错误提示。
但调用者不能用这个 connected 字段判断模型检索已就绪；应区分结构索引、持久化、向量服务、重排和模块建模状态。

## 评测边界

- Python 跨仓库 import 未解析到目标、函数片段与完整文件标签不对齐，仍是此前已记录的问题；完整证据 0/9 不等于业务任务全部失败。
- UI 当前任务检索预算仅设 30 秒，基线采用 60 秒、10 文件、240 行；界面手工测试与基线不完全同条件。
- 已运行凭据、模块 scope/handoff、workspace translation host 相关 4 个测试文件，19 项通过；这些单测未覆盖上述九 scope 和企业数据集的完整服务编排。
- 本轮只检查与复现，没有修改产品逻辑，也没有执行模型迁移或写回。

建议顺序：先统一服务启动与配置；修复九 scope 冲突；接通模型重排；补齐跨仓库取证范围；将 Python 行为验收接入翻译服务；最后在同一请求路径和预算下重跑端到端对比。
