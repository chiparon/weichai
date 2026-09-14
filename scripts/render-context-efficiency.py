import argparse
import csv
import json
import math
import os
from pathlib import Path
from statistics import mean

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager


def read_run(report_path, variant, label):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    observations = [
        row for row in report["observations"]
        if row["variant"] == variant and row["budget"] is None
    ]
    assert observations and all(row["status"] == "ok" for row in observations)
    tasks = {}
    repeats = {}
    compilation = []
    recall = []
    packets = {}
    request_budget = None
    for row in observations:
        raw = json.loads((report_path.parent / (row["taskId"] + ".json")).read_text(encoding="utf-8"))
        request = raw["task"]["request"]
        task = {key: request[key] for key in ("requirement", "granularity", "scopes")}
        assert tasks.setdefault(row["baseTask"], task) == task
        repetitions = repeats.setdefault(row["baseTask"], set())
        assert row["repeat"] not in repetitions
        repetitions.add(row["repeat"])
        if request_budget is None:
            request_budget = request["budget"]
        assert request_budget == request["budget"]
        assert all(key not in request_budget for key in ("maxTokens", "maxFiles", "maxSourceLines"))
        compilation.append(raw["packet"]["usage"]["retrieval"]["stages"]["compilationMs"])
        recall.append(raw["packet"]["usage"]["retrieval"]["stages"]["recallMs"])
        packets[(row["baseTask"], row["repeat"])] = {
            key: value for key, value in raw["packet"].items()
            if key not in ("packetId", "requestId", "usage")
        }
        assert math.isfinite(row["latencyMs"]) and row["latencyMs"] > 0
    assert len(tasks) == report["metadata"]["taskCount"]
    assert all(value == set(range(report["metadata"]["repeats"])) for value in repeats.values())
    result = {
        "label": label,
        "variant": variant,
        "source": str(report_path),
        "startedAt": report["metadata"]["startedAt"],
        "commit": report["metadata"]["commit"],
        "requestBudget": request_budget,
        "tasks": len(tasks),
        "repeats": report["metadata"]["repeats"],
        "requests": len(observations),
        "errors": 0,
        "meanResponseMs": mean(row["latencyMs"] for row in observations),
        "meanContextConstructionMs": mean(compilation),
        "meanRecallMs": mean(recall),
    }
    return result, tasks, report["metadata"], packets


parser = argparse.ArgumentParser(description="Render measured context retrieval efficiency for presentation.")
parser.add_argument("--report", type=Path, default=Path("logs/experiments/retrieval-strategies-20260909-run1/report.json"))
parser.add_argument("--output", type=Path, default=Path("experiments/guochuang-pilot/strategy-efficiency-demo"))
parser.add_argument("--font", type=Path, default=Path("/mnt/c/Windows/Fonts/msyh.ttc"))
args = parser.parse_args()

before, before_tasks, before_metadata, before_packets = read_run(args.report, "serial-hybrid", "朴素串行混合检索")
after, after_tasks, after_metadata, after_packets = read_run(args.report, "full", "RECAST 并行混合检索")
reference, reference_tasks, _, _ = read_run(args.report, "vector-topk", "向量 Top-K 片段检索")
assert before_tasks == after_tasks, "Compared runs must use the same queries and snapshots."
assert before_tasks == reference_tasks
assert before_packets == after_packets, "Serial and parallel variants must return identical context content."
assert before["repeats"] == after["repeats"]
assert before["requestBudget"] == after["requestBudget"] == reference["requestBudget"]
for key in ("database", "embedding", "vectorConfiguration", "cpu", "node", "cache"):
    assert before_metadata[key] == after_metadata[key], f"Inconsistent runtime or index: {key}"

