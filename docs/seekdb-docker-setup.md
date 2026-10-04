# ForeXplore SeekDB Docker 配置记录

本文记录在 Windows Docker Desktop + WSL 环境中，为 ForeXplore 启动和配置
SeekDB 的完整过程。所有命令均从仓库根目录执行：

```text
/mnt/e/CS/devsys/weichai
```

## 1. 检查 Docker 环境

```bash
docker version
docker compose version
```

作用：

- `docker version` 同时检查 Docker CLI 和 Docker Engine 是否可用。
- `docker compose version` 确认 Compose 插件已经安装。
- 如果只能看到 Client、看不到 Server，通常说明 Docker Desktop 尚未启动或 WSL
  Integration 未开启。

本次环境使用 Docker Desktop，WSL 可以正常访问 Docker Engine。

## 2. Compose 配置说明

项目使用的配置文件是：

```text
services/code-intelligence-service/infra/docker-compose.yml
```

核心配置如下：

```yaml
services:
  seekdb:
    image: oceanbase/seekdb:1.3.0.0-100000092026051510@sha256:e3a46b65…
    container_name: forexplore-seekdb
    ports:
      - "127.0.0.1:2881:2881"
      - "127.0.0.1:2886:2886"
    environment:
      SEEKDB_DATABASE: forexplore
      MEMORY_LIMIT: 2G
      CPU_COUNT: 2
    volumes:
      - seekdb-data:/var/lib/oceanbase
```

各配置项的作用：

| 配置 | 作用 |
| --- | --- |
| `oceanbase/seekdb:1.3.0.0-…@sha256:…` | 固定版本与摘要的 SeekDB 官方镜像；不用 `latest`，避免重建容器时静默升级改变磁盘格式。升级前先执行 `npm run data:backup` |
| `forexplore-seekdb` | 固定容器名称，便于查看日志和执行命令 |
| `127.0.0.1:2881:2881` | 仅在本机回环地址暴露 MySQL 兼容数据库端口 |
| `127.0.0.1:2886:2886` | 仅在本机回环地址暴露 SeekDB 管理端口 |
| `SEEKDB_DATABASE=forexplore` | 首次初始化时创建 `forexplore` 数据库 |
| `MEMORY_LIMIT=2G` | 将 SeekDB 内存限制设为 2 GiB |
| `CPU_COUNT=2` | 为 SeekDB 配置 2 个 CPU |
| `seekdb-data` | 使用 Docker 命名卷持久化数据库文件和索引 |

Compose 还配置了健康检查，每 10 秒通过 `mysqladmin ping` 检查一次数据库。

## 3. 启动 SeekDB

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml up -d
```

作用：

1. 在本地没有镜像时拉取固定版本的 SeekDB 镜像。
2. 创建名为 `forexplore-seekdb` 的容器。
3. 创建命名卷 `seekdb-data`。
4. 将容器的 2881、2886 端口映射到宿主机的 `127.0.0.1`（局域网不可访问）。
5. 在后台启动容器；`-d` 表示 detached 模式。

该命令是幂等的。容器已经存在时再次执行，会按当前 Compose 配置启动或更新容器。

## 4. 查看初始化日志

```bash
docker logs -f forexplore-seekdb
```

作用：持续输出容器日志。`-f` 表示 follow，用于观察首次初始化、数据库创建和
健康检查过程。

本次启动日志中的关键结果是：

```text
SeekDB started successfully
Database forexplore created.
Initialization complete.
Seekdb started
```

看到这些信息说明 SeekDB 已启动并创建了 `forexplore` 数据库。按 `Ctrl+C` 只会
退出日志跟踪，不会停止容器。

## 5. 检查容器状态

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml ps
```

作用：显示该 Compose 项目中的容器、镜像、运行状态和端口映射。

正常状态应包含：

```text
forexplore-seekdb   Up ... (healthy)
```

`healthy` 表示 Compose 中定义的数据库健康检查已经通过。

## 6. 直接检查数据库端口

```bash
docker exec forexplore-seekdb mysqladmin ping -h 127.0.0.1 -P 2881 -u root
```

作用：

- `docker exec` 在正在运行的 SeekDB 容器内执行命令。
- `mysqladmin ping` 检查 2881 端口是否接受数据库连接。
- 当前开发配置使用 `root` 用户和空密码；端口只绑定 `127.0.0.1`，因此只有本机进程能连接。
  如需密码：在数据库中为用户设置密码后，同时配置 `SEEKDB_PASSWORD`（retrieval service）和
  `CODE_INTELLIGENCE_SEEKDB_PASSWORD`（扩展），并同步修改 Compose 健康检查中的 `mysql -u root` 参数。
  旧 Compose 配置（绑定所有网卡）需执行一次 `docker compose ... up -d` 才会改为回环绑定。

正常输出：

```text
mysqld is alive
```

