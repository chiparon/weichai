# Baseline results

运行 `scripts/run-enterprise-asset-upgrade-baseline.sh` 会在这里创建一个独立的
`baseline-<UTC时间>/` 目录。每次运行包含：

- `target-project/`：Agent 实际编辑的副本，作为 baseline 结果代码；
- `requirements/`：本次运行读取的需求副本；
- `task-prompt.md`：发送给 Coding Agent 的提示词；
- `agent-stream.jsonl`：Agent 的完整输出日志；
- `run-manifest.json`、`run-result.json`：模型、隔离边界和退出状态。
- `hidden-evaluation.json`、`hidden-evaluation.log`：Agent 退出后由工作区外
  的独立验收器生成的逐条件结果和质量分数。

脚本只复制 `target-project/` 和需求文件，不复制或注册
`source-repositories/` 历史资产。baseline 只调用一个 Coding Agent，使用
当前 Coding Agent 的默认模型参数，不进入 RECAST 的检索、分析、翻译和验证链路。
结果目录默认被 Git 忽略。

```bash
bash scripts/run-enterprise-asset-upgrade-baseline.sh
```

使用 `--prompt-file FILE` 可替换任务提示词，使用 `--run-id NAME` 可固定结果目录名。
设置 `BASELINE_DRY_RUN=1` 只验证复制和 manifest 生成，不启动 Agent。
