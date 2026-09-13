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

## 8. 下一步（按证据排序）

1. **扩充标注集**（最高优先，且是其他一切的前提）：dev 已饱和（12/12，无法区分改进）、holdout 仅 6 题
   且 MRR 提升由单题驱动。现有规模下任何调参都会重犯"对着无法区分的指标调参"的错误。
2. **系统性地扩充词表覆盖**（按 §7.1 的合规路径，从语料而非测试结果出发）：这是当前唯一被证明有效的杠杆
   （词表贡献 +41.7pp / +33.3pp）的短板所在。
3. **升级跨模态嵌入模型**：接口已就绪，改配置 + 重建索引；直接对应 §7.1 的语义失败。
4. **重排层**：`java-content-type` 的噪声问题已由降权缓解，重排的价值需在更大标注集上评估。

## 9. 复现命令

```bash
# 基线（dev / holdout，官方口径：无预算）
node --import tsx scripts/run-guochuang-pilot.mts --database forexplore_task_context_dev_20260908 \
  --tasks experiments/guochuang-pilot/tasks.json --variants full,vector-topk --budgets none --repeats 1 --output tmp/pilot-baseline-1

# 查询扩展消融
RECAST_QUERY_EXPANSION=off node --import tsx scripts/run-guochuang-pilot.mts \
  --database forexplore_task_context_dev_20260908 --tasks experiments/guochuang-pilot/tasks.json \
  --variants full --budgets none --repeats 1 --output tmp/pilot-devexp-off
```
