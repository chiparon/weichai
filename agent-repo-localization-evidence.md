# 证据检索报告：超大代码仓库中 Coding Agent 定位慢 / 绕路多 / 成本高 / 成功率低

> 核验等级：🟢=本次搜索结果的**标题或片段中直接出现**该数值；🟡=来自模型知识、**必须人工打开原文核对**；🔴=二手转述或厂商主张。
> ⚠️ 本次会话 `web_fetch` 对**所有域名**返回 "resolves to a non-public IP address"（已实测），PowerShell 出网亦失败；`web_search` 仅返回标题+URL，**偶发**片段。因此绝大部分数值只能到 🟡，**本报告不含任何推测生成的新数字**。

---

## 0. 本次真正拿到 🟢 的证据（先看这一节）

| # | 内容 | 值 / 事实 | 出处 | 等级 |
|---|---|---|---|---|
| A | **仓库规模 → 通过率**（唯一直接命中的实证表） | Project Size **Small = 65.4%**、**Medium = 62.4%**（Large 行被截断未显示） | [arXiv 2604.23190v2 PDF 表格片段](https://arxiv.org/pdf/2604.23190v2) | 🟢（数值）/ 🟡（论文身份未核实） |
| B | 定位类 Agent 的 token 消耗 | 每条轨迹总 token **中位数 28.6k** | [SHERLOC: Structured Diagnostic Localization for Code Repair Agents](https://arxiv-org.ezproxy.obspm.fr/html/2606.24820v1) 片段 | 🟢 |
| C | 定位评测口径明确定义 | 以「预测 == ground-truth 文件」记 **File ACC**，以函数记 **Func ACC** | [HF papers-content 2607.00016 片段](https://huggingface.co/buckets/huggingchat/papers-content/tree/2607/2607.00016.md?code=true) | 🟢（口径） |
| D | Google 内部调研 | 约**九成**软件工程师已在工作中使用 AI 工具 | [中文转述报道](http://www.163.com/dy/article/KA68NT2J05198CJN.html) | 🔴（数值经中文二手转述） |
| E | SWE-bench Verified 一年演进 | 标题直接写 "From **65%** to **80.9%**" | [AgentMarketCap 分析文](https://agentmarketcap.ai/blog/2026/04/06/swe-bench-verified-12-month-progress-arc-65-to-80-saturation) | 🔴（行业博客，非论文） |
| F | METR 结论方向 | 标题 "AI coding tools make developers **slower** but they **think they're faster**" | [The Register 2025-07-11](https://www.theregister.com/2025/07/11/ai_code_tools_slow_down) | 🟢（方向）/ 具体数值 🟡 |

**已确认存在的论文/文档（标题+venue 级 🟢，数值均需人工核对）**
- SWE-bench, ICLR 2024 — [proceedings](https://proceedings.iclr.cc/paper_files/paper/2024/hash/edac78c3e300629acfe6cbe9ca88fb84-Abstract-Conference.html)；arXiv **2310.06770**（URL 中直接出现 🟢）
- LocAgent: Graph-Guided LLM Agents for Code Localization, **ACL 2025 长文** — [ACL Anthology 2025.acl-long.426](https://aclanthology.org/2025.acl-long.426/)；arXiv **2503.09089**（检索结果 URL 直接出现 🟢）
- RepoGraph: Enhancing AI Software Engineering with Repository-level Code Graph, **ICLR 2025** — [proceedings](https://proceedings.iclr.cc/paper_files/paper/2025/hash/4a4a3c197deac042461c677219efd36c-Abstract-Conference.html)
- Agentless 官方仓库 — [OpenAutoCoder/Agentless](https://github.com/OpenAutoCoder/Agentless)
- Anthropic — [Raising the bar on SWE-bench Verified with Claude 3.5 Sonnet](https://www.anthropic.com/news/swe-bench-sonnet)（有官方 engineering 页 [swe-bench-sonnet](https://www.anthropic.com/engineering/swe-bench-sonnet)）
- Long Code Arena（JetBrains，2024-08）— [JetBrains Blog](https://blog.jetbrains.com/ai/2024/08/long-code-arena-how-well-can-ai-models-understand-your-entire-project/)
- DORA — [Balancing AI tensions](https://dora.dev/insights/balancing-ai-tensions/)；[2025 DORA 报告解读 (ADTmag, 2025-09-24)](https://adtmag.com/articles/2025/09/24/what-2025-dora-report-means-for-developers.aspx)
- SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks? — [arXiv 2509.16941](https://arxiv-org.ezproxy.obspm.fr/html/2509.16941v2)
- 定位/探索效率相关新工作（仅标题确认）：[SweRank (2505.07849)](https://ar5iv.labs.arxiv.org/html/2505.07849)、[BLAgent: Agentic RAG for File-Level Bug Localization (2605.17965)](https://ar5iv.labs.arxiv.org/html/2605.17965)、[A Benchmark for Localizing Code and Non-Code Issues (2509.25242)](https://huggingface.co/papers/2509.25242)、[Long Live the Librarian! Persistent Search Sub-Agent (2605.27787)](https://export.arxiv.org/pdf/2605.27787)、[CORVUS: Context Optimization and Reduction (2607.22711)](https://papers.cool/arxiv/2607.22711)

---

## 1. 仓库级基线成功率（论"精度差"）

| 数据 | 精确数值 | 数据集 / 设置 | 等级 | 支撑什么 |
|---|---|---|---|---|
| SWE-bench 原论文，Claude 2 | 解决率 **1.96%** | SWE-bench 全量（2,294 实例 / 12 个 Python 仓库），2023-10 | 🟡 | 最有力的"起点极低"锚点 |
| SWE-bench Verified，GPT-4o | **33.2%** | SWE-bench **Verified**（500 条人工校验子集），OpenAI 2024-08 | 🟡 | Verified 与全量不可混用 |
| Claude 3.5 Sonnet | **49.0%** | SWE-bench **Verified**，Anthropic 2024-10 | 🟡（官方博客 URL 🟢） | 官方 agent scaffold 的一年内跃升 |
| Devin | **13.86%** | SWE-bench **全量**，Cognition 2024-03 | 🟡 | 首个"端到端 agent"基线，与 Verified 上的数值不可比 |
| SWE-agent + GPT-4 Turbo | **12.5%** | SWE-bench **全量** test set pass@1，NeurIPS 2024 | 🟡 | 学术 agent 基线 |
| Agentless + GPT-4o | **27.3%** | SWE-bench **Lite**（300 条） | 🟡 | "无 agent 的三阶段流水线"反超复杂 agent |
| OpenHands + Claude 3.5 Sonnet | **26.0%** | SWE-bench **Verified**，ICLR 2025 | 🟡（置信度中低） | 开源 agent 平台基线 |
| AutoCodeRover | 未确认（见 §6） | — | — | — |
| Claude 3.7 / Sonnet 4 / Opus 4.1 / Sonnet 4.5 | **62.3% / 72.7% / 74.5% / 77.2%**（Sonnet 4.5 并行测试时计算 **82.0%**） | 均为 SWE-bench **Verified**，2025 各月 | 🟡 | 说明"饱和"，须标注模型+月份 |

> ⚠️ 跨设置红线：SWE-bench **全量**、**Lite**、**Verified** 三者分母不同（2294 / 300 / 500），且年份、模型、scaffold 都不同——**不可混引**。

---

## 2. 定位阶段的准确率与贡献（论"先定位"是关键瓶颈）

| 工作 | 数值 | 设置 | 等级 | 支撑什么 |
|---|---|---|---|---|
| **LocAgent**（ACL 2025） | 文件级定位准确率 **92.7%**（另称成本大幅下降，具体降幅未确认） | LocBench / SWE-bench 定位子任务，图引导 agent | 🟡 | 定位可达高精度，但需专门的图结构 + 定向搜索；其动机即"定位是修复的前置瓶颈" |
| **RepoGraph**（ICLR 2025） | SWE-bench 解出率**相对提升至多 32.8%**（具体基线-终值对未确认） | 作为即插即用模块挂到 SWE-agent / Agentless | 🟡（低置信度，务必核对） | 仓库级代码图能补上"定位/上下文获取"的缺口 |
| **Agentless** 三阶段流水线 | 定位阶段仅需**少量 LLM 调用**，整体 **$0.34/issue** | SWE-bench Lite | 🟡 | 反证：**Agent 式反复探索对定位而言是冗余开销** |
| **SHERLOC** | 每条轨迹 **中位数 28.6k tokens** | 代码修复 agent 的诊断定位 | 🟢 | 定位/诊断本身即耗费数万 token |
| 定位评测口径 | File ACC / Func ACC 精确匹配 | 见 [2607.00016](https://huggingface.co/buckets/huggingchat/papers-content/tree/2607/2607.00016.md?code=true) | 🟢 | 项目说明书可直接采用该指标定义 |
| "定位是瓶颈"的直接论断 | **未确认**（未检索到明确说"localization is the bottleneck"的可引用论文） | — | — | 建议改用"定位是前置且高成本步骤"的表述，或用 LocAgent/Agentless 的动机段落间接支撑 |

---

## 3. 探索代价：轮数 / 工具调用 / token / 美元

| 数据 | 数值 | 设置 | 等级 |
|---|---|---|---|
| Agentless 单实例成本 | **$0.34 / issue** | SWE-bench Lite，GPT-4o | 🟡 |
| SWE-agent 单实例成本 | 约 **$4.01 / instance** | SWE-bench，GPT-4 Turbo | 🟡（**低置信度**，务必核对原文/README） |
| SHERLOC 轨迹 token | 中位数 **28.6k tokens** | 定位+修复轨迹 | 🟢 |
| 每实例平均轮数 / 工具调用次数（SWE-agent、OpenHands、Agentless 的权威表） | **未确认** | — | — |
| 重复搜索 / 冗余文件读取的量化证据 | **未确认**（仅找到*动机类*工作标题：[Long Live the Librarian! 持久搜索子 agent](https://export.arxiv.org/pdf/2605.27787)、[CORVUS 上下文压缩](https://papers.cool/arxiv/2607.22711)） | — | 🟡（标题） |

---

## 4. 代码库规模的影响（论"仓库越大越糟"）

| 数据 | 数值 | 设置 | 等级 |
|---|---|---|---|
| **Project Size → Pass Rate** | Small **65.4%** / Medium **62.4%** / Large **未显示（表格被截断）** | [arXiv 2604.23190v2](https://arxiv.org/pdf/2604.23190v2) | 🟢（前两行数值）/ 🟡（论文身份、数据集未核实） |
| Long Code Arena 基线分数 | **未确认**（只确认基准存在，6 个长上下文任务，JetBrains 2024-08） | — | — |
| SWE-Bench Pro 基线 | **未确认**（论文标题确认："Can AI Agents Solve Long-Horizon Software Engineering Tasks?"） | — | — |

> 这是全报告**最贴合本项目**的一条：它给出的正是"仓库规模 ↑ → 通过率 ↓"的单调趋势（65.4% → 62.4%）。**但必须先人工打开该 PDF 确认**：论文标题、Large 行的具体值、以及"Project Size"的定义（文件数？LOC？）。

---

## 5. 工业界体感数据

| 数据 | 数值 | 设置 | 等级 |
|---|---|---|---|
| **METR 2025 RCT** | **16 名**资深开源开发者、**246 个**真实任务；AI 使其完成时间 **慢 19%**；事前预测 **快 24%**；事后自认 **快 20%** | 2025 年初工具（Cursor Pro + Claude 3.5/3.7 Sonnet），开发者熟悉的自家仓库 | 🟡（数值）/ 🟢（方向，The Register 标题） |
| METR 其他细节（平均任务耗时分钟数、AI 实际使用比例、为何自觉更快） | **未确认** | — | — |
| DORA 2024 | AI 采用率每 **+25%**，交付吞吐量 **−1.5%**、交付稳定性 **−7.2%** | Google Cloud DORA 2024，全球调研 | 🟡 |
| DORA 2025 | **~90%** 开发者已用 AI；仅 **~30%** 高度信任 AI 产出（返工/信任数据的具体口径未确认） | DORA 2025 | 🟡 |
| Google 内部调研 | **~90%** 工程师工作中使用 AI 工具 | 中文二手转述 | 🔴 |
| Microsoft/GitHub 大仓库 AI 工具信任度/返工率 | **未确认** | — | — |

---

## 6. 未能确认的项（**请勿在说明书中引用，或必须先打开原文**）

1. SWE-bench 原论文中除 Claude 2 外其他模型的早期数值（如 GPT-4 的 1.x%）。
2. **AutoCodeRover** 在 SWE-bench / Lite 上的 resolve rate 与成本。
3. **Agentless 1.5** 在 SWE-bench Verified 上的数值（记忆中有 ~40.7%，但无法核验）。
4. **LocAgent** 的成本降幅百分比、LocBench 数据集规模、以及 92.7% 的确切口径（文件级？top-k？）。
5. **RepoGraph** 的 32.8% 到底是"相对提升"还是绝对值，以及具体基线→终值对。
6. SWE-agent / OpenHands 论文中的**每实例平均交互轮数、工具调用次数、输入输出 token 明细**。
7. "Agent 重复搜索、冗余读取文件"的**任何量化统计**（未找到可引用来源）。
8. Long Code Arena 各任务的**基线分数**。
9. SWE-Bench Pro 上 GPT-5 / Claude 各模型的公开分数。
10. METR 实验的**平均任务耗时（分钟）**、**AI 工具实际使用比例**、开发者主观加速归因的原文表格。
11. Microsoft / GitHub 关于**大型 monorepo 内 AI 编码工具表现、信任度、返工率**的任何一手调研。
12. DORA 2024/2025 报告中"AI 采用率↑ → 吞吐量/稳定性↓"的**原始回归系数与置信区间**。
13. 是否存在明确主张"**定位是仓库级任务瓶颈**"的可引用论文（本次未找到）。

## 7. 给下一轮检索的建议（在有网络抓取能力的环境里）
- 打开下列 6 个页面即可把大量 🟡 升级为 🟢：`aclanthology.org/2025.acl-long.426/`（LocAgent 摘要）、`anthropic.com/news/swe-bench-sonnet`（Claude 3.5 Sonnet 49%）、`arxiv.org/abs/2310.06770`（1.96%）、`github.com/OpenAutoCoder/Agentless`（27.3% / $0.34）、`metr.org` 的 2025 RCT 论文页（19%/24%/20% + 明细表）、`arxiv.org/pdf/2604.23190`（规模-通过率完整表）。
