# 检索响应效率展示

本页保留历史配置对照。检索策略展示已改为 [串行与并行混合检索实测](../strategy-efficiency-demo/README.zh-CN.md)，本页数值不代表朴素检索基线。

在同一批 12 个 Java / TypeScript 函数定位任务上，平均检索与上下文构建响应时间由 **870 ms** 降至 **168 ms**，缩短 **80.7%**，约 **5.2 倍加速**。

| 指标 | 旧版（4k 配置） | 新版（默认配置） |
| --- | --- | --- |
| 平均响应时间，含检索与 Context 构建 | 870 ms | 168 ms |

![检索响应效率](context-efficiency.png)

## 图表与数据

- [PNG 展示图](context-efficiency.png)
- [SVG 矢量图](context-efficiency.svg)
- [PDF 矢量图](context-efficiency.pdf)
- [CSV 数据表](efficiency.csv)
- [精确数值与来源](efficiency.json)

## 统计口径

使用已经完成的两轮实测记录，同一批查询、索引快照、E5 模型和硬件；两轮在不同时间运行。旧版为 4,000 Token、20 个文件、1,200 行源码上限，新版默认不设这些内容上限，均使用 10 秒请求时限。每组 12 题、每题重复 3 次，共 36 次请求，全部纳入统计，均无请求错误。

响应时间从本地 HTTP 提交查询开始，到接收完整 Context 响应结束，包含检索、源码读取与上下文构建。每题预热一次，预热、建库、模型加载及后续代码生成不计入该指标。

这是配置与实现升级后的整体效率对比。分阶段记录中，平均 Context 构建耗时由 715 ms 降至 29 ms，是整体耗时下降的主要来源。

## 来源与复现

- [旧版原始报告](../../../logs/experiments/guochuang-pilot-20260909-run1/report-source-range.json)，选择 `variant=full, budget=4000`。
- [新版原始报告](../../../logs/experiments/context-ablation-20260909-run1/report.json)，选择 `variant=full, budget=null`。

图表脚本核对两组的任务、快照、环境、重复次数及全部原始响应后计算指标，不修改查询或原始结果。

在安装了 Matplotlib 3.10.6 并可访问中文字体的 Python 环境中，从仓库根目录执行：

```bash
python scripts/render-context-efficiency.py --font /mnt/c/Windows/Fonts/msyh.ttc
```
