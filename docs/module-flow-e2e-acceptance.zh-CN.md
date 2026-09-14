# 模块级全流程端到端验收（导入 → 检索 → Top1 → 翻译 → 回填 → 上游测试）

**结论**：在**全语料（1 个目标仓 + 17 个参考仓，全部完成模块建模）**上，模块级检索 → 自动选 Top1 →
模块作用域翻译 → 回填目标工作区 → 独立复跑 Apache 原始测试套件，**两波跑通，53/53 通过**。

复跑命令（仓库根目录）：

```bash
# 一次性：把语料补齐到"全部有模块摘要"（可重复执行，已建模的会跳过）
npx tsx scripts/model-corpus.mts --attempts 3

# 每一波（每个目标模块一次）
npx tsx scripts/verify-module-flow-e2e.mts --reset-target \
  --target-file src/main/java/org/apache/commons/fileupload/MultipartStream.java \
  --output tmp/java-fileupload-flow/module-flow-e2e.json

npx tsx scripts/verify-module-flow-e2e.mts --keep-target-changes \
  --target-file src/main/java/org/apache/commons/fileupload/disk/DiskFileItem.java \
  --requirement "恢复上传项的磁盘存储实现：实现 DiskFileItem 的输出流、临时文件读写与清理" \
  --output tmp/java-fileupload-flow/module-flow-e2e-wave2.json
```

## 1. 被测对象与固定环境

| 项 | 值 |
| --- | --- |
| 目标工作区 | `tmp/java-fileupload-flow/target-repo`（Java，60 个源文件，已提交骨架含 stub） |
| 参考工程 | `fixtures/code-corpus/*` 全部 17 个仓 |
| 数据库 | `forexplore_javafileupload_flow_20260913`（SeekDB 2881） |
| 嵌入服务 | `Xenova/multilingual-e5-small`（本地 4021，384 维） |
| 工作台 / 语义查询 | `4042` / `4043` |
| 翻译服务 | `8790`（`ADAPTATION_WORKSPACE_TRANSLATION_ENABLED=true`，编译命令 + 12 个 Apache 测试类） |
| 模型输出上限 | 脚本注入 `x-recast-model-config`，`maxOutputTokens=32768`（服务默认 8192 装不下 33 KB 整文件重写） |
| 评分标准 | 编译 `tools/compile.mjs` + 上游套件 `tools/verify.mjs`，由**脚本自己**在翻译结束后重跑 |

## 2. 先决条件：语料必须被建模（这是本次最大的一步）

模块级检索只认模块摘要。入库时只有 3 个仓有摘要（详见 `docs/recall-kernel-acceptance.zh-CN.md` §11.2），
本次用 `scripts/model-corpus.mts` 把 **17 个参考仓全部建模**（agent 策略），结果：

| 阶段 | 结果 |
| --- | --- |
| 参考仓建模 | 17/17 成功（python 4、ts 4、ledger-flow-ts 8、multipart-vault-py 4、account-stream-rs 10、circuit-lane-java 9、batch-reconcile-go 12、buffered-journal-rs 13、csharp 8、durable-audit-java 5、forexplore-reference-java 5、ordered-events-py 13、quote-fanout-go 12、resilient-pricing-py 8、settlement-queue-py 10、signal-buffer-ts 16、swift-cache-ts 13 个模块） |
| 目标仓建模 | 6 个模块：`module-multipart-core`(3 文件)、`module-item-contracts`(12)、`module-disk-storage`(4)、`module-container-integration`(7)、`module-util-mime`(8)、`module-test-support`(18) |
| 耗时 | 参考仓合计约 5.6 分钟；目标仓约 37 秒 |
| 失败与重试 | `buffered-journal-rs` 首次失败：`revision-scoped 模块规划服务拒绝请求：Semantic index query failed.`（SeekDB 向量查询撞 10 s 上限），重试即成功。**这是偶发，不是死症**，但产品路径目前没有重试 |

## 3. 两波实测

### 3.1 第一波：`module-multipart-core`（Multipart 解析核心）

| 步骤 | 结果 |
| --- | --- |
| 检索 | 17 仓 → 5 个候选，**9,334 ms**；Top1 = python `module-core-multipart`（0.8737），第 2 名 = **csharp `module-multipart-stream`（0.8153，此前因无摘要完全不可见）** |
| 自动选 Top1 | python `module-core-multipart`（≥ 阈值 0.5） |
| 作用域 | 写集 = 3 个文件（`FileUploadBase` / `MultipartStream` / `ParameterParser`），1 个证据作用域，4,944 字符 |
| 翻译 | 14 轮、6 次按需证据查询、1 处改动、1 次编译 |
| 服务判定 | `failed` / `compilation-only` |
| 独立复验 | 编译 OK（40 源文件）；套件未通过 |
| 越界写入 | 无 |

失败原因（Agent 原话）：`readBodyData` / `skipPreamble` 已正确恢复且编译通过，但**行为套件被 writeFiles 之外的
stub 卡住**：`disk/DiskFileItem.java:458` 抛 `UnsupportedOperationException: TODO: create item output stream`，
36 个失败全部源于这一个根因。Agent 明确**拒绝越界写入并报告缺口**。

### 3.2 第二波：`module-disk-storage`（磁盘存储实现）