本次检查已经通过，说明 SeekDB 容器和数据库端口均可用。

## 7. 数据存储位置

数据库数据通过命名卷挂载：

```yaml
seekdb-data:/var/lib/oceanbase
```

因此镜像、容器层和 `seekdb-data` 都由 Docker Desktop 管理，实际位于 Docker
Desktop 设置的 **Disk image location** 中，而不是项目目录。移动 Disk image
location 时应通过 Docker Desktop 设置操作，不能直接移动内部数据文件。

可以查看实际创建的卷：

```bash
docker volume ls
docker volume inspect code-intelligence-service_seekdb-data
```

Compose 会在卷名前添加项目名。本次实际创建并验证的卷名是
`code-intelligence-service_seekdb-data`。

## 8. 配置连接 SeekDB

SeekDB 容器启动后，还需要配置 retrieval service。以下不是 Docker
命令，但它们是让服务真正使用 SeekDB 的必要步骤。

创建本地配置文件：

```bash
cp services/code-intelligence-service/.env.example CODE_INTELLIGENCE_* environment variables
```

该文件配置 SeekDB 地址、数据库、表、向量维度和 embedding provider。

`.env` 可能包含数据库密码或 API Key，不应提交到 Git。


## 9. 初始化检索表和代码索引

```bash
```

作用：在 `forexplore` 数据库中创建或更新 `code_symbols` 表、向量索引和全文索引。

```bash
```

作用：

1. 扫描 `fixtures/code-corpus` 下的多语言代码仓库。
2. 提取 class、method 和 function 符号。
3. 生成 embedding。
4. `--replace` 先写入（覆盖）全部新符号，成功后再删除不在本次语料中的旧符号；中途失败时旧索引保持完整，检索期间不会出现空表。
5. 刷新 SeekDB 索引，使新数据立即可检索。

开发环境默认使用 `hash` embedding，适合离线联调；生产质量语义检索应配置
OpenAI-compatible embedding 服务。

## 10. 启动并验证代码智能索引

索引由扩展宿主在导入目标工程或参考工程时按 revision 建立。SeekDB 只需要
保持运行；可通过 `docker compose ... ps` 检查容器状态，并在工作台的工程状态
面板查看索引进度和 active revision。

## 11. 启动 VS Code 扩展

```bash
npm run dev:extension
```

扩展会连接本机的 retrieval service、adaptation service 和 SeekDB.

## 12. 日常启停命令

停止容器但保留容器和数据：

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml stop
```

重新启动已停止的容器：

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml start
```

删除容器和网络，但保留命名卷数据：

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml down
```

重新创建并启动容器：

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml up -d
```

删除容器并同时删除数据库卷：

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml down -v
```

最后一条命令会永久删除 SeekDB 数据库和代码索引，只应在明确需要完全重建时使用；执行前先做一次备份。

### 备份与恢复代码智能数据库

备份是逻辑导出（每张表一个 `*.jsonl.gz` + `manifest.json`，含行数、sha256、列类型、
SeekDB 版本和 embedding 身份），在同一个只读事务内完成，因此各表来自同一快照，
并且可以跨 SeekDB 镜像版本恢复。默认输出到 `backups/<库名>-<时间戳>/`（已被 git 忽略），
写入过程中目录名带 `.partial` 后缀，完成后才改名。

```bash
npm run data:backup -- --database <库名>            # 省略 --database 时使用 CODE_INTELLIGENCE_SEEKDB_DATABASE
npm run data:restore -- --from backups/<目录> --database <新库名>          # 预览
npm run data:restore -- --from backups/<目录> --database <新库名> --apply  # 执行
```

恢复的安全约束：

1. 只恢复到尚不存在的数据库，不覆盖现有库；恢复成功后把 `CODE_INTELLIGENCE_SEEKDB_DATABASE` 指向新库。
2. 加载前逐文件校验 sha256。
3. 表结构由当前代码的 `SeekDbIndexStore.initialize()` 创建；当前 embedding 配置
   （模型、维度、前缀）必须与备份一致，否则拒绝，因为向量会失去意义。
4. 恢复后逐表核对行数；任何失败都会删除这次新建的库。
5. 向量以文本形式导出，恢复后余弦距离误差约 `1e-7`，不影响检索排序。

retrieval service 的 `forexplore` 库可以从语料重建，不在备份范围内。

### 升级 SeekDB 镜像

1. `npm run data:backup -- --database <库名>`。
2. 修改 `docker-compose.yml` 中固定的镜像标签和摘要。
3. `docker compose -f services/code-intelligence-service/infra/docker-compose.yml up -d` 重建容器（命名卷保留）。
4. 启动后若旧库无法打开，删除卷重建容器，再用 `data:restore` 恢复到新库。

### 表结构迁移

代码智能库的表结构版本记录在 `schema_migrations` 表（`version`、`name`、`applied_at`）。
`SeekDbIndexStore.initialize()` 每次启动先按基线建表，再按序执行未记录的迁移并逐条记录，
已记录的迁移不会重跑。

- 库中记录的版本高于当前代码支持的版本时，启动会被拒绝（防止旧版本代码写坏新结构）。
  此时应升级 ForeXplore，或改用其他库。
- 开发约定：`initialize()` 中的 `CREATE TABLE` 语句是冻结的基线，新增列或索引只能在
  `#migrate()` 末尾追加新迁移，已发布的迁移不修改；每个迁移都要先探测再变更，保证可重复执行。
