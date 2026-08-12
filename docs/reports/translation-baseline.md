# 翻译模块基线记录

## 记录范围

这份记录用于成员 A 的基线复现和后续新旧流程对比。当前仓库里可追溯的原始运行结果是：

- 结果文件：`services/adaptation-service/poc/output/result_20260718_180933.json`
- 场景数量：5
- 场景类型：完全对应、部分对应、签名差异、异常映射、集合转换

## 历史原始结果摘要

| 场景 | 匹配类型 | 独立编译 | 修复次数 | 主要失败原因 |
| --- | --- | --- | ---: | --- |
| case-1-exact-match | exact | 失败 | 3 | wrapper 中缺少 `OrderItem`、`Discount` 等领域类型，`CS0246` |
| case-2-partial-match | partial | 失败 | 3 | wrapper 中缺少 `Order`，`CS0246` |
| case-3-different-signature | partial | 通过 | 0 | 无 |
| case-4-exception-mapping | exact | 失败 | 3 | wrapper 中缺少支付领域类型，`CS0246` |
| case-5-collection-transform | exact | 失败 | 3 | wrapper 中缺少 `Order`，`CS0246` |

汇总：5 个场景中 1 个独立编译通过，4 个失败，共触发 12 次修复。失败集中在测试 wrapper 没有目标仓库领域类型，并不能直接说明翻译逻辑错误。这也说明旧流程只做孤立方法编译时，容易把“上下文缺失”误判成“生成代码需要修复”。新流程加入目标上下文和依赖计划后，Validator 应优先使用集成编译或带领域 stub 的编译方式。

## 当前可复跑基线

2026-08-08 修复了验证器本身的两个兼容性问题：Windows `csc.exe` 中文输出不再按错误编码解码崩溃；受控领域桩和样例代码可以在仓库当前回退使用的 C# 5 编译器下运行。当前结果为 5/5 编译通过：

| 场景 | 当前编译结果 |
| --- | --- |
| case-1-exact-match | 通过 |
| case-2-partial-match | 通过 |
| case-3-different-signature | 通过 |
| case-4-exception-mapping | 通过 |
| case-5-collection-transform | 通过 |

这次修复没有改变五个样例的业务行为。领域类型仍由受控 stub 提供；case 5 仅把 C# 7 的内联 `out` 变量声明改成等价的 C# 5 写法，以兼容 Windows Framework 自带编译器。

## 真实模型复跑结果

2026-08-12 使用 `DEEPSEEK_MODEL=deepseek-v4-flash` 重新运行了同一批 5 个 POC。运行时从未跟踪的 `services/adaptation-service/.env` 读取密钥，结果文件为本地生成的 `services/adaptation-service/poc/output/result_20260812_195316.json`。

| 场景 | 编译结果 | 修复次数 |
| --- | --- | ---: |
| case-1-exact-match | 通过 | 0 |
| case-2-partial-match | 通过 | 0 |
| case-3-different-signature | 通过 | 0 |
| case-4-exception-mapping | 通过 | 0 |
| case-5-collection-transform | 通过 | 0 |

汇总：5/5 通过，未触发编译修复循环。第一次复跑中 case 5 曾生成 C# 7 的内联 `out` 声明，已在 POC 提示词中加入 C# 5 兼容约束并复跑确认通过。

## 可复跑方式

```bash
python services/adaptation-service/poc/validate_baseline.py
npm test
npm run build:adaptation
```

正式模型对比时应固定模型、API 地址和 temperature，并把新结果保存为新的时间戳文件，不覆盖历史记录。当前离线基线不调用外部模型。

## 新流程对比项

下一次有模型密钥时，同一批输入同时记录：

- Analyzer 报告是否能区分领域类型缺失和真正的代码错误；
- Translator 是否保持目标签名和已有依赖；
- `blockingIssues` 是否只拦截无法可靠实现的问题；
- 独立编译、集成编译和 Validator 行为测试的结果；
- 两次模型调用的耗时、失败重试次数和模型配置。
