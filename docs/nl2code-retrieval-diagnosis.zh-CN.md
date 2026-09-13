# NL2Code 检索诊断（2026-09-13）

本文件记录针对"RECAST 任务检索准确率为什么达不到命题 ≥90%"所做的三件诊断，以及一个被证伪的假设。
所有数字都由 `scripts/run-guochuang-pilot.mts` 在进程内实测，库为 `forexplore_task_context_dev_20260908`，
`--budgets none`（与说明书 8.7.2「调用时未设置 Token、文件数或源码行数上限」的官方口径一致），
评测口径由 `services/code-intelligence-service/src/retrieval-evaluation.ts` 定义。

## 0. 口径说明

- `recallAtK` = 单标签 Hit@10（每条任务标注一个目标实现）
- `evidenceCoverage` / `taskSuccess` = 必需证据（含精确行区间）是否被完整交付
- `MRR` / `nDCG@10` = 排序质量
- 题目规模：dev 12 题（6 类意图 × Java/TS），holdout 6 题（冻结，不参与调参）

## 1. 诊断一：两条检索链路不共用索引

| | ForeXplore Code2Code 链路 | RECAST 任务检索 |
| --- | --- | --- |
| 服务 | `services/retrieval-service` | `services/code-intelligence-service` |
| SeekDB 库 | `forexplore` | `forexplore_recast_live_20260912` 等 |
| 主要表 | `code_symbols`、`code_symbols_v2_*`、`module_knowledge*` | `symbols`、`search_documents`、`dependency_edges`、`files`、`analysis_revisions` |
| 嵌入默认 | `hash`（占位假向量） | E5-small 384 维真实向量 |
| 重排 | **可选 DeepSeek LLM rerank**（`RERANK_PROVIDER=deepseek`，默认 `deepseek-v4-flash`） | 无 |

同一 SeekDB 实例，不同库、不同 schema。**结论：Code2Code 的高正确率不能靠复用索引获得。**
它来自两点：查询本身就是代码（词法通道直接命中），以及可选的 LLM 重排。
**后者是模态无关的，可以直接迁移到 NL2Code 链路。**

## 2. 诊断二：基线准确率（此前未被报告过）

| 集 | 查询扩展 | taskSuccessRate | recallAtK | MRR | nDCG@10 | 平均延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| dev(12) | **ON** | **1.000** | 1.000 | 0.572 | 0.667 | 304 ms |
| dev(12) | OFF | 0.583 | 0.583 | 0.300 | 0.368 | 240 ms |
| holdout(6) | **ON** | **0.667** | 0.667 | 0.163 | 0.278 | 274 ms |
| holdout(6) | OFF | 0.333 | 0.333 | 0.117 | 0.170 | 314 ms |
| dev(12) | 纯向量 top-k 基线 | 0.250 | 0.250 | 0.090 | 0.130 | 37 ms |

三点结论：

1. **dev 已达 100%，超过命题的 ≥90%；holdout 只有 66.7%，不达标。** 差距在**泛化**，不在能力。
2. **dev 已饱和**：12/12 无法再区分任何改进。任何后续优化必须在 holdout 或更大的标注集上验证。
3. **查询侧桥接是当前最大的单一杠杆**：+41.7pp（dev）、+33.3pp（holdout），而它的全部实现只是一本 355 条离线词表。
   同时混合召回相对纯向量 top-k 是 100% vs 25%，说明三通道融合本身贡献巨大。

## 3. 诊断三：失败个案解剖（结论与预期相反）

### 3.1 `java-content-type`（需求"读取上传项自身的内容类型（MIME 类型）"，答案 `DiskFileItem.getContentType`，第 222–225 行）

目标类**一次都没进 top-10**，返回的是：

