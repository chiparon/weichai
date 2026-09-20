# 插件后端与跨仓取证修复

本次修复位于 `codex/enterprise-history-benchmark` 工作树。运行该工作树根目录的 `start-enterprise-extension.cmd`，在扩展开发窗口打开 RECAST。已经打开的旧扩展窗口需要执行 **Developer: Reload Window** 才会加载新构建。

## 自动启动与模型配置

- 在可信工作区首次打开工作台时，宿主启动扩展自带的 adaptation 后端。分析、模块规划、任务重排、模块重排和翻译会按需检查后端。
- 默认地址是 `http://127.0.0.1:8788`，可以通过 `forexplore.adaptationApiUrl` 修改。仅本机 HTTP 根地址支持自动启动。
- 后端绑定启动时的目标工程；如果更换目标工程或端口，请关闭原扩展开发窗口并重新启动。这样不会中断旧目标的翻译并把后续修改发往错误目录。
- 重复调用共用一次启动。关闭窗口时只停止本窗口启动的子进程；兼容的外部后端可复用，不会被终止。启动失败、目标不匹配与鉴权失败会明确报错。
- 设置面板中的 Provider、API Base、Model 与 API Key 现在也用于任务与模块重排。Key 由 VS Code SecretStorage 每次请求读取，经本机请求传入后端，不写入工作区、命令行或日志。修改配置后后续重排立即使用新配置。
- 模型重排是受约束的模型调用，返回候选 ID 排列；翻译 Agent 才负责多轮规划、取证、修改与验证。重排失败时任务检索记录 `CONTEXT_RERANK_UNAVAILABLE`，不能将回退结果当作模型重排成绩。

`forexplore.backend.autoStart` 默认开启。自动启动仅包含 adaptation 模型后端，SeekDB 和 embedding 服务仍需按原部署流程配置。开发模式的内存索引不等价于生产向量检索。

## 编译与行为验收

默认编译助手识别 Python、Go、Rust 和 .NET 工程，并调用本机工具。其他工程使用用户设置 `forexplore.backend.compileCommand`，例如：

```json
{
  "forexplore.backend.compileCommand": {
    "executable": "python",
    "args": ["-m", "compileall", "-q", "src"],
    "timeoutMs": 120000
  }
}
```

需要业务验收时配置 `forexplore.backend.verification`：包含 `command`（同上结构）和非空 `protectedFiles`（工程相对路径数组）。编译与验收命令只读取用户设置，工作区不能替换宿主执行命令。未配置行为验收时，界面明确显示没有行为验证；语法编译成功不代表业务实现正确。

手动运行的外部后端如需用于翻译，仍需与扩展配置同一个 `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN`；自动启动时宿主在内存中生成并传递该令牌。

## 检索与取证范围

- UI、HTTP、MCP、Agent 取证和后端验证统一使用 64 个仓库版本上限。目标工程加 8 个历史仓库的 9 范围请求可以执行；超限明确拒绝，不再静默丢掉第 9 个及之后的仓库。
- 选择一个历史模块后，翻译 Agent 可按需查询当前窗口可见的全部已索引历史仓库。候选固定为所选版本，其他仓库固定为准备翻译时的活动版本。未完成索引的参考工程会阻止范围准备，避免交付一个看似完整的范围。
- 任务证据包中由宿主记录的参考仓库快照也会进入 Agent 的只读取证范围。隐藏仓库不会因共享索引存在而自动获得授权。
- 扩大的是读取范围；`writeFiles` 仍仅来自选中的目标模块。
- Python 绝对模块导入会在已授权快照的根目录和 `src` 布局中进行精确路径匹配，递归补充依赖文件。仅包含常量或初始化语句的中间模块也能继续遍历。关系记录包含来源、目标仓库及双方版本。
- 同名模块歧义不猜选目标；找不到目标、源码截断和遍历上限会记录缺口。当前新增的是 Python 静态导入关系，不能声称覆盖其他语言、动态导入或运行时调用图。

取证请求仍有文本、文件数、时间与源码行预算。范围完整表示授权仓库未被静默截断，不代表一次请求会返回全部源码。

## 验证记录

- 扩展完整测试：235 项通过；代码智能服务完整测试：221 项通过。
- 后端 HTTP、凭据、多 Provider、配置、翻译与 Agent 取证相关测试：54 项通过；MCP 服务测试：19 项通过。
- 企业历史库的 24 条查询已用修复后的内存检索重跑，0 请求失败；结果位于 `results/enterprise-history/evaluation/fixed-cross-repo/recast-memory.json`。该轮明确关闭 embedding 和模型重排，仅用于检索集成验证。
- `npx tsx scripts/verify-extension-backend.mts` 验证实际打包后端启动、能力探测、令牌鉴权、Python 编译，以及“模拟 SecretStorage → 后端 → 模拟模型 → 重排”的全链路，最后验证子进程退出。
- 全后端回归中的 .NET 模块准备测试因本机缺少 .NET SDK 而失败，诊断为 `No .NET SDKs were found`。未将该测试计为通过。
- 未使用或导出用户的真实 Key；上述模拟模型检查不代表真实模型效果评测。
