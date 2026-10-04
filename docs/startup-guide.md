# 启动指南

## 一键启动

在仓库根目录执行：

```sh
npm install
npm run dev:extension -- --folder fixtures/target-system/commons-fileupload-java-skeleton
```

启动脚本会准备 SeekDB、Embedding 和本地模块重排服务，启动适配服务，并打开
VS Code Extension Development Host。需要跳过某个依赖时可使用
`--skip-seek-db` 或 `--skip-services`。

## 手动启动适配服务

如果不使用一键启动，先准备 SeekDB：

```sh
docker compose -f services/code-intelligence-service/infra/docker-compose.yml up -d
```

然后配置适配服务并启动：

```sh
DEEPSEEK_API_KEY="sk-xxx" \
ADAPTATION_PROJECT_ROOT="/absolute/path/to/target" \
npm run dev:adaptation
```

扩展宿主负责目标工程和参考工程的索引、模块候选检索以及证据范围；适配服务
只负责模块分析、翻译、编译验证和回填。