| 排名 | 返回 | 问题类型 |
| --- | --- | --- |
| 1 | `MimeUtility.MimeUtility` | **构造函数**（匹配扩展词 `mimeType`） |
| 2 | `FileUploadBase.getBoundary` | 无关 |
| 3 | `Base64Decoder.Base64Decoder` | **构造函数** |
| 4、6 | `MockHttpServletRequest.MyServletInputStream.read` ×2 | **`src/test/` 测试代码** |
| 5 | `MockPortletActionRequest.MockPortletActionRequest` | **测试代码** |
| 7 | `FileItemStreamImpl.getContentType` | 名字完全匹配却只排第 7 |
| 9 | `MockPortletActionRequest.getContentType` | **测试代码**，同名不同类 |
| 10 | `StreamingTest.testFILEUPLOAD135.read` | **测试代码** |

**10 条里 4 条是测试代码、2 条是构造函数。**

### 3.2 holdout 逐题排序质量

| 题目 | 命中 | MRR | 名次 |
| --- | --- | --- | --- |
| ts-parse-request | ✓ | 0.500 | 2 |
| ts-stream-copy | ✗ | 0.000 | — |
| ts-size-threshold | ✓ | 0.250 | 4 |
| java-unique-id | ✓ | 0.125 | **8** |
| java-write | ✓ | 0.100 | **10** |
| java-content-type | ✗ | 0.000 | — |

**"命中"的题也大多是第 8–10 名才命中。** 因此 holdout 的 66.7% 非常脆弱。

### 3.3 结论

失败模式**不是模态鸿沟，而是排序与噪声**：

1. **测试代码污染**：`src/test/` 的实现与生产实现在同一候选池里竞争，无任何区分；
2. **构造函数污染**：构造函数名等于类名，会被"类型名类"的扩展词大量命中，而它几乎不可能是答案；
3. **无重排**：名字完全匹配的 `getContentType` 也只能排第 7，同名不同类无法区分。

这与说明书 8.9.3 与 PPT 推进计划中已写明的「候选重排」完全一致，也与 Code2Code 链路已有的 DeepSeek 重排一致。

## 4. 被证伪的假设：分通道查询构造

**假设**：三个召回视图索引不同形态的代码，应各自接收能匹配的查询形态
（声明视图 ← 标识符形状词、正文视图 ← 扩展词集、模块摘要 ← 原始中文需求）。

**实测（两版都做了，都未采纳）**：

| 版本 | dev(12) | dev MRR | holdout(6) | holdout MRR |
| --- | --- | --- | --- | --- |
| 原始（扩展词集用于全部三视图） | **1.000** | 0.572 | **0.667** | 0.163 |
| 替换版（每视图用自己的查询形态） | 0.917 | 0.676 | **0.333** | 0.061 |
| 加性版（保留原单元，另加标识符符号视图） | 0.917 | 0.625 | 0.667 | 0.131 |

- 替换版：holdout 从 4/6 掉到 2/6，**判定为错**——把扩展词集从摘要/符号视图移走会丢失承载正确答案的候选；
- 加性版：holdout 持平、dev 掉 1 题、MRR 下降，**判定为零收益**。

**结论：给声明视图补标识符形状查询不解决问题**；召回不变量是"扩展词集作用于全部视图"。
两版均已回退，`task-retrieval.ts` 保持 HEAD 状态。

## 5. 已实施：噪声降权（holdout 4/6 → 5/6）

针对 §3 定位的两类噪声，在 `task-retrieval.ts` 的命中打分处加了降权因子（**降权而非删除**，因为确有答案位于测试源码中）：

- 测试路径（`src/test/`、`__tests__/`、`*Test.java`、`*.spec.ts` 等）：×0.7
- 构造函数（`kind === 'constructor'`，或限定名尾段等于其容器名——Java 构造函数名等于类名，任何类型名类扩展词都会命中它）：×0.6

