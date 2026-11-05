import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import Button from "../../components/ui/Button";
import Menu from "../../components/ui/Menu";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";

interface ConsoleTabProps {
  connectionId: string;
  connectionName: string;
  initialDb: number;
  onNotify: (message: string) => void;
  onLog: (message: string, level?: "info" | "error") => void;
  fontFamily?: string;
  fontSize?: number;
}

interface ConsoleLine {
  id: number;
  kind: "prompt" | "output" | "error" | "info";
  text: string;
}

/** Keep the DOM bounded; the original console also grows but is single-user. */
const MAX_LINES = 5000;
const HISTORY_LIMIT = 200;

/**
 * Mirrors src/qml/console/RedisConsole.qml: one command per Return, Up/Down
 * history, `clear`, and a right-click Clear menu. The original has no output
 * filter, no "errors only" toggle and no batch runner, so neither does this.
 */
export default function ConsoleTab({
  connectionId,
  connectionName,
  initialDb,
  onNotify,
  onLog,
  fontFamily,
  fontSize,
}: ConsoleTabProps) {
  const t = useT();
  const [db, setDb] = useState(initialDb);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const seq = useRef(0);
  const lineId = useRef(0);
  const dbRef = useRef(initialDb);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = `${connectionName}:${db}>`;
  // Output follows the app font size, but never drops below the tier baseline.
  const textStyle = {
    fontFamily: fontFamily || undefined,
    fontSize: fontSize ? `max(${fontSize}px, var(--fs-content))` : undefined,
  };

  const append = (kind: ConsoleLine["kind"], text: string) => {
    setLines((prev) => {
      const next = [...prev, { id: (lineId.current += 1), kind, text }];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  };

  useEffect(() => {
    [
      t("console.startup"),
      t("console.connecting"),
      t("console.connected", { name: connectionName, db: initialDb }),
    ].forEach((text) => append("info", text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const rememberCommand = (command: string) => {
    setHistory((prev) => {
      if (prev[prev.length - 1] === command) return prev;
      return [...prev, command].slice(-HISTORY_LIMIT);
    });
    setHistoryIndex(null);
  };

  const executeOne = async (command: string, ticket: number) => {
    const activeDb = dbRef.current;
    append("prompt", `${connectionName}:${activeDb}> ${command}`);
    try {
      const reply = await ipc.consoleExecute({ connectionId, db: activeDb, command });
      if (seq.current !== ticket) return;
      if (reply.db !== dbRef.current) {
        dbRef.current = reply.db;
        setDb(reply.db);
      }
      append(reply.error ? "error" : "output", reply.output);
      if (reply.error) onLog(`${connectionName}: ${reply.error}`, "error");
    } catch (e) {
      if (seq.current !== ticket) return;
      const message = errMessage(e);
      append("error", message);
      onNotify(message);
      onLog(`${connectionName}: ${message}`, "error");
    }
  };

  const clear = () => {
    seq.current += 1;
    setLines([]);
    setBusy(false);
  };

  const runCommand = async () => {
    const command = input.trim();
    if (!command || busy) return;
    if (command.toLowerCase() === "clear") {
      clear();
      setInput("");
      return;
    }
    const ticket = seq.current;
    setBusy(true);
    setInput("");
    rememberCommand(command);
    await executeOne(command, ticket);
    if (seq.current === ticket) setBusy(false);
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void runCommand();
      return;
    }
    if (event.key === "ArrowUp" && history.length > 0) {
      event.preventDefault();
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(null);
        setInput("");
      } else {
        setHistoryIndex(next);
        setInput(history[next]);
      }
    }
  };

  const colorFor = (kind: ConsoleLine["kind"]): string => {
    switch (kind) {
      case "prompt":
        return "text-accent";
      case "error":
        return "text-danger";
      case "info":
        return "text-muted";
      default:
        return "text-text";
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <div className="flex items-center gap-2 border-b border-border bg-surface/40 px-3 py-1.5">
        <span className="t-13 font-semibold text-text">{t("console.title")}</span>
        <span className="rounded-sm border border-border px-1.5 py-[1px] t-11 text-muted">
          {connectionName} · db{db}
        </span>
        {busy ? <span className="t-12 text-muted">{t("console.waiting")}</span> : null}
        <div className="ml-auto">
          <Button variant="ghost" onClick={clear}>
            {t("console.clear")}
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={textStyle}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-base px-3 py-2 font-mono t-content leading-[var(--ui-editor-leading)]"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuAt({ x: event.clientX, y: event.clientY });
        }}
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center t-content text-muted">
            {t("console.placeholder")}
          </div>
        ) : null}
        {lines.map((line) => (
          <div key={line.id} className={colorFor(line.kind)}>
            {line.text}
          </div>
        ))}
      </div>

      {menuAt ? (
        <div className="fixed z-20" style={{ left: menuAt.x, top: menuAt.y }}>
          <Menu
            items={[
              {
                key: "clear",
                label: t("console.clear"),
                onClick: () => {
                  clear();
                  setMenuAt(null);
                },
              },
            ]}
            onClose={() => setMenuAt(null)}
          />
        </div>
      ) : null}

      <div
        style={textStyle}
        className="flex items-center gap-2 border-t border-border bg-surface/40 px-3 py-2 font-mono t-content"
      >
        <span className="shrink-0 font-semibold text-accent">{prompt}</span>
        <input
          ref={inputRef}
          className="h-[var(--ui-control)] min-w-0 flex-1 rounded-sm border border-border bg-base px-2 text-text outline-none placeholder:text-muted focus:border-highlight/60"
          placeholder={busy ? t("console.waiting") : t("console.placeholder")}
          value={input}
          readOnly={busy}
          spellCheck={false}
          autoFocus
          onChange={(event) => {
            setInput(event.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onInputKeyDown}
        />
        <Button
          variant="primary"
          disabled={busy || !input.trim()}
          onClick={() => void runCommand()}
        >
          {t("console.run")}
        </Button>
      </div>
    </div>
  );
}
