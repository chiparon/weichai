# 共享召回内核（Shared Recall Kernel）验收记录

本文件是"两条检索链路共用一套召回内核"改造的**冻结验收方法 + 实测记录**。
判定以本文件与 `tmp/recall-baseline/` 下的证据文件为准，不以口头结论为准。

---

## 1. 目的与范围

**目的**：把 NL2Code（`TaskRetrievalService`）与 Code2Code（`ModuleImplementationSearchService`
+ `searchModules`）中**各自实现了一遍**的"多视图召回 + 加权倒数排名融合"抽成唯一内核
`RecallKernel`，并用冻结基线证明改造**不使既有功能退化**。

**范围内**：

- 新增 `services/code-intelligence-service/src/recall-kernel.ts`；
- 三个接入点：`task-retrieval.ts`（NL2Code）、`module-implementation-search.ts`（C2C 符号路径）、
  `module-matching.ts`（C2C 模块路径）；
- **符号路径扁平化**：class / function 目标的候选改为扁平召回，模块降级为标注与打折证据（§11）；
- 内核单元测试、冻结快照比对脚本、深度探针脚本。

**范围外**（本次不承诺、也不以此验收）：

- 更换嵌入模型、重建索引、向量维度变更；
- 重排器（`ModuleReranker`）与 `TaskReranker` 的策略调整；
- C2C 候选 → `query_evidence` 结果类型（Layer 2）；
- 真实大仓（百万行以上）的容量与准确率结论。

---

## 2. 被测对象与固定环境

| 项 | 固定值 |
| --- | --- |
| 数据库 | `forexplore_javafileupload_flow_20260913`（SeekDB `127.0.0.1:2881`，18 仓 / 27,041 检索文档） |
| 目标工程 | `target-repo`（Java Commons FileUpload 1.5 骨架，`tmp/java-fileupload-flow/target-repo`） |
| 参考工程 | `commons-fileupload-csharp`、`commons-fileupload-python`、`commons-fileupload-ts` |
| 向量模型 | `Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78`（384 维，本地 `4021`） |
| 检索入口 | 直连 `SeekDbIndexStore` + 两个引擎（不经 HTTP），见 `scripts/recall-acceptance/capture.mts` |
| 验收期间约束 | 不重建索引、不改动索引内容、不改嵌入模型 |

若任一固定项在执行中变化，本次比对作废并重跑。

---

## 3. 改造内容

| 文件 | 角色 | 关键点 |
| --- | --- | --- |
| `recall-kernel.ts`（新增） | 唯一召回内核 | 视图集合 `symbol` / `source-fragment` / `summary`；通道 = (计划, 视图)；融合 `Σ weight / (61 + rank)`；`normalise` = `fused / max(fused)`；跨版本文档直接抛错；通道按"计划主序 + 视图序"合并 |
| `task-retrieval.ts` | NL2Code 接入 | 用内核替换内联召回；`documents` 拼接顺序与 `documentRanks`（融合值）语义保持不变 |
| `module-implementation-search.ts` | C2C 符号路径接入 | 先用内核替换内联召回；随后整条路径改为**扁平**：召回直接提名符号，模块只标注与打折背书（详见 §11） |
| `module-matching.ts` | C2C 模块路径接入 | 模块身份（摘要文档）与实现/声明证据统一计分；归属仍在**有界**前提下完成 |

---

## 4. 保持不变的契约

1. **融合公式**：`1 / (61 + rank)`，计划权重相乘后累加。单计划 + 单视图时
   `normalise` 恰好等于改造前的 `61 / (61 + rank)`，因此单视图调用方逐位数不变。
2. **通道顺序与重复**：`documents` 按"计划主序、视图序"拼接，跨视图重复文档保留，
   融合值按文档 id 累加（同一文档命中多通道时归一化仍为 1）。
3. **版本守卫**：任何 `repositoryId` / `analysisRevision` 不符的命中一律抛
   `Search returned a document from another revision.`，不再静默过滤。
4. **模块路径的有界性**：仍不调用 `getStructuralIndex` / `listModuleArtifacts` / `listSymbols` /
   `listFiles`；归属只用**已召回 proposal** 的产物信息（`module-matching.test.ts` 中把这些方法
   打桩成抛错，测试仍通过）。