| 步骤 | 结果 |
| --- | --- |
| 检索 | 17 仓 → 5 个候选，**2,777 ms**；Top1 = python `module-core-multipart`（0.8327，semantic 0.9158 / contract 0.5），第 3 名 = csharp `module-disk-items`（0.7498，**semantic 0.9373** / contract 0） |
| 作用域 | 写集 = 4 个文件（`DiskFileItem` / `DiskFileItemFactory` / `DefaultFileItem` / `DefaultFileItemFactory`） |
| 翻译 | 15 轮、5 步、4 处改动、1 次编译、6 次按需证据查询 |
| 服务判定 | **`completed` / `behavior-verified`** |
| 独立复验 | 编译 OK（40 源文件）；**`OK (53 tests)`** |
| 工作区改动 | 恰好两个文件（第一波的 `MultipartStream.java` + 本波 `DiskFileItem.java`），**越界写入为空** |

两波合计构成完整流程闭环；`passed: true`。

## 4. 本次暴露的四个问题（都要决策，不是脚注）

1. **模块检索的 10 秒预算太紧**：`searchModules` 对"全部 17 仓"只有 10 s 总预算（`AbortSignal.timeout(10_000)`）。
   第一波用掉 **9.33 s（余量 0.7 s）**，第二波 2.78 s——同一批数据、不同负载，差 3 倍。负载一高必然整体 abort。
   建议：按仓数/文档量放宽预算，或把超时改成"每仓预算 + 总预算"两级。
2. **自动 Top1 的排序口径值得复核**：磁盘存储这一波，语义上最贴合的是 csharp `module-disk-items`
   （semantic 0.9373 > 0.9158），但因为模块打分的 20% 是 coreApis 命中率、它命中 0 个，最终 Top1 给了
   python 的 multipart 核心模块。翻译仍然成功，但"自动选 Top1"在语义/接口两个信号打架时会偏向接口名。
3. **单元件写集无法满足跨模块的测试预言**：一个模块的作用域只覆盖该模块文件，而预言（上游套件）跨模块。
   所以**一波不可能全绿**，第一波以 `compilation-only` 收尾是正确行为，波浪化是必需而非可选。
4. **语料建模需要重试**：SeekDB 向量查询 10 s 超时会偶发打掉一次建模（本次 1/18）。脚本层已加重试，
   产品路径（工作台/扩展）没有。

## 5. 口径（不要过度解读）

- 能证明的是**流程打通**：检索 → 上下文 → 翻译 → 回填 → 编译 → 上游测试，全程真实组件、真实模型、真实验收。
- **不能**证明"收益来自检索"：java-fileupload 是模型可能记得上游实现的仓。因果证明仍需私有模块 A/B。
- 第二波 Top1 选的参考模块与目标模块语义并不完全对应，翻译依然通过——这既说明流程鲁棒，
  也说明本次证据**不足以**支撑"检索质量决定翻译质量"的结论。

## 6. 证据文件

| 文件 | 内容 |
| --- | --- |
| `tmp/java-fileupload-flow/module-flow-e2e.json` | 第一波报告（含 Top1 依据、轮次、编译/测试、越界检查） |
| `tmp/java-fileupload-flow/module-flow-e2e-wave2.json` | 第二波报告（`passed: true`，53 测试） |
| `scripts/model-corpus.mts` | 语料建模补齐工具（含失败即断、重试、进度输出） |
| `scripts/verify-module-flow-e2e.mts` | 本次全流程验收脚本 |
| `tmp/java-fileupload-flow/target-repo/` | 目标工作区当前状态 = 两波翻译后的已验证结果 |

## 7. 目标工程为什么要"选一次"

目标仓 `tmp/java-fileupload-flow/target-repo` 在本机索引里天然含**两个工程**：

| 工程 | 内容 | 计划 |
| --- | --- | --- |
| `pom`（kind=maven） | `pom.xml` + `src/`，61 个 Java 文件 | 5 个模块（核心上传解析与契约 / 磁盘文件项存储 / Servlet 与 Portlet 容器适配 等） |
| 「未归属工程文件」（kind=directory） | 仓根 `tools/*.mjs`（`compile.mjs`/`verify.mjs`/`jdk.mjs`） | 3 个模块（JDK 定位与类路径契约 / Java 源码编译入口 / Java 测试执行入口） |

`tools/*.mjs` 是宿主自有的验收工具（在 `run-adaptation-full.ps1` 里登记为 `protectedFiles`），
必须留在仓根、不能被搬走，所以这个"多工程"是结构性的，不是脏数据。

规则（`code-intelligence-host.ts` 的 `resolveProjectChoice`）：

1. 非历史仓若存在**多个工程**且没有选择，宿主不会替用户猜是哪一个真工程，该仓不出现在工程树里。
   这是为了避免模型费用花在错误的工程上。
2. **目标仓的唯一例外**：多个工程里只有一个"真工程"（`kind !== 'directory'`），其余都是索引器的
   「未归属工程文件」分组时，自动选中那个真工程——上表的 `target-repo` 正是这种情况，
   所以它启动即显示，不需要任何手动选择。
3. 两个真工程（例如两个 maven 模块）仍然要求显式选择一次；选择写入窗口 UI 状态
   （`context.globalState`），**重启后自动恢复**，不需要每次重选。
4. 恢复的选择仍要按当前 revision 校验：工程已不存在则丢弃并回到"待选择"，
   不会让一个失效的 ID 把整仓永久藏起来。历史仓选择旧 revision 时不会误删选择。

