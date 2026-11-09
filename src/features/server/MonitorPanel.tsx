import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import Button from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/fields";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";
import type { MonitorEndedEvent, MonitorLineEvent } from "../../lib/types";

/** Hard cap on retained lines so a busy server cannot grow memory forever. */
const MAX_LINES = 2000;
/** Buffered flush interval: MONITOR can emit thousands of lines per second. */
const FLUSH_MS = 250;
/** Lines longer than this are truncated for display with a "view full" toggle. */
const MAX_LINE_DISPLAY = 240;

type CommandKind = "read" | "write" | "delete" | "danger" | "other";

interface MonitorEntry {
  id: number;
  raw: string;
  timestamp: string;
  db: string;
  client: string;
  /** Uppercase command name, "" when the line could not be parsed. */
  command: string;
  kind: CommandKind;
}

const READ_COMMANDS = new Set([
  "get", "mget", "getrange", "strlen", "exists", "ttl", "pttl", "type", "keys", "scan",
  "hget", "hmget", "hgetall", "hkeys", "hvals", "hlen", "hexists", "hstrlen",
  "lrange", "llen", "lindex", "lpos", "smembers", "sismember", "smismember", "scard",
  "srandmember", "zrange", "zrangebyscore", "zrevrange", "zrank", "zrevrank", "zscore",
  "zcard", "zcount", "zlexcount", "xrange", "xrevrange", "xlen", "xinfo", "info", "dbsize",
  "ping", "echo", "time", "json.get", "json.type", "json.arrlen", "geopos", "geodist",
  "geosearch", "pfcount", "bitcount", "getbit", "dump", "object", "memory", "command",
  "slowlog", "client", "config", "acl", "role", "lastsave", "randomkey", "lolwut",
]);

const WRITE_COMMANDS = new Set([
  "set", "setnx", "setex", "psetex", "append", "getset", "getdel", "getex", "setrange",
  "mset", "msetnx", "incr", "decr", "incrby", "decrby", "incrbyfloat", "setbit", "bitop",
  "hset", "hsetnx", "hmset", "hincrby", "hincrbyfloat", "lpush", "rpush", "lpushx", "rpushx",
  "linsert", "lset", "ltrim", "rpoplpush", "lmove", "sadd", "smove", "spop", "zadd",
  "zincrby", "zpopmin", "zpopmax", "zrangestore", "geoadd", "pfadd", "pfmerge", "xadd",
  "json.set", "json.arrappend", "json.arrinsert", "json.numincrby", "json.merge",
  "expire", "expireat", "pexpire", "pexpireat", "persist",
]);

const DELETE_COMMANDS = new Set([
  "del", "unlink", "hdel", "lpop", "rpop", "lrem", "srem", "zrem", "zremrangebyscore",
  "zremrangebyrank", "zremrangebylex", "xdel", "xtrim", "rename", "renamenx", "move",
  "json.del", "getdel", "flushdb", "flushall",
]);

const DANGER_COMMANDS = new Set([
  "flushall", "flushdb", "shutdown", "debug", "monitor", "config", "script", "acl",
  "module", "replicaof", "slaveof", "swapdb", "migrate", "failover", "save", "bgsave",
  "bgrewriteaof", "cluster", "reset",
]);

function classify(command: string): CommandKind {
  const name = command.toLowerCase();
  if (!name) return "other";
  if (DANGER_COMMANDS.has(name)) return "danger";
  if (DELETE_COMMANDS.has(name)) return "delete";
  if (WRITE_COMMANDS.has(name)) return "write";
  if (READ_COMMANDS.has(name)) return "read";
  return "other";
}

const LINE_PATTERN = /^(\S+)\s+\[(\d+)\s+([^\]]+)\]\s+(.*)$/;

function parseLine(raw: string, id: number): MonitorEntry {
  const match = LINE_PATTERN.exec(raw);
  if (!match) {
    return { id, raw, timestamp: "", db: "", client: "", command: "", kind: "other" };
  }
  const command = /^"([^"]*)"/.exec(match[4])?.[1] ?? "";
  return {
    id,
    raw,
    timestamp: match[1],
    db: match[2],
    client: match[3],
    command: command.toUpperCase(),
    kind: classify(command),
  };
}

