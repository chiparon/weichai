# 企业历史系统数据集与基线对比

本次基于上游 `chiparon/weichai` 的 `05f2806fae25d9c1ee5f5bbdbffc65c79876ea45` 实现。
目标是让参考工程构成可执行的内部业务系统，检索任务必须考虑跨仓库契约、权限、事务和版本兼容。
这是第一版合成试验集，不是真实潍柴内部系统或生产数据；没有复制 Apache 实现，也不以 Apache 官方库名发布。

## 数据集形态

生成器：[`experiments/enterprise-history`](../experiments/enterprise-history/)。
默认输出在被 git 忽略的 `results/enterprise-history`；生成代码、任务和测量结果均可复现。

| 历史仓库 | 业务职责 | 关联 |
| --- | --- | --- |
| business-contracts | 租户、资产、附件、整数金额契约 | 被权限、文档、资产、财务使用 |
| identity-access | 租户与角色联合授权 | 上传、索赔、质检、维保共用 |
| document-center | 附件上传、格式/限额校验、扫描隔离 | 三条业务链共用已放行凭证 |
| asset-registry | 发动机质保和运行时数、备件库存 | 索赔与维保使用不同规则 |
| finance-ledger | 租户内幂等入账、供应商扣款 | 索赔赔付和质检扣款共用账本协议 |
| audit-trail | 幂等发件箱、确认后标记投递 | 业务操作必须保留凭证摘要 |
| case-services | 质保索赔、质量不合格单、维保工单 | 调用上述仓库的真实函数 |
| operations-portal | 业务入口、账本与发件箱共同提交 | 编排工单和事务 |

核心集含 **8 个仓库、20 个非空实现文件、25 条内部 import 关系**，另有空包初始化文件。
每个仓库均有 manifest，可通过工作台 `--corpus` 一起注册；集成测试通过各仓库的 `src` 路径导入它们。
当前全部使用 Python，便于无外部服务验证业务。已有跨语言 FileUpload 语料仍保留，尚未接入这三条业务链。

真实关联包括：同一资产归属、同一附件扫描状态、同一租户/工单/用途幂等键、整数分计价和事件证据摘要。
门户以写时复制模拟账本和事件同时提交，明确假设串行请求；没有声称实现分布式 ACID、消息中间件或真正的病毒扫描。
文档中心接收文件字节并检查签名、文件名和大小，不是完整 HTTP multipart/FileUpload 实现。

`--git-history` 生成 8 个独立 Git 仓库，每仓两个带标签的提交：

- `synthetic-v1`：内网角色校验、排除保修最后一天的旧逻辑。
- `synthetic-v2`：增加租户隔离、修正保修期限边界。

提交身份和时间均为明确标记的合成信息。除身份和资产仓库外，其余仓库第二次提交为空，表示同步发布，不能算独立演化案例。
索引仅使用 v2 工作树；v1 不混入当前正例。另保留 `legacy_upload`、`legacy_posting` 和员工报销等困难负例，检索器必须区分相似名称与兼容契约。

## 任务、隔离和指标

12 个任务族各有中英文查询，共 24 题：3 族 dev、9 族 test。
同族语言变体保持同一 split，结果按语言分别报告。dev/test 共用历史代码，**不是仓库级留出或独立企业泛化评测**。
没有使用 test 分数调整检索参数。业务场景和标注由模型编写，仍需业务专家复核。

标注位于 `evaluation/tasks.json`，包含主实现、所需依赖与分级相关性；不放进候选仓库。
候选只读取 manifest 声明的源文件。生成器记录 SHA-256，评测前核验源码、标注与从 AST 重建的 import 图。
标注是显式编写的，图扩展不读取标注，也不把业务测试或目标答案加入检索库。

统一预算：Top-10、最多 10 个源文件、240 行源代码。基线以完整文件为候选，RECAST 使用函数检索和实际返回的源码片段，因粒度差异不能把分数直接解释为算法优劣。

| 指标 | 定义 |
| --- | --- |
| Recall@10 | 命中的不同相关文件 / 全部相关文件 |
| Primary MRR | 第一个主实现所在文件的倒数排名 |
| nDCG@10 | 主实现相关性 3、必需依赖 2，去重后计算 |
| Evidence coverage | 已完整交付的必需文件比例 |
| Evidence complete | 本题所有必需文件均完整交付 |
| Source lines、latency | 实际交付行数和实测检索耗时 |

