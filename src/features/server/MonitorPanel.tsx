import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import Button from "../../components/ui/Button";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";
import type { MonitorEndedEvent, MonitorLineEvent } from "../../lib/types";

/** Hard cap on retained lines so a busy server cannot grow memory forever. */
const MAX_LINES = 2000;
/** Buffered flush interval: MONITOR can emit thousands of lines per second. */
const FLUSH_MS = 250;

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
  const [lines, setLines] = useState<string[]>([]);

  const pending = useRef<string[]>([]);
  const runningRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      setLines((prev) => {
        const next = prev.concat(batch);
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
        pending.current.push(event.payload.line);
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
    if (!running) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, running]);

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

  const stop = async () => {
    runningRef.current = false;
    setRunning(false);
    await ipc.stopMonitor(connectionId).catch((e) => {
      onLog(t("monitor.logStopFailed", { name: connectionName, error: errMessage(e) }), "error");
    });
  };

  const clear = () => {
    pending.current = [];
    setLines([]);
  };

  const needle = filter.trim().toLowerCase();
  const visible = needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border bg-surface px-3 py-2 text-[12px] leading-[1.45]">
        <div className="font-semibold text-danger">{t("monitor.warningTitle")}</div>
        <div className="text-muted">{t("monitor.warningBody")}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
        <Button variant="primary" disabled={running || starting} onClick={() => void start()}>
          {starting ? t("monitor.starting") : t("monitor.start")}
        </Button>
        <Button variant="secondary" disabled={!running} onClick={() => void stop()}>
          {t("monitor.stop")}
        </Button>
        <Button variant="ghost" onClick={clear}>
          {t("monitor.clear")}
        </Button>
        <input
          className="h-6 w-[200px] rounded-sm border border-border bg-base px-2 text-[12px] outline-none"
          placeholder={t("monitor.filterPlaceholder")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="text-[11px] text-muted">
          {running ? t("monitor.running") : t("monitor.stopped")}
        </span>
        <span className="ml-auto text-[11px] text-muted">
          {t("monitor.lineCount", { count: lines.length, max: MAX_LINES })}
        </span>
      </div>

      {error ? (
        <div className="border-b border-border bg-surface px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px]">
        {visible.length === 0 ? (
          <p className="text-muted">{running ? t("monitor.emptyRunning") : t("monitor.empty")}</p>
        ) : (
          visible.map((line, index) => (
            <div key={`${index}-${line}`} className="whitespace-pre-wrap break-all leading-[1.5]">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
