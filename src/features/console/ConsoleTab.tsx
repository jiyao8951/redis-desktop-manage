import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import Button from "../../components/ui/Button";
import Dialog from "../../components/ui/Dialog";
import Menu from "../../components/ui/Menu";
import { errMessage } from "../../lib/format";
import { useT, type MessageKey } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";
import { loadCommandArguments, loadCommandCatalog, type CommandCatalog } from "./commandCatalog";
import ConsoleOutput from "./ConsoleOutput";

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
const HISTORY_KEY_PREFIX = "rdm.console.history.";
const SUGGESTION_LIMIT = 10;

function loadHistory(connectionId: string): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY_PREFIX + connectionId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(connectionId: string, history: string[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY_PREFIX + connectionId, JSON.stringify(history));
  } catch {
    // Private mode / quota exhaustion: history simply stays in memory.
  }
}

interface DangerRule {
  impact: MessageKey;
}

/**
 * Only commands that can affect server-wide state are confirmed. The console
 * does not keep a "read-only allow-list", so any other command runs directly.
 */
function dangerRule(command: string): DangerRule | null {
  const tokens = command.trim().toUpperCase().split(/\s+/);
  const name = tokens[0] ?? "";
  const sub = tokens[1] ?? "";

  switch (name) {
    case "FLUSHALL":
      return { impact: "console.danger.flushAll" };
    case "FLUSHDB":
      return { impact: "console.danger.flushDb" };
    case "SHUTDOWN":
      return { impact: "console.danger.shutdown" };
    case "DEBUG":
      return { impact: "console.danger.debug" };
    case "CONFIG":
      if (sub === "SET") return { impact: "console.danger.configSet" };
      if (sub === "REWRITE") return { impact: "console.danger.configRewrite" };
      if (sub === "RESETSTAT") return { impact: "console.danger.configResetStat" };
      return null;
    case "SCRIPT":
      if (sub === "FLUSH") return { impact: "console.danger.scriptFlush" };
      return null;
    case "ACL":
      if (sub === "SETUSER") return { impact: "console.danger.aclSetUser" };
      if (sub === "DELUSER") return { impact: "console.danger.aclDelUser" };
      return null;
    default:
      return null;
  }
}

