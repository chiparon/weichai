# A 计划（离线领域词表查询扩展）实施结果

验收标准见 [`docs/query-expansion-acceptance.zh-CN.md`](query-expansion-acceptance.zh-CN.md)。
本文件如实记录两轮结果，包含第一轮的未通过结论与失败分析。

**最终判定：通过，并达到命题口径（TARGET）。**

| 轮次 | 开发集 | 泛化集 | 契约校验 | 判定 |
| --- | --- | --- | --- | --- |
| 第一轮（替换式，未降噪） | 7/12 → 12/12 | 2/6 → 3/6 | 开启后失败 | ❌ 未通过 |
| **第二轮（降噪 + 基线权重 0.15）** | 7/12 → **12/12** | 2/6 → **5/6** | 开/关均通过 | ✅ **通过（TARGET）** |

---

## 1. 最终结果

| 指标 | 关闭扩展（基线） | 开启扩展 | 判定 |
| --- | --- | --- | --- |
| 开发集 Hit@10（12 题） | 7/12 = 58.3% | **12/12 = 100%** | ✅ TARGET（≥11/12） |
| 泛化集 Hit@10（6 题，冻结、隔离） | 2/6 = 33.3% | **5/6 = 83.3%** | ✅ TARGET（≥5/6） |
| 开发集严格子集（多词标识符标签 6 题） | 1/6 | **6/6** | ✅ |
| 泛化集严格子集（4 题） | 2/4 | 3/4 | ✅ |
| 泛化集豁免子集（2 题） | 0/2 | **2/2** | ✅ |
| 基线复现（关闭开关） | 7/12，逐题与历史一致 | — | ✅ 唯一变量是开关 |
| 旧命中丢失 | — | **0 题**（7 题全部仍命中，且名次提升） | ✅ |
| 扩展步骤耗时 | — | 最大 **0.761 ms** | ✅（≤5 ms） |
| 端到端平均耗时（dev） | 2049 ms | 2238 ms（+9.2%） | ✅（≤10%；同一批次 P95 反而下降 4521→4365 ms） |
| 端到端契约校验 | exit=0（9/9） | **exit=0（9/9）** | ✅ |
| 全量 `npm test` | — | **711 passed / 1 skipped / 0 failed** | ✅ |
| 泄漏审计 | — | 355 条 · 0 违规 | ✅ |

逐题（关闭 → 开启）：

- 开发集：`ts-filename` miss→#10、`java-filename` miss→#5、`ts-charset` miss→#8、`java-charset` miss→#10、`java-part-headers` miss→#5；
  原有命中名次普遍前移：`java-quoted-printable` #7→#1、`java-base64` #3→#1、`java-cleanup` #2→#1、`ts-base64` #2→#1。
- 泛化集：`ts-size-threshold` miss→#4、`ts-stream-copy` miss→#10、`java-write` miss→#10；`ts-parse-request` #2→#2、`java-unique-id` #5→#8；
  仅 `java-content-type` 仍未命中。

---

## 2. 第一轮为什么没通过（失败分析）

第一轮采用"扩展查询直接替换原查询"，开发集 12/12，但：

1. **泛化集只有 3/6**：`java-unique-id` 从 #5 退化为未命中（扩展词里的 `length/size/count` 把 `getContentLength` 一类符号抬到前面）。
2. **仓库自带端到端契约校验失败**：`default-budget-auto` / `default-budget-function` 报
   `Per-file size evidence is missing`。探针定位到机制：开启扩展后承载"单个文件大小限制"实现的
   `FileUploadBase.java` 被**完全挤出交付证据**（4000 与 8000 预算都是），因为扩展把
   "限制 → limit / bound / exceed" 这类**泛化词**注入查询，召回被 `FileCountLimitExceededException`
   等近邻干扰项占据。

根因一句话：**通用虚词带来的是"相关的错东西"，同时稀释了中文需求的语义信号。**

---

## 3. 第二轮的两处修改（均只依据开发侧证据）

### 3.1 扩展词降噪（`query-expansion.ts`）

加入 46 个**超通用词**黑名单（`put/send/set/get/code/item/value/data/err/doc/mem/obj/...`），
并把扩展词上限从 24 降到 16。理由：这些词文档频率极高、判别力接近零，却会匹配到无关符号。

单独使用降噪后：开发集 11/12（原 12/12），契约校验仍失败 → 说明只靠降噪不够。

