# Context 构建 S1 改造验收标准（冻结）

先冻结、后实现。判定以本文件为准。例外按 §8 登记。

## 1. 背景与目标

实测问题（2026-09-12 真实请求）：

| 现象 | 实测值 |
| --- | --- |
| 4000 token 预算下交付的真代码 | **94 行 / 975 tokens** |
| 代码占预算比例 | **25%（4000）/ 33%（8000）** |
| 上下文编译阶段占端到端时延 | **79–89%**（最大 4,976 ms） |
| 超预算行为 | 整条静默跳过，且**先从尾部删主结果** |
| 真实任务闭包体量 | 12,436–16,925 tokens（单语言/单仓/不含调用方与测试） |

S1 目标：**在不动召回、不改依赖图的前提下**，让同样的预算装下更多真代码、把编译耗时降一个数量级、并把"降级"变成显式可审计的行为。

## 2. 范围

**范围内**：`compileTaskContext` 的选择与计量算法；Markdown 渲染的元数据上限；证据渲染档位；降级/省略的缺口记录；`usage` 诊断字段。
**范围外**：召回算法、依赖图、嵌入模型、闭包/切片建模（S2/S3）、跨语言语义边。

## 3. 固定环境与口径

| 项 | 固定值 |
| --- | --- |
| 服务 | 工作台 `http://127.0.0.1:4040`，数据库 `forexplore_recast_live_20260912` |
| 检索参数 | `granularity=function`，`budget={maxTokens:8000, maxLatencyMs:10000}`（召回评测）；预算对比另用 4000 |
| 度量需求 | ①「修改文件上传总大小限制和单个文件大小限制」②「检查上传文件名中的空字符，发现非法文件名时抛出异常。」 |
| 对照 | legacy 模式（`RECAST_CONTEXT_COMPILER=legacy`）= 改造前的 `compileTaskContext` |

## 4. 指标与阈值

| 等级 | 条款 | 阈值 |
| --- | --- | --- |
| **MUST** | 代码 token 占比（两个需求 × 4000/8000 四组的最低值） | ≥ **70%**（现状 25–51%） |
| **MUST** | 同预算（4000）交付源码行数 | 比 legacy 提升 ≥ **1.5×** |
| **MUST** | 编译阶段耗时（`usage.retrieval.stages.compilationMs`，四组中位数） | 比 legacy 下降 ≥ **5×** |
| **MUST** | 预算不被突破 | 最终 `usage.tokens` ≤ `maxTokens`（四组全部） |
| **MUST** | 大条目不得整条消失 | 当某证据因超出预算未能全量交付时，必须以更低档位（skeleton/signature）交付，或在 gaps 中显式记录省略原因 |
| **MUST** | 主结果不被删除 | 任何预算下 `results.length` 不得因预算被裁剪；若元数据本身超出预算，记 gap 而不删结果 |
| **MUST** | 降级可审计 | 发生降级时 gaps 含 `CONTEXT_EVIDENCE_DOWNGRADED`（含名称与档位） |
| **MUST** | 召回不回退 | 开发集 12/12、冻结泛化集 ≥5/6（`scripts/verify-query-expansion.mts` 口径） |
| **MUST** | 全量测试 | `npm test` 0 失败 |
| **MUST** | 端到端契约 | `scripts/verify-task-context-live.mts` exit=0 |
| **MUST** | legacy 逐字节复现 | legacy 模式对固定输入的 markdown 与冻结快照**完全一致** |
| **MUST** | 确定性 | 同一输入重复编译，`markdown` 逐字节一致 |
| **TARGET** | 交付源码行数（8000 预算） | ≥ 500 行 |

## 5. 算法要求（实现约束）