/**
 * Mirrors src/qml/console/RedisConsole.qml: one command per Return, Up/Down
 * history and `clear`, plus dynamic command completion, a searchable history
 * panel, multi-line input, dangerous-command confirmation and a bounded
 * request/response transcript.
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
  const [history, setHistory] = useState<string[]>(() => loadHistory(connectionId));
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [catalog, setCatalog] = useState<CommandCatalog | null>(null);
  const [argHint, setArgHint] = useState<string[] | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  const [confirm, setConfirm] = useState<{ command: string; impact: MessageKey } | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const seq = useRef(0);
  const lineId = useRef(0);
  const dbRef = useRef(initialDb);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // History is isolated per connection and persisted locally.
  useEffect(() => {
    saveHistory(connectionId, history);
  }, [connectionId, history]);

  // Command names are fetched from the server, cached per connection.
  useEffect(() => {
    let alive = true;
    const exec = (command: string) =>
      ipc.consoleExecute({ connectionId, db: dbRef.current, command });
    void loadCommandCatalog(connectionId, exec)
      .then((next) => {
        if (alive) setCatalog(next);
      })
      .catch(() => {
        if (alive) setCatalog({ names: [], source: "none", version: "" });
      });
    return () => {
      alive = false;
    };
  }, [connectionId]);

  // Argument names are fetched lazily, only for the command being typed.
  const firstToken = /^([a-zA-Z][\w.-]*)\s/.exec(input)?.[1]?.toLowerCase() ?? null;
  useEffect(() => {
    setArgHint(null);
    if (!firstToken || !catalog || !catalog.names.includes(firstToken)) return;
    let alive = true;
    const exec = (command: string) =>
      ipc.consoleExecute({ connectionId, db: dbRef.current, command });
    const timer = window.setTimeout(() => {
      void loadCommandArguments(connectionId, firstToken, exec)
        .then((args) => {
          if (alive) setArgHint(args);
        })
        .catch(() => {
          if (alive) setArgHint(null);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [firstToken, catalog, connectionId]);

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

  const executeCommand = async (command: string) => {
    const ticket = seq.current;
    setBusy(true);
    rememberCommand(command);
    await executeOne(command, ticket);
    if (seq.current === ticket) setBusy(false);
  };

  const runCommand = () => {
    const command = input.trim();
    if (!command || busy) return;
    if (command.toLowerCase() === "clear") {
      clear();
      setInput("");
      return;
    }
    const danger = dangerRule(command);
    if (danger) {
      setConfirm({ command, impact: danger.impact });
      return;
    }
    setInput("");
    setSuggestDismissed(true);
    void executeCommand(command);
  };

  const suggestions =
    catalog !== null && !input.includes("\n") && /^[a-zA-Z][\w.-]*$/.test(input)
      ? catalog.names
          .filter((name) => name.startsWith(input.toLowerCase()))
          .slice(0, SUGGESTION_LIMIT)
      : [];
  const showSuggest =
    suggestions.length > 0 &&
    !suggestDismissed &&
    !historyOpen &&
    !(suggestions.length === 1 && suggestions[0] === input.toLowerCase());

  const applySuggestion = (name: string) => {
    setInput(`${name} `);
    setHistoryIndex(null);
    setSuggestIndex(0);
    setSuggestDismissed(true);
    textareaRef.current?.focus();
  };

  const stepHistory = (direction: -1 | 1) => {
    if (history.length === 0) return;
    if (direction === -1) {
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setInput(history[next]);
    } else if (historyIndex !== null) {
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

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggest) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSuggestIndex((value) => (value + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestIndex((value) => (value + suggestions.length - 1) % suggestions.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        applySuggestion(suggestions[Math.min(suggestIndex, suggestions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runCommand();
      return;
    }
    if (
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !input.includes("\n")
    ) {
      event.preventDefault();
      stepHistory(event.key === "ArrowUp" ? -1 : 1);
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

  const filteredHistory = historyQuery.trim()
    ? history.filter((item) => item.toLowerCase().includes(historyQuery.trim().toLowerCase()))
    : history;
  const historyRows = [...filteredHistory].reverse();

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <div className="flex items-center gap-2 border-b border-border bg-surface/40 px-3 py-1.5">
        <span className="t-13 font-semibold text-text">{t("console.title")}</span>
        <span className="rounded-sm border border-border px-1.5 py-[1px] t-11 text-muted">
          {connectionName} · db{db}
        </span>
        {busy ? <span className="t-12 text-muted">{t("console.waiting")}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          {catalog?.source === "none" ? (
            <span className="t-11 text-muted">{t("console.autocompleteUnavailable")}</span>
          ) : null}
          <Button variant="ghost" onClick={() => setHistoryOpen((value) => !value)}>
            {t("console.history")}
          </Button>
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
        {lines.map((line) =>
          line.kind === "output" ? (
            <div key={line.id} className={colorFor(line.kind)}>
              <ConsoleOutput text={line.text} />
            </div>
          ) : (
            <div key={line.id} className={colorFor(line.kind)}>
              {line.text}
            </div>
          ),
        )}
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

      <div className="relative border-t border-border bg-surface/40">
        {historyOpen ? (
          <div className="absolute bottom-full left-2 right-2 z-30 mb-1 max-h-[45vh] overflow-auto rounded-md border border-border bg-base p-2 shadow-xl">
            <div className="mb-1 flex items-center gap-2">
              <input
                className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-base px-2 t-13 outline-none focus:border-highlight/60"
                placeholder={t("console.historySearch")}
                value={historyQuery}
                autoFocus
                onChange={(event) => setHistoryQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setHistoryOpen(false);
                  }
                }}
              />
              <Button variant="ghost" onClick={() => setHistoryOpen(false)}>
                {t("common.close")}
              </Button>
            </div>
            {historyRows.length === 0 ? (
              <p className="px-1 py-2 t-12 text-muted">{t("console.historyEmpty")}</p>
            ) : (
              historyRows.map((item, index) => (
                <button
                  key={`${index}-${item}`}
                  type="button"
                  className="block w-full truncate rounded-sm px-2 py-1 text-left font-mono t-13 text-text hover:bg-surface"
                  onClick={() => {
                    setInput(item);
                    setHistoryIndex(null);
                    setHistoryOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  {item}
                </button>
              ))
            )}
          </div>
        ) : null}

        {showSuggest ? (
          <div className="absolute bottom-full left-2 right-2 z-30 mb-1 max-h-[40vh] overflow-auto rounded-md border border-border bg-base p-1 shadow-xl">
            {suggestions.map((name, index) => (
              <button
                key={name}
                type="button"
                className={`block w-full truncate rounded-sm px-2 py-1 text-left font-mono t-13 ${
                  index === suggestIndex ? "bg-highlight/10 text-highlight" : "text-text hover:bg-surface"
                }`}
                onClick={() => applySuggestion(name)}
              >
                {name}
              </button>
            ))}
          </div>
        ) : null}

        <div style={textStyle} className="flex items-end gap-2 px-3 py-2 font-mono t-content">
          <span className="shrink-0 font-semibold text-accent">{prompt}</span>
          <div className="min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              rows={Math.min(6, Math.max(1, input.split("\n").length))}
              className="block max-h-40 w-full min-w-0 resize-none overflow-auto rounded-sm border border-border bg-base px-2 py-1 text-text outline-none placeholder:text-muted focus:border-highlight/60 [field-sizing:content]"
              placeholder={busy ? t("console.waiting") : t("console.placeholder")}
              value={input}
              readOnly={busy}
              spellCheck={false}
              autoFocus
              onChange={(event) => {
                setInput(event.target.value);
                setHistoryIndex(null);
                setSuggestIndex(0);
                setSuggestDismissed(false);
              }}
              onKeyDown={onInputKeyDown}
            />
            {argHint && argHint.length > 0 ? (
              <div className="mt-0.5 truncate t-11 text-muted">
                {t("console.argHint")} {argHint.join(" ")}
              </div>
            ) : null}
          </div>
          <Button variant="primary" disabled={busy || !input.trim()} onClick={runCommand}>
            {t("console.run")}
          </Button>
        </div>
      </div>

      {confirm ? (
        <Dialog
          title={t("console.danger.title")}
          width={520}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const command = confirm.command;
                  setConfirm(null);
                  setInput("");
                  void executeCommand(command);
                }}
              >
                {t("console.danger.confirm")}
              </Button>
            </>
          }
        >
          <div className="space-y-2 t-13">
            <div className="break-all rounded-sm border border-border bg-surface px-3 py-2 font-mono">
              {confirm.command}
            </div>
            <p className="text-danger">{t(confirm.impact)}</p>
            <p className="text-muted">{t("console.danger.body")}</p>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
