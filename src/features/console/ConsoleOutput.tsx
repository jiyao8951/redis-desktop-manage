import { useMemo, useState } from "react";

import { useT } from "../../lib/i18n";

/** Blocks larger than this are collapsed by default. */
const COLLAPSE_CHARS = 2000;
const COLLAPSE_LINES = 18;
const PREVIEW_LINES = 12;
/** A single displayed line longer than this gets a "view full" toggle. */
const MAX_LINE_CHARS = 600;

function detectJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function hexToBase64(hex: string): string | null {
  const slice = hex.slice(0, 8192);
  if (slice.length === 0 || slice.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(slice)) return null;
  let binary = "";
  for (let index = 0; index < slice.length; index += 2) {
    binary += String.fromCharCode(parseInt(slice.slice(index, index + 2), 16));
  }
  try {
    const encoded = btoa(binary);
    return hex.length > slice.length ? `${encoded}…` : encoded;
  } catch {
    return null;
  }
}

/**
 * Renders one console reply. Large replies start collapsed, long lines offer a
 * "view full" toggle, JSON payloads can be pretty-printed purely for display,
 * and binary replies (`(binary) <hex>`) get a Base64 toggle.
 */
export default function ConsoleOutput({ text }: { text: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [pretty, setPretty] = useState(false);
  const [fullLines, setFullLines] = useState<Record<number, boolean>>({});
  const [base64Lines, setBase64Lines] = useState<Record<number, boolean>>({});

  const json = useMemo(() => detectJson(text), [text]);
  const source = useMemo(() => {
    if (json !== undefined && pretty) return JSON.stringify(json, null, 2);
    return text;
  }, [json, pretty, text]);

  const lines = source.split("\n");
  const isLarge = text.length > COLLAPSE_CHARS || lines.length > COLLAPSE_LINES;
  const visibleLines = isLarge && !expanded ? lines.slice(0, PREVIEW_LINES) : lines;

  return (
    <div>
      {isLarge || json !== undefined ? (
        <div className="mb-0.5 flex flex-wrap items-center gap-2 t-11 text-muted">
          {isLarge ? (
            <button
              type="button"
              className="underline decoration-dotted hover:text-text"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? t("console.output.collapse")
                : t("console.output.expand", { count: lines.length })}
            </button>
          ) : null}
          {isLarge && !expanded ? (
            <span>
              {t("console.output.collapsedHint", {
                shown: PREVIEW_LINES,
                total: lines.length,
              })}
            </span>
          ) : null}
          {json !== undefined ? (
            <button
              type="button"
              className="underline decoration-dotted hover:text-text"
              onClick={() => setPretty((value) => !value)}
            >
              {pretty ? t("console.output.compact") : t("console.output.pretty")}
            </button>
          ) : null}
        </div>
      ) : null}

      {visibleLines.map((line, index) => {
        const binary = /^\(binary\)\s*([0-9a-fA-F]+)$/.exec(line);
        const full = fullLines[index] ?? false;
        const showBase64 = base64Lines[index] ?? false;
        let display = line;
        if (binary && showBase64) {
          display = `(binary, base64) ${hexToBase64(binary[1]) ?? "?"}`;
        }
        const truncated = !full && display.length > MAX_LINE_CHARS;
        if (truncated) display = `${display.slice(0, MAX_LINE_CHARS)}…`;
        return (
          <div key={index} className="whitespace-pre-wrap break-all">
            {display}
            {truncated || binary ? (
              <span className="ml-2 inline-flex gap-2 t-11 text-muted">
                {truncated ? (
                  <button
                    type="button"
                    className="underline decoration-dotted hover:text-text"
                    onClick={() =>
                      setFullLines((prev) => ({ ...prev, [index]: true }))
                    }
                  >
                    {t("console.output.viewFull")}
                  </button>
                ) : null}
                {binary ? (
                  <button
                    type="button"
                    className="underline decoration-dotted hover:text-text"
                    onClick={() =>
                      setBase64Lines((prev) => ({ ...prev, [index]: !showBase64 }))
                    }
                  >
                    {showBase64
                      ? t("console.output.showHex")
                      : t("console.output.showBase64")}
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