1. **增量计量**：选择过程中不得对完整 Markdown 反复分词；每条证据的 token 成本只计算一次并缓存，最终做一次精确校验与有界回修（回修次数与候选数无关）。
2. **分档渲染**：每条证据按 `full → skeleton → signature` 依次尝试，选中能放下的最高档；skeleton 必须使用显式省略标记（`… 省略 N 行 …`）且不得伪装成可编译代码。
3. **元数据上限**：Markdown 中 relations ≤16 条、gaps ≤8 条（各附"N 条未列出"），单条 gap 消息 ≤140 字符，result.reason ≤200 字符；结构化字段不裁剪（MCP/UI 仍可读全量）。
4. **牺牲顺序**：预算不足时依次牺牲：元数据 → 低优先角色 → 同角色内靠后的证据；**核心实现（role=implementation）最后降级**。
5. **保持既有不变量**：`formatContextMarkdown(packet) === packet.markdown`、版本/哈希/范围校验、`knownEvidence` 去重、包含关系去重、files/lines 上限语义不变。

## 6. 证据与产物

| 产物 | 路径 |
| --- | --- |
| 本验收标准 | `docs/context-compiler-acceptance.zh-CN.md` |
| 实现 | `services/code-intelligence-service/src/context-compiler.ts` |
| 渲染上限 | `packages/contracts/src/task-retrieval.ts` |
| 单元测试 | `services/code-intelligence-service/src/context-compiler.test.ts` |
| 实测脚本 | `scripts/verify-context-compiler.mts` |
| 实测报告 | `logs/experiments/context-compiler-<ts>/report.json` |

## 7. 判定流程

```powershell
npm test
node --import tsx scripts/verify-context-compiler.mts --out logs/experiments   # 指标对比
node --import tsx scripts/verify-query-expansion.mts --off http://127.0.0.1:4040 --on http://127.0.0.1:4050
node --import tsx scripts/verify-task-context-live.mts --endpoint http://127.0.0.1:4040 ...
```

全部 MUST 满足 → 通过；同时满足 TARGET → 达标。

## 8. 例外记录

（暂无）

---

### 第二轮（2026-09-13，增加 region 档位与 declarations 预算上限）

**仍未通过**，但覆盖类指标大幅改善：

| 需求/预算 | legacy | 第一轮（skeleton/signature） | 第二轮（region + 声明上限） |
| --- | --- | --- | --- |
| 大小限制 4000 | 97 行 / 25% | 135 行 / 32% | **257 行 / 42%** |
| 大小限制 8000 | 352 行 / 33% | 150 行 / 17% | **709 行 / 66%** |
| 文件名 4000 | 316 行 / 52% | 311 行 / 54% | 313 行 / 51% |
| 文件名 8000 | 664 行 / 56% | 485 行 / 42% | 485 行 / 42% |
| 编译耗时（中位数） | 2960 ms | 423 ms | **288 ms（10.3×）** |

| 条款 | 结果 |
| --- | --- |
| MUST 编译耗时 ≥5× | ✅ 10.3× |
| MUST 预算 / 主结果 / 降级审计 | ✅ |
| MUST 召回不回退 | ✅ dev 12/12、泛化集 5/6 |
| MUST 同预算行数 ×1.5（4000） | ❌ 413 → 570 行（**1.38×**，已很接近） |
| MUST 代码占比 ≥70% | ❌ 最低 42%（最好 66%） |
| MUST 契约校验 | ❌ 仅剩 1 例：`default-budget-auto` 要求"per-file 校验 + 其异常"同现于一条实现证据 |

**本轮新增的两个机制**：
1. **region 档位**：整类证据（如 `FileUploadBase` 51,281 字符）不再压成签名，而是按查询词命中行向外扩展，取一段**逐字源码窗口**并重算 `sourceRange`/`contentHash`，标记 `truncated`（属于派生摘录，校验器按哈希自洽 + 首行可溯源校验）。
2. **declarations 预算上限 20% + 成员签名上限 12 条**：类签名大纲不再吃掉三分之一预算。

**剩余缺口的根因（已定位，属 S2）**：契约用例要求"校验条件"与"它抛出的异常"同时出现，而**单个连续窗口跨不到两个方法**。需要"**多区域渲染**"：一条证据允许拼接 2–3 个窗口，中间用显式省略标记，各自带范围。这也是代码占比的最后一截空间（declarations 与 framing 之外，单窗口粒度限制了一次能装多少正文）。

### 第一轮（2026-09-13，skeleton/signature 版本）

**判定：未通过**（时延类指标大幅达标，覆盖类指标未达标，并有 1 个契约用例回归）。

