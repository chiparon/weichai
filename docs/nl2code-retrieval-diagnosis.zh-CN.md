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

## 5. 下一步（按证据排序）

1. **重排层**（最高优先）：模态无关，Code2Code 链路已有实现可参考；直接对应 MRR 0.10–0.27 的现状，
   也是说明书 8.9.3 与 PPT 已列的计划。
2. **噪声区分**（零成本，先于重排即可见效）：
   - 测试路径降权（`src/test/`、`*Test.java`、`*Test.ts`、`__tests__`）——注意降权而非硬删（`StreamingTest` 类答案确实存在于测试中）；
   - 构造函数降权（`symbol.kind` 或 `qualifiedName` 的尾段等于其容器名）。
3. **扩大标注集**：dev 已饱和、holdout 仅 6 题且 MRR 极低，现有规模无法区分改进。
   在动排序之前应先扩充到可区分的规模，否则会重犯"对着无法区分的指标调参"的错误。
4. **嵌入模型升级**（跨模态通道本身）：接口已就绪，改配置 + 重建索引即可，但优先级在排序之后。

## 6. 复现命令

```bash
# 基线（dev / holdout，官方口径：无预算）
node --import tsx scripts/run-guochuang-pilot.mts --database forexplore_task_context_dev_20260908 \
  --tasks experiments/guochuang-pilot/tasks.json --variants full,vector-topk --budgets none --repeats 1 --output tmp/pilot-baseline-1

# 查询扩展消融
RECAST_QUERY_EXPANSION=off node --import tsx scripts/run-guochuang-pilot.mts \
  --database forexplore_task_context_dev_20260908 --tasks experiments/guochuang-pilot/tasks.json \
  --variants full --budgets none --repeats 1 --output tmp/pilot-devexp-off
```