完整文件证据包括 import、契约与实现，RECAST 只有函数体时不会被算作完整文件。
空结果与异常保留在分母中。`evidenceComplete` 不是编译成功率或业务通过率。
业务行为另由 18 项企业断言校验；5 项 harness 测试验证版本、可复现性、指标和覆盖保护。
`evaluate:guochuang` 的原生 MRR 是任意相关项首命中，本套 Primary MRR 是主实现首命中，两种报告不要混列。

## 已完成的对比

1. Empty-context：检索空上下文对照，未调用模型生成代码。
2. Random：按查询哈希固定随机顺序。
3. TF-IDF cosine：词法向量，不是模型语义向量。
4. BM25：固定 `k1=1.2, b=0.75`。
5. BM25 + local imports：前两个词法种子，最多两跳，仅保留仓库内 import。
6. BM25 + cross imports：同一策略，允许跨仓库 import；通过完整源码静态解析精确模块名。
7. RECAST memory lexical：实际 Tree-sitter 索引、RecallKernel、TaskRetrievalService 和上下文编译，使用 `InMemoryIndexStore` 的词法检索；关闭查询扩展及重排。

第 5/6 项只改变跨仓库边的保留方式，候选池、查询、预算一致。图基线的全局 Python 模块名解析是额外工程能力，不能把第 6 项称作当前 RECAST 产品结果。

实测结果保存在 [`enterprise-history-results.json`](../experiments/enterprise-history/enterprise-history-results.json)，包含逐题结果、运行参数、数据哈希、实现文件哈希和环境版本。
英语 test 共 9 题，以下为核心集结果：

| 方法 | Recall@10 | Primary MRR | 完整证据题数 |
| --- | ---: | ---: | ---: |
| TF-IDF | 0.826 | 0.861 | 4/9 |
| BM25 | 0.826 | 0.944 | 4/9 |
| BM25 + 仓内 import | 0.848 | 0.944 | 5/9 |
| BM25 + 跨仓 import | 1.000 | 0.944 | 9/9 |
| RECAST 内存词法 | 0.730 | 0.347 | 0/9 |

中文 test：BM25 完整证据 0/9，跨仓 import 1/9，RECAST 内存词法 0/9。
英语源码与中文需求之间缺少语义编码；少量数字匹配不能代表中文理解能力。

扩容集在每仓增加 125 个只读历史报表模板，共 **1,020 个实现文件**；这是容量/干扰压力测试，新增 1,000 文件没有新增独立业务场景。
同样 9 道英文测试题，BM25 完整证据 5/9，跨仓 import 9/9；RECAST Recall@10 降至约 0.452，完整证据仍为 0/9。
核心集与扩容集 RECAST 各完成 24 次请求，均无运行异常；不能把“请求成功”写成“任务完成”。

RECAST 索引报告的 31 条依赖均未解析为具体目标（包含标准库依赖），而数据集 AST 中有 25 条可确定的内部 import。
这为后续跨仓库包映射和证据补全提供可复现输入。不能仅凭本集断言所有语言都存在相同问题。
完整文件标准也会压低函数片段系统的覆盖得分，后续应由专家补充“足够证据”的最小行范围，保留本次严格指标用于纵向对比。

23 项测试通过；行为验收对参考门户 18/18 通过，对目标空实现正确失败（13 项错误）。
这证明验收能拒绝空实现，不代表模型已经完成迁移。

## 复现

### 一键打开 VS Code 扩展

双击仓库根目录的 [`start-enterprise-extension.cmd`](../start-enterprise-extension.cmd)。脚本自动定位本工作区、按需安装依赖和生成数据集、构建扩展，再打开配置好目标工程与 8 个参考仓库的 VS Code 扩展开发宿主。已有 workspace 配置会保留。

也可以在本仓库根目录运行 `npm run dev:extension:enterprise`。
已有构建时传 `-- -SkipBuild`，选择扩容集时传 `-- -Dataset results/enterprise-history-scale`。
在可信工作区打开 RECAST 后，扩展自动启动打包的 adaptation 模型后端，面板保存的模型配置同时用于分析、重排与翻译。SeekDB 与 embedding 仍需单独配置；开发模式可用内存索引。启动器不会套用旧 Java FileUpload 脚本的数据库和翻译目标。详见 [插件后端与跨仓修复说明](extension-backend-and-evidence.zh-CN.md)。