实测（`scripts/verify-context-compiler.mts`，adaptive 实例 4040 / legacy 实例 4050，同一索引与 revision）：

| 需求 | 预算 | legacy 行数/占比/编译 | adaptive 行数/占比/编译 |
| --- | --- | --- | --- |
| 修改上传大小限制 | 4000 | 97 行 / 25% / 2525 ms | 135 行 / 32% / **283 ms** |
| 修改上传大小限制 | 8000 | 352 行 / 33% / 4928 ms | 150 行 / 17% / **488 ms** |
| 上传文件名空字符 | 4000 | 316 行 / 52% / 1733 ms | 311 行 / 54% / **190 ms** |
| 上传文件名空字符 | 8000 | 664 行 / 56% / 3937 ms | 485 行 / 42% / **423 ms** |

| 条款 | 结果 |
| --- | --- |
| MUST 编译耗时下降 ≥5× | ✅ 中位数 3937 ms → 423 ms（**9.3×**） |
| MUST 预算不被突破 | ✅ 四组全部 ≤ 预算 |
| MUST 主结果不被删除 | ✅ `results.length` 恒为 10 |
| MUST 降级可审计 | ✅ 出现 `CONTEXT_EVIDENCE_DOWNGRADED`（本轮 7 条降级、含档位） |
| MUST 召回不回退 | ✅ 开发集 12/12、泛化集 5/6 |
| MUST 全量测试 | ✅ 仓库跟踪的测试全绿（另有 3 个失败来自其他会话的未跟踪文件，见备注） |
| MUST 契约校验 | ❌ `chinese-size-limits` 报 "Total upload size evidence is missing" |
| MUST 代码占比 ≥70% | ❌ 最低 17%（目标 70%） |
| MUST 同预算行数 ×1.5（4000） | ❌ 413 → 446 行（+8%） |
| MUST legacy 逐字节复现 | ✅ legacy 路径输出与改造前一致（4 组数据完全对齐） |
| MUST 确定性 | ✅ 单元测试覆盖 |

**过程中修掉的一个真实缺陷**：降级证据最初沿用了原 `contentHash`，导致仓库校验器报 "excerpt hash mismatch"（5/9 用例失败）。现已改为：降级内容重算 `contentHash` 并置 `truncated=true`，校验器对 `renderLevel ≠ full` 的条目按"派生摘录"校验（哈希自洽 + 首行可溯源）。

### 未达标的根因（已定位，属 S2 范畴）

追踪单次请求的编译器内部计量（`FileUploadBase` 单条证据 **51,281 字符**）：

1. **证据粒度是"整个类"**：一个类作为一条证据，51 KB 既放不进 full，连 skeleton（20,172 字符）也放不进，只能退到 signature（51 字符）——于是"文件大小校验"的正文从交付里消失，契约用例因此失败。
2. **类签名大纲（declarations）占用大**：14 个类大纲约 9.7 KB（MultipartStream 2,217 字符、DiskFileItem 1,869 字符），在 8,000 预算里占约三分之一，而它们只是签名。
3. 两条都指向同一件事：**在"整类证据 + 签名大纲"的粒度上，无论怎么分配预算都不可能同时拿到高代码占比与任务所需正文**。

### 下一轮（S2）方向

1. 证据粒度下沉到**声明/区域级**：类只交付与需求相关的方法与字段，而不是整个类或整类签名；
2. **必含槽位**：需求涉及"大小限制"时，含 `sizeMax`/`fileSizeMax` 的分支方法必须入选且**不可降级**（本轮缺这一条，直接导致契约回归）；
3. declarations 设**预算上限**（如 ≤20%），超出部分只保留与命中的需求项相关的成员签名。

### 备注

`npm test` 中出现的 3 个失败（`services/adaptation-service/src/module-patch-preparer.test.ts`）来自**其他会话未提交的未跟踪文件**（同目录 `.ts/.test.ts` 均为 `??` 状态，且其测试使用 `.mjs`，而 `analyzeRepository` 仅支持 `.java/.cs`）；排除后 adaptation-service 为 202 passed / 1 skipped，与本轮改动前完全一致。
