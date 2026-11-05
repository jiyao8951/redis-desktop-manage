# Redis Desktop Manager

基于 **Tauri v2（Rust）+ React** 的 Windows Redis 图形客户端，以单文件绿色版分发。

连接、分组和设置保存在本机 SQLite；键浏览、值编辑、命令控制台和服务器诊断都在同一个窗口内完成，界面提供简体中文与英文。

## Overview (English)

Redis Desktop Manager is a Redis GUI for Windows x64, built with Tauri v2 (Rust) and React 19. It ships as a single portable executable and covers connection management, a namespace-aware key tree, viewing/editing of the six core Redis types, a command console, server diagnostics (INFO / MONITOR / SLOWLOG / CLIENT LIST / STATS / CONFIG GET / MEMORY), keyspace-notification Live Update, and an English/Simplified Chinese UI.

Common commands, run from the repository root:

```powershell
bun install          # install frontend dependencies
bun run tauri:dev    # launch the desktop app (dev)
bun run check:types  # TypeScript type check
bun run tauri:build  # build the single portable exe
```

The packaging command is Windows-only. Chinese sections below contain the full details.

## 功能特性

### 连接管理

- 连接的新建、编辑、删除、复制，以及连接测试。
- 连接分组；导入/导出 JSON 连接文件。
- 支持普通 TCP 与 `rediss://` TLS；可选择忽略证书错误。
- 每个连接可选 RESP2 或 RESP3；RESP3 握手不被服务端支持时回退到 RESP2，并在测试连接时给出提示。
- SSH 隧道的字段可以保存，但当前版本不支持建立 SSH 隧道。
- 自定义 CA / 客户端证书路径可以保存，但 TLS 层目前不会加载它们。

### 连接树与键浏览

- 数据库列表来自 `INFO keyspace`，空库按配置的数据库数量补齐。
- namespace 分组树，按需 `SCAN` 加载，支持键过滤与过滤历史。
- 键、namespace、数据库级别的右键菜单，覆盖打开、添加键、删除、批量 TTL、按 pattern 删除、复制键、`FLUSHDB`、Live Update、Console、内存分析等操作。
- 关闭连接会同步关闭相关标签页并释放连接资源。

### 键值查看与编辑

- 支持 `string`、`hash`、`set`、`zset`、`list`、`stream`。
- 多行类型按 `valueEditorPageSize` 分页；字符串按块加载，超过 `valueSizeLimit` 时显示截断提示并可继续加载。
- `hash` / `set` / `zset` / `list` 支持行级新增、修改、删除；`string` 支持整体编辑；`stream` 支持浏览，并可通过 Add Key 以 `XADD` 新增条目。
- TTL 设置与 `PERSIST`；键重命名与删除。
- 内置 formatter：`auto`、`text`、`json`、`hex`、`hex-table`、`base64-text`。
- 不认识的 `TYPE` 以只读方式显示，避免对未知结构做错误写入。

### 命令控制台

- 每条命令单独执行，支持 `↑` / `↓` 浏览历史、`clear` 清空输出、右键清空菜单。
- 显示执行耗时和当前数据库，可在连接内切换 DB。

### 服务器视图

- **INFO**：按 section 展示服务器信息。
- **MONITOR**：独立连接实时输出，前端有行数上限与关键字过滤。
- **SLOWLOG / CLIENT LIST / STATS**：慢日志、客户端列表与采样图表。
- **CONFIG GET**：只读白名单配置项。
- **MEMORY**：内存统计与 `MEMORY DOCTOR`。
- **Console**：在服务器操作页内复用命令控制台。

### Live Update

- 基于 Redis keyspace 通知；每个 `(connection, db)` 使用**独立** pub/sub 连接（`PSUBSCRIBE __keyspace@{db}__:*`），不占用共享连接池。
- 事件在短时间窗口内合并，前端按 `liveUpdateInterval` 秒做一次刷新。
- 键数量超过 `liveUpdateKeysLimit` 时自动停用并提示。
- 服务端需开启 keyspace 通知，例如 `notify-keyspace-events "KEA"`（由管理员在服务端配置，客户端不会发送该命令）。

### 标签页与界面

- 欢迎页按普通标签处理；关闭全部标签后自动新建欢迎页；顶部“连接”菜单可打开或聚焦欢迎页。
- 标签右键菜单：关闭、关闭其他、关闭右侧、关闭全部；绑定连接的标签可“关闭标签并断开连接”。
- 深色模式：自动跟随系统 / 强制开启 / 强制关闭。
- 中英双语：默认跟随系统语言，可在设置中切换。
- 字号与多分辨率适配：应用字号、值编辑器字号可调；布局在 1600px、2400px 断点进入更大档位。
- 无系统托盘：关闭主窗口即退出，并释放连接池、Live 订阅与 Monitor 任务。

