# 模块解析的模型凭据门（Model Key Gate）

**规则**：未在设置中配置 API Key 时，**模块解析被直接拒绝执行**——不发请求、不写任务记录、不留"看起来成功"的库。

## 1. 为什么只拦模块解析，不拦建库

| 环节 | 需要模型/key | 处理 |
| --- | --- | --- |
| 建索引（结构扫描 + 检索投影） | 不需要（只用本地嵌入服务） | **照常执行**，不受门影响 |
| 模块解析（`ProjectAnalysisCoordinator.ensure`） | 需要（agent 策略调模型） | **拒绝**，并告知原因 |

理由：索引、符号检索、源码检索本来就不需要模型（库里 15 个仓在零模块摘要的状态下仍有完整符号文档）。
把不需要模型的步骤一起拦掉，是拿可用性换整齐。

## 2. 落点

| 位置 | 作用 |
| --- | --- |
| `apps/vscode-extension/src/model-credential.ts` → `modelKeyRefusalReason(storage, endpoint, settings)` | 判定：当前服务商在本机凭据存储里是否有 Key。返回拒绝原因或 `undefined` |
| `apps/vscode-extension/src/code-intelligence-host.ts` → `ensureProjectAnalysis()` | 两个入口（同步后的自动调度、面板显式重试）都先过门；被拒时**不调用** `ensure()` |
| 同上 → `retryProject()` | 显式用户操作**抛错**（面板显示原因），而不是只写日志 |
| 同上 → `onModelRefusal` | 自动调度被拒时通知用户一次（去重，key 变化后重置） |
| `apps/vscode-extension/src/extension.ts` | 用 `context.secrets` + 当前 `forexplore.llm` 组成判定函数；面板消息处理器统一把抛错转成面板错误 |

判定为"未配置"的三种情况：没有存 Key、Key 只有空白、当前服务商与 Key 所属服务商不一致（Key 按
`endpoint + provider + apiBase` 隔离）。另有两种失败关闭：后端地址不是本机地址、凭据存储读失败——
两者都拒绝建模并给出对应提示。

## 3. 副作用（有意）

- 面板消息处理器此前是 `void handlePanelMessage(...)`，抛错会变成 unhandled promise、用户看不到任何反馈；
  现在统一 `publishError(errorMessage(error, '面板操作失败'))`，拒绝原因能真正显示出来。
- 已索引但仍未建模的仓，其状态仍是"仅索引"（`ProjectAnalysisRecord.state: 'missing'` +
  「基础索引已完成，功能模块需要 Agent 分析。」），门只负责不让它悄悄进入建模。

## 4. 明确不做的事

- **不拦建库**（见 §1）；**不替代检索侧解耦**：模块摘要会随 revision 变化而 stale，
  所以"配一次就永远有摘要"不可能成立，符号检索必须继续不依赖它
  （见 `docs/recall-kernel-acceptance.zh-CN.md` §11）。
- **无头脚本路径未覆盖**：`scripts/serve-code-workbench.mts` 不走插件设置，其 Key 来自服务侧/环境变量，
  且已有自己的前置（`--adaptation-url` 缺失即无 plan port），建库循环在项目未就绪时直接抛错。

## 5. 测试

| 用例 | 断言 |
| --- | --- |
| `apps/vscode-extension/src/module-analysis-gate.test.ts` | 无 Key 时选中项目不触发 `ensure`、重试抛错、索引与项目列表不受影响；配置好 Key 后 `ensure(scope, false)` 正常被调用一次 |
| `apps/vscode-extension/src/model-credential.test.ts` | 判定函数的四种结果：缺 Key、空白 Key、跨服务商 Key、非本机地址、凭据存储读失败 |