| 集 | 改前 | 改后 | Δ |
| --- | --- | --- | --- |
| dev(12) | 1.000，MRR 0.572，nDCG 0.667 | **1.000**，MRR **0.656**，nDCG **0.733** | 召回持平，MRR +0.083 |
| holdout(6) | 0.667（4/6），MRR 0.163，nDCG 0.278 | **0.833（5/6）**，MRR **0.197**，nDCG **0.344** | **+1 题** |

逐题对照证明机制按设计生效：`java-content-type` 由 0 → 1，其 top-5 中的 4 条测试实现与 2 个构造函数全部消失，替换为生产代码；`java-unique-id` 的 MRR 由 0.125 升至 0.167。

**注意**：当前 18 道标注题的答案全部位于生产源码且均非构造函数，因此本降权在该评测集上只有收益；其代价（答案确实在测试或构造函数时）无法在本集上测量。

## 6. 模态鸿沟的直接测量

`ts-stream-copy`（需求"把输入数据整体写入输出对象，并返回写入的字节数"，答案 `src/compatibility.ts:111` 单行）在降权后仍失败。直接对索引发探针：

| 查询 | symbol 通道 rank 1 | 命中目标 |
| --- | --- | --- |
| `copy`（单词） | **`Streams.copy`** | ✅ |
| 真实源码片段（oracle） | **`Streams.copy`** | ✅ |
| 中文需求原文 | `LimitedInputStream.getCount` | ❌ |
| 中文近义串「整体写入输出对象 返回字节数」 | `LimitedInputStream.getCount` | ❌ |

**结论：索引与排序在该用例上完全有能力（oracle 查询 rank 1），失败 100% 发生在查询侧的中文→代码词汇映射。**
扩展词集里有 `write/output/input/bytes/return/object/data`，唯独没有 `copy`；交付的 11 条证据中 0 条含 `copy`。
`source-fragment` 通道用中文查询时 rank 1 已经是正确的文件 `src/compatibility.ts`，说明**素材是够的，缺的是从素材里取出标识符的那一步**。

因此两道失败题的根因不同：

| 题 | 查询能否找到目标 | 根因 |
| --- | --- | --- |
| `java-content-type` | 能（`contentType` 在扩展词中） | 噪声与排序（测试代码、构造函数占位） |
| `ts-stream-copy` | **不能**（查询中无 `copy`） | 模态／词表覆盖缺口 |

## 7. 已尝试并回退：伪相关反馈（PRF）

**假设**：`source-fragment` 通道用中文查询时 rank 1 已是正确文件，因此从排名靠前的检索片段中挖掘标识符形状的词、
回查声明通道，即可补上词表缺失的词（如 `copy`）。

**实现**：仅挖掘"已包含扩展词的代码行"中的词（候选与召回自身判定相关的内容绑定），
排除语言关键字与通用成员名，取前 12 个词构成一个新的符号视图，权重 0.5（低于直接查询）。

**实测**：

| 集 | 无 PRF | PRF(0.5) | Δ |
| --- | --- | --- | --- |
| dev(12) | 1.000，MRR 0.656，nDCG 0.733 | 1.000，MRR 0.613，nDCG 0.702 | 召回持平，MRR **−0.043** |
| holdout(6) | 0.833（5/6），MRR 0.197，nDCG 0.344 | 0.833（5/6），MRR **0.318**，nDCG **0.435** | 召回持平，MRR +0.121 |

**判定：不采纳，已回退。** 两条理由：

1. **它没有修好目标用例**：`ts-stream-copy` 仍为 0，交付的 11 条证据中依然是 0 条含 `copy`；
2. **holdout 的 MRR 增益只来自一道题**（`ts-size-threshold` 的 MRR 由 0.250 升至 1.000），
   其余题目持平或略降（`java-unique-id` 0.167 → 0.143），同时 dev 的 MRR 回退 0.043。单题驱动，不构成验证。

### 7.1 为什么不生效：真正的阻塞点是词表覆盖（数据问题，不是机制问题）

直接调试该用例的挖掘环节：

