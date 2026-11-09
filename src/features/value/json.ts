/**
 * Render-layer JSON detection for the value viewer. Nothing here ever mutates
 * the stored payload: probes and formatting only feed the read-only views.
 */

/** Cells above this many UTF-8 bytes are never parsed automatically. */
export const JSON_PARSE_LIMIT_BYTES = 256 * 1024;

export type JsonProbe =
  | { kind: "not-json" }
  | { kind: "too-large"; bytes: number }
  | { kind: "parsed"; value: unknown }
  | { kind: "invalid"; error: string };

/** UTF-8 byte length that avoids encoding when the string is obviously huge. */
export function jsonByteLength(text: string): number {
  if (text.length > JSON_PARSE_LIMIT_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Detects JSON cells: trimmed content must start with `{` or `[` and parse.
 * With `requireContainer` disabled (manual "try parsing"), any valid JSON
 * document is accepted. Never throws.
 */
export function probeJson(
  text: string,
  enforceLimit = true,
  requireContainer = true,
): JsonProbe {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "not-json" };
  if (requireContainer && trimmed[0] !== "{" && trimmed[0] !== "[") {
    return { kind: "not-json" };
  }
  if (enforceLimit) {
    const bytes = jsonByteLength(trimmed);
    if (bytes > JSON_PARSE_LIMIT_BYTES) return { kind: "too-large", bytes };
  }
  try {
    return { kind: "parsed", value: JSON.parse(trimmed) };
  } catch (error) {
    return { kind: "invalid", error: errorText(error) };
  }
}

/** Pretty prints JSON text; returns the validation error instead of guessing. */
export function prettyJson(text: string): { text: string; value: unknown } | { error: string } {
  try {
    const value: unknown = JSON.parse(text);
    return { text: JSON.stringify(value, null, 2), value };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** Serializes a parsed node for display; never throws. */
export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return errorText(error);
  }
}
