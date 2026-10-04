# 启动指南

## VS Code 工作流

从仓库根目录运行：

```sh
npm install
npm run dev:extension
```

启动器先启动 SeekDB、embedding 和 rerank，验证 SQL 和模型健康状态，再打开 Extension Development Host。点击 RECAST 后，由扩展启动绑定当前目标工程的 adaptation 后端；不要再手动启动另一个 adaptation 进程争抢同一端口。

- 已有 SeekDB：`npm run dev:extension -- --skip-seek-db`。外部数据库通过 `CODE_INTELLIGENCE_SEEKDB_HOST` 和 `CODE_INTELLIGENCE_SEEKDB_PORT` 指定；健康检查使用该地址。
- 自行管理依赖：`npm run dev:extension -- --skip-services --skip-seek-db`，并确认实际配置的数据库、embedding/rerank 已就绪。
- 指定工程：`npm run dev:extension -- --folder <path>`。
- 修改源码并重新构建后，在开发窗口执行 **Developer: Reload Window**。

## 端口与诊断

外部翻译后端配置地址默认 `http://127.0.0.1:8788`，显式 `forexplore.adaptationApiUrl` 优先，否则使用 `ADAPTATION_PORT`。扩展自动启动的翻译子进程与每个窗口的语义查询服务均由系统分配端口，实际地址见 **输出 → RECAST**；API Key 仍按配置地址保存。只有外部 MCP / 手动后端需要固定地址时，才在启动扩展前设置 `FOREXPLORE_SEMANTIC_QUERY_PORT`；外部客户端必须使用同一地址与令牌。

```sh
npm run services:up
```

该命令检查真实依赖健康状态，不会把“端口能连接”当作服务就绪。失败时检查输出列出的日志：`not serving the configured … model` 表示该端口上的服务模型与配置不匹配；模型下载的 `fetch failed` / `UND_ERR_CONNECT_TIMEOUT` 需要检查模型源网络或模型缓存，不能靠更换索引端口解决。索引异常的详细原因记录在 RECAST 输出中。

模型 Key 在 RECAST **设置 → AI 服务**配置。后端已连接不等于模型请求已授权；没有 Key 时不能声称完成真实翻译。SeekDB、模型配置及独立 HTTP 服务运行方法见[根目录 README](../README.md)和[后端说明](extension-backend-and-evidence.zh-CN.md)。