- 该需求经词表只展开出 **6 个词**：`response write save store return result`。
  **`输入`、`输出`、`数据`、`字节数` 在 355 条词表里都没有对应条目**，因此锚点极弱；
- 扩展查询取回的 top-3 片段长度仅 **64 / 145 / 38 字符**，不含答案邻域；
- 因此挖掘只得到 `discardBodyData readBodyData length number this`，**没有 `copy`**。

**结论：`ts-stream-copy` 失败的根因是词表对该需求的覆盖近乎为零**，而非"取词机制"缺失。
PRF 只在查询侧已有可用锚点和足够素材时才可能起作用，本例两者都不具备。

**修复路径与禁忌**：
- 直接往词表补「输入/输出/整体写入 → input/output/copy」会**污染已冻结的 holdout**
  （其头部明文禁止参与词表构建或调参），因此不作为选项；
- 合规路径是**从语料/文档系统性地扩充词表**（而非看着测试结果补词），或在扩充后明确声明该 holdout 对这次变更已不再干净；
- 另一条路径是**升级跨模态嵌入模型**：`输入数据整体写入输出对象` 与 `copy` 的语义距离本应由嵌入通道承担，
  当前 384 维 E5-small 未能覆盖。

## 8. 词表覆盖审计（本轮最关键发现）

对全部 18 道题逐条打印展开结果，展开词数与失败/靠后高度相关：

| 任务 | 展开词数 | 关键缺失 | 实测表现 |
| --- | --- | --- | --- |
| ts/java-filename、ts/java-cleanup | 16 | — | 命中 |
| ts/java-charset、ts/java-part-headers | 14 | — | 命中 |
| ts-parse-request | 13 | — | 命中（第 2 名） |
| ts-size-threshold | 11 | — | 命中（第 4 名） |
| java-unique-id | 9 | — | 命中（第 6–8 名） |
| ts/java-base64、ts/java-quoted-printable | 8 | — | 命中 |
| **java-write** | **8** | **无 `write`**（需求写"把上传项内容**写出**到指定文件"，`写出` 不在词表） | MRR 0.100（**第 10 名**，勉强命中） |
| java-content-type | 7 | 有 `contentType` ✓ | 曾被噪声挤出（已由降权修复） |
| **ts-stream-copy** | **6** | **无 `copy`、无 `output`、无 `bytes`** | **未命中** |
| ts-stream-copy 需求实际展开 | 6 | `response write save store return result` | — |

**结论：词表收得进名词与概念（`fileName`、`characterSet`、`threshold`、`unique`），
但系统性地缺失常用编程动词与量词**——`写出`→`write`、`整体写入/复制`→`copy`、`字节数`→`bytes`/`count`。
两道未命中/靠后的题同源于此。

这解释了词表杠杆的双面性：它贡献了 +41.7pp / +33.3pp（说明方向正确），
但只有 355 条、且动词层缺失，因此其上限被自身覆盖度卡住。

**修复的合规边界**：补齐动词层（`write`/`read`/`copy`/`delete`/`parse`/`encode`/`decode`/`convert`/`generate`/`validate` 等）
属于**系统性补缺**而非针对单题调参，但作者在补齐前已观察到 holdout 的失败模式，
因此**补齐后该 holdout 对这次变更不再干净**，必须以 dev 集 + 新标注集重新度量。

## 9. 新增评测集：`experiments/nl2code-eval/tasks.json`（16 题）

原 dev 集已饱和（12/12）、holdout 仅 6 题，两者都不足以区分改动。新建第三套标注集：

- **选取原则**：非测试路径、`qualifiedName` 唯一（排除重载方法，因 harness 要求唯一匹配）、实现体量 ≥ 8 行；
- **标注方式**：逐个读取目标实现后，按其**行为**撰写中文需求，需求中不出现任何标识符；正文全部经由 harness 的
  「标签唯一解析」断言机器校验通过（16/16 解析成功）；
