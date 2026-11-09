import { useEffect, useMemo, useState, type CSSProperties } from "react";

import Button from "../../components/ui/Button";
import JsonTree from "../../components/ui/JsonTree";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";
import type { ValueCell } from "../../lib/types";
import {
  FORMATTERS,
  cellBytes,
  formatCell,
  isBinary,
  printable,
  textOf,
  type FormatterId,
} from "./formatters";
import {
  JSON_PARSE_LIMIT_BYTES,
  prettyJson,
  probeJson,
  stringifyJson,
  type JsonProbe,
} from "./json";

interface ValueEditorPaneProps {
  label: string;
  cell: ValueCell | null;
  formatter: FormatterId;
  limit: number;
  /** Fill the remaining tab height (string view) instead of the fixed pane. */
  fill?: boolean;
  editing?: boolean;
  /** The loaded value is incomplete; format-and-save would lose data. */
  truncated?: boolean;
  /** Text the draft starts from (loaded value / selected cell payload). */
  sourceText: string;
  /** Changes when the selection or the loaded data changes, resetting the draft. */
  editKey: string;
  saving?: boolean;
  fontFamily?: string;
  fontSize?: number;
  /** Reports whether the draft differs from the loaded value (tab close guard). */
  onDirtyChange?: (dirty: boolean) => void;
  onFormatter: (formatter: FormatterId) => void;
  onSave: (text: string) => void;
  onCopy: (text: string) => void;
}

type ViewMode = "text" | "json" | "tree";

const VIEW_MODES: { id: ViewMode; labelKey: "value.view.text" | "value.view.json" | "value.view.tree" }[] = [
  { id: "text", labelKey: "value.view.text" },
  { id: "json", labelKey: "value.view.json" },
  { id: "tree", labelKey: "value.view.tree" },
];

/** Probe only after the user pauses typing so parsing never slows keystrokes. */
const PROBE_DELAY_MS = 250;

const editorStyle = (fontFamily?: string, fontSize?: number) =>
  ({
    fontFamily: fontFamily || undefined,
    "--editor-font": fontSize ? `${fontSize}px` : undefined,
  }) as CSSProperties;

/**
 * Value editor pane. String values and single collection cells are editable;
 * the Save button writes the raw draft back to Redis. JSON detection and the
 * structured views are render-only: they never change what gets saved unless
 * the user explicitly confirms "format & save".
 */
