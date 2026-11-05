import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "../../components/ui/Icon";
import Menu from "../../components/ui/Menu";
import type { FilterHistoryEntry } from "../../lib/types";
import { useT } from "../../lib/i18n";

/** Mirrors the inline filter menu of DatabaseItem / AbstractNamespaceItem. */
export default function FilterBar({
  initial,
  history,
  busy,
  onApply,
  onReset,
  onClose,
}: {
  initial: string;
  history: FilterHistoryEntry[];
  busy: boolean;
  onApply: (pattern: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const [historyOpen, setHistoryOpen] = useState(false);

  const submit = () => {
    const pattern = value.trim();
    if (!pattern) return;
    onApply(pattern);
  };

  return (
    <div className="relative flex h-7 w-full items-center gap-1 bg-surface pl-1 pr-2">
      <button
        type="button"
        className="rounded-sm p-0.5 text-muted hover:text-text"
        title={t("filter.history")}
        onClick={() => setHistoryOpen((v) => !v)}
      >
        <Icon name="chevron-down" />
      </button>
      <input
        className="h-5 min-w-0 flex-1 rounded-sm border border-border bg-base px-1.5 text-[11px]"
        value={value}
        autoFocus
        placeholder={t("filter.placeholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onClose();
        }}
      />
      <button
        type="button"
        className="rounded-sm p-0.5 text-muted hover:text-text disabled:opacity-40"
        title={t("filter.apply")}
        disabled={busy}
        onClick={submit}
      >
        <Icon name="filter" />
      </button>
      <button
        type="button"
        className="rounded-sm p-0.5 text-muted hover:text-text"
        title={t("filter.reset")}
        onClick={onReset}
      >
        <Icon name="x" />
      </button>
      <button
        type="button"
        className="rounded-sm p-0.5 text-muted hover:text-text"
        title={t("filter.help")}
        onClick={() => void openUrl("https://docs.resp.app/en/latest/keyspaces/")}
      >
        <Icon name="help" />
      </button>

      {busy ? <span className="text-[11px] text-muted">…</span> : null}

      {historyOpen ? (
        <Menu
          className="left-0 top-7 w-[260px]"
          onClose={() => setHistoryOpen(false)}
          items={
            history.length
              ? history.slice(0, 10).map((entry) => ({
                  key: entry.pattern,
                  label: entry.pattern,
                  shortcut: `x${entry.useCount}`,
                  onClick: () => {
                    setValue(entry.pattern);
                    onApply(entry.pattern);
                  },
                }))
              : [
                  {
                    key: "empty",
                    label: t("filter.empty"),
                    disabled: true,
                    onClick: () => undefined,
                  },
                ]
          }
        />
      ) : null}
    </div>
  );
}
