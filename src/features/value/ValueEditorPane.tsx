import { useEffect, useMemo, useState } from "react";

import Button from "../../components/ui/Button";
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
  /** Text the draft starts from (loaded value / selected cell payload). */
  sourceText: string;
  /** Changes when the selection or the loaded data changes, resetting the draft. */
  editKey: string;
  saving?: boolean;
  fontFamily?: string;
  fontSize?: number;
  onFormatter: (formatter: FormatterId) => void;
  onSave: (text: string) => void;
  onCopy: (text: string) => void;
}

/**
 * Value editor pane. String values and single collection cells are editable;
 * the Save button mirrors the original editor Apply action. The draft lives in
 * this component so typing never re-renders the whole value table.
 */
export default function ValueEditorPane({
  label,
  cell,
  formatter,
  limit,
  fill = false,
  editing = false,
  sourceText,
  editKey,
  saving = false,
  fontFamily,
  fontSize,
  onFormatter,
  onSave,
  onCopy,
}: ValueEditorPaneProps) {
  const t = useT();
  const [draft, setDraft] = useState(sourceText);

  useEffect(() => {
    setDraft(sourceText);
  }, [editKey, sourceText]);

  // Formatting can decode a multi-megabyte value; skip it while the user is
  // editing because the textarea renders the draft directly.
  const formatted = useMemo(
    () => (cell && !editing ? formatCell(cell, formatter, limit) : null),
    [cell, editing, formatter, limit],
  );

  const dirty = editing && draft !== sourceText;
  const copyText = editing ? draft : (formatted?.text ?? "");

  return (
    <div
      className={`flex flex-col border-t border-border ${
        fill ? "min-h-0 flex-1" : "h-48 shrink-0"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface/50 px-3 py-1.5">
        <span className="min-w-0 truncate text-[11px] font-medium text-text" title={label}>
          {label}
        </span>
        {dirty ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            {t("value.unsaved")}
          </span>
        ) : null}
        <select
          className="ml-auto h-7 rounded-sm border border-border bg-base px-1.5 text-[11px] text-text outline-none hover:border-muted/50 focus:border-highlight/60"
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
          <Button
            variant="primary"
            disabled={saving || !dirty}
            onClick={() => onSave(draft)}
          >
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          disabled={!copyText}
          onClick={() => copyText && onCopy(copyText)}
        >
          <Icon name="copy" className="h-3.5 w-3.5" />
          {t("common.copy")}
        </Button>
      </div>
      <textarea
        className={`min-h-0 flex-1 resize-none bg-base p-2 font-mono text-xs text-text outline-none focus:bg-base ${
          editing ? "" : "text-muted/90"
        }`}
        style={{
          fontFamily: fontFamily || undefined,
          fontSize: fontSize ? `${fontSize}px` : undefined,
        }}
        readOnly={!editing}
        spellCheck={false}
        value={editing ? draft : (formatted?.text ?? "")}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={cell ? "" : t("value.selectRow")}
      />
      {!editing && formatted?.truncated ? (
        <div className="border-t border-border px-3 py-1 text-xs text-muted">
          {t("value.displayTruncated", { limit: limit.toLocaleString() })}
        </div>
      ) : null}
    </div>
  );
}
