# Context 构建调整与简单验证

2026-09-09，分支 `codex/guochuang-ui`。当前实现基于 `e1c1adb` 的本地修改，实验目录保存了对应的 `implementation.patch`。

最新四组对照已完成：12 题、144 次请求，比较 8k / 不设内容上限及开启 / 关闭依赖扩展。见 [2026-09-09 晚间实测结果](../../logs/experiments/context-ablation-20260909-run1/summary.zh-CN.md)。下文保留此前调整说明与历史对照。

## 本次调整

- 默认取消 Token、文件数和源码行数裁剪。前端宿主只传入 30 秒超时；HTTP/MCP 使用 `budget: {}` 时保留全部已选内容。调用方仍可显式设置内容上限，也可设置超过 32,000 的 Token 窗口。
- 核心函数、方法按索引中的完整声明范围读取。每次最多读取 32,000 字符，长声明继续分页拼接，保留真实来源位置和内容校验。
- 上下文按核心实现、类型定义、辅助实现、构建配置分组。核心实现先交付；重复或被完整包含的源码只保留一份；已交付且未变化的证据可省略。
- 依赖扩展以具体符号为起点，沿已有调用关系继续查找，并通过访问记录终止循环。辅助类及接口单独输出索引中的声明和成员签名，不再默认交付整个类的实现。
- 声明信息位于 `ContextPacket.declarations`，与真实源码 `evidence` 区分。MCP 校验其版本和来源；现有翻译交接会将声明带入上下文说明。
- 缺少调用关系、目标符号未解析、局部查询未取全等情况写入 `gaps`。当前保留单次局部查询 200 条、调用扩展 200 个实现节点及超时边界，触及时报告缺口。

这版以函数任务为验证对象。模块检索仍使用代表实现策略。当前基础索引对部分语言只提供导入和导出关系；新增遍历能够使用已有调用边，不会自行推断缺失的调用图。

## 三个简单指标

复用上一轮固定的 Java、TypeScript 仓库和 E5 索引。12 个源码定位任务，每种配置重复 3 次，最终版本共执行 72 次请求。每题只有一个目标实现，覆盖率按标注的源码行范围计算，类型签名不算完整实现。查询预热后串行执行，并轮换配置顺序。

| 配置 | 目标源码完整覆盖 | 平均上下文 | 平均耗时 |
| --- | --- | --- | --- |
| 旧版默认 4k，历史记录 | 3 / 12，25.0% | 3,829 Token | 870 ms |
| 旧版 8k，历史记录 | 8 / 12，66.7% | 7,167 Token | 927 ms |
| 新版 8k，本次运行 | 7 / 12，58.3% | 6,365 Token | 980 ms |
| 新版默认，不裁剪 | 7 / 12，58.3% | 10,201 Token | 156 ms |

本次两组均为零请求错误。检索结果仍命中 7 / 12 题，新版完整交付了这 7 题的目标源码。其余 5 题需要改进召回与排序。

旧版 8k 额外覆盖的题目是 `ts-charset`：虽然主要结果未命中 `DiskFileItem.getCharSet`，返回的整个 `DiskFileItem` 类包含了该方法。新版将辅助类改为声明信息，该方法没有随之交付，因此总源码覆盖少了一题。这项问题仍保留在结果中。

新版两组使用相同实现、相同索引及相同请求时限。8k 组平均上下文编译耗时约 844 ms，不裁剪组约 28 ms，主要差异来自预算检查时的反复编码。旧版数据来自前一次运行，用于对照此前行为。

这 12 题覆盖 6 类功能在两种语言中的实现，属于小样例验证。本轮没有评测完整任务依赖或 Coding Agent 的开发成功率。

## 可查看的结果

- [最终实验报告](../../logs/experiments/context-construction-20260909-run2/report.json)
- [简表](../../logs/experiments/context-construction-20260909-run2/summary.md)
- [CSV](../../logs/experiments/context-construction-20260909-run2/summary.csv)
- [TypeScript 解码任务上下文](../../logs/experiments/context-construction-20260909-run2/ts-quoted-printable-full-none.md)
- [Java 临时文件清理任务上下文](../../logs/experiments/context-construction-20260909-run2/java-cleanup-full-none.md)
- [对应实现补丁](../../logs/experiments/context-construction-20260909-run2/implementation.patch)

逐题 JSON 同时保存查询、标签、原始响应和结果。`run1` 保留首次试跑，`run2` 对应最终代码。

## 复现

启动已有 SeekDB 与固定版本的本地 E5 服务后执行：

```bash
node --import tsx scripts/run-guochuang-pilot.mts --budgets 8000,none --variants full --repeats 3
```

最简单的默认请求只设置时限：

```json
{
  "budget": { "maxLatencyMs": 30000 }
}
```

显式限制场景可以使用 `"maxTokens": 128000`。未设置上限时，响应中的 `usage.maxTokens` 为 `null`，`usage.tokens` 始终为实际输出 Markdown 的 Token 数。

## 运行检查

代码智能服务回归、最终定向用例、MCP、前端宿主和源码交接测试通过，相关 TypeScript 检查通过。新增用例覆盖长函数分页读取、大上下文、显式小预算的回退、跨文件循环调用、导入与调用关系优先级及声明来源校验。调用链用例使用明确标注的关系夹具，验证遍历逻辑；本轮真实索引实验不将这些夹具计入指标。
