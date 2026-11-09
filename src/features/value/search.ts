import type { ValueRow } from "../../lib/types";

/** Contract with the backend `read_value_page` search parameters. */
export type SearchTarget = "field" | "value";

/** Result of a backend full-key search (bounded scan). */
export interface ValueSearch {
  pattern: string;
  target: SearchTarget;
  rows: ValueRow[];
  /** Entries compared by the backend so far; null when it does not report. */
  scanned: number | null;
  /** False when the backend hit its scan limit and more may exist. */
  done: boolean;
  cursor: string;
}

/** Which search targets make sense for a key type. Empty hides the entry. */
export function searchTargetsFor(keyType: string): SearchTarget[] {
  if (keyType === "hash") return ["field", "value"];
  if (keyType === "set" || keyType === "zset" || keyType === "list") return ["value"];
  return [];
}
