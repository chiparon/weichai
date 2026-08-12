# 翻译模块优化计划

> 适用分支：`analyzer-translator`

## 1. 这阶段要解决什么

目前仓库已经跑通了 Java 到 C# 的基本链路：检索结果进入 `adaptation-service`，模型生成 C# 方法，随后做编译、修复和 patch。这个版本能证明链路可行，但翻译前的判断还比较薄：

- `translator.ts` 主要靠一次提示词直接翻译；
- 候选是“完全匹配、部分匹配还是仅供参考”，目前从 `decisionNotes` 的关键词推断；
- 目标侧只传了方法签名和需求，类上下文、调用方、现有依赖、不可变约束没有形成统一输入；
- 类型映射是在翻译后用简单规则补出来的，无法说明哪些行为可复用、哪些地方必须重写；
- 编译失败可以触发修复，但模型在翻译前并不知道候选实现和目标模块之间到底差在哪。

下一阶段不重做整条链路，重点补上翻译前的分析，并让分析结果真正约束翻译。整体收敛成两个独立 Agent：

```text
目标模块上下文 + 检索候选 + 需求
                |
                v
       Analyzer Agent（含 planning）
                |
          AnalysisReport
                |
                v
          Translator Agent
                |
     TranslationResult / FilePatch
                |
                v
       Validator（由测试组负责）
```