### 3.2 基线召回通道权重（`task-retrieval.ts`，`DEFAULT_BASELINE_RECALL_WEIGHT = 0.15`）

扩展开启时，除扩展查询外，**再把原需求作为一条低权重召回通道**并入 RRF 融合。
这样原需求找到的候选不会被挤出候选池，同时扩展查询仍主导排序。

### 3.3 开发侧配置扫描（只用 12 题开发集 + 仓库契约校验，未触碰泛化集）

| 基线权重 | 开发集 | 契约 4k | 契约 8k | 结论 |
| --- | --- | --- | --- | --- |
| 0（纯替换） | 11/12 | ✗ | ✗ | 契约不通过 |
| 0.10 | 12/12 | ✗ | ✗ | 契约不通过 |
| **0.15** | **12/12** | **✓** | **✓** | **采用** |
| 0.20 | 11/12 | ✓ | ✓ | 开发集掉 |
| 0.25 | 10/12 | ✓ | ✓ | — |
| 0.35 | 9/12 | ✓ | ✓ | — |
| 无扩展 | 7/12 | ✓ | ✓ | 基线 |

---

## 4. 交付物

| 组件 | 路径 |
| --- | --- |
| 离线词表生成器（LLM 一次性，输入白名单） | `scripts/build-query-lexicon.mts` |
| 词表产物（355 条 + sha256 + 输入清单） | `services/code-intelligence-service/src/query-lexicon.json`、`query-lexicon-data.ts`、`logs/experiments/query-lexicon-20260912-234033/inputs.json` |
| 查询扩展模块（纯同步、零 I/O、0.76 ms） | `services/code-intelligence-service/src/query-expansion.ts` |
| 召回接入 + 诊断字段 | `services/code-intelligence-service/src/task-retrieval.ts`、`packages/contracts/src/task-retrieval.ts`（`usage.retrieval.expansion`） |
| 单元测试（10 项） | `services/code-intelligence-service/src/query-expansion.test.ts` |
| 泄漏审计 / A/B 验收脚本 | `scripts/verify-query-lexicon.mts`、`scripts/verify-query-expansion.mts` |
| 最终 A/B 报告 | `logs/experiments/query-expansion-2026-09-12T16-08-27-468Z/report.json` |
| 契约校验报告 | `tmp/live-verify-off/`、`tmp/live-verify-on/` |

词表：`query-lexicon/v1`，355 条，`sha256=2badb6e2f0713489dcb27eca18a67fb31d1f910e231967c8feeb0e61647877f2`；
模型 `deepseek-v4-flash`（关闭思考），生成耗时约 28 秒；**查询路径不含任何模型或网络调用**（单元测试用 fetch spy 断言）。

---

## 5. 复现

```powershell
# 泄漏审计
node --import tsx scripts/verify-query-lexicon.mts
# A/B（OFF 实例 4040，ON 实例 4050；ON 现在也是默认）
node --import tsx scripts/verify-query-expansion.mts --off http://127.0.0.1:4040 --on http://127.0.0.1:4050
# 契约校验
node --import tsx scripts/verify-task-context-live.mts --endpoint http://127.0.0.1:4050 ...
# 词表重建（离线，不参与查询路径）
node --import tsx scripts/build-query-lexicon.mts --from services/code-intelligence-service/src/query-lexicon.json
```

---

## 6. 口径提醒与后续

1. **口径必须写明**：12/12 是"**含离线查询扩展**"的口径；关闭扩展时是 7/12。写入说明书/PPT 时必须注明，
   否则与基线混用构成误导。建议表述：*"冻结评测集上，含离线领域词表查询扩展的检索 Hit@10 = 12/12（100%）；关闭扩展为 7/12。"*
2. **泛化集只 5/6，仍有 1 题未命中**（`java-content-type`）。若要继续提升，建议：
   - 为该类"薄封装 getter"补充判别词（内容类型/MIME 相关的 `mimeType`、`mediaType` 已在表中，问题更可能在排序而非词表）；
   - 或引入重排（`bge-reranker-base` 本地脚本已具备，`retrieval-service` 亦有 LLM 重排实现）——这属于 B/C 计划。
3. **延迟余量偏紧**（+9.2%，勉强在 10% 阈值内）：扩展模式多出一组召回通道。若后续要留余量，
   可只对扩展通道降低 `candidateLimit`。
4. 泛化集已参与判定，按 §5.3 精神，下一轮迭代应另写一份新题作为新的泛化集，本份保留为已用历史。
