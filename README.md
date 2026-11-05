# Redis Desktop Manager (Tauri v2 rebuild)

A Tauri v2 + React desktop client for Redis, rebuilt from the original open-source
Redis Desktop Manager (QML/C++) sources. The original sources under `../src` are
the functional and visual reference; nothing outside `new/` is modified.

Implemented: application shell, connection management (SQLite CRUD, groups,
import/export, duplicate), connection tree with namespaces and lazy SCAN,
value viewer/editor, console, server actions (stats charts, INFO, slow log,
clients, memory), live update, settings, delete/regroup/add-key flows and the
write commands listed below.

> **Verification status:** `cargo check --tests`,
> `bun x tsc --noEmit` (same as `bun run check:types`), `bun run build` and
> `bun x vp check` pass. `bun x vp test` reports no test files. The application
> has not been launched, no screenshots were taken and no installer was
> produced in this workspace. See [Not verified yet](#not-verified-yet) —
> treat that list as required manual acceptance work.

## Requirements

- Node.js 20.19+ (the Vite+ 1.4.0 toolchain requires `^20.19` / `^22.18` / `>=24.11`)
- Bun (all install and run commands use `bun`; `bun.lock` is the only lockfile)
- Rust stable with the `x86_64-pc-windows-msvc` target
- WebView2 runtime (Windows 10/11 usually ships it)
- Tauri bundling prerequisites (NSIS/WiX are downloaded by the Tauri CLI on
  the first bundle run)

## Commands

Run every command from `new/`. The frontend toolchain is **Vite+ 1.4.0
(`vp`)**, which bundles Vite 8.3.5, Rolldown, Oxlint/Oxfmt and Vitest; the
`dev`, `build` and `preview` scripts call `vp`, so Vite 8 is not downgraded.
`bun run <script>` and `vp run <script>` both execute the `package.json` script
with that name.

| Goal                    | Command (run in `new/`)                                              | Status / notes                                                                                     |
| ----------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| First-time install      | `bun install`                                                        | not re-run in this round; `bun.lock` is the only lockfile (no `package-lock.json` is kept)         |
| Desktop dev             | `bun run tauri:dev`                                                  | **not verified** — launches the Tauri window                                                       |
| Frontend dev only       | `bun run dev`                                                        | **partly verified** — `vp dev --port 1420 --strictPort`; see the note below                        |
| Type check              | `bun run check:types`                                                | verified, exit 0 (`tsc --noEmit`)                                                                  |
| Production frontend     | `bun run build`                                                      | verified, exit 0 (`tsc --noEmit && vp build`; output in `new/dist/`)                               |
| Preview built frontend  | `bun run preview`                                                    | **not verified** — `vp preview`; frontend only, `invoke` calls fail                                |
| Build installers        | `bun run tauri:build`                                                | **not verified** — `tauri build` with NSIS + MSI from `tauri.conf.json`                            |
| Build via script        | `powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1` | **not verified** — version check + `bun install` + bundles; add `-Bundles nsis` for NSIS only      |
| Package portable exe    | `bun run package:portable`                                           | release exe only (no NSIS/MSI); rewrites `dist-release/RedisDesktopManager_<version>_portable_x64.exe` |
| Lint, format, types     | `bun x vp check`                                                     | verified, exit 0 (39 files; formatting, lint rules and type-aware check)                           |
| Lint without formatting | `bun x vp check --no-fmt`                                            | verified, exit 0                                                                                   |
| Frontend tests          | `bun x vp test`                                                      | exit 1 — no `*.test.*` / `*.spec.*` files exist; the Rust tests below are the only automated tests |
| Rust checks             | `cargo check --tests --manifest-path src-tauri\Cargo.toml`           | verified, exit 0                                                                                   |
| Legacy alias            | `bun run tauri -- <args>`                                            | kept for compatibility; prefer `tauri:dev` / `tauri:build`                                         |

`vite.config.ts` already uses Vite+'s `defineConfig` and `lazyPlugins`, and
`vp build` accepts the existing `server.port` / `server.strictPort` and
`build.minify: "oxc"` settings, so no configuration change was needed.

Note on the frontend dev server: port 1420 was already occupied on this
machine, so `bun run dev` exited with `Port 1420 is already in use` (which
confirms `strictPort` works) and a cold start of `vp dev` is still unverified.

Warm Rust dependencies before the first build (optional; not verified in this
round):

```powershell
cargo fetch --manifest-path src-tauri\Cargo.toml
```

Artifacts (version comes from `src-tauri/tauri.conf.json`):

- portable exe: `new/src-tauri/target/release/resp-app.exe`
- NSIS setup: `new/src-tauri/target/release/bundle/nsis/Redis Desktop Manager_1.0.0_x64-setup.exe`
- MSI: `new/src-tauri/target/release/bundle/msi/Redis Desktop Manager_1.0.0_x64_en-US.msi`

The script checks that `package.json`, `Cargo.toml` and `tauri.conf.json`
versions match before building.

Optional read-only smoke test against a real server (never sends writes):

```powershell
$env:RESP_TEST_HOST = "<host>"
$env:RESP_TEST_PORT = "6379"
$env:RESP_TEST_PASSWORD = "<password>"
cargo test --manifest-path src-tauri\Cargo.toml read_only_smoke -- --ignored --nocapture
```

To check Live Update readiness, also run this read-only command with your
password:

```powershell
redis-cli -h <host> -a <password> CONFIG GET notify-keyspace-events
```

## Write capability matrix

The UI and backend follow the original QML/C++ implementation. `update` means
editing an existing row/value, `add` a new row, `delete` removing a row (not
the whole key). Every destructive UI action asks for confirmation with the
original wording.

| Type   | Update                                                                                                 | Add                                                  | Delete row                                                          |
| ------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------- |
| string | `SET key value`                                                                                        | `SET key value` (Add Key)                            | `DEL key` (Delete Key)                                              |
| hash   | field renamed: `HDEL key field` + `HSET key newField value`; value only: `HSET key field value`        | `HSETNX key field value`                             | `HDEL key field`                                                    |
| set    | `SREM key member` + `SADD key newMember`                                                               | `SADD key member`                                    | `SREM key member`                                                   |
| zset   | member renamed: `ZREM key member` + `ZADD key score newMember`; score only: `ZADD key XX score member` | `ZADD key score member`                              | `ZREM key member`                                                   |
| list   | `LSET key position value`                                                                              | `LPUSH key value` (original ListKeyModel uses LPUSH) | `LSET key position <unique-token>` then `LREM key 0 <unique-token>` |
| stream | not supported (original rejects it)                                                                    | `XADD key id field value ...` (`*` = auto id)        | `XDEL key id`                                                       |

Other write paths:

| Action                              | Command(s)                                                            |
| ----------------------------------- | --------------------------------------------------------------------- |
| Add Key (hash/zset/list/set/stream) | `HSETNX` / `ZADD` / `LPUSH` / `SADD` / `XADD`                         |
| Add Key overwrite (confirmed)       | `DEL` then the type-specific add                                      |
| Delete Key                          | `DEL key`                                                             |
| Delete Keys with Filter             | `SCAN MATCH <pattern>` + `DEL` in batches of 500                      |
| Flush Database                      | `FLUSHDB`                                                             |
| Set TTL                             | `EXPIRE key seconds`                                                  |
| Bulk TTL (pattern)                  | `SCAN MATCH <pattern>` + `EXPIRE` per key                             |
| Persist TTL                         | `PERSIST key`                                                         |
| Rename Key                          | `DUMP key` + `RESTORE newKey <ttl> <payload>` + `DEL key`             |
| Copy Keys to another db             | source `DUMP key` + target `RESTORE key <ttl ms> <payload> [REPLACE]` |
| Regroup / move connection           | local SQLite `UPDATE connections SET group_id`                        |

Write path unit tests live in `src-tauri/src/redis/write.rs` and assert the
exact argument order without contacting a server:
`cargo test --manifest-path src-tauri\Cargo.toml write::tests`.

The list row delete uses a random marker (`__resp_deleted_<uuid>__`) so an
existing element with the same value can never be removed by `LREM`.

## Live Update preconditions

Live Update opens a **dedicated** pub/sub connection per `(connection, db)`
(`PSUBSCRIBE __keyspace@{db}__:*`); it never reuses the shared connection pool.
The backend turns messages into a Tauri `live-update` event and the tree does at
most one reload per `liveUpdateInterval` seconds.

Keyspace notifications must be enabled on the Redis server:

```
notify-keyspace-events "KEA"
```

`K` enables keyspace channels, `E` enables keyevent channels, `A` is the alias
for all event classes (`g$lshzxe`). For this feature `K` plus at least one
class is required: `KEA` covers every command, while `Kg` only reports generic
events (`del`, `expire`, `rename`, …) and misses `set`/`hset`/`sadd`/`zadd`
changes. Apply it in `redis.conf` or with
`CONFIG SET notify-keyspace-events KEA` (an administrator action; this client
never sends `CONFIG SET`).

When notifications are off (empty value):

- `PSUBSCRIBE` still succeeds and the UI can show Live Update as enabled;
- no keyspace messages arrive, so the tree simply does not auto-refresh;
- nothing crashes, and toggling Live Update off still closes the dedicated
  connection.

Read-only probe result for the shared development test database: the
TCP port is reachable, but the server answered `NOAUTH Authentication required`
to `CONFIG GET notify-keyspace-events` because no credentials were available in
this workspace. The effective value is therefore **unverified**; run
`CONFIG GET notify-keyspace-events` with the password before testing Live
Update.

## Persistence and credentials

`rusqlite` (bundled SQLite) is used so schema migrations, settings and
connections stay in Rust; the database handle never runs on the UI thread.
File: `%APPDATA%\app.resp.desktop\resp.sqlite3`. Tables: `connections`,
`connection_groups`, `filter_history`, `app_settings`.

- Credentials are entered by the user and stored in the local SQLite file,
  plaintext at rest (same model as the original `connections.json`). Windows
  DPAPI protection is still a hardening task.
- `.env` / `.env.*` are gitignored. The application does not read them.
- Settings are stored as JSON under the `app_settings` key. A startup migration
  keyed by `settings_schema_version` rewrites historical defaults (for example
  `liveUpdateKeysLimit: 10000` → `1000`) exactly once, only when the persisted
  value still equals the old default. A migration failure is logged and does
  not block startup.

## Redis client behaviour

- `redis` crate 0.27 with `tokio-comp`, `connection-manager`,
  `tokio-rustls-comp`, `tls-rustls-insecure`.
- One `ConnectionManager` per `(connection id, db)`. The db is part of the URL
  path, so no `SELECT` is issued on the shared multiplexed connection.
- `rediss://` for TLS; `#insecure` when "ignore SSL errors" is on. Custom CA /
  client certificate files are persisted but **not applied** (see gaps).
- SSH tunnel settings are persisted and rejected with the original OSS
  "not supported" message.
- RESP: `resp2` by default; `?protocol=resp3` when selected, with fallback to
  RESP2 reported as a warning by "Test Connection".
- `executeTimeout` and `connectionTimeout` wrap each command and connection
  creation, clamped to 500 ms..600 s.
- Database list comes from `INFO keyspace`, padding empty databases up to the
  configured `databases` value, matching `TreeOperations::loadDatabases()`.
- SCAN uses `COUNT <scanPageSize>`; the cursor crosses IPC as a decimal string.
- TYPE/TTL are batched with `Semaphore(8)` + `JoinSet`; failed lookups yield
  `type=unknown, ttl=-2` so the UI does not re-queue forever.
- Namespace grouping follows `keysrendering.cpp`, including the
  `showNamespacesOnTop`, `reopenNamespacesOnReload` and
  `namespacedKeysShortName` settings.
- Value loading respects `valueSizeLimit`; table pages respect
  `valueEditorPageSize`; defaults and clamps mirror `GlobalSettings.qml`.

## Remaining original features: feasibility

| Feature                            | Original support                                                                                                               | Current state                                                                                                   | Cost / decision                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copy Keys                          | Yes: `BulkOperations` CopyOperation, `DUMP`/`RESTORE` with REPLACE and TTL                                                     | Implemented: destination connection + db index, pattern, TTL, replace checkbox                                  | Low; done                                                                                                                                                                             |
| Bulk TTL                           | Yes: `TtlOperation`, pipelined `EXPIRE` over a key pattern                                                                     | Implemented: pattern + seconds, confirmation                                                                    | Low; done                                                                                                                                                                             |
| Import RDB                         | Yes: `RdbImport` shells out to Python `rdb` (rdbtools) and converts keys to Redis commands                                     | Not implemented                                                                                                 | High: requires a Python runtime plus `rdbtools`, or a native RDB parser; no such dependency exists in the Rust tree. Deliberately no stub menu item                                   |
| Formatter coverage                 | Built-ins Plain Text, HEX, HEX TABLE, JSON, BASE64→Text plus embedded Python formatters and an external formatter server       | Built-ins are implemented (auto/text/json/hex/hex-table/base64-text); default formatter is wired per connection | Python formatters are high cost (embed Python). Remaining gap is only third-party formatter plugins                                                                                   |
| Language switching                 | `.ts` translations (`rdm_<locale>.ts`), `app/locale` setting, restart required                                                 | English only                                                                                                    | High: every UI string must be externalised and translated; no fake selector is shown                                                                                                  |
| Proxy                              | Only Qt network proxy (`app/useSystemProxy`, `disableProxyForRedisConnections`); Redis connections deliberately bypass proxies | Not applicable                                                                                                  | Low value for Redis: proxy never applied to Redis connections in the original either. No UI added                                                                                     |
| TLS custom CA / client certificate | Connection dialog stores CA/client cert paths and loads them into `QSslConfiguration`; `ignoreSSLErrors`                       | Persisted; `#insecure` applied; custom CA/cert not applied                                                      | High with redis-rs 0.27: `Client::open` builds its own rustls config and exposes no hook for a custom `ClientConfig`. Would require a dedicated TLS connector or another client crate |
| Cluster connection                 | Yes: cluster mode detection, redirects, `overrideClusterHost`, db 0 only                                                       | Standalone only                                                                                                 | High: `redis` cluster client uses a different model (no per-db `ConnectionManager`, no `SELECT`), and SCAN/namespace/statistics would need node-level handling                        |

## Not verified yet

These require a real Redis server and manual acceptance; no write command was
sent during development.

1. Every row in the write matrix against a disposable database: string, hash,
   set, zset, list, stream update/add/delete.
2. List delete on a list that already contains the marker-like value (must
   remove only the target index).
3. `RESTORE` TTL units for rename and copy (milliseconds), and `BUSYKEY`
   behaviour without REPLACE.
4. Add Key overwrite across different types (confirmed `DEL` before add).
5. Single-key delete, delete-by-filter, `FLUSHDB`, bulk TTL, copy keys.
6. TTL/persist dialogs and rename round-trip (TTL and binary payload).
7. Live Update end-to-end, including `notify-keyspace-events` = `KEA`, event
   payload shape, subscription teardown on tab/tree close and connection
   delete, and the `liveUpdateKeysLimit` auto-disable notice.
8. Regroup drag-and-drop persistence across restart, and "Remove from Group".
9. Settings effects: `scanPageSize`, namespace separator, `valueSizeLimit`,
   `valueEditorPageSize`, fonts, live-update interval/limit.
10. Startup settings migration on an existing SQLite file
    (`liveUpdateKeysLimit` 10000 → 1000) and idempotency on the next launch.
11. Packaging: `scripts/build-windows.ps1`, NSIS languages/icon, window minimum
    size 1024×700, and the portable exe.
12. Statistics charts over a longer session (sample retention, axis rounding).

## Directory map

```
new/
├─ scripts/build-windows.ps1
├─ src/
│  ├─ lib/            types.ts, ipc.ts, defaults.ts, format.ts
│  ├─ components/ui/  Button, fields, Dialog, Menu, Icon
│  └─ features/
│     ├─ shell/       Toolbar, TabBar, WelcomeTab, SettingsDialog, LogDrawer
│     ├─ connections/ ConnectionDialog (tabs, URL import, test)
│     ├─ tree/        ConnectionTree, TreeRow, BulkDialogs, treeModel
│     ├─ value/       ValueTab, ValueEditorPane, AddKeyDialog
│     ├─ console/     ConsoleTab
│     └─ server/      ServerActionsTab, StatsChart
└─ src-tauri/
   ├─ tauri.conf.json  icons/
   └─ src/
      ├─ models/   connection.rs, tree.rs, settings.rs
      ├─ db/       migrations.rs, connections_repo.rs, groups_repo.rs, settings_repo.rs
      ├─ redis/    manager.rs, scan.rs, meta.rs, value.rs, write.rs, live.rs
      └─ commands/ connections.rs, tree.rs, settings.rs, value.rs, server.rs, console.rs
```

## Redis 8 notes

The target server reported `redis_version 8.10.1` during read-only probing,
standalone mode, 16 configured databases, module `vectorset`. New Redis 8 types
are displayed by their `TYPE` string; no additional commands are invented
beyond what the original client issued.