这里借鉴的是 [ReCodeAgent](https://arxiv.org/abs/2604.07341) “分析、规划、翻译、验证分工”的思路，不照搬它的整仓生成流程。我们的目标是给已有仓库中的一个待实现模块填空，目标工程和签名已经存在，不需要再生成项目骨架，也不需要维护文件级的全仓翻译顺序。

## 2. 和 ReCodeAgent 的差别

这几个差别会直接影响实现方式：

| ReCodeAgent | 我们的场景 | 对应调整 |
| --- | --- | --- |
| 从源仓库生成完整目标仓库 | 在现有仓库里补一个类或方法 | 分析范围限制在目标模块及必要的邻接上下文 |
| 源代码和目标代码原则上一一对应 | 检索结果可能只覆盖部分行为 | Analyzer 必须逐项区分可复用、需改写、缺失和冲突 |
| Planning 负责拆文件、建骨架、排依赖顺序 | 目标骨架已经存在 | Planning 合入 Analyzer，只输出本模块的实现步骤 |
| Translator 同时翻译源码和测试 | 本组只负责实现代码 | 测试生成、执行和判定交给 Validator 组 |
| 以整仓翻译完成度为主要目标 | 以目标契约和行为是否满足为主要目标 | 目标签名、调用约定和需求优先于候选源码 |

第一版仍聚焦现有的 Java → C# 场景，但报告和 Agent 接口不要把语言规则写死在公共契约里。后续增加语言对时，替换语言规则即可，流程本身不需要推倒重来。

## 3. 范围边界

- 复现当前翻译链路，固定一份可重复比较的基线；
- 补齐目标模块上下文的收集和裁剪；
- 实现独立的 Analyzer Agent；
- 把原 Planning 中有用的部分合入 Analyzer 报告；
- 改造 Translator Agent，使其按分析报告翻译，而不是只看一段候选源码；
- 串起 `analyze -> translate` 两步编排，并保留现有 HTTP/Workflow 接口兼容性；
- 提供单元测试、固定样例和运行记录；
- 定义与 Validator 组的输入输出格式。

## 4. 两个 Agent 怎么分

### 4.1 Analyzer Agent

Analyzer 的任务不是泛泛总结代码，而是回答三个问题：

1. 候选实现对当前需求到底能复用多少；
2. 候选和目标契约有哪些明确差异；
3. Translator 应按什么顺序实现，哪些地方不能照抄。

输入至少要包含：

- 目标方法签名、文档和待实现位置；
- 目标文件中所属类、字段、构造参数、已有 import/using；
- 必要的领域类型、依赖接口和调用方摘要；
- 用户需求及不可变约束；
- 检索候选的源码、签名、依赖、兼容性提示和风险信息。

Analyzer 输出结构化 `AnalysisReport`。建议第一版包含下面这些字段：

```ts
interface AnalysisReport {
  schemaVersion: '1.0';
  applicability: {
    level: 'direct' | 'adapt' | 'reference' | 'reject';
    confidence: number;
    reasons: string[];
  };
  behaviorMapping: Array<{
    requirement: string;
    status: 'covered' | 'partial' | 'missing' | 'conflict';
    candidateEvidence: string[];
    targetAction: string;
  }>;
  contractMapping: Array<{
    source: string;
    target: string;
    action: 'preserve' | 'rename' | 'convert' | 'inject' | 'replace';
    note: string;
  }>;
  dependencyPlan: Array<{
    sourceDependency: string;
    targetDependency?: string;
    action: 'reuse-existing' | 'adapt' | 'inline' | 'unresolved';
  }>;
  implementationPlan: string[];
  risks: string[];
  assumptions: string[];
  unresolved: string[];
  blockingIssues: string[];
}
```

这份报告有几条硬要求：

- 每个复用判断都要能指回输入中的代码或契约，不能凭空补事实；
- `partial` 和 `conflict` 不能被包装成“基本可用”；
- 目标需求里有、候选里没有的行为必须列入 `missing`；
- 目标项目不存在的依赖不能默认可用，要标成适配、内联或未解决；
- `implementationPlan` 只写本模块的落地顺序，不生成项目骨架和测试计划。

### 4.2 Translator Agent

Translator 只做实现，决策优先级固定为：

```text
目标不可变契约 > 功能需求 > AnalysisReport > 候选实现细节
```

也就是说，候选代码与目标签名冲突时，必须服从目标；候选只覆盖一半需求时，剩余部分应依据目标上下文补齐，而不是把候选原样翻过去。

第一版 Translator 需要做到：

- 消费完整 `AnalysisReport`，逐项执行 `implementationPlan`；
- 保持目标方法名、参数、返回值、可见性和异步约定；
- 优先使用目标工程已经存在的类型和依赖；
- 只修改目标模块需要填充的区域，不顺手改外围结构；
- 输出代码、接口映射、已完成步骤和未解决项；
- 当 Analyzer 给出 `reject`，或存在会导致错误实现的关键未解决项时，停止生成并返回明确原因；
- 预留接收 Validator 反馈的 repair 入口，但本阶段不自行生成或执行测试。

Analyzer 和 Translator 应是两次独立的模型调用，各自有单独的 system prompt 和输出约束，中间只通过可序列化报告交接。当前只有两步，没有必要先引入复杂的多 Agent 框架；由 `adaptation-adapter.ts` 顺序编排更容易调试，也方便后面替换模型。

## 5. 代码落点

计划中的主要改动控制在下面几个位置：

| 位置 | 计划改动 |
| --- | --- |
| `packages/contracts/src/adaptation.ts` | 增加分析请求、分析报告和翻译结果契约 |
| `services/adaptation-service/src/context-collector.ts` | 收集并裁剪目标模块上下文，避免把整个仓库塞给模型 |
| `services/adaptation-service/src/analyzer.ts` | Analyzer prompt、结构化输出解析和校验 |
| `services/adaptation-service/src/translator.ts` | 改为消费 `AnalysisReport`，保留必要的兼容入口 |
| `services/adaptation-service/src/adaptation-adapter.ts` | 编排 analyze → translate，并记录两阶段结果 |
| `services/adaptation-service/src/*.test.ts` | Agent 输出解析、异常分支和编排单元测试 |
| `services/adaptation-service/testdata/` | 固定的小规模输入与期望分析结论 |

模型访问、重试、超时和响应解析可以共用一个轻量客户端，但 Analyzer 与 Translator 的 prompt 不要揉成一个大文件。公共契约先定下来，再并行开发，能减少两边反复对字段。

为了兼容现有 Web 和 `CodeAdaptationPort`，第一轮可以继续返回现有 `AdaptationResult`，同时在服务内部保留 `AnalysisReport`。等前端或 Validator 明确需要展示分析过程，再通过可选字段或单独接口暴露，不要一开始就强推跨包改造。

## 6. 三人分工

暂时按角色分，确定成员后直接把姓名补到表里即可。

| 角色 | 主要工作 | 主要交付 |
| --- | --- | --- |
| 成员 A | 基线复现、契约定稿、两步编排、跨组接口、合并与最终验收 | 契约、adapter、集成记录、阶段总结 |
| 成员 B | Analyzer 和目标上下文收集 | `context-collector.ts`、`analyzer.ts`、分析样例与单测 |
| 成员 C | Translator 改造和 repair 接口预留 | `translator.ts`、翻译样例与单测 |

协作方式建议保持简单：

- 第 2 天前一起过一遍 `AnalysisReport`，定稿后再并行；
- Analyzer 的 PR 由 Translator 成员 A主审，重点看报告是否真能指导实现；
- Translator 的 PR 由 Analyzer 成员 A主审，重点看是否遗漏或违背报告；
- 成员 A每天处理接口冲突和集成，不长期占用某一个 Agent 的具体实现；
- 大改分开提交，契约、Analyzer、Translator、集成不要混在同一个 commit 里。

## 7. 十个工作日安排

### 第 1～2 天：基线和契约

- 跑通现有 `translate -> compile -> patch` 流程，记录模型、参数、输入、输出、耗时和结果；
- 从现有 Java 参考工程与 C# skeleton 中选出首批样例；
- 补充“完全对应、部分对应、签名不同、依赖不同、低相关、错误候选”六类小样例；
- 定稿 `AnalysisReport` 和 Translator 输入格式；
- 和 Validator 组确认反馈格式及交付时间。

阶段出口：同一输入可以重复跑基线，两个 Agent 的契约评审通过。

### 第 3～5 天：两个 Agent 并行实现

成员A：

- 完成公共契约和模型客户端的必要调整；
- 准备集成分支上的 adapter 骨架；
- 跟进 Validator 组的接口，及时处理字段分歧。

成员 B：

- 完成目标上下文收集；
- 完成 Analyzer prompt 和结构化解析；
- 覆盖 `direct / adapt / reference / reject` 四类判断；
- 为缺失行为、冲突契约和不存在依赖补单测。

成员 C：

- 把 Translator 输入改为候选代码 + 目标上下文 + `AnalysisReport`；
- 加入目标契约保护和输出清洗；
- 输出实际采用的映射、计划步骤和未解决项；
- 保留现有 Java → C# 调用方式，避免一次改坏 HTTP 链路。

阶段出口：两个 Agent 都能基于固定 fixture 单独运行，输出可解析且可断言。

### 第 6～8 天：集成和对比

- 串起 `analyze -> translate`；
- 对同一批样例分别跑旧流程和新流程；
- 重点检查目标签名保持、缺失行为补齐、错误依赖引入和无关改动；
- 修正报告字段过多、上下文过长或 Translator 不按计划执行的问题；
- 将输出交给 Validator 组试接一次。

阶段出口：所有固定样例能走完整链路，旧 HTTP 调用方不需要同步大改。

### 第 9～10 天：收口和交付

- 接入 Validator 组提供的首版反馈样例；
- 至少跑一轮真实候选，不只测手写的理想输入；
- 补齐 README、配置说明和故障排查；
- 整理新旧结果、遗留问题和下一轮建议；
- 三人交叉 review 后合并。

阶段出口：代码、固定样例、接口文档和对比记录齐全，可以独立交给下一组使用。

## 8. 基线样例和评价方法

仓库已有两份可以直接利用的材料：

- `services/adaptation-service/poc/` 中已有 5 类 Java → C# 翻译样例；
- `fixtures/code-corpus/forexplore-reference-java/` 与 `fixtures/target-system/forexplore-csharp-workspace/` 本身就不是严格一一对应，包含异步接口、类型结果、取消规则和存储端口差异。

首轮不追求大量数据，先选 8～12 组有代表性的目标—候选对。每组固定以下内容：

- 目标上下文和需求；
- 候选代码；
- 人工确认的可复用点、冲突点和缺失行为；
- 旧流程输出；
- 新流程的 `AnalysisReport` 和翻译输出；
- Validator 组返回的编译/行为结果。

对比时保持模型、temperature 和输入样例一致。模型输出有波动，关键样例建议重复 3 次，不用单次最好结果下结论。

本组先看下面几项：

| 指标 | 第一阶段要求 |
| --- | --- |
| 报告可解析率 | 固定样例全部通过 schema 校验 |
| 目标签名保持率 | 固定样例中不得擅改签名 |
| 行为差异识别 | 人工标注的缺失和冲突不能漏掉关键项 |
| 依赖处理 | 不得直接引入目标工程不存在的包或类型 |
| 修改范围 | 默认只改目标模块，额外改动必须在结果中说明 |
| 新旧对比 | 新流程不得降低编译通过率，行为通过率以 Validator 结果为准 |
| 成本与耗时 | 记录两次 Agent 调用的 token、耗时和失败重试次数 |

具体的行为通过率目标要等 Validator 的测试集稳定后再定。现在先保证数据可追踪、同条件可复跑，避免先写一个好看的百分比，最后无法解释。

## 9. 和 Validator 组的接口

跨组接口已经按下面的最小格式落到 `packages/contracts/src/adaptation.ts`。本组交付 `ValidatorHandoff`，Validator 组回传 `ValidatorFeedback`：

```ts
interface ValidatorFeedback {
  schemaVersion: '1.0';
  traceId: string;
  targetId: string;
  candidateId: string;
  verdict: 'pass' | 'fail' | 'blocked';
  checks: Array<{ label: string; status: 'pass' | 'warn'; detail: string }>;
  issues: Array<{
    code: string;
    severity: 'error' | 'warning';
    message: string;
    path?: string;
    line?: number;
    suggestedAction?: string;
  }>;
}
```

双方边界如下：

- 本组提供生成代码、目标信息、`AnalysisReport`、接口映射和 trace id；
- Validator 组负责测试生成/选择、执行、失败归类和最终通过判定；
- Validator 不直接改实现代码，只返回结构化问题；
- Translator 后续 repair 时只改报告指出的目标区域，不改测试来规避失败；
- 首版先支持一次反馈、一次修复，循环次数和停止条件在联调后再决定。

## 10. 主要风险

### 目标上下文不足

当前 `AdaptationRequest` 没有完整目标文件和调用关系。只扩 prompt 不补输入，Analyzer 仍然只能猜。第一优先级应是补一个可控的 context collector，并限制只读目标模块附近真正需要的内容。

### Analyzer 报告写得多，但 Translator 不执行

报告字段必须能在 Translator prompt 中逐项引用，翻译结果也要回报完成了哪些计划步骤。无法被消费的描述先不加，避免生成一份看起来完整、实际没有约束力的文档。

### 把低相关候选硬翻译

一定要保留 `reference` 和 `reject`。检索返回 Top K 不代表每个候选都值得翻译，错误候选能够及时停下来，本身也是正确结果。

### 两组重复做验证

本组只保留开发所需的单元测试和现有编译保护，不扩展测试生成器。行为测试、覆盖率和最终判定统一使用 Validator 组的结果。

### 两次模型调用带来成本和延迟

先记录基线，再看 Analyzer 报告是否能缓存。相同目标和候选在源码 hash 未变化时，可以直接复用报告；第一版不急着做复杂缓存，但契约里要保留稳定版本号。

## 11. 当前进度（2026-08-12，B/C 验收后）

- [x] 复核现有 5 个 POC 的基线记录；历史结果保存在 `services/adaptation-service/poc/output/result_20260718_180933.json`；
- [x] 定稿 `AnalysisReport v1`，增加 `blockingIssues` 区分普通未决项和翻译前阻断项；
- [x] 增加 `CodeAnalysisPort` 和独立的 `POST /v1/analyze`，分析调用不再要求翻译策略字段；
- [x] 串起 `analyze -> translate -> compile -> handoff`，并补上可注入的确定性集成测试；
- [x] 定稿 `ValidatorHandoff v1`、`ValidatorFeedback v1` 和 `TranslationRepairRequest`；
- [x] 迁移 ReCodeAgent 中适合本项目的只读 MCP 工具；
- [x] 验收 B 的目标上下文收集：补充字段、构造参数、相关成员、依赖类型、调用方、`REQ:` 约束和预算裁剪，并保留旧上下文字段兼容性；
- [x] 验收 C 的 Translator：补充单目标方法范围保护，并让编译修复继续携带 `AnalysisReport` 和目标上下文；
- [ ] 用相同模型参数重跑 5 个 POC 和真实候选。当前环境没有 `DEEPSEEK_API_KEY`，不能伪造新基线；
- [ ] Validator 组用实际反馈样例完成一次联调；
- [ ] 从现有 Java/C# fixture 中选定 8～12 组正式评测对并补人工标注。

## 12. MCP 迁移说明

本次对照的是 ReCodeAgent 提交 `cd20f3a893bcaef40c7f56ea1090ac7867ea17ea`（2026-08-07）。上游的 `project-analyzer` 提供 `get_directory_tree` 和 `get_file_structure`，语言服务器提供 `definition`、`references` 等工具。我们没有直接搬 Tree-sitter 和整套 LSP 运行时，而是在 TypeScript 服务里重写了翻译阶段真正需要的只读子集：

- 保留上游四个工具名和必需参数，方便已有 prompt 迁移；
- 增加 `read_file` 和 `get_target_context`，让 Analyzer 能读取受控上下文；
- 支持 Java、C#、TypeScript/JavaScript、Python、Go、C 和 Rust 的轻量结构提取；
- 所有文件访问限制在配置的项目根目录，包含符号链接越界检查；
- 目录、文件、引用和定义都有上限，避免一次 MCP 调用把整个仓库送进模型；
- stdio 服务按 MCP JSON-RPC 握手工作，协商版本覆盖 `2026-07-28` 到 `2024-11-05`；
- 不迁移编辑、重命名、诊断和测试执行工具。这些能力会扩大写权限，也和 Translator、Validator 的职责重叠。

这不是完整 LSP 的替代品。`definition` 和 `references` 目前按源码符号做有界检索，对重载、动态绑定和跨语言生成代码只提供候选上下文，Analyzer 不能把它当作编译器级事实。
