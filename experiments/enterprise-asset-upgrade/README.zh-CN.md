# 企业混合代码资产升级数据集

这个数据集模拟企业已有的多语言代码资产池，以及基于资产池开发新的 C# 模块。

历史资产保持仓库边界，不要求这些开源项目组成一个可整体启动的应用。每个仓库独立保留来源、许可证、commit 和构建信息；数据集额外维护跨项目的能力映射，用于构造“找到并组合已有资产”的任务。

## 当前首批资产

资产清单见 [`asset-sources.json`](./asset-sources.json)。首批包含：

- Apache Camel：企业集成和路由；
- Flowable：工作流和状态编排；
- Keycloak：身份、角色和租户边界；
- BullMQ：队列、重试和延迟任务；
- APScheduler：周期任务和失败恢复；
- nopCommerce：C# 业务域和插件结构；
- Apache Commons FileUpload：文件上传与输入校验。

这些仓库的本地源码位于 `source-repositories/`，该目录由仓库根目录的 `.gitignore` 忽略，不会进入项目提交。下载后运行冻结脚本生成 `asset-manifest.json`，记录每个仓库的 commit、源码文件、语言统计、代码行数和许可证文件；需要时可额外生成逐文件哈希。

当前本地冻结结果为 7 个仓库、约 249 万行源码、约 1.9 万个源码文件。原始仓库保存在被忽略的 `source-repositories/` 目录；脚本使用浅克隆和稀疏检出，只展开任务相关目录，Git 对象仍保留在各仓库中。

重新下载或在另一台机器复现：

```bash
python3 experiments/enterprise-asset-upgrade/materialize.py --depth 1
```

需要更强的逐文件校验时再加 `--file-hashes`；挂载盘上该选项会明显增加耗时。

## 目标工程

`target-project/` 是一个独立的待开发 .NET 8 模块。它只包含接口、数据模型、调用骨架、需求和公开测试；核心实现由实验条件中的 Agent 完成。隐藏测试只在评测环境中保存。

目标模块围绕 `AssetUpgradeGateway`，组合租户校验、附件隔离、工作流投递、队列重试、周期补偿和审计幂等等企业约束。

## 数据集原则

1. 历史仓库使用固定 release 或 commit，不能随运行自动更新。
2. 目标任务不直接复制历史仓库的类名、包名或 README 需求。
3. 每个任务必须列出历史资产覆盖矩阵和可执行验收条件。
4. 目标工程和历史工程分开冻结，避免把目标实现泄漏进历史资产。
5. 开源许可证和 NOTICE 文件随来源仓库保留。

任务清单和验收条件见 [`tasks/task-manifest.json`](./tasks/task-manifest.json)，历史资产到目标需求的覆盖关系见 [`tasks/coverage-matrix.json`](./tasks/coverage-matrix.json)，跨仓库能力关系见 [`relations.json`](./relations.json)。