export default function ValueEditorPane({
  label,
  cell,
  formatter,
  limit,
  fill = false,
  editing = false,
  truncated = false,
  sourceText,
  editKey,
  saving = false,
  fontFamily,
  fontSize,
  onDirtyChange,
  onFormatter,
  onSave,
  onCopy,
}: ValueEditorPaneProps) {
  const t = useT();
  const [draft, setDraft] = useState(sourceText);
  const [probeText, setProbeText] = useState(sourceText);
  const [userView, setUserView] = useState<ViewMode | null>(null);
  const [forceParse, setForceParse] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    setDraft(sourceText);
    setProbeText(sourceText);
    setUserView(null);
    setForceParse(false);
    setFormatError(null);
    setMaximized(false);
  }, [editKey, sourceText]);

  // Debounced probe: while editing, wait for a pause; while read-only the
  // payload only changes when the selection changes.
  useEffect(() => {
    if (!editing) {
      setProbeText(sourceText);
      return undefined;
    }
    const timer = window.setTimeout(() => setProbeText(draft), PROBE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, editing, sourceText]);

  useEffect(() => {
    if (!maximized) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [maximized]);

  const bytes = useMemo(() => (cell ? cellBytes(cell) : new Uint8Array()), [cell]);
  const binary = useMemo(() => (bytes.length > 0 ? isBinary(bytes) : false), [bytes]);
  const rawText = useMemo(() => (cell ? textOf(bytes) : ""), [bytes, cell]);

  // Raw (text) view: binary cells keep the chosen formatter, text cells are
  // shown verbatim and only clipped for display.
  const textView = useMemo(() => {
    if (!cell) return { text: "", truncated: false };
    if (binary) return formatCell(cell, formatter, Math.min(limit, 50_000));
    return printable(rawText, limit);
  }, [binary, cell, formatter, limit, rawText]);

  const probe = useMemo<JsonProbe>(() => {
    if (binary) return { kind: "not-json" };
    return probeJson(probeText, !forceParse);
  }, [binary, forceParse, probeText]);

  const autoView: ViewMode = probe.kind === "parsed" ? "json" : "text";
  // While editing, never auto-switch away from the textarea: a draft that
  // starts to look like JSON must not hide the caret mid-typing.
  const view: ViewMode = binary ? "text" : (userView ?? (editing ? "text" : autoView));
  const prettyText = useMemo(
    () => (probe.kind === "parsed" ? stringifyJson(probe.value) : null),
    [probe],
  );

  const dirty = editing && draft !== sourceText;
  const contentTruncated = truncated || textView.truncated;
  const copyText = editing ? draft : (prettyText ?? textView.text);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const formatLimit = `${Math.round(JSON_PARSE_LIMIT_BYTES / 1024)} KB`;

  const runFormat = () => {
    const result = prettyJson(editing ? draft : rawText);
    if ("error" in result) {
      setFormatError(t("value.formatInvalid", { error: result.error }));
      return;
    }
    setFormatError(null);
    setForceParse(true);
    setProbeText(editing ? draft : rawText);
    setUserView("json");
  };

  const tryParse = () => {
    setFormatError(null);
    setForceParse(true);
  };

  const formatAndSave = () => {
    if (contentTruncated) {
      setFormatError(t("value.formatSaveBlocked"));
      return;
    }
    const result = prettyJson(draft);
    if ("error" in result) {
      setFormatError(t("value.formatInvalid", { error: result.error }));
      return;
    }
    if (result.text === sourceText) return;
    if (!window.confirm(t("value.formatSaveConfirm"))) return;
    setFormatError(null);
    onSave(result.text);
  };

  const showFormatSave = editing && probe.kind === "parsed" && draft !== prettyText;

  return (
    <div
      className={`flex flex-col bg-base ${
        maximized
          ? "fixed inset-0 z-50"
          : `border-t border-border ${
              fill ? "min-h-0 flex-1" : "h-52 min-h-[12rem] max-h-[70vh] shrink-0 resize-y overflow-hidden"
            }`
      }`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/50 px-3 py-1.5">
        <span className="min-w-0 max-w-[16rem] truncate t-content font-medium text-text" title={label}>
          {label}
        </span>
        {dirty ? (
          <span className="flex shrink-0 items-center gap-1 t-11 text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            {t("value.unsaved")}
          </span>
        ) : null}
        {cell && !binary ? (
          <div className="flex shrink-0 items-center rounded-sm border border-border p-[1px]">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`rounded-[2px] px-1.5 py-0.5 t-11 ${
                  view === mode.id
                    ? "bg-highlight text-white"
                    : "text-muted hover:text-text"
                }`}
                onClick={() => setUserView(mode.id)}
              >
                {t(mode.labelKey)}
              </button>
            ))}
          </div>
        ) : null}
        {view === "text" ? (
          <select
            className="h-[var(--ui-control)] shrink-0 rounded-sm border border-border bg-base px-1.5 t-12 text-text outline-none hover:border-muted/50 focus:border-highlight/60"
            value={formatter}
            onChange={(event) => onFormatter(event.target.value as FormatterId)}
          >
            {FORMATTERS.map((item) => (
              <option key={item.id} value={item.id}>
                {t(item.labelKey)}
              </option>
            ))}
          </select>
        ) : null}
        {cell && !binary ? (
          <Button variant="ghost" onClick={runFormat}>
            {t("value.format")}
          </Button>
        ) : null}
        {showFormatSave ? (
          <Button
            variant="secondary"
            disabled={saving || contentTruncated}
            title={contentTruncated ? t("value.formatSaveBlocked") : undefined}
            onClick={formatAndSave}
          >
            {t("value.formatSave")}
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {editing ? (
            <Button variant="primary" disabled={saving || !dirty} onClick={() => onSave(draft)}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={!copyText} onClick={() => copyText && onCopy(copyText)}>
            <Icon name="copy" className="h-3.5 w-3.5" />
            {t("common.copy")}
          </Button>
          <Button
            variant="ghost"
            title={maximized ? t("value.editorRestore") : t("value.editorMaximize")}
            aria-label={maximized ? t("value.editorRestore") : t("value.editorMaximize")}
            onClick={() => setMaximized((previous) => !previous)}
          >
            <Icon name={maximized ? "chevron-down" : "export"} className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {formatError ? (
        <div className="border-b border-border bg-danger/10 px-3 py-1 t-12 text-danger" role="alert">
          {formatError}
        </div>
      ) : null}
      {view === "text" ? (
        <textarea
          className={`min-h-0 flex-1 resize-none bg-base p-2 font-mono t-editor leading-[var(--ui-editor-leading)] text-text outline-none focus:bg-base ${
            editing ? "" : "text-muted/90"
          }`}
          style={editorStyle(fontFamily, fontSize)}
          readOnly={!editing}
          spellCheck={false}
          value={editing ? draft : textView.text}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={cell ? "" : t("value.selectRow")}
        />
      ) : view === "json" ? (
        <div className="min-h-0 flex-1 overflow-auto p-2 font-mono t-editor leading-[var(--ui-editor-leading)]" style={editorStyle(fontFamily, fontSize)}>
          {probe.kind === "too-large" ? (
            <div className="flex flex-col items-start gap-2">
              <span className="t-12 text-muted">
                {t("value.jsonTooLarge", { limit: formatLimit })}
              </span>
              <Button variant="secondary" onClick={tryParse}>
                {t("value.tryParse")}
              </Button>
              <pre className="whitespace-pre-wrap break-all text-muted/90">{textView.text}</pre>
            </div>
          ) : probe.kind === "parsed" ? (
            <pre className="whitespace-pre-wrap break-all text-text">{prettyText}</pre>
          ) : (
            <div className="flex flex-col gap-2">
              {probe.kind === "invalid" ? (
                <span className="t-12 text-danger" role="alert">
                  {t("value.formatInvalid", { error: probe.error })}
                </span>
              ) : null}
              <pre className="whitespace-pre-wrap break-all text-muted/90">{textView.text}</pre>
            </div>
          )}
        </div>
      ) : probe.kind === "parsed" ? (
        <JsonTree value={probe.value} onCopy={onCopy} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-start gap-2 overflow-auto p-2">
          <span className="t-12 text-muted">
            {probe.kind === "too-large"
              ? t("value.jsonTooLarge", { limit: formatLimit })
              : probe.kind === "invalid"
                ? t("value.formatInvalid", { error: probe.error })
                : t("value.jsonNotDetected")}
          </span>
          {probe.kind === "too-large" ? (
            <Button variant="secondary" onClick={tryParse}>
              {t("value.tryParse")}
            </Button>
          ) : null}
          <pre className="whitespace-pre-wrap break-all font-mono t-12 text-muted/90">
            {textView.text}
          </pre>
        </div>
      )}
      {view === "text" && !binary && probe.kind === "too-large" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1 t-12 text-muted">
          <span>{t("value.jsonTooLarge", { limit: formatLimit })}</span>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 text-text"
            onClick={tryParse}
          >
            {t("value.tryParse")}
          </button>
        </div>
      ) : null}
      {view === "text" && !editing && textView.truncated ? (
        <div className="border-t border-border px-3 py-1 t-content text-muted">
          {t("value.displayTruncated", { limit: limit.toLocaleString() })}
        </div>
      ) : null}
    </div>
  );
}
