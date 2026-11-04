export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** TTL badge text: -1 persistent, -2 vanished, otherwise a short duration. */
export function humanTtl(ttl: number, noExpiry = "no expiry", missing = "missing"): string {
  if (ttl === -1) return noExpiry;
  if (ttl === -2) return missing;
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

/** Original DatabaseItem display: "db0 (12)" plus the active filter, if any. */
export function databaseLabel(
  index: number,
  keys: number,
  filter: string | null,
  filterSuffix = "filter: {pattern}",
): string {
  const suffix = !filter || filter === "*" ? "" : ` (${filterSuffix.replace("{pattern}", filter)})`;
  return `db${index} (${keys})${suffix}`;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function errMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