在仓库根目录运行；需要 Python 3.10+、Node/npm，生成历史还需 Git。

```powershell
npm ci --ignore-scripts
npm run test:enterprise
npm run dataset:enterprise
npm run evaluate:enterprise:recast
python experiments/enterprise-history/benchmark.py --packets results/enterprise-history/evaluation/recast-memory.json --output results/enterprise-history/evaluation/comparison.json
```

生成器拒绝覆盖非空目录。重跑请通过 `--output` 选一个新目录，并给评测脚本传相同的 `--dataset`。
RECAST 完整 ContextPacket 保存在对应 `evaluation/recast-memory-packets`，可逐题核验源范围、哈希和检索缺口。

```powershell
python experiments/enterprise-history/build.py --output results/enterprise-history-scale --noise-per-repo 125
npm run evaluate:enterprise:recast -- --dataset results/enterprise-history-scale
python experiments/enterprise-history/benchmark.py --dataset results/enterprise-history-scale --repeats 3 --packets results/enterprise-history-scale/evaluation/recast-memory.json --output results/enterprise-history-scale/evaluation/comparison.json
python experiments/enterprise-history/summarize.py --datasets results/enterprise-history results/enterprise-history-scale --output experiments/enterprise-history/enterprise-history-results.json
```

验收可信的迁移候选（会执行候选 Python 代码）：

```powershell
python experiments/enterprise-history/acceptance.py --target results/enterprise-history/repositories/operations-portal/src/erp_portal/gateway.py
python experiments/enterprise-history/acceptance.py
```

第一条用参考实现验证验收链路；第二条检查尚未实现的目标，预期非零退出。模型写出候选后传其文件路径即可复用相同验收。
其中 13 项断言直接经过迁移入口，其他 5 项验证环境和支持服务。

接入生产工作台（先按主 README 配好 SeekDB、embedding 和 adaptation）：

```powershell
npm run dev:code-workbench -- --target results/enterprise-history/target --corpus results/enterprise-history/repositories --adaptation-url http://127.0.0.1:8788
```

复制生成的 `evaluation/bindings.example.json`，填写**这次持久化索引**的实际 repositoryId 和 ready analysisRevision，然后导出原生评测任务：

```powershell
python experiments/enterprise-history/benchmark.py --bindings results/enterprise-history/evaluation/bindings.seekdb.json --output results/enterprise-history/evaluation/recast-tasks.json
npm run evaluate:guochuang -- --tasks results/enterprise-history/evaluation/recast-tasks.json --url http://127.0.0.1:4041 --output results/enterprise-history/evaluation/seekdb-report.json
```

不要使用本次内存运行的 `bindings.memory.json` 请求重启后的服务；内存 revision 不会持久化。
当前 RECAST 请求最多允许 8 个 scope，因此本集采用 8 个仓库。更多仓库需要显式的检索范围路由或修改产品限制，不能悄悄截断候选。

## 后续大规模实验的边界

本次已完成数据生成、真实业务关联、历史版本、检索对照、压力运行及行为验收入口。
尚未执行生产 SeekDB + 模型 embedding/reranker，以及固定同一模型的“直接生成 / 独立库检索 / 关联历史检索”代码生成三组实验；当时没有运行中的相关本地服务。
这些条件应锁定模型版本、token/工具预算、重复次数和目标验收，分别报告通过率、修复轮次、延迟、费用与失败原因。
不能用本次 Empty-context 对照冒充“模型直接生成”的结果。

扩大业务规模应增加独立编写、专家审核的流程，例如采购收货—检验—退货—发票核销，或维保工单—备件占用—库存回补。
每个流程必须通过集成测试制造真实的调用、事件或数据约束，并加入过期接口和相似业务负例；多个语言翻译本和模板副本只能计作同一个任务族。
引入真实开源仓库时记录许可证、URL、固定提交和本地修改，保持原项目身份；业务适配层与开源来源分开记录。
后续按整个企业/仓库族/演化谱系划分 train/dev/test，增加独立标注和最小证据范围，才能用于泛化与企业落地结论。