function kindBorder(kind: CommandKind): string {
  switch (kind) {
    case "read":
      return "border-l-accent/60";
    case "write":
      return "border-l-success/70";
    case "delete":
      return "border-l-danger/50";
    case "danger":
      return "border-l-danger";
    default:
      return "border-l-border";
  }
}

/** Replaces credential-bearing arguments before a log line is exported. */
export function maskMonitorLine(line: string): string {
  const split = /^(\S+\s+\[\d+\s+[^\]]+\]\s+)(.*)$/.exec(line);
  if (!split) return line;
  const prefix = split[1];
  const rest = split[2];
  const name = /^"([^"]*)"/.exec(rest)?.[1]?.toUpperCase() ?? "";

  if (name === "AUTH") {
    return prefix + rest.replace(/^"AUTH"(?:\s+"[^"]*")+/i, '"AUTH" "***"');
  }
  if (name === "HELLO") {
    return prefix + rest.replace(/"AUTH"\s+"[^"]*"\s+"[^"]*"/i, '"AUTH" "***" "***"');
  }
  if (name === "CONFIG") {
    return prefix + rest.replace(/("CONFIG"\s+"SET"\s+"requirepass"\s+)"[^"]*"/i, '$1"***"');
  }
  if (name === "SETEX" || name === "PSETEX") {
    return prefix + rest.replace(/("(?:SETEX|PSETEX)"\s+"[^"]*"\s+"[^"]*"\s+)"[^"]*"/i, '$1"***"');
  }
  if (name === "ACL") {
    return prefix + rest.replace(/">([^"]*)"/g, '">***"');
  }
  return line;
}

/**
 * Streams MONITOR output from the dedicated backend connection.
 *
 * The backend owns the socket (never the shared pool) and emits `monitor-line`.
 * This component keeps a bounded ring buffer, filters it client-side and
 * always stops the backend stream when it unmounts (tab closed, view switched).
 */