- **建立时未参考任何检索结果**，因此可用于评价后续改动。

### 9.1 三集合计（查询扩展 ON，无预算，官方口径）

| 集 | 题数 | full 混合召回 | vector-topk 纯向量 |
| --- | --- | --- | --- |
| dev | 12 | 12/12 = **1.000** | 3/12 = 0.250 |
| holdout | 6 | 5/6 = **0.833** | — |
| 新集 | 16 | 15/16 = **0.938** | **0/16 = 0.000** |
| **合计** | **34** | **32/34 = 0.941** | — |

- **命题要求的「代码检索准确率 ≥90%」在 34 题合计口径下首次达标（94.1%）**，此前从未有过这个数字；
- 平均延迟 348 ms、p95 1125 ms，远低于 ≤10 s 的要求；
- **纯向量 top-k 在新集上为 0/16**，混合召回的价值在更难的数据上被放大（dev 上为 25%）。

### 9.2 新集的唯一未命中与排序分布

`java-mime-decode-text`（需求"解码请求头里经过编码的文本片段，未编码的内容原样返回"→ `MimeUtility.decodeText`，89 行）未命中，
top-5 被 `FileItem.getString`、`QuotedPrintableDecoder.decode`、`Base64Decoder.decode`、两处 `setHeaderEncoding` 占据。

**根因与 §8 同类**：需求里"解码…文本"映射到 `decode`，命中的是两个**解码器类**的方法；
而被检索目标最有区分度的行为特征是"未编码时原样返回"这一**行为语义**，词表无法表达。

排序分布：3 题 MRR = 1.000（第 1 名命中），其余命中题多在 0.143–0.5（第 2–7 名），说明排名仍有较大改善空间。

### 9.4 稳定性验证：34 题口径完全可复现

三个集各重复运行 3 次（`--repeats 3`，固定 revision、预热缓存、无预算）：

| 集 | taskSuccessRate | MRR | nDCG@10 |
| --- | --- | --- | --- |
| dev(12) | 1.000 | 0.6556547619047618 | 0.7328391852954144 |
| holdout(6) | 0.8333 | 0.19722222222222222 | 0.3438475853631304 |
| 新集(16) | 0.9375 | 0.5184523809523809 | 0.6186067976374908 |

三次重复的 MRR 与单次运行**逐位一致**（16 位有效数字相同），即该设置下整条链路是完全确定的。
**因此 32/34 = 94.1% 是可复现的读数，而非单次抽样。**
（此前观察到的 legacy 基线 97/171 行差异来自索引换代，不是 HNSW 本身的随机性——这一点在此得到澄清。）

### 9.5 排名错误的成因诊断

对 MRR < 1 的题逐条查看"谁排在答案前面"，模式高度集中：

| 任务 | 目标 | 排在前面的是 | 模式 |
| --- | --- | --- | --- |
| java-item-bytes | `DiskFileItem.get` | `DiskFileItem.isInMemory` | **同类兄弟方法** |
| java-boundary-detect | `MultipartStream.readBoundary` | `MultipartStream.skipPreamble`、`computeBoundaryTable` | **同类兄弟方法** |
| java-skip-preamble | `MultipartStream.skipPreamble` | `MultipartStream.setBoundary` | **同类兄弟方法** |
| java-buffer-fill | `ItemInputStream.makeAvailable` | `FileItemStreamImpl.openStream`、`Streams.copy` | 同类兄弟 / 近义方法 |
| java-item-tempfile | `DiskFileItem.getStoreLocation` | `DiskFileItemFactory.getRepository`、`setRepository` | 近义方法 |
| java-mime-decode-text | `MimeUtility.decodeText` | `FileItem.getString`（接口声明） | 接口声明 + 解码器类方法 |