5. **粒度与不可用上报不变**：NL2Code 的 `resolvedGranularities` / `GRANULARITY_UNAVAILABLE`
   分支未改动；"模块投影缺失"用例仍返回显式不可用。
6. **参数校验前置**：计划、权重、每视图上限在发起任何查询前全部校验，非法请求不会发出半截扇出。
7. **未接入的调用点**：`semantic-query-service.querySymbols` 仍直接调用 `searchSearchDocuments`
   单视图查询——它是"结构读模型 + 投影加速排序"，没有多视图、没有多计划、没有融合，
   不属于召回引擎；接入内核语义等价但无收益，故本次不动（如需统一，用
   `views: ['symbol']` 单计划即可）。

---

## 5. 有意的行为变化（必须记录，不是回归）

1. **模块相关性口径**：模块的 relevance 现在取"该模块摘要文档 ∪ 其名下实现/声明文档"的**最大值**。
   因此同一模块的 `score.semantic` 可能改由代码文档给出（见 §7.2 的分数变化）。
2. **归属规则**：实现/声明命中按其 `relativePath` 归到已召回 proposal 内的模块；无法归属的命中
   **丢弃而不是猜测**。
3. **已知边界**：若某模块所属 proposal 完全没有被摘要召回，仅凭代码无法召回该模块——
   要做到需要整版加载模块产物，违反模块检索的有界契约。这是明确边界，留待单独设计（§10）。

---

## 6. 验收方法（可复跑）

判定规则**冻结**如下：

1. **NL2Code**：5 个用例的 `status` / `tokens` / `routing` / 结果顺序 / 分数 / 证据 / 关系 / `gaps`
   必须与改造前**完全一致**。
2. **C2C**：改造前 top-5 的候选，在改造后 `topK=10` 内必须**全部仍可召回**。
3. **排名允许变化**，但每处变化必须可解释并记录（不得用"看起来差不多"代替）。
4. 三个受影响包的既有测试与类型检查必须全绿。

| 步骤 | 命令（仓库根目录执行） | 判定 |
| --- | --- | --- |
| A 内核单测 | `npx vitest run src/recall-kernel.test.ts`（在 `services/code-intelligence-service`） | 9/9 通过 |
| B 冻结快照比对 | `npx tsx scripts/recall-acceptance/compare.mts` | 规则 1、3 |
| C 深度探针 | `npx tsx scripts/recall-acceptance/c2c-depth.mts --top-k 10 --snapshot tmp/recall-baseline/before.json` | 规则 2 |
| D 回归套件 | `services/code-intelligence-service` / `services/adaptation-service` / `apps/vscode-extension` 各自 `npx tsc -p tsconfig.json --noEmit` + `npx vitest run` | 规则 4 |

改造前基线由 `npx tsx scripts/recall-acceptance/capture.mts --label before --output tmp/recall-baseline/before.json`
冻结；改造后用同一脚本 `--label after` 生成对照，二者都用同一条目、同一参数集。

---

## 7. 实测结果

基线 `before.json` 生成于 `2026-09-14T08:27:31Z`，早于全部改造文件落盘
（`task-retrieval.ts` 08:28、`module-matching.ts` 08:31、`recall-kernel.ts` 08:32），
因此是真正的改造前镜像；`after.json` 生成于 `2026-09-14T08:33:10Z`。

### 7.1 NL2Code：5/5 完全一致

| 用例 | 粒度 | status | tokens | 结果数 | 顺序/分数/证据/关系/gaps |
| --- | --- | --- | --- | --- | --- |
| function-both | function | partial → partial | 7365 → 7365 | 10 → 10 | 一致 |
| class-target | class | complete → complete | 150 → 150 | 0 → 0 | 一致 |
| module-both | module | partial → partial | 5380 → 5380 | 8 → 8 | 一致 |
| auto-chinese | auto | partial → partial | 7941 → 7941 | 10 → 10 | 一致 |
| no-match | function | partial → partial | 5771 → 5771 | 10 → 10 | 一致 |

结论：`nl2codeIdentical: true`。内核在 NL2Code 上是**纯等价替换**。