export default function MonitorPanel({
  connectionId,
  connectionName,
  onNotify,
  onLog,
}: {
  connectionId: string;
  connectionName: string;
  onNotify: (message: string) => void;
  onLog: (message: string, level?: "info" | "error") => void;
}) {
  const t = useT();
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [commandFilter, setCommandFilter] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [dbFilter, setDbFilter] = useState("");
  const [entries, setEntries] = useState<MonitorEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [pausedReceived, setPausedReceived] = useState(0);
  const [pausedDropped, setPausedDropped] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [maskSensitive, setMaskSensitive] = useState(true);
  const [expandedLines, setExpandedLines] = useState<Record<number, boolean>>({});

  const pending = useRef<string[]>([]);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const pausedBuffer = useRef<MonitorEntry[]>([]);
  const pausedReceivedRef = useRef(0);
  const pausedDroppedRef = useRef(0);
  const entryId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      const parsed = batch.map((line) => {
        entryId.current += 1;
        return parseLine(line, entryId.current);
      });

      if (pausedRef.current) {
        // Keep the display frozen but retain only the most recent lines.
        const buffer = pausedBuffer.current.concat(parsed);
        const overflow = Math.max(0, buffer.length - MAX_LINES);
        if (overflow > 0) buffer.splice(0, overflow);
        pausedBuffer.current = buffer;
        pausedDroppedRef.current += overflow;
        pausedReceivedRef.current += parsed.length;
        setPausedReceived(pausedReceivedRef.current);
        setPausedDropped(pausedDroppedRef.current);
        return;
      }

      setEntries((prev) => {
        const next = prev.concat(parsed);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }, FLUSH_MS);
    return () => {
      window.clearInterval(timer);
      pending.current = [];
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const offLine = await listen<MonitorLineEvent>("monitor-line", (event) => {
        if (event.payload.connectionId !== connectionId) return;
        // One payload may carry several lines joined by "\n".
        for (const line of event.payload.line.split("\n")) {
          if (line) pending.current.push(line);
        }
      });
      const offEnded = await listen<MonitorEndedEvent>("monitor-ended", (event) => {
        if (event.payload.connectionId !== connectionId) return;
        runningRef.current = false;
        setRunning(false);
        setError(t("monitor.disconnected"));
      });
      if (disposed) {
        offLine();
        offEnded();
        return;
      }
      unlisteners.push(offLine, offEnded);
    })();

    return () => {
      disposed = true;
      unlisteners.forEach((off) => off());
      // Closing the tab (or leaving the view) must release the server-side
      // connection, not merely hide the output.
      if (runningRef.current) {
        runningRef.current = false;
        void ipc.stopMonitor(connectionId).catch(() => undefined);
      }
    };
  }, [connectionId, t]);

  useEffect(() => {
    pending.current = [];
    pausedRef.current = false;
    pausedBuffer.current = [];
    pausedReceivedRef.current = 0;
    pausedDroppedRef.current = 0;
    setEntries([]);
    setPaused(false);
    setPausedReceived(0);
    setPausedDropped(0);
    setExpandedLines({});
  }, [connectionId]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, autoScroll]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await ipc.startMonitor(connectionId);
      runningRef.current = true;
      setRunning(true);
      onLog(t("monitor.logStarted", { name: connectionName }));
    } catch (e) {
      const message = errMessage(e);
      setError(message);
      onNotify(message);
      onLog(t("monitor.logFailed", { name: connectionName, error: message }), "error");
    } finally {
      setStarting(false);
    }
  };

  const resetPauseState = () => {
    pausedRef.current = false;
    pausedBuffer.current = [];
    pausedReceivedRef.current = 0;
    pausedDroppedRef.current = 0;
    setPaused(false);
    setPausedReceived(0);
    setPausedDropped(0);
  };

  const pause = () => {
    pausedRef.current = true;
    pausedBuffer.current = [];
    pausedReceivedRef.current = 0;
    pausedDroppedRef.current = 0;
    setPaused(true);
    setPausedReceived(0);
    setPausedDropped(0);
  };

  const resume = () => {
    const buffered = pausedBuffer.current;
    resetPauseState();
    if (buffered.length > 0) {
      setEntries((prev) => {
        const next = prev.concat(buffered);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }
  };

  const stop = async () => {
    runningRef.current = false;
    setRunning(false);
    resetPauseState();
    await ipc.stopMonitor(connectionId).catch((e) => {
      onLog(t("monitor.logStopFailed", { name: connectionName, error: errMessage(e) }), "error");
    });
  };

  const clear = () => {
    pending.current = [];
    pausedBuffer.current = [];
    if (pausedRef.current) {
      pausedReceivedRef.current = 0;
      pausedDroppedRef.current = 0;
      setPausedReceived(0);
      setPausedDropped(0);
    }
    setEntries([]);
    setExpandedLines({});
  };

  const commandPrefixes = commandFilter
    .split(/[\s,]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  const needle = filter.trim().toLowerCase();
  const clientNeedle = clientFilter.trim().toLowerCase();
  const dbNeedle = dbFilter.trim();

  const visible = entries.filter((entry) => {
    if (needle && !entry.raw.toLowerCase().includes(needle)) return false;
    if (commandPrefixes.length > 0 && !commandPrefixes.some((p) => entry.command.startsWith(p))) {
      return false;
    }
    if (clientNeedle && !entry.client.toLowerCase().includes(clientNeedle)) return false;
    if (dbNeedle && entry.db !== dbNeedle) return false;
    return true;
  });

  const exportLog = () => {
    if (visible.length === 0) {
      onNotify(t("monitor.exportEmpty"));
      return;
    }
    const text = visible
      .map((entry) => (maskSensitive ? maskMonitorLine(entry.raw) : entry.raw))
      .join("\n");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = connectionName.replace(/[^\w.-]+/g, "_") || "redis";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `monitor-${base}-${stamp}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onNotify(t("monitor.exportStarted", { count: visible.length }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border bg-surface px-3 py-2 t-13 leading-[1.45]">
        <div className="font-semibold text-danger">{t("monitor.warningTitle")}</div>
        <div className="text-muted">{t("monitor.warningBody")}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 t-13">
        <Button variant="primary" disabled={running || starting} onClick={() => void start()}>
          {starting ? t("monitor.starting") : t("monitor.start")}
        </Button>
        <Button variant="secondary" disabled={!running} onClick={() => void stop()}>
          {t("monitor.stop")}
        </Button>
        <Button
          variant="secondary"
          disabled={!running}
          onClick={() => (paused ? resume() : pause())}
        >
          {paused ? t("monitor.resume") : t("monitor.pause")}
        </Button>
        <Button variant="ghost" onClick={clear}>
          {t("monitor.clear")}
        </Button>
        <span className={paused ? "t-12 font-semibold text-danger" : "t-12 text-muted"}>
          {paused ? t("monitor.paused") : running ? t("monitor.running") : t("monitor.stopped")}
        </span>
        {paused ? (
          <>
            <span className="t-12 text-muted">
              {t("monitor.pausedStats", {
                received: pausedReceived,
                dropped: pausedDropped,
              })}
            </span>
            <span className="t-11 text-muted">{t("monitor.pausedHint")}</span>
          </>
        ) : null}
        <span className="ml-auto t-12 text-muted">
          {t("monitor.lineCount", { count: entries.length, max: MAX_LINES })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 t-12">
        <input
          className="h-6 w-[170px] rounded-sm border border-border bg-base px-2 t-12 outline-none"
          placeholder={t("monitor.filterPlaceholder")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <input
          className="h-6 w-[150px] rounded-sm border border-border bg-base px-2 t-12 outline-none"
          placeholder={t("monitor.filterCommandPlaceholder")}
          value={commandFilter}
          onChange={(event) => setCommandFilter(event.target.value)}
        />
        <input
          className="h-6 w-[150px] rounded-sm border border-border bg-base px-2 t-12 outline-none"
          placeholder={t("monitor.filterClientPlaceholder")}
          value={clientFilter}
          onChange={(event) => setClientFilter(event.target.value)}
        />
        <input
          className="h-6 w-[80px] rounded-sm border border-border bg-base px-2 t-12 outline-none"
          placeholder={t("monitor.filterDbPlaceholder")}
          value={dbFilter}
          onChange={(event) => setDbFilter(event.target.value)}
        />
        <Checkbox
          checked={autoScroll}
          onChange={setAutoScroll}
          label={<span className="t-12 text-muted">{t("monitor.autoScroll")}</span>}
        />
        <Checkbox
          checked={maskSensitive}
          onChange={setMaskSensitive}
          label={<span className="t-12 text-muted">{t("monitor.exportMask")}</span>}
        />
        {!maskSensitive ? (
          <span className="t-11 text-danger">{t("monitor.exportRisk")}</span>
        ) : null}
        <Button variant="secondary" className="ml-auto" onClick={exportLog} disabled={visible.length === 0}>
          {t("monitor.export")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-1 t-11 text-muted">
        <span className="border-l-2 border-l-accent/60 pl-1">{t("monitor.kindRead")}</span>
        <span className="border-l-2 border-l-success/70 pl-1">{t("monitor.kindWrite")}</span>
        <span className="border-l-2 border-l-danger/50 pl-1">{t("monitor.kindDelete")}</span>
        <span className="border-l-2 border-l-danger pl-1">{t("monitor.kindDanger")}</span>
        <span className="ml-auto">
          {t("monitor.filteredCount", { shown: visible.length, total: entries.length })}
        </span>
      </div>

      {error ? (
        <div className="border-b border-border bg-surface px-3 py-2 t-13 text-danger">
          {error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-auto px-3 py-2 font-mono t-content leading-[1.5]"
          onScroll={(event) => {
            const el = event.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 12);
          }}
        >
          {visible.length === 0 ? (
            <p className="text-muted">
              {running ? t("monitor.emptyRunning") : t("monitor.empty")}
            </p>
          ) : (
            visible.map((entry) => {
              const full = expandedLines[entry.id] ?? false;
              const truncated = !full && entry.raw.length > MAX_LINE_DISPLAY;
              return (
                <div
                  key={entry.id}
                  className={`whitespace-pre-wrap break-all border-l-2 pl-2 leading-[1.5] ${kindBorder(entry.kind)}`}
                >
                  {truncated ? `${entry.raw.slice(0, MAX_LINE_DISPLAY)}…` : entry.raw}
                  {entry.raw.length > MAX_LINE_DISPLAY ? (
                    <button
                      type="button"
                      className="ml-2 t-11 text-muted underline decoration-dotted hover:text-text"
                      onClick={() =>
                        setExpandedLines((prev) => ({ ...prev, [entry.id]: !full }))
                      }
                    >
                      {full ? t("monitor.collapseLine") : t("monitor.viewFull")}
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        {!atBottom && visible.length > 0 ? (
          <button
            type="button"
            className="absolute bottom-3 right-4 rounded-sm border border-border bg-surface px-2 py-1 t-12 text-text shadow-lg hover:bg-win"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setAtBottom(true);
            }}
          >
            {t("monitor.jumpToBottom")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
