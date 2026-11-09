import { memo, useState } from "react";

import { useT } from "../../lib/i18n";
import { Icon } from "./Icon";

/** Guards against pathological nesting; deeper nodes render as an ellipsis. */
const MAX_DEPTH = 200;
const MAX_STRING_PREVIEW = 500;

type JsonObject = Record<string, unknown>;

function isContainer(value: unknown): value is JsonObject | unknown[] {
  return typeof value === "object" && value !== null;
}

function fragment(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    const clipped =
      value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}…` : value;
    return <span className="break-all text-success">"{clipped}"</span>;
  }
  if (typeof value === "number") return <span className="text-highlight">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-accent">{String(value)}</span>;
  if (value === null) return <span className="italic text-muted">null</span>;
  return <span className="text-muted">{JSON.stringify(value)}</span>;
}

interface JsonNodeProps {
  name: string | number | null;
  value: unknown;
  depth: number;
  onCopy: (text: string) => void;
}

function NodeLabel({ name }: { name: string | number | null }) {
  if (name === null) return null;
  return (
    <span className="shrink-0 text-highlight">
      {typeof name === "number" ? `[${name}]` : JSON.stringify(name)}
      <span className="text-muted">:</span>
    </span>
  );
}

/**
 * One JSON node. Only expanded containers render their children, so a large
 * payload never mounts thousands of rows at once. The root starts expanded and
 * every deeper container starts collapsed ("first level only").
 */
function JsonNode({ name, value, depth, onCopy }: JsonNodeProps) {
  const t = useT();
  const [open, setOpen] = useState(depth === 0);

  if (!isContainer(value)) {
    return (
      <div className="flex items-start gap-1 py-[1px] pl-4 font-mono t-12 leading-5">
        <NodeLabel name={name} />
        <span className="min-w-0">
          <Primitive value={value} />
        </span>
      </div>
    );
  }

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((child, index) => [index, child])
    : Object.entries(value);
  const isArray = Array.isArray(value);
  const summary = isArray
    ? t("json.arraySummary", { count: entries.length })
    : t("json.objectSummary", { count: entries.length });

  return (
    <div className="font-mono t-12 leading-5">
      <div className="group flex items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left hover:bg-surface"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
        >
          <Icon
            name={open ? "chevron-down" : "chevron-right"}
            className="h-3 w-3 shrink-0 text-muted"
          />
          <NodeLabel name={name} />
          <span className="shrink-0 text-muted">{isArray ? "[" : "{"}</span>
          {!open ? (
            <>
              <span className="truncate text-muted/80">{summary}</span>
              <span className="shrink-0 text-muted">{isArray ? "]" : "}"}</span>
            </>
          ) : null}
        </button>
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-muted opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
          title={t("json.copyNode")}
          aria-label={t("json.copyNode")}
          onClick={() => onCopy(fragment(value))}
        >
          <Icon name="copy" className="h-3 w-3" />
        </button>
      </div>
      {open ? (
        depth >= MAX_DEPTH ? (
          <div className="pl-4 text-muted">…</div>
        ) : (
          <div className="border-l border-border/60 pl-3">
            {entries.map(([key, child]) => (
              <JsonNode key={String(key)} name={key} value={child} depth={depth + 1} onCopy={onCopy} />
            ))}
            {entries.length === 0 ? <div className="pl-4 text-muted">{summary}</div> : null}
          </div>
        )
      ) : null}
    </div>
  );
}

interface JsonTreeProps {
  value: unknown;
  onCopy: (text: string) => void;
}

/** Read-only expandable JSON tree. Purely presentational. */
function JsonTree({ value, onCopy }: JsonTreeProps) {
  if (!isContainer(value)) {
    return (
      <div className="p-2 font-mono t-12 leading-5">
        <Primitive value={value} />
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <JsonNode name={null} value={value} depth={0} onCopy={onCopy} />
    </div>
  );
}

export default memo(JsonTree);