speedup = before["meanResponseMs"] / after["meanResponseMs"]
reduction = 100 * (1 - after["meanResponseMs"] / before["meanResponseMs"])
output = args.output
output.mkdir(parents=True, exist_ok=True)
report = {
    "metric": "Mean HTTP response time, including retrieval and context construction.",
    "comparison": "Interleaved serial and parallel hybrid recall with identical queries, snapshots, caches, candidate limits and context construction. No content limits. Returned context content is verified equal for every paired request.",
    "before": before,
    "after": after,
    "reference": reference,
    "identicalContextPairs": len(before_packets),
    "speedup": speedup,
    "latencyReductionPercent": reduction,
}
(output / "efficiency.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
with (output / "efficiency.csv").open("w", encoding="utf-8-sig", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["检索策略", "平均响应时间_ms", "平均召回时间_ms", "平均Context构建时间_ms", "任务数", "重复次数", "请求数", "请求错误"])
    for row in (before, after, reference):
        writer.writerow([row["label"], round(row["meanResponseMs"], 3), round(row["meanRecallMs"], 3), round(row["meanContextConstructionMs"], 3),
                         row["tasks"], row["repeats"], row["requests"], row["errors"]])

font_manager.fontManager.addfont(str(args.font))
font_name = font_manager.FontProperties(fname=str(args.font)).get_name()
plt.rcParams.update({"font.family": font_name, "axes.unicode_minus": False, "pdf.fonttype": 42, "svg.fonttype": "path"})
fig = plt.figure(figsize=(12.8, 7.2), facecolor="white")
fig.text(0.09, 0.90, "检索并行化效率", fontsize=26, color="#20252b", weight="bold")
fig.text(0.09, 0.84, "平均响应时间", fontsize=15, color="#59636e")
fig.text(0.91, 0.895, f"响应时间缩短 {reduction:.1f}%", fontsize=24, color="#16836b", ha="right", weight="bold")
fig.text(0.91, 0.84, "相同候选与上下文输出", fontsize=14, color="#59636e", ha="right")

ax = fig.add_axes([0.29, 0.30, 0.60, 0.45])
values = [before["meanResponseMs"], after["meanResponseMs"]]
ax.barh([1, 0], values, height=0.40, color=["#75849a", "#16836b"], zorder=3)
ax.set_yticks([1, 0], [before["label"], after["label"]], fontsize=15, color="#303840")
step = 50 if max(values) < 400 else 250
upper = math.ceil(max(values) * 1.18 / step) * step
ax.set_xlim(0, upper)
ax.set_ylim(-0.65, 1.65)
ax.set_xticks(range(0, upper + 1, step))
ax.set_xlabel("平均响应时间（ms）", fontsize=12, color="#59636e", labelpad=12)
ax.tick_params(axis="both", length=0, pad=12, labelcolor="#59636e")
ax.grid(axis="x", color="#e8ecef", linewidth=0.8, zorder=0)
for spine in ax.spines.values():
    spine.set_visible(False)
for y, value in zip([1, 0], values):
    ax.text(value + upper * 0.025, y, f"{value:,.0f} ms", va="center", fontsize=19, color="#20252b", weight="bold")

fig.text(0.09, 0.14, f"{before['tasks']} 个 Java / TypeScript 函数定位任务，每组重复 {before['repeats']} 次；预热后测量。", fontsize=11, color="#59636e")
fig.text(0.09, 0.095, "同一索引、模型与硬件，交替运行；统计从提交查询到返回 Context 的完整响应时间。", fontsize=10, color="#59636e")
fig.text(0.09, 0.05, "两组均不设内容上限；声明、正文和摘要通道分别串行或并行执行。", fontsize=10, color="#59636e")
for suffix in ("png", "svg", "pdf"):
    fig.savefig(output / ("context-efficiency." + suffix), dpi=200, facecolor="white")
plt.close(fig)

report_link = os.path.relpath(args.report, output)
text = f"""# 检索策略与响应效率展示

采用朴素串行混合检索作为效率基线，依次查询声明、源码正文与模块摘要，再完成候选融合及上下文构建。RECAST 将三个独立召回通道并行执行，候选范围、融合方式与上下文构建逻辑保持一致。

在同一批 {before['tasks']} 个 Java / TypeScript 函数定位任务上，每组重复 {before['repeats']} 次，平均完整响应时间由 **{before['meanResponseMs']:,.0f} ms** 降至 **{after['meanResponseMs']:,.0f} ms**，缩短 **{reduction:.1f}%**。两组返回的候选、源码、声明与关系内容逐次核对一致。

| 指标 | 朴素串行混合检索 | RECAST 并行混合检索 |
| --- | --- | --- |
| 平均响应时间，含检索与 Context 构建 | {before['meanResponseMs']:,.0f} ms | {after['meanResponseMs']:,.0f} ms |

![检索响应效率](context-efficiency.png)

## 图表与数据

- [PNG 展示图](context-efficiency.png)
- [SVG 矢量图](context-efficiency.svg)
- [PDF 矢量图](context-efficiency.pdf)
- [CSV 数据表](efficiency.csv)
- [精确数值与来源](efficiency.json)

## 统计口径

三组策略使用相同查询、索引快照、E5 模型与硬件，在同一轮实验中轮换执行顺序。均不设置 Token、文件数或源码行数上限，请求时限均为 10 秒。每组 {before['tasks']} 题、每题重复 {before['repeats']} 次，共 {before['requests']} 次请求，全部纳入统计，均无请求错误。

响应时间从本地 HTTP 提交查询开始，到接收完整 Context 响应结束，包含检索、源码读取与上下文构建。每题预热一次，预热、建库、模型加载及后续代码生成不计入该指标。

串行组保留与当前方案相同的查询向量缓存，每个通道内部仍采用全文与向量融合。两组只改变声明、正文及摘要三个通道的执行顺序。平均召回阶段耗时由 {before['meanRecallMs']:,.0f} ms 降至 {after['meanRecallMs']:,.0f} ms。

## 向量 Top-K 参考组

另外运行单通道向量检索，直接返回相似度最高的 10 个已有源码片段，采用相同 E5 与 HNSW 索引，不补充完整声明、模块或依赖。其平均响应时间为 **{reference['meanResponseMs']:,.0f} ms**，比完整 Context 流程更短。

这组参考说明单纯片段检索的开销；上图的 {reduction:.1f}% 改善仅对应输出一致的串行与并行混合检索。原来的 870 ms 与 168 ms 来自历史配置对照，不作为朴素检索策略的测试结果。

## 来源与复现

- [本轮原始报告]({report_link})，主对照为 `serial-hybrid` 与 `full`，参考组为 `vector-topk`，均为 `budget=null`。

图表脚本核对任务、快照、环境、重复次数及全部原始响应，并对 {len(before_packets)} 对串行与并行输出执行内容相等断言后计算指标。

启动已有 SeekDB 和本地 E5 服务后运行：

```bash
node --import tsx scripts/run-guochuang-pilot.mts --budgets none --variants vector-topk,serial-hybrid,full --repeats 5
```

在安装了 Matplotlib 3.10.6 并可访问中文字体的 Python 环境中，从仓库根目录执行：

```bash
python scripts/render-context-efficiency.py --report logs/experiments/retrieval-strategies-20260909-run1/report.json --font /mnt/c/Windows/Fonts/msyh.ttc
```
"""
(output / "README.zh-CN.md").write_text(text, encoding="utf-8")
print(json.dumps({"output": str(output), "beforeMs": before["meanResponseMs"], "afterMs": after["meanResponseMs"],
                  "speedup": speedup, "reductionPercent": reduction}, ensure_ascii=False))