## 技术栈

| 层     | 技术                                                    | 职责                                                 |
| ------ | ------------------------------------------------------- | ---------------------------------------------------- |
| 前端   | React 19、TypeScript、Tailwind CSS 4                    | 界面、标签页、连接树、值编辑器、服务器视图           |
| 构建   | Vite+ 1.4.0（Vite / Rolldown / Oxlint / Oxfmt）         | 开发服务器、构建、格式化、lint 与类型感知检查        |
| 桌面壳 | Tauri v2（CLI 2.12.4）                                  | 窗口、IPC、文件对话框、应用退出                      |
| 后端   | Rust、Tokio                                             | 命令实现、连接池、SCAN、值读写、Live Update、Monitor |
| Redis  | `redis` 0.27（`tokio-comp`、`connection-manager`、TLS） | RESP2/RESP3、连接复用与超时控制                      |
| 存储   | `rusqlite` 0.32（bundled SQLite）                       | 连接、分组、过滤历史、应用设置                       |

## 环境要求

| 依赖     | 要求                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| 操作系统 | Windows 10/11 x64                                                                       |
| WebView2 | Microsoft Edge WebView2 Runtime（Windows 10/11 通常自带，精简系统需单独安装）           |
| Node.js  | Vite+ 1.4.0 要求 `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`                                 |
| Bun      | 用于安装依赖和运行脚本；仓库只保留 `bun.lock`                                           |
| Rust     | stable 工具链，`x86_64-pc-windows-msvc` 目标；`Cargo.toml` 声明 `rust-version = "1.77"` |

打包脚本会主动检查 `node`、`bun`、`cargo` 是否可用。

## 快速开始

在仓库根目录执行：

```powershell
bun install
bun run tauri:dev
```

`tauri:dev` 默认使用 1530：端口空闲时直接启动前端开发服务器；若 1530 已被本仓库残留的 dev server 占用则直接复用；若被其它程序占用，会自动在 1421–1440 中选择第一个空闲端口。首次运行需要下载并编译 Rust 依赖，耗时会明显长于后续启动。

只调试前端：

```powershell
bun run dev
```

该命令固定使用 1530 端口并启用 `strictPort`，端口被占用时会直接失败。`bun run preview` 只预览已构建的前端，Tauri `invoke` 相关功能不可用。

## 打包与产物

唯一的打包入口：

```powershell
bun run tauri:build
```

该脚本（`scripts/package-portable.ps1`）会：

1. 检查 `node`、`bun`、`cargo` 是否存在，以及 `node_modules` 是否已安装。
2. 校验 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 三处版本号一致。
3. 设置 `CARGO_INCREMENTAL=0`，执行 `tauri build --no-bundle`（内部先跑 `bun run build`）。
4. 把 `src-tauri/target/release/resp-app.exe` 复制为唯一产物，并清理旧文件和残留的 `bundle/` 目录。

产物路径（版本号来自 `src-tauri/tauri.conf.json`，当前为 `1.0.0`）：

```text
dist-release\RedisDesktopManager_1.0.0_portable_x64.exe
```

这是一个单文件绿色版，**不生成 NSIS/MSI 安装包**。`dist-release/` 与 `*.exe` 已被 `.gitignore` 忽略，不会进入版本库。

## 目录结构

```text
.
├─ src/                         React 前端
│  ├─ features/
│  │  ├─ connections/           连接编辑对话框
│  │  ├─ tree/                  连接树、过滤、批量操作
│  │  ├─ value/                 值查看/编辑、formatter、Add Key
│  │  ├─ console/               命令控制台
│  │  ├─ server/                服务器视图、MONITOR、STATS
│  │  └─ shell/                 工具栏、标签栏、设置、欢迎页、日志
│  ├─ lib/                      IPC 封装、类型、默认值、i18n
│  ├─ components/ui/            Button、Dialog、Menu、字段等基础组件
│  └─ styles/globals.css        主题变量、字号档位、响应式断点
├─ src-tauri/                   Rust 后端
│  ├─ src/commands/             Tauri command 入口
│  ├─ src/db/                   迁移与 SQLite 仓储
│  ├─ src/models/               IPC 数据结构
│  ├─ src/redis/                连接池、SCAN、值读写、Live Update、Monitor
│  ├─ src/lib.rs                应用装配、窗口关闭与退出清理
│  ├─ tauri.conf.json           窗口、产品名、标识符
│  └─ Cargo.toml                Rust 依赖与 crate 名
├─ scripts/
│  ├─ package-portable.ps1       唯一打包脚本
│  └─ lib-versions.ps1           版本一致性检查
├─ dist-release/                 打包产物（gitignored）
├─ package.json
├─ vite.config.ts
└─ AGENTS.md                     Vite+ 工具链约定
```