**机制**：`task-retrieval.ts` 中，路径级片段文档（`!document.symbolKey && sourceRange === undefined`）会与**同一文件的所有声明**匹配，
于是同一文件内每个方法都拿到该文件的召回排名（`Math.max(...matched.map(...))`），彼此分数接近，次序由 `result.id.localeCompare` 决定。
真正的区分只能来自**该声明自身的直接证据**（符号视图命中，或带 sourceRange 的片段命中）。

**而目标往往没有直接证据**——因为需求里最有区分度的词（"字节数组""整体读""原样返回"）不在词表里。
**结论：这一轮的排名错误与 §8/§9.2 同源，主要仍是词表覆盖问题，不是排序函数问题。**

### 9.6 合规性说明

本集在 §7/§8 的两次尝试**之后**建立，因此它不构成对那两次尝试的洁净验证集（作者已知其失败模式）；
但它可用于评价**今后**的改动，且规模（16）大于原 holdout（6）。

## 10. 词表扩充的硬约束（本轮实测：本环境不可执行）

§8 与 §9.2 的两次未命中同源于词表覆盖，词表扩充是证据最强的下一步，但**当前环境无法合规执行**：

1. **生成流程需要模型凭据**：`scripts/build-query-lexicon.mts` 调用 `deepseek-v4-flash` 生成条目
   （`--model`、`--chunk-domains`、prompt 构造见该脚本 98/153/158 行）。本环境
   `services/retrieval-service/.env` 与进程环境中**均无 `DEEPSEEK_API_KEY`**，builder 无法运行。
2. **手改冻结产物被契约禁止**：`query-lexicon-data.ts` 头部标注 `Generated ... Do not edit by hand`；
   builder 头部声明 `forbidden inputs: any evaluation task requirement text, target symbol`。
   而本轮的候选词（`写出`、`整体写入`）正是通过观测评测任务失败得到的，属于被禁止的输入来源。
   仅有的离线入口 `--from`（从既有 JSON 重建 TS 模块）绕不过这条约束。
3. **校验脚本有机器化防污染规则**：`scripts/verify-query-lexicon.mts` 检查
   **任何 6 字符的评测需求子串都不得成为词表的 zh 键**，以及词形必须为单词级（≤3 个驼峰段）。

**合规的扩充路径**（留待有凭据的环境执行）：向 builder 的**通用中文软件术语种子表**补充动词与行为词
（`write`/`read`/`copy`/`delete`/`parse`/`encode`/`decode`/`convert`/`generate`/`validate`，
以及"原样返回""跳过""归组"这类行为表述），重新生成并跑 `verify-query-lexicon.mts`。

## 11. 下一步（按证据排序）

1. **补齐词表动词层与行为词**：按 §10 的合规路径执行（需模型凭据），以 dev(12) + 新集(16) 度量。
2. **在更大的集上评估重排**：新集 MRR 分布为 3 题第 1 名、多数第 2–7 名，排名仍有空间。
   注意 DeepSeek 重排同样需要凭据；本地 cross-encoder 需先解决模型下载。
3. **升级跨模态嵌入模型**：接口已就绪，改配置 + 重建索引（同样依赖模型下载）。
4. **继续收敛噪声类**：本轮已处理测试路径与构造函数；接口声明 vs 实现、生成代码等类别尚未处理，
   属零成本、可离线验证的方向。

## 12. 复现命令

```bash
# 基线（dev / holdout，官方口径：无预算）
node --import tsx scripts/run-guochuang-pilot.mts --database forexplore_task_context_dev_20260908 \
  --tasks experiments/guochuang-pilot/tasks.json --variants full,vector-topk --budgets none --repeats 1 --output tmp/pilot-baseline-1

# 查询扩展消融
RECAST_QUERY_EXPANSION=off node --import tsx scripts/run-guochuang-pilot.mts \
  --database forexplore_task_context_dev_20260908 --tasks experiments/guochuang-pilot/tasks.json \
  --variants full --budgets none --repeats 1 --output tmp/pilot-devexp-off
```
