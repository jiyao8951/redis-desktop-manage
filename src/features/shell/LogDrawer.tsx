import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";
import type { LogEntry } from "../../App";

export default function LogDrawer({
  entries,
  onClose,
  onClear,
}: {
  entries: LogEntry[];
  onClose: () => void;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <aside className="absolute bottom-0 right-0 top-0 z-20 flex w-full max-w-[420px] flex-col border-l border-border bg-base shadow-2xl">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <span className="text-[12px] font-semibold">{t("log.title")}</span>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={onClear}>
            {t("log.clear")}
          </Button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted hover:bg-win hover:text-text"
            onClick={onClose}
            aria-label={t("log.close")}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-[1.45]">
        {entries.length === 0 ? (
          <p className="p-2 text-muted">{t("log.empty")}</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className={`break-words border-b border-border/60 px-1 py-1 hover:bg-surface/60 ${
                entry.level === "error" ? "text-danger" : ""
              }`}
            >
              <span className="mr-2 text-muted">{new Date(entry.at).toLocaleTimeString()}</span>
              {entry.message}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