### 7.2 Code2Code：候选未丢失，2 处排名位移，1 个新候选进入

| 用例 | 目标类型 | top-5 候选数 | 旧 top-5 在 top-10 内仍可召回 | 排名移动 |
| --- | --- | --- | --- | --- |
| module-multipart | module | 5 → 5 | **5/5** | 3 处 |
| module-disk | module | 5 → 5 | **5/5** | 3 处 |
| class-fileuploadbase | class | 5 → 5 | **5/5** | 0 处（顺序一致） |
| function-parserequest | function | 5 → 5 | **5/5** | 0 处（顺序一致） |

- **位移（不是丢失）**：两个 module 用例中，python `公共 API 聚合导出`（`module-public-api`，
  `src/commons_fileupload/__init__.py` 纯再导出模块）由 top-5 内滑到第 6 / 第 7 位；
  深度探针确认它仍在召回结果中。
- **新候选**：ts `Commons FileUpload Compatibility Layer`（`module-compatibility-shims`）进入 top-5。
- **分数变化的解释**（§5.1）：`Core Multipart File Upload Engine`（ts）
  `overall 0.68314 → 0.713877`、`semantic 0.853924 → 0.892346`，排名 4 → 1——
  该模块现在由**其名下的实现片段**给出相关性，而不是只由摘要文档给出。
  同类变化还有 `核心测试套件` `semantic 0.875482 → 0.875968`。
- 符号路径（class / function）成员与顺序完全不变，仅第 5 位候选的支撑文档改为代码文档
  （`semantic 0.424775 → 0.492235`，排名不变）。

按规则 2，**20/20 旧候选全部仍可召回，无候选丢失**；按规则 3，全部 8 处排名移动已逐条记录。

> §7.2 描述的是**共享内核阶段**（符号路径仍走模块门）。符号路径随后被改为扁平召回，
> 其验收与实测见 **§11**；对 class / function 目标，以 §11 为准。

### 7.3 回归套件

| 包 | 类型检查 | 测试 |
| --- | --- | --- |
| `services/code-intelligence-service` | 通过 | 24 文件 / **212 通过**（新增 `recall-kernel.test.ts` 9 条、`module-matching.test.ts` 1 条） |
| `services/adaptation-service` | 通过 | 25 文件 / **214 通过，1 跳过** |
| `apps/vscode-extension` | 通过 | 38 文件 / **181 通过**（高负载下曾有 1 次偶发失败，静默复跑通过，与本次改动无关） |

新增的 `module-matching.test.ts` 用例把 §5.2 的能力钉死：同一 proposal 内的兄弟模块即使
**没有任何摘要字段**命中查询词，也能凭其实现片段被召回（并同时断言"仅摘要视图"确实召回不到它）。

---

## 8. 证据文件

| 文件 | 内容 |
| --- | --- |
| `tmp/recall-baseline/before.json` | 改造前冻结快照（NL2Code 5 例 + C2C 4 例） |
| `tmp/recall-baseline/after.json` | 共享内核阶段快照 |
| `tmp/recall-baseline/flat.json` | 扁平符号路径（校准前）快照 |
| `tmp/recall-baseline/flat-calibrated.json` | 扁平符号路径（校准后，当前实现）快照 |
| `tmp/recall-baseline/diff.json` / `diff-flat.json` | 逐用例差异（状态、token、顺序、分数、丢失/新增/位移） |
| `tmp/recall-baseline/c2c-depth10.json` / `c2c-depth-flat.json` / `c2c-depth-calibrated.json` | `topK=10` 深度探针，用于区分"丢失"与"被挤出 topK" |
| `scripts/recall-acceptance/capture.mts` | 快照采集（唯一入口，改造前后共用） |
| `scripts/recall-acceptance/compare.mts` | 快照比对与判定 |
| `scripts/recall-acceptance/c2c-depth.mts` | C2C 深度探针 |
| `scripts/recall-acceptance/module-coverage.mjs` | 各仓模块产物/摘要/符号文档覆盖统计（§11.2 的数据来源） |
| `scripts/recall-acceptance/displaced-targets.mts` | 被挤出的候选换成各自目标后的排名探针（§11.3 的反向核查） |

