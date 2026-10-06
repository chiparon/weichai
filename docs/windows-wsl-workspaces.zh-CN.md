# Windows 与 WSL 分开开发

两个平台使用相同版本的源码和 package-lock.json，各自安装原生依赖。
目录映射保存在本机 `.recast-platforms.json`，不进入 Git。

本机已经配置：

| 平台 | 工作目录 | 分支 |
| --- | --- | --- |
| Windows | `E:\CS\devsys\weichai` | `test/enterprise-asset-upgrade-dataset` |
| WSL | `/home/ryanlyu/worktrees/weichai-wsl` | `dev/wsl-enterprise-asset-upgrade` |

在 PowerShell 中启动：

```powershell
cd E:\CS\devsys\weichai
npm run workspace:check
npm run dev:extension
```

准备改用 WSL 时，在 PowerShell 中同步源码：

```powershell
npm run workspace:sync -- --to wsl
```

该命令通过 WSL 执行文件同步，可以同时访问 Windows 源码和 Linux worktree。
然后在 WSL 终端进入 Linux 目录：

```bash
cd /home/ryanlyu/worktrees/weichai-wsl
npm run workspace:check
npm run build:extension
# 如需打开 Linux 扩展宿主，使用 VS Code Remote WSL：
code .
```

结束 WSL 开发并返回 Windows 前，在 WSL 目录执行：

```bash
npm run workspace:sync -- --to windows
```

`--dry-run` 可以查看同步数量而不写入文件。同步命令检查源文件与上次同步
基线：目标目录独有的修改会保留，同一文件两边都改过会中止整个同步并列出
冲突，不会选择某一边覆盖。只完成到本地源码的同步，不自动提交 Git。

同步包括工程源码、开发脚本、需求、测试和文档。`node_modules`、`dist`、
`bin/obj`、Java `target`、模型缓存、日志、结果目录、原始历史仓库和本地
凭据不参与同步。冻结的历史参考源码由创建 worktree 时的 Git checkout
提供，不参与日常同步。各平台已有的本地服务配置独立保留。

依赖清单发生变化时，同步命令会提示在目标平台目录运行 `npm ci`。
没有依赖变化时，切换平台无需重新安装。

同步命令要求两个 worktree 的 Git HEAD 一致。若在某个平台创建了新提交，
先通过 Git 合并或 cherry-pick 把提交同步到另一分支；有未提交改动时按正常
Git 流程保存和合并，不要使用 hard reset 强行对齐。

`npm run build:extension`、`npm test` 和扩展开发启动器在开始工作前会检查
目录与平台。直接运行其他脚本、`npm ci` 或 `npx tsx` 时，也应使用上表中
当前平台的目录。不能在 `/mnt/e/cs/devsys/weichai` 重新安装 Linux 依赖。

WSL worktree 的注册已锁定，避免 Windows Git 因不能访问 `/home/...` 而在
prune 时误删它。两个目录的构建产物各自保留；SeekDB 容器可共用。