## 验证与质量

在仓库根目录执行，以下结果为本仓库当前实测：

| 命令                                                       | 作用                              | 实测结果                                  |
| ---------------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `bun run check:types`                                      | `tsc --noEmit` 类型检查           | 通过                                      |
| `bun run build`                                            | 类型检查 + `vp build`             | 通过；59 modules，产物在 `dist/`          |
| `bun x vp check --no-fmt`                                  | Oxlint + 类型感知检查（不格式化） | 通过；43 files，无 warning/lint/type 错误 |
| `cargo test --manifest-path src-tauri\Cargo.toml`          | Rust 单元测试                     | 51 passed，0 failed，1 ignored            |
| `cargo check --tests --manifest-path src-tauri\Cargo.toml` | Rust 编译检查                     | 可用于快速检查测试代码编译                |

被忽略的测试是只读冒烟测试 `read_only_smoke`，需要真实服务器环境才运行：

```powershell
$env:RESP_TEST_HOST = "<host>"
$env:RESP_TEST_PORT = "6379"
$env:RESP_TEST_PASSWORD = "<password>"
cargo test --manifest-path src-tauri\Cargo.toml read_only_smoke -- --ignored --nocapture
```

前端目前没有 `*.test.*` / `*.spec.*` 文件，自动化测试集中在 Rust 侧。

## 数据与配置

应用启动时通过 Tauri 的 `app_data_dir()` 创建数据目录，数据库文件为：

```text
%APPDATA%\app.resp.desktop\resp.sqlite3
```

本机实测该路径存在（标识符 `app.resp.desktop` 来自 `src-tauri/tauri.conf.json`）。

SQLite 表：

- `connections`：连接配置，包括主机、端口、认证、TLS、SSH 字段、超时、协议等。
- `connection_groups`：连接分组。
- `filter_history`：每个连接的键过滤历史。
- `app_settings`：应用设置，按 JSON 存储。

设置迁移按 `settings_schema_version` 只执行一次，仅在存储值仍等于旧默认值时改写；迁移失败只记录日志，不阻塞启动。

注意：

- 连接用户名、密码等凭据保存在本地 SQLite 中，**明文存储**，未使用 Windows DPAPI 加密。
- 应用不读取 `.env` / `.env.*`；这些文件只被 `.gitignore` 忽略。
- 卸载或删除应用前如需保留配置，请备份上述 `resp.sqlite3`。

## 常见问题

**Q：启动时提示端口 1530 被占用。**

`bun run dev`（只调试前端）仍固定使用 1530 并启用 `strictPort`，占用时会直接失败，请先关闭占用该端口的进程。`bun run tauri:dev` 会自动处理：如果是本仓库自己的残留 dev server，会直接复用、不再启动第二份；如果是其它程序占用，会自动选用 1421–1440 中第一个空闲端口。

**Q：启动后窗口空白或提示缺少 WebView2。**

安装 Microsoft Edge WebView2 Evergreen Runtime 后重试。Windows 10/11 正常版本通常已自带。

**Q：Rust 编译出现 `no entry found for key` 之类的 ICE。**

已知本地 `target/release/incremental` 缓存损坏会触发 rustc ICE。打包脚本已默认设置 `CARGO_INCREMENTAL=0`；手动运行 cargo 时可执行：

```powershell
$env:CARGO_INCREMENTAL = "0"
```

**Q：打包提示 `node_modules is missing`。**

先执行 `bun install`，再运行 `bun run tauri:build`。

**Q：为什么没有安装包？**

这是刻意设计：`tauri:build` 使用 `--no-bundle`，只保留单文件绿色版，并确保 `dist-release/` 中恰好有一个 exe。

## 已知限制

- 发布产物仅面向 Windows x64；运行依赖系统 WebView2。
- 不提供 NSIS/MSI 安装包，只产出绿色版 exe。
- 单窗口应用，无系统托盘；关闭主窗口即退出。
- 不支持 Redis Cluster 集群连接，只连接单个 Redis 节点。
- SSH 隧道暂不支持；相关配置只做保存。
- TLS 只应用 `rediss://` 与“忽略证书错误”，不加载自定义 CA / 客户端证书。
- 凭据在本地 SQLite 中明文存储。
- 不提供 RDB 文件导入。
- 前端暂无自动化测试。
