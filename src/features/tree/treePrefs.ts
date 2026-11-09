/**
 * Local persistence for connection-tree preferences (favorites, recent
 * connections, expansion state) and the resizable sidebar width.
 *
 * Everything is best-effort: a corrupt JSON value is discarded and treated as
 * empty so a broken preference can never block application start-up.
 */

const PREFIX = "resp.";

const KEYS = {
  favorites: `${PREFIX}favorites.connections`,
  recent: `${PREFIX}recent.connections`,
  collapsedGroups: `${PREFIX}tree.collapsedGroups`,
  expandedServers: `${PREFIX}tree.expandedServers`,
  expandedDatabases: `${PREFIX}tree.expandedDatabases`,
  sidebarWidth: `${PREFIX}layout.sidebarWidth`,
} as const;

export interface RecentConnection {
  id: string;
  /** Epoch milliseconds of the last successful connect. */
  at: number;
}

function readJson(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage can be disabled; ignore and start from defaults.
    }
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage: preferences simply do not persist.
  }
}

function readStringSet(key: string): Set<string> {
  const raw = readJson(key);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((item): item is string => typeof item === "string"));
}

function writeStringSet(key: string, values: Iterable<string>) {
  writeJson(key, [...values]);
}

export function loadFavoriteConnections(): Set<string> {
  return readStringSet(KEYS.favorites);
}

export function saveFavoriteConnections(ids: Iterable<string>) {
  writeStringSet(KEYS.favorites, ids);
}

/** Most recent first, capped so the quick picker stays small. */
export function loadRecentConnections(): RecentConnection[] {
  const raw = readJson(KEYS.recent);
  if (!Array.isArray(raw)) return [];
  const entries: RecentConnection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<RecentConnection>;
    if (typeof entry.id !== "string" || typeof entry.at !== "number") continue;
    entries.push({ id: entry.id, at: entry.at });
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, 12);
}

/** Records a successful connect. Unknown ids are filtered when displayed. */
export function touchRecentConnection(id: string) {
  const previous = loadRecentConnections().filter((entry) => entry.id !== id);
  writeJson(KEYS.recent, [{ id, at: Date.now() }, ...previous].slice(0, 12));
}

export function loadCollapsedGroups(): Set<string> {
  return readStringSet(KEYS.collapsedGroups);
}

export function saveCollapsedGroups(ids: Iterable<string>) {
  writeStringSet(KEYS.collapsedGroups, ids);
}

export function loadExpandedServers(): Set<string> {
  return readStringSet(KEYS.expandedServers);
}

export function saveExpandedServers(ids: Iterable<string>) {
  writeStringSet(KEYS.expandedServers, ids);
}

/** Database expansion keys use the same `connectionId:dbIndex` format as the tree. */
export function loadExpandedDatabases(): Set<string> {
  return readStringSet(KEYS.expandedDatabases);
}

export function saveExpandedDatabases(ids: Iterable<string>) {
  writeStringSet(KEYS.expandedDatabases, ids);
}

export const DEFAULT_SIDEBAR_WIDTH = 320;

export function loadSidebarWidth(min: number, max: number): number {
  const raw = readJson(KEYS.sidebarWidth);
  const width = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(max, Math.max(min, width));
}

export function saveSidebarWidth(width: number) {
  writeJson(KEYS.sidebarWidth, width);
}
