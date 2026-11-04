import type { MessageKey } from "../../lib/i18n";
import type { ValueCell } from "../../lib/types";

export type FormatterId = "auto" | "text" | "json" | "hex" | "hex-table" | "base64-text";

export const FORMATTERS: { id: FormatterId; labelKey: MessageKey }[] = [
  { id: "auto", labelKey: "formatter.auto" },
  { id: "text", labelKey: "formatter.text" },
  { id: "json", labelKey: "formatter.json" },
  { id: "hex", labelKey: "formatter.hex" },
  { id: "hex-table", labelKey: "formatter.hexTable" },
  { id: "base64-text", labelKey: "formatter.base64Text" },
];

/** Decode a cell payload into raw bytes. */
export function cellBytes(cell: ValueCell): Uint8Array {
  if (cell.encoding === "utf8") {
    return new TextEncoder().encode(cell.payload);
  }
  const binary = atob(cell.payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isBinary(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder();
  const text = decoder.decode(bytes);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  // Invalid UTF-8 sequences are replaced; treat those as binary as well.
  return text.includes("\uFFFD");
}

export function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function tryPrettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== "{" && trimmed[0] !== "[" && trimmed[0] !== '"') return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

export function printable(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/** Space-separated hex bytes, matching the original "HEX" formatter. */
export function hexBytes(bytes: Uint8Array, limit: number): { text: string; truncated: boolean } {
  const slice = bytes.slice(0, limit);
  let output = "";
  for (let i = 0; i < slice.length; i += 1) {
    if (i > 0) output += i % 16 === 0 ? "\n" : " ";
    output += slice[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return { text: output, truncated: bytes.length > limit };
}

/**
 * hexy.js-style dump: offset, 16 bytes per line, ASCII gutter. The original
 * renders the whole value, but generation is capped so a 1.5 MB value cannot
 * freeze the UI.
 */
export function hexTable(bytes: Uint8Array, limit: number): { text: string; truncated: boolean } {
  const slice = bytes.slice(0, limit);
  const lines: string[] = [];
  for (let offset = 0; offset < slice.length; offset += 16) {
    const chunk = slice.slice(offset, offset + 16);
    let hex = "";
    let ascii = "";
    for (let i = 0; i < 16; i += 1) {
      const byte = chunk[i];
      hex += byte === undefined ? "  " : byte.toString(16).padStart(2, "0").toUpperCase();
      hex += i === 7 ? "  " : " ";
      if (byte === undefined) {
        ascii += " ";
      } else {
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
      }
    }
    lines.push(`${offset.toString(16).padStart(8, "0").toUpperCase()}  ${hex} |${ascii}|`);
  }
  return { text: lines.join("\n"), truncated: bytes.length > limit };
}

export function formatCell(
  cell: ValueCell,
  formatter: FormatterId,
  limit: number,
): { text: string; truncated: boolean } {
  const bytes = cellBytes(cell);
  const raw = textOf(bytes);
  const binary = isBinary(bytes);

  switch (formatter) {
    case "text":
      return printable(binary ? hexBytes(bytes, limit).text : raw, limit);
    case "json":
      return printable(tryPrettyJson(raw) ?? raw, limit);
    case "hex":
      return hexBytes(bytes, Math.min(limit, 50_000));
    case "hex-table":
      return hexTable(bytes, Math.min(limit, 50_000));
    case "base64-text":
      return printable(raw, limit);
    case "auto":
    default: {
      if (binary) return hexBytes(bytes, Math.min(limit, 50_000));
      const json = tryPrettyJson(raw);
      if (json) return printable(json, limit);
      return printable(raw, limit);
    }
  }
}