- `data:restore` 不导入备份中的 `schema_migrations`，由恢复时的代码重新写入；
  备份中的列若在当前结构中不存在，恢复会被拒绝。
- 迁移 2：给 `search_documents` 增加 `project_id` 列和索引
  `idx_search_documents_scope (repository_id, analysis_revision, kind, project_id)`。
  已有数据在首次启动时回填：符号/源码片段按 `files.project_id`，摘要按其 JSON 中的 `projectId`。
  实测 6 万条文档约 2.3 秒。旧备份（迁移 2 之前）恢复后，`data:restore` 同样会自动回填。
  回填之后，项目范围的向量召回会在 top-N 之前按项目过滤，
  不会再因为先取 top-N、后按项目过滤而丢结果。

### 数据保留与清理

三个命令默认只预览（输出 JSON 清单），加 `--apply` 才执行。

```bash
npm run data:gc -- --database <库名> [--keep-superseded 1] [--stale-hours 24] [--apply]
npm run data:files -- --workspace <工作区> [--days 30] [--extension-storage <目录>] [--apply]
npm run data:scratch -- --database <当前库名> [--apply]
```

`data:gc`：清理代码智能库中的旧分析版本。

1. 每个仓库只保留：active 版本、最新 N 个 superseded（默认 1）、最新 1 个 failed、
   未超过 `--stale-hours` 的 building。超时的 building 视为崩溃残留，直接删除。
2. 每个版本在单个事务内删除；存储层拒绝删除 active 版本。
3. 随后清理 `search_embedding_cache` 中不再被任何搜索文档引用的向量缓存行。
4. 运行时的 embedding 配置必须与库一致，否则 `initialize()` 拒绝。

`data:files`：清理工作区中超过 `--days`（默认 30）天的已结束记录。

- `.forexplore/checkpoints/`：只删 committed / rolled-back。
- `.forexplore/workspace-translations/`：只删 completed / rolled-back；failed、cancelled、
  interrupted 可恢复，一律保留；超期的 `*.tmp` 残留会被删除。
- `<gitdir>/forexplore-wave-transactions/`：只删 committed / rolled-back；非 git 目录跳过。
- 扩展 globalStorage 下的 `checkpoints/ws-*.json` 只在显式传入 `--extension-storage` 时处理。
- 进行中的记录（prepared、committing、translating 等）永不删除；无法解析的文件只列在
  `unreadable`，不删除。
- 注意：删除 committed 检查点或 completed 翻译记录后，就无法再回滚它们。

`data:scratch`：列出并删除验证脚本遗留的临时库（名称前缀 `forexplore_task_scale_`、
`project_live_`、`module_accept_`），`--database` 指定的当前库始终排除。

`start-recast-services` 的服务日志在启动时若超过 10 MiB，会轮转为 `<名称>.log.1`（只保留一份）。

### 诊断

两个命令均只读，不建表、不执行迁移：

```bash
npm run data:stats -- --database <库名>
npm run data:doctor -- --database <库名> [--stale-hours 24]
```

- `stats`：各表行数、已应用迁移、每个仓库的活动 revision、各状态 revision 数和活动 revision 的检索文档（按 kind）。
- `doctor`：输出 `findings`（`error`/`warning`，含 `fix` 建议），存在 `error` 时退出码为 1。
  - error：缺表、库版本高于当前构建、embedding 身份与当前配置不一致、仓库活动 revision 缺失或非 `ready`。
  - warning：无关表、待迁移、无主 revision、孤儿行、缺 `project_id` 的检索文档、超时的 `building` revision、
    未被引用的 embedding 缓存（后两项由 `data:gc -- --apply` 清理）。

## 13. 本次执行结果

本次已完成的 Docker 阶段包括：

1. 确认 Docker Engine 和 Compose 可用。
2. 使用 Compose 启动 `forexplore-seekdb`。
3. 观察日志，确认 `forexplore` 数据库创建完成。
4. 确认容器状态为 `healthy`。
5. 使用 `mysqladmin ping` 确认 2881 数据库端口可用。

SeekDB 基础设施已经就绪。后续需要完成 `.env` 配置、schema 初始化、corpus
索引和 retrieval service 启动，检索链路才会使用真实数据而非本地回退实现。