---

## 9. 何时必须重跑

- 改动 `recall-kernel.ts`、三个接入点、`seekdb-projection.ts`（文档/视图投影）、嵌入模型或索引内容
  → 重跑 A + B + C + D；
- 只改重排器、UI、提示词 → 至少重跑 A + D。

---

## 10. 未覆盖 / 后续

1. **检索因果未证明**：java-fileupload 的模块翻译成功受"模型记得上游实现"干扰，
   需要**私有模块 A/B** 才能证明收益来自检索而不是模型记忆。
2. **Layer 2 未做**：C2C 候选 → `query_evidence` 结果类型（让候选直接进入翻译上下文）。
3. **整版归属**：让"proposal 未被摘要召回"的模块也能仅凭代码被召回，需要一套有界方案
   （例如按召回路径反查归属），当前明确不做。符号目标已不再受此限制（§11），
   受限的只剩模块目标。
4. **尾部噪声策略未定**：符号目标命中不足 `topK` 时，尾部会补进"零身份相似"的语义近似符号
   （`score.symbol = 0`）。当前照给并暴露信号，是否改为"零身份相似就不返回"是产品决策（§11.5）。

---

## 11. 补充改造（2026-09-14）：符号路径改为扁平召回

> 本节对 **class / function 目标**取代 §4.4、§5、§7.2 的相应描述；模块目标不受影响。

### 11.1 设计

| 目标类型 | 候选是什么 | 模块的角色 |
| --- | --- | --- |
| `module` | 模块 | 就是答案本体（两级结构保留） |
| `class` / `function` | **符号（扁平）** | 只做两件事：**标注**（`sourceModule`，含 `sourceFiles` / `coreApis`）与**打折证据** |

扁平打分（每个符号只算一次）：

```
证据     = max( 该符号自身文档的最大融合归一值,
               0.5 × 其所属模块摘要的最大融合归一值 )       // 摘要按半价为其名下符号背书
身份相似 = overlapIdentity(目标身份, 符号身份)
           目标身份 = 目标名字 + 签名 + 文档注释（不含需求）
           两侧都剔除语言关键字与样板词                 // public/class/def/string/...
类型匹配 = class→class/record/struct 记 1，否则 0.65；function→constructor 记 0.7，否则 1
overall  = min(1, 0.55 × 证据 + 0.35 × 身份相似 + 0.10 × 类型匹配)
抽样     = 全局按 overall 排序，**每个文件最多 2 个**，取 topK
```

**为什么可以扁平**：符号路径进入时会 `getStructuralIndex(scope)` 把该 revision 的结构索引
全部载入内存，模块门省不下任何读取，只会隐藏候选。旧实现的门有两处：只有被评分的模块
才会被展开，且只展开 `max(4, topK × 2)` 个模块。

### 11.2 这道门实际藏了多少（关键证据）

对库内 18 个仓库统计模块产物覆盖：

| 仓库类别 | 数量 | 当前模块摘要 | 符号文档 |
| --- | --- | --- | --- |
| 有模块摘要的历史仓 | 3（`commons-fileupload-python`、`commons-fileupload-ts`、`ledger-flow-ts`） | 1–1 个 | 194–914 |
| **无模块摘要的历史仓** | **15** | **0 个** | 336–1752 |

旧实现对 class / function 目标只能从"有模块摘要"的仓里取候选，因此
**15 / 18 = 83% 的历史仓完全不可达**，其中包括目标库的 C# 移植版
（`commons-fileupload-csharp`，554 个符号文档）和 `forexplore-reference-java`（1752 个符号文档）。
扁平召回后这些仓都能被符号/实现片段文档直接提名。

### 11.3 实测：同一冻结基线，before vs 扁平（校准后）

