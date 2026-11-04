import { useMemo } from "react";

import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";
import type { ValueCell } from "../../lib/types";
import { FORMATTERS, formatCell, type FormatterId } from "./formatters";

interface ValueEditorPaneProps {
  label: string;
  cell: ValueCell | null;
  formatter: FormatterId;
  limit: number;
  /** Fill the remaining tab height (string view) instead of the fixed pane. */
  fill?: boolean;
  editing?: boolean;
  draft?: string;
  dirty?: boolean;
  saving?: boolean;
  fontFamily?: string;
  fontSize?: number;
  onFormatter: (formatter: FormatterId) => void;
  onDraftChange?: (text: string) => void;
  onSave?: () => void;
  onCopy: (text: string) => void;
}

/**
 * Value editor pane. String values and single collection cells are editable;
 * the Save button mirrors the original editor Apply action.
 */
export default function ValueEditorPane({
  label,
  cell,
  formatter,
  limit,
  fill = false,
  editing = false,
  draft,
  dirty = false,
  saving = false,
  fontFamily,
  fontSize,
  onFormatter,
  onDraftChange,
  onSave,
  onCopy,
}: ValueEditorPaneProps) {
  const t = useT();
  const formatted = useMemo(
    () => (cell ? formatCell(cell, formatter, limit) : null),
    [cell, formatter, limit],
  );

  return (
    <div
      className={`flex flex-col border-t border-border ${
        fill ? "min-h-0 flex-1" : "h-48 shrink-0"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted">{label}</span>
        <select
          className="h-7 rounded border border-border bg-base px-2 text-xs text-text outline-none"
          value={formatter}
          onChange={(event) => onFormatter(event.target.value as FormatterId)}
        >
          {FORMATTERS.map((item) => (
            <option key={item.id} value={item.id}>
              {t(item.labelKey)}
            </option>
          ))}
        </select>
        {editing ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-accent bg-accent px-2 py-0.5 text-xs text-base disabled:opacity-40"
            disabled={saving || !dirty}
            onClick={() => onSave?.()}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        ) : null}
        <button
          type="button"
          className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-text disabled:opacity-40"
          disabled={!formatted}
          onClick={() => formatted && onCopy(formatted.text)}
        >
          <Icon name="copy" className="h-3.5 w-3.5" />
          {t("common.copy")}
        </button>
      </div>
      <textarea
        className="min-h-0 flex-1 resize-none bg-base p-2 font-mono text-xs text-text outline-none"
        style={{
          fontFamily: fontFamily || undefined,
          fontSize: fontSize ? `${fontSize}px` : undefined,
        }}
        readOnly={!editing}
        spellCheck={false}
        value={editing ? (draft ?? "") : (formatted?.text ?? "")}
        onChange={(event) => onDraftChange?.(event.target.value)}
        placeholder={cell ? "" : t("value.selectRow")}
      />
      {formatted?.truncated ? (
        <div className="border-t border-border px-3 py-1 text-xs text-muted">
          {t("value.displayTruncated", { limit: limit.toLocaleString() })}
        </div>
      ) : null}
    </div>
  );
}
