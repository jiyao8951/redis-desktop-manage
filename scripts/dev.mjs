#!/usr/bin/env bun
/**
 * Development launcher: picks a usable frontend dev-server port and starts
 * Tauri pointed at it, without ever starting a second Vite by accident.
 *
 * 1530 free            -> start Vite on 1530.
 * 1530 held by THIS repo's vite/vp dev -> reuse it (no second server).
 * 1530 held by anything else -> first free port in 1421..1440.
 */
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 1530;
const MAX_PORT = 1440;
const IS_WIN = process.platform === "win32";
// Stable dev-only WebView2 profile next to the app's data directory. Kept out
// of the repo so it survives clean checkouts, and separate from the release
// profile so dev and packaged runs never fight over the same folder.
const DEV_WEBVIEW_DIR = path.join(
  process.env.LOCALAPPDATA ?? os.homedir(),
  "app.resp.desktop",
  "webview2-dev",
);

function cargoDevEnv() {
  if (process.env.CARGO_INCREMENTAL !== undefined) {
    log(`沿用已有 CARGO_INCREMENTAL=${process.env.CARGO_INCREMENTAL}`);
    return {};
  }
  log("设置 CARGO_INCREMENTAL=0（规避本地增量缓存导致的 rustc ICE，仅 dev 子进程）");
  return { CARGO_INCREMENTAL: "0" };
}

function webview2DevEnv() {
  if (process.env.WEBVIEW2_USER_DATA_FOLDER) {
    log(`沿用已有 WEBVIEW2_USER_DATA_FOLDER=${process.env.WEBVIEW2_USER_DATA_FOLDER}`);
    return {};
  }
  fs.mkdirSync(DEV_WEBVIEW_DIR, { recursive: true });
  log(`WebView2 dev 数据目录：${DEV_WEBVIEW_DIR}（仅 dev 子进程，退出后保留）`);
  return { WEBVIEW2_USER_DATA_FOLDER: DEV_WEBVIEW_DIR };
}

const children = new Set();
const extraKills = new Set();
let tempConfig = null;
let cleaned = false;

function log(message) {
  console.log(`[dev] ${message}`);
}

// Synchronous on purpose: cleanup runs from process exit handlers, so the
// taskkill must finish before this process disappears.
function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const child of children) killTree(child.pid);
  for (const pid of extraKills) killTree(pid);
  if (tempConfig) {
    try {
      fs.rmSync(tempConfig, { force: true });
    } catch {
      /* ignore */
    }
    tempConfig = null;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
process.on("exit", cleanup);

function bindOnce(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port, host });
  });
}

// Vite listens on `localhost`, which may resolve to 127.0.0.1 or ::1 (Windows
// commonly reports ::1 only). Both loopback families must be free to call the
// port usable.
async function canBind(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    if (!(await bindOnce(port, host))) return false;
  }
  return true;
}

function portOwner(port) {
  if (!IS_WIN) return null;
  try {
    const script =
      `$p = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -First 1).OwningProcess; if ($p) { $c = Get-CimInstance Win32_Process -Filter "ProcessId=$p"; ` +
      `Write-Output ($p.ToString() + "|" + $c.CommandLine) }`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
    }).trim();
    if (!out) return null;
    const [pid, command] = out.split("|");
    return { pid: Number(pid), command: command ?? "" };
  } catch {
    return null;
  }
}

function isThisRepoDevServer(owner) {
  if (!owner?.command) return false;
  const cmd = owner.command.toLowerCase().replace(/\\/g, "/");
  const repo = root.toLowerCase().replace(/\\/g, "/");
  return cmd.includes(repo) && /(vite|vite-plus|vp\.exe|vp dev|--strictport)/.test(cmd);
}

function connectOnce(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if ((await connectOnce(port, "127.0.0.1")) || (await connectOnce(port, "::1"))) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待端口 ${port} 超时`);
}

async function choosePort() {
  if (await canBind(DEFAULT_PORT)) {
    log(`${DEFAULT_PORT} 空闲 → 使用 ${DEFAULT_PORT}（新起 Vite）`);
    return { port: DEFAULT_PORT, startVite: true };
  }
  const owner = portOwner(DEFAULT_PORT);
  if (owner && isThisRepoDevServer(owner)) {
    log(`${DEFAULT_PORT} 被本仓库 dev server 占用（PID ${owner.pid}）→ 复用，不再启动第二份 Vite`);
    log(`复用已有 dev server：退出时不会关闭它（PID ${owner.pid}）`);
    return { port: DEFAULT_PORT, startVite: false };
  }
  log(
    `${DEFAULT_PORT} 被其它进程占用（PID ${owner?.pid ?? "未知"}）→ 从 ${DEFAULT_PORT + 1} 向上寻找空闲端口`,
  );
  for (let port = DEFAULT_PORT + 1; port <= MAX_PORT; port++) {
    if (await canBind(port)) {
      log(`选用空闲端口 ${port}（新起 Vite）`);
      return { port, startVite: true };
    }
  }
  throw new Error(`端口 ${DEFAULT_PORT + 1}–${MAX_PORT} 全部被占用，无法启动开发服务器`);
}

function findNode() {
  if (process.versions.bun) {
    try {
      const nodePath = execFileSync(IS_WIN ? "where.exe" : "which", ["node"], { encoding: "utf8" })
        .split(/\r?\n/)[0]
        .trim();
      if (nodePath) return nodePath;
    } catch {
      /* fall through to the current runtime */
    }
  }
  return process.execPath;
}

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

async function main() {
  const { port, startVite } = await choosePort();

  let vite = null;
  if (startVite) {
    const vp = path.join(root, "node_modules", ".bin", IS_WIN ? "vp.exe" : "vp");
    if (!fs.existsSync(vp)) throw new Error(`找不到 vp 可执行文件：${vp}（请先 bun install）`);
    vite = run(vp, ["dev", "--port", String(port), "--strictPort"]);
    vite.once("exit", (code) => {
      if (!cleaned) {
        console.error(`[dev] Vite 提前退出（code ${code ?? "?"}）`);
        cleanup();
        process.exit(code ?? 1);
      }
    });
    await waitForPort(port);
    // vp may hand the listener to a child node process; remember both so a
    // hard shutdown cannot leave Vite behind.
    const listener = portOwner(port);
    if (listener?.pid && listener.pid !== vite.pid) extraKills.add(listener.pid);
    log(`Vite 已在 ${port} 端口就绪`);
  }

  tempConfig = path.join(os.tmpdir(), `rdm-tauri-dev-${process.pid}.json`);
  fs.writeFileSync(
    tempConfig,
    JSON.stringify({ build: { devUrl: `http://localhost:${port}`, beforeDevCommand: null } }),
  );

  const tauriCli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!fs.existsSync(tauriCli))
    throw new Error(`找不到 Tauri CLI：${tauriCli}（请先 bun install）`);
  const devEnv = { ...webview2DevEnv(), ...cargoDevEnv() };
  log(`启动 Tauri dev（devUrl=http://localhost:${port}，beforeDevCommand=null）`);

  // Tauri CLI is a CommonJS entry that loads a native addon; run it with Node
  // even though this wrapper itself may be executed by Bun.
  const node = findNode();
  const tauri = run(node, [tauriCli, "dev", "--config", tempConfig], devEnv);
  tauri.once("exit", (code) => {
    log(`Tauri dev 已退出（code ${code ?? "?"}）`);
    if (vite) killTree(vite.pid);
    cleanup();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[dev] 启动失败：${error instanceof Error ? error.message : String(error)}`);
  cleanup();
  process.exit(1);
});