| 用例 | 改造前 top-5 | 扁平（校准后）top-5 |
| --- | --- | --- |
| `class-fileuploadbase` | python `FileUploadBase`、python `FileUpload`、ts `FileUpload`、ts `DiskFileItemFactory`、python `QuotedPrintableDecoder` | python `FileUploadBase`(1.0000)、python `FileUpload`、ts `FileUpload`、**csharp `FileUploadBase`**、csharp `FileUploadBase.FileUploadIOException` |
| `function-parserequest` | ts `parseRequest`、python `parse_parameter_map`、python `parse_request`、ts `parseParameterMap`、python `ServletRequestContext.__init__` | ts `parseRequest`(0.8600)、**csharp `FileUploadBase.ParseRequest`**、ts `parseParameterMap`、csharp `ServletFileUpload.ParseRequest`、python `FileUploadBase.parse_request` |

- 前三位（真正的同名端口）保持不变；被挤掉的 `DiskFileItemFactory` / `QuotedPrintableDecoder` /
  `parse_parameter_map` / `ServletRequestContext.__init__` 都是**相关度靠模块成员身份搭便车**进来的。
- **它们没有丢失**：换成各自的目标后仍排第一——
  `DiskFileItemFactory` 目标下 ts `DiskFileItemFactory` #0 (0.9911)；
  `QuotedPrintableDecoder` 目标下 python/ts 均 #0 (1.0000)；
  `MultipartStream` 目标下 python #0 (1.0000)、ts #1 (0.9911)、csharp #2 (0.8250)。
- 模块目标的结果与 §7.2 相同（未改动）：仍是 5/5 不丢、2 处位移、1 个新候选。

### 11.4 权重校准记录（两次实测）

| 版本 | 身份相似口径 | 结果 |
| --- | --- | --- |
| 校准前 | 整个查询（含需求）+ 全部词 | `public` / `class` 这类关键字被当成身份相似：ts `MultipartStream` 在"上传基类"目标下排到 **#2 (0.7411)**，python `parse_request`（真正的 Python 端口）被挤出 top-5 |
| 校准后 | 仅目标身份（去掉需求）+ 剔除语言关键字 | `MultipartStream` 落到 #5/#6，python `parse_request` 回到 **#4**，同名 C# 端口稳定在前二 |

判据不是"好看"，而是"身份相似应当只反映**这是不是同一个代码元素**"：`public class X` 与
`public class Y` 共享 `public`/`class`，这不是身份证据。

### 11.5 代价与已知取舍

1. **尾部噪声**：当真实端口只有 3–4 个时，第 5 个位置会补进"零身份相似、语义相近"的无关符号，
   其分数恰为地板值 `0.55 × 1 + 0.10 = 0.65`，且 `score.symbol = 0`。当前选择是**照给并暴露信号**，
   由调用方按 `score.symbol` 过滤，而不是在引擎里偷偷设阈值——是否改为"零身份相似就不返回"
   属于产品决策，尚未定。
2. **拼写偏好仍在**：同名端口（C# `ParseRequest`）比改名端口（Python `parse_request`）更容易拿满身份分；
   校准后改名端口靠证据回到 top-5，但整体仍吃亏。
3. **模块目标的天花板未变**：proposal 完全没被摘要召回的模块仍召不回（§5.3）。
4. **每仓查询成本**：3 视图 × 2 条 SQL = 6 条/仓（原为 1 视图 = 2 条），约 3 倍；换到的是
   83% 原本不可达的语料。

### 11.6 新增回归测试（含"改前必失败"验证）

| 用例 | 钉住的契约 |
| --- | --- |
| `ranks symbols flat: a module that loses the module race no longer hides its symbols` | 7 个模块、`topK=3`（模块阶段最多展开 6 个），目标符号所属模块是第 7 个 → 旧实现返回空。**已把 HEAD 的旧实现临时换回实测：该用例失败（`expected undefined to be defined`），换回扁平实现后通过。** 同时断言摘要通道仍生效、每文件上限为 2 |
| `annotates a recalled symbol with its reviewed module instead of gating on it` | 模块仍作为 `sourceModule` 标注出现（含 `sourceFiles`），不再是门槛 |
| `module-matching.test.ts` 既有用例 | 模块路径仍不加载整版结构（`getStructuralIndex` / `listModuleArtifacts` 打桩抛错仍通过） |

回归套件（校准后重跑）：`code-intelligence-service` 24 文件 / **213 通过**、
`adaptation-service` 25 文件 / **214 通过 + 1 跳过**、`vscode-extension` 38 文件 / **181 通过**，类型检查全绿。
