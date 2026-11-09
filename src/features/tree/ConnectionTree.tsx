import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import DangerDialog from "../../components/ui/DangerDialog";
import { TextInput } from "../../components/ui/fields";
import { Icon } from "../../components/ui/Icon";
import type { MenuItem } from "../../components/ui/Menu";
import { ipc } from "../../lib/ipc";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type {
  ConnectionConfig,
  ConnectionGroup,
  ConnectionSummary,
  FilterHistoryEntry,
  KeyMeta,
  LiveUpdateEvent,
  ServerActionView,
  Settings,
} from "../../lib/types";
import TreeRow from "./TreeRow";
import { buildChildren, flattenNodes, type FlatKeyRow } from "./treeModel";
import { dbKeyOf, type DbView, type ServerView, type TreeRowData } from "./rowTypes";
import {
  loadCollapsedGroups,
  loadExpandedDatabases,
  loadExpandedServers,
  loadFavoriteConnections,
  saveCollapsedGroups,
  saveExpandedDatabases,
  saveExpandedServers,
  saveFavoriteConnections,
  touchRecentConnection,
} from "./treePrefs";
import AddKeyDialog from "../value/AddKeyDialog";
import { BulkTtlDialog, CopyKeysDialog } from "./BulkDialogs";

const ROW_HEIGHT = 34;

/** Must mirror --ui-row in globals.css so virtualization matches the CSS row. */
function rowHeightForViewport(): number {
  if (typeof window === "undefined") return ROW_HEIGHT;
  if (window.matchMedia("(min-width: 2400px)").matches) return 42;
  if (window.matchMedia("(min-width: 1600px)").matches) return 38;
  return ROW_HEIGHT;
}
/** Upper bounds for the two caches that otherwise grow with every scan page. */
const META_CACHE_LIMIT = 5000;
const NS_CACHE_LIMIT = 200;

/** Drops the oldest cache entries; JS object key order is insertion order. */
function capRecord<T>(record: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;
  const capped: Record<string, T> = {};
  for (const key of keys.slice(keys.length - limit)) capped[key] = record[key];
  return capped;
}

function emptyServerView(): ServerView {
  return {
    loaded: false,
    loading: false,
    error: null,
    expanded: false,
    databases: [],
    facts: null,
  };
}

function emptyDb(index: number, filter: string): DbView {
  return {
    index,
    keys: 0,
    filter,
    loaded: false,
    loading: false,
    loadingMore: false,
    expanded: false,
    rootKeys: [],
    cursor: "0",
    nsData: {},
  };
}

function mergeUnique(existing: string[], next: string[], limit: number): string[] {
  const seen = new Set(existing);
  for (const key of next) {
    if (!seen.has(key)) {
      seen.add(key);
      existing.push(key);
      if (existing.length >= limit) break;
    }
  }
  return existing;
}

type DangerAction =
  | { kind: "deleteKey"; connectionId: string; dbIndex: number; key: string }
  | { kind: "deletePattern"; connectionId: string; dbIndex: number; pattern: string }
  | { kind: "flushDb"; connectionId: string; dbIndex: number }
  | { kind: "flushAll"; connectionId: string };

interface DangerPrompt {
  action: DangerAction;
  title: string;
  description: string;
  serverName: string;
  database?: number | null;
  keyCount?: number | null;
  fullServer?: boolean;
  requireText?: string | null;
  confirmLabel?: string;
}

export default function ConnectionTree({
  connections,
  groups,
  settings,
  revision,
  onAddConnection,
  onEditConnection,
  onExportConnection,
  onOpenServerTab,
  onOpenKey,
  onOpenConsole,
  onOpenServerActions,
  onDeleteConnection,
  onBeforeCloseConnection,
  onConnectionClosed,
  externalClose,
  onConnectionsChanged,
  onGroupsChanged,
  onNotify,
  onLog,
}: {
  connections: ConnectionSummary[];
  groups: ConnectionGroup[];
  settings: Settings;
  /** Incremented when connection configs change; resets cached tree data. */
  revision: number;
  onAddConnection: () => void;
  onEditConnection: (id: string) => void;
  /** Backup the single selected connection instead of exporting everything. */
  onExportConnection: (connection: ConnectionSummary) => void;
  onOpenServerTab: (connection: ConnectionSummary) => void;
  onOpenKey: (connectionId: string, db: number, key: string) => void;
  onOpenConsole: (connection: ConnectionSummary, db: number) => void;
  onOpenServerActions: (connection: ConnectionSummary, view?: ServerActionView) => void;
  onDeleteConnection: (id: string) => void;
  /** Returns false to abort the close (e.g. unsaved tabs need confirmation). */
  onBeforeCloseConnection?: (id: string) => boolean;
  /** Called after the pool/subscriptions are released so the shell can drop its tabs. */
  onConnectionClosed?: (id: string) => void;
  /** Closing triggered from elsewhere (a tab) so the cached view must be reset too. */
  externalClose?: { id: string; token: number } | null;
  onConnectionsChanged: () => void;
  onGroupsChanged: () => void;
  onNotify: (message: string) => void;
  onLog: (message: string, level?: "info" | "error") => void;
}) {
  const t = useT();
  const [servers, setServers] = useState<Record<string, ServerView>>({});
  const [configs, setConfigs] = useState<Record<string, ConnectionConfig>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);
  const [favorites, setFavorites] = useState<Set<string>>(loadFavoriteConnections);
  const [query, setQuery] = useState("");
  const [danger, setDanger] = useState<DangerPrompt | null>(null);
  const [dangerBusy, setDangerBusy] = useState(false);
  const [duplicatePrompt, setDuplicatePrompt] = useState<ConnectionSummary | null>(null);
  const [expandedNs, setExpandedNs] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterDb, setFilterDb] = useState<string | null>(null);
  const [filterBusy, setFilterBusy] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, FilterHistoryEntry[]>>({});
  const [meta, setMeta] = useState<Record<string, KeyMeta>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);
  const [rowHeight, setRowHeight] = useState(rowHeightForViewport);
  useEffect(() => {
    const queries = [
      window.matchMedia("(min-width: 1600px)"),
      window.matchMedia("(min-width: 2400px)"),
    ];
    const update = () => setRowHeight(rowHeightForViewport());
    queries.forEach((query) => query.addEventListener("change", update));
    return () => queries.forEach((query) => query.removeEventListener("change", update));
  }, []);
  const [groupDialog, setGroupDialog] = useState<{
    mode: "add" | "edit";
    group: ConnectionGroup | null;
    name: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    kind: "connection" | "group";
    id: string;
    name: string;
  } | null>(null);
  const [addKey, setAddKey] = useState<{
    connectionId: string;
    db: number;
    initialName?: string;
  } | null>(null);
  const [bulk, setBulk] = useState<{
    kind: "ttl" | "copy";
    connectionId: string;
    dbIndex: number;
  } | null>(null);
  const [liveDbs, setLiveDbs] = useState<Set<string>>(new Set());
  const [regroupMode, setRegroupMode] = useState(false);
  const [rootDropActive, setRootDropActive] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const pendingScrollTop = useRef(0);
  const configRequests = useRef(new Map<string, Promise<ConnectionConfig>>());
  const pendingMeta = useRef(new Set<string>());
  const failedMeta = useRef(new Set<string>());
  const metaQueue = useRef<{ connectionId: string; db: number; key: string; cacheKey: string }[]>(
    [],
  );
  const restoredExpansions = useRef(false);
  /** DBs that were expanded before restart and still need their first load. */
  const pendingAutoExpand = useRef(new Set<string>());

  // Live update plumbing. The listener is registered once and reads from refs
  // so it always sees the latest settings/servers without re-subscribing.
  const liveDbsRef = useRef(liveDbs);
  const settingsRef = useRef(settings);
  const serversRef = useRef(servers);
  const liveTimers = useRef<Record<string, number>>({});
  const liveRefreshRef = useRef<(connectionId: string, dbIndex: number) => void>(() => {});

  useEffect(() => {
    liveDbsRef.current = liveDbs;
  }, [liveDbs]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    serversRef.current = servers;
  }, [servers]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) window.cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  /** Coalesces scroll events into at most one state update per animation frame. */
  const handleScroll = (top: number) => {
    pendingScrollTop.current = top;
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      setScrollTop(pendingScrollTop.current);
    });
  };

  useEffect(() => {
    // Connection configs changed (save/delete/duplicate/import): drop cached
    // SCAN pages and TYPE/TTL results so the next expansion re-reads the server.
    setServers({});
    setConfigs({});
    setMeta({});
    setSelectedId(null);
    setFilterDb(null);
    setExpandedNs(new Set());
    configRequests.current.clear();
    pendingMeta.current.clear();
    failedMeta.current.clear();
  }, [revision]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<LiveUpdateEvent>("live-update", (event) => {
      const payload = event.payload;
      const key = dbKeyOf(payload.connectionId, payload.db);
      if (!liveDbsRef.current.has(key)) return;
      // One reload per interval, like databaseitem.cpp's single-shot timer.
      if (liveTimers.current[key]) return;
      const interval = Math.max(3, settingsRef.current.liveUpdateInterval);
      liveTimers.current[key] = window.setTimeout(() => {
        delete liveTimers.current[key];
        liveRefreshRef.current(payload.connectionId, payload.db);
      }, interval * 1000);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((e) => onLog(t("tree.liveListenerFailed", { error: errMessage(e) }), "error"));

    return () => {
      disposed = true;
      unlisten?.();
      for (const timer of Object.values(liveTimers.current)) window.clearTimeout(timer);
      liveTimers.current = {};
      // Closing the tree (or the window) closes every dedicated subscription.
      for (const key of liveDbsRef.current) {
        const [connectionId, rawDb] = key.split(":");
        void ipc.stopLiveUpdate({ connectionId, db: Number(rawDb) }).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureConfig = (connectionId: string): Promise<ConnectionConfig> => {
    const cached = configs[connectionId];
    if (cached) return Promise.resolve(cached);
    let request = configRequests.current.get(connectionId);
    if (!request) {
      request = ipc
        .getConnection(connectionId)
        .then((config) => {
          setConfigs((prev) => ({ ...prev, [connectionId]: config }));
          return config;
        })
        .catch((e) => {
          configRequests.current.delete(connectionId);
          throw e;
        });
      configRequests.current.set(connectionId, request);
    }
    return request;
  };

  const updateServer = (id: string, fn: (view: ServerView) => ServerView) => {
    setServers((prev) => ({ ...prev, [id]: fn(prev[id] ?? emptyServerView()) }));
  };

  const updateDb = (connectionId: string, dbIndex: number, fn: (db: DbView) => DbView) => {
    updateServer(connectionId, (view) => ({
      ...view,
      databases: view.databases.map((db) => (db.index === dbIndex ? fn(db) : db)),
    }));
  };

  /** Persisted expansion flags; unknown/stale ids are filtered on restore. */
  const rememberServerExpanded = (connectionId: string, expanded: boolean) => {
    const ids = loadExpandedServers();
    if (expanded) ids.add(connectionId);
    else ids.delete(connectionId);
    saveExpandedServers(ids);
  };

  const rememberDbExpanded = (connectionId: string, dbIndex: number, expanded: boolean) => {
    const ids = loadExpandedDatabases();
    const key = dbKeyOf(connectionId, dbIndex);
    if (expanded) ids.add(key);
    else ids.delete(key);
    saveExpandedDatabases(ids);
  };

  const forgetConnectionExpansion = (connectionId: string) => {
    const prefix = `${connectionId}:`;
    const serverIds = loadExpandedServers();
    serverIds.delete(connectionId);
    saveExpandedServers(serverIds);
    const dbIds = loadExpandedDatabases();
    for (const key of [...dbIds]) if (key.startsWith(prefix)) dbIds.delete(key);
    saveExpandedDatabases(dbIds);
    for (const key of [...pendingAutoExpand.current]) {
      if (key.startsWith(prefix)) pendingAutoExpand.current.delete(key);
    }
  };

  const dbKeyCount = (connectionId: string, dbIndex: number): number | null => {
    const db = servers[connectionId]?.databases.find((item) => item.index === dbIndex);
    return db ? db.keys : null;
  };

  const refreshHistory = async (connectionId: string) => {
    try {
      const entries = await ipc.filterHistory(connectionId);
      setHistory((prev) => ({ ...prev, [connectionId]: entries }));
    } catch (e) {
      onLog(t("tree.filterHistoryFailed", { error: errMessage(e) }), "error");
    }
  };

  const loadServer = async (connection: ConnectionSummary) => {
    updateServer(connection.id, (view) => ({
      ...view,
      expanded: true,
      loading: !view.loaded,
      error: null,
    }));
    rememberServerExpanded(connection.id, true);
    try {
      const config = await ensureConfig(connection.id);
      const [databases, facts] = await Promise.all([
        ipc.listDatabases(connection.id),
        ipc.serverFacts(connection.id).catch((error) => {
          onLog(t("tree.loadFactsFailed", { error: errMessage(error) }), "error");
          return null;
        }),
      ]);
      const prefix = `${connection.id}:`;
      const expandedDbIndexes = new Set(
        [...loadExpandedDatabases()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => Number(key.slice(prefix.length)))
          .filter((index) => Number.isInteger(index)),
      );
      updateServer(connection.id, (view) => {
        const previous = new Map(view.databases.map((db) => [db.index, db]));
        return {
          ...view,
          loaded: true,
          loading: false,
          error: null,
          facts,
          databases: databases.map((info) => {
            const old = previous.get(info.index);
            return old
              ? { ...old, keys: info.keys }
              : {
                  ...emptyDb(info.index, config.keysPattern),
                  keys: info.keys,
                  expanded: expandedDbIndexes.has(info.index),
                };
          }),
        };
      });
      for (const index of expandedDbIndexes) {
        if (databases.some((db) => db.index === index)) {
          pendingAutoExpand.current.add(dbKeyOf(connection.id, index));
        }
      }
      touchRecentConnection(connection.id);
      onLog(t("tree.loadedDatabases", { count: databases.length, name: connection.name }));
    } catch (e) {
      const message = errMessage(e);
      updateServer(connection.id, (view) => ({ ...view, loading: false, error: message }));
      onNotify(message);
      onLog(`${connection.name}: ${message}`, "error");
    }
  };

  // Restore the servers that were expanded in the previous session. Unknown
  // connection ids from a deleted/renamed config are simply skipped.
  useEffect(() => {
    if (restoredExpansions.current || !connections.length) return;
    restoredExpansions.current = true;
    for (const id of loadExpandedServers()) {
      const connection = connections.find((item) => item.id === id);
      if (!connection || servers[id]?.expanded) continue;
      void loadServer(connection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  // Expanded DBs restored from storage load their first SCAN page once the
  // server view has been populated by the render triggered above.
  useEffect(() => {
    if (!pendingAutoExpand.current.size) return;
    for (const key of [...pendingAutoExpand.current]) {
      const separator = key.indexOf(":");
      const connectionId = key.slice(0, separator);
      const dbIndex = Number(key.slice(separator + 1));
      const db = servers[connectionId]?.databases.find((item) => item.index === dbIndex);
      if (!db) continue;
      pendingAutoExpand.current.delete(key);
      if (!db.loaded && !db.loading) void loadDb(connectionId, dbIndex, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);

  const scanDb = async (
    connectionId: string,
    dbIndex: number,
    cursor: string,
    filter: string,
    namespace: string | null,
  ) => {
    return ipc.scanKeys({
      connectionId,
      db: dbIndex,
      cursor,
      namespace,
      filter,
      pageSize: settings.scanPageSize,
    });
  };

  const clearNsExpansion = (dbKey: string) => {
    setExpandedNs((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (!id.startsWith(`ns:${dbKey}:`)) next.add(id);
      return next;
    });
  };

  /**
   * Scans the database root from cursor 0. `reset` replaces the loaded page
   * (explicit reload / new filter); `preserve` keeps the already loaded keys
   * and namespace pages visible and merges the new page into them, which is
   * what the Live Update refresh needs.
   */
  const loadDb = async (
    connectionId: string,
    dbIndex: number,
    reset: boolean,
    filterOverride?: string,
    preserve = false,
  ) => {
    const dbKey = dbKeyOf(connectionId, dbIndex);
    const current = servers[connectionId]?.databases.find((db) => db.index === dbIndex);
    if (!current || current.loading) return;
    const filter =
      filterOverride ??
      (reset || !current.loaded
        ? (configs[connectionId]?.keysPattern ?? current.filter)
        : current.filter);
    const replace = reset && !preserve;

    updateDb(connectionId, dbIndex, (db) => ({
      ...db,
      loading: true,
      // Keep the existing rows on screen while the refresh is in flight
      // instead of collapsing the database and losing the loaded pages.
      loaded: db.loaded,
      expanded: true,
      filter: reset ? filter : db.filter,
    }));
    rememberDbExpanded(connectionId, dbIndex, true);

    try {
      const page = await scanDb(connectionId, dbIndex, "0", filter, null);
      updateDb(connectionId, dbIndex, (db) => ({
        ...db,
        loading: false,
        loaded: true,
        expanded: true,
        filter,
        rootKeys: replace
          ? page.keys.slice(0, settings.scanLimit)
          : mergeUnique(db.rootKeys.slice(), page.keys, settings.scanLimit),
        cursor: page.cursor,
        nsData: replace ? {} : db.nsData,
      }));
      if (reset && !preserve) {
        // The original "reopen namespaces on reload" option keeps previously
        // expanded namespaces open (and re-reads their own SCAN page).
        if (settings.reopenNamespacesOnReload) {
          const prefix = `ns:${dbKey}:`;
          const reopened = [...expandedNs]
            .filter((id) => id.startsWith(prefix))
            .map((id) => id.slice(prefix.length));
          for (const fullPath of reopened) {
            void loadNamespace(connectionId, dbIndex, fullPath, filter);
          }
        } else {
          clearNsExpansion(dbKey);
        }
        await ipc.rememberFilter(connectionId, filter).catch(() => undefined);
        await refreshHistory(connectionId);
      }

      // databaseitem.cpp disables live update once the key count exceeds the
      // configured limit.
      if (liveDbsRef.current.has(dbKey) && current.keys > settings.liveUpdateKeysLimit) {
        liveDbsRef.current.delete(dbKey);
        const timer = liveTimers.current[dbKey];
        if (timer) {
          window.clearTimeout(timer);
          delete liveTimers.current[dbKey];
        }
        setLiveDbs((prev) => {
          const next = new Set(prev);
          next.delete(dbKey);
          return next;
        });
        void ipc.stopLiveUpdate({ connectionId, db: dbIndex }).catch(() => undefined);
        onNotify(
          t("tree.liveDisabledLimit", {
            db: dbIndex,
            count: current.keys,
            limit: settings.liveUpdateKeysLimit,
          }),
        );
      }
    } catch (e) {
      updateDb(connectionId, dbIndex, (db) => ({ ...db, loading: false }));
      const message = errMessage(e);
      onNotify(message);
      onLog(t("tree.dbError", { db: dbIndex, error: message }), "error");
    }
  };

  liveRefreshRef.current = (connectionId, dbIndex) => {
    const db = servers[connectionId]?.databases.find((item) => item.index === dbIndex);
    if (!db || !db.loaded) return;
    // preserve: a Live Update tick must not blank the tree or drop the pages
    // and namespace data the user already loaded.
    void loadDb(connectionId, dbIndex, true, db.filter, true);
  };

  const loadMore = async (row: Extract<TreeRowData, { kind: "loadmore" }>) => {
    const view = servers[row.connectionId];
    const db = view?.databases.find((item) => item.index === row.dbIndex);
    if (!db) return;
    if (row.namespace === null) {
      if (db.cursor === "0" || db.loadingMore) return;
      updateDb(row.connectionId, row.dbIndex, (d) => ({ ...d, loadingMore: true }));
      try {
        const page = await scanDb(row.connectionId, row.dbIndex, db.cursor, db.filter, null);
        updateDb(row.connectionId, row.dbIndex, (d) => ({
          ...d,
          loadingMore: false,
          rootKeys: mergeUnique(d.rootKeys.slice(), page.keys, settings.scanLimit),
          cursor: page.cursor,
        }));
      } catch (e) {
        updateDb(row.connectionId, row.dbIndex, (d) => ({ ...d, loadingMore: false }));
        onNotify(t("common.operationFailed", { error: errMessage(e) }));
      }
      return;
    }

    const ns = db.nsData[row.namespace];
    if (!ns || ns.cursor === "0" || ns.loading) return;
    updateDb(row.connectionId, row.dbIndex, (d) => ({
      ...d,
      nsData: {
        ...d.nsData,
        [row.namespace as string]: { ...ns, loading: true },
      },
    }));
    try {
      const page = await scanDb(row.connectionId, row.dbIndex, ns.cursor, db.filter, row.namespace);
      updateDb(row.connectionId, row.dbIndex, (d) => {
        const existing = d.nsData[row.namespace as string];
        return {
          ...d,
          nsData: capRecord(
            {
              ...d.nsData,
              [row.namespace as string]: {
                ...existing,
                loading: false,
                loaded: true,
                keys: mergeUnique(existing.keys.slice(), page.keys, settings.scanLimit),
                cursor: page.cursor,
              },
            },
            NS_CACHE_LIMIT,
          ),
        };
      });
    } catch (e) {
      updateDb(row.connectionId, row.dbIndex, (d) => ({
        ...d,
        nsData: {
          ...d.nsData,
          [row.namespace as string]: { ...ns, loading: false },
        },
      }));
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    }
  };

  const loadNamespace = async (
    connectionId: string,
    dbIndex: number,
    fullPath: string,
    filterOverride?: string,
  ) => {
    const db = servers[connectionId]?.databases.find((item) => item.index === dbIndex);
    if (!db) return;
    const existing = db.nsData[fullPath];
    if (existing?.loading) return;
    const filter = filterOverride ?? db.filter;
    updateDb(connectionId, dbIndex, (d) => ({
      ...d,
      nsData: {
        ...d.nsData,
        [fullPath]: {
          keys: existing?.keys ?? [],
          cursor: existing?.cursor ?? "0",
          loaded: existing?.loaded ?? false,
          loading: true,
        },
      },
    }));
    try {
      const page = await scanDb(connectionId, dbIndex, "0", filter, fullPath);
      updateDb(connectionId, dbIndex, (d) => ({
        ...d,
        nsData: capRecord(
          {
            ...d.nsData,
            [fullPath]: {
              keys: page.keys.slice(0, settings.scanLimit),
              cursor: page.cursor,
              loaded: true,
              loading: false,
            },
          },
          NS_CACHE_LIMIT,
        ),
      }));
    } catch (e) {
      updateDb(connectionId, dbIndex, (d) => ({
        ...d,
        nsData: {
          ...d.nsData,
          [fullPath]: {
            keys: existing?.keys ?? [],
            cursor: existing?.cursor ?? "0",
            loaded: existing?.loaded ?? false,
            loading: false,
          },
        },
      }));
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    }
  };

  const applyFilter = async (dbKey: string, pattern: string) => {
    const [connectionId, rawDb] = dbKey.split(":");
    const dbIndex = Number(rawDb);
    const db = servers[connectionId]?.databases.find((item) => item.index === dbIndex);
    if (!db) return;

    if (!pattern.includes("*")) {
      try {
        const exists = await ipc.keyExists({ connectionId, db: dbIndex, key: pattern });
        if (exists) {
          onNotify(t("tree.filterIsKey"));
          return;
        }
      } catch (e) {
        onLog(t("tree.existsFailed", { error: errMessage(e) }), "error");
      }
    }

    setFilterBusy(dbKey);
    setFilterDb(null);
    await loadDb(connectionId, dbIndex, true, pattern);
    setFilterBusy(null);
  };

  const resetFilter = async (dbKey: string) => {
    const [connectionId, rawDb] = dbKey.split(":");
    const dbIndex = Number(rawDb);
    const pattern = configs[connectionId]?.keysPattern ?? "*";
    setFilterBusy(dbKey);
    setFilterDb(null);
    await loadDb(connectionId, dbIndex, true, pattern);
    setFilterBusy(null);
  };

  // ---- row construction -------------------------------------------------
  // Memoized: scrolling and selection changes must not rebuild the tree model.
  // Rebuilding sorted every loaded key (`buildChildren` -> `keys.slice().sort()`)
  // on each scroll tick, which froze the sidebar for large databases.
  const rows = useMemo<TreeRowData[]>(() => {
    const next: TreeRowData[] = [];
    const knownGroups = new Set(groups.map((group) => group.id));

    const localHasMore = (db: DbView, namespace: string | null): boolean => {
      if (namespace === null) return db.cursor !== "0" && db.rootKeys.length < settings.scanLimit;
      const ns = db.nsData[namespace];
      return Boolean(ns && ns.cursor !== "0" && ns.keys.length < settings.scanLimit);
    };

    const addConnectionRows = (connection: ConnectionSummary, depth: number) => {
      const view = servers[connection.id] ?? emptyServerView();
      next.push({ kind: "server", id: `server:${connection.id}`, connection, view, depth });
      if (!view.expanded || !view.loaded) return;

      for (const db of view.databases) {
        const dbKey = dbKeyOf(connection.id, db.index);
        const dbDepth = depth + 1;
        next.push({ kind: "database", id: `db:${dbKey}`, connection, db, depth: dbDepth });
        if (filterDb === dbKey) {
          next.push({
            kind: "filter",
            id: `filter:${dbKey}`,
            connection,
            db,
            depth: dbDepth + 1,
          });
        }
        if (!db.expanded || !db.loaded) continue;

        const separator = configs[connection.id]?.namespaceSeparator ?? ":";
        const tree = buildChildren(
          dbKey,
          "",
          db.rootKeys,
          separator,
          settings.namespacedKeysShortName,
          db.nsData,
          settings.showNamespacesOnTop,
        );
        const flat: FlatKeyRow[] = flattenNodes(tree, expandedNs, (namespace) =>
          localHasMore(db, namespace),
        );
        for (const row of flat) {
          if (row.rowKind === "node") {
            next.push({
              kind: "node",
              id: row.node.id,
              connectionId: connection.id,
              dbKey,
              dbIndex: db.index,
              node: row.node,
              depth: dbDepth + 1 + row.depth,
            });
          } else {
            next.push({
              kind: "loadmore",
              id: row.id,
              connectionId: connection.id,
              dbKey,
              dbIndex: db.index,
              namespace: row.namespace,
              depth: dbDepth + 1 + row.depth,
            });
          }
        }
        if (localHasMore(db, null)) {
          next.push({
            kind: "loadmore",
            id: `more:${dbKey}`,
            connectionId: connection.id,
            dbKey,
            dbIndex: db.index,
            namespace: null,
            depth: dbDepth + 1,
          });
        }
      }
    };

    const sortedGroups = groups
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const rootConnections = connections.filter(
      (connection) => !connection.groupId || !knownGroups.has(connection.groupId),
    );

    // Search only filters connections; groups/structure and the persisted
    // collapse state stay untouched. Matching members are shown even inside a
    // collapsed group so the result is never hidden.
    const needle = query.trim().toLowerCase();
    const searching = needle.length > 0;
    const matchesSearch = (connection: ConnectionSummary) =>
      !searching ||
      connection.name.toLowerCase().includes(needle) ||
      `${connection.host}:${connection.port}`.toLowerCase().includes(needle) ||
      connection.host.toLowerCase().includes(needle);

    for (const group of sortedGroups) {
      const members = connections
        .filter((connection) => connection.groupId === group.id)
        .filter(matchesSearch);
      if (searching && members.length === 0) continue;
      next.push({ kind: "group", id: `group:${group.id}`, group, depth: 0 });
      if (searching || !collapsedGroups.has(group.id)) {
        for (const connection of members) addConnectionRows(connection, 1);
      }
    }
    for (const connection of rootConnections.filter(matchesSearch)) {
      addConnectionRows(connection, 0);
    }
    return next;
  }, [
    connections,
    groups,
    servers,
    configs,
    settings,
    collapsedGroups,
    expandedNs,
    filterDb,
    query,
  ]);

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 16;
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  /** Visible window plus overscan; metadata is only requested for these rows. */
  const windowRows = rows.slice(startIndex, endIndex);

  // ---- metadata (TYPE / TTL) for key rows --------------------------------

  const keyRows = windowRows.filter(
    (row): row is Extract<TreeRowData, { kind: "node" }> =>
      row.kind === "node" && row.node.kind === "key",
  );
  const missingMeta = keyRows
    .map((row) => ({
      connectionId: row.connectionId,
      db: row.dbIndex,
      key: row.node.full,
      cacheKey: `${row.dbKey}:${row.node.full}`,
    }))
    .filter(
      (item) =>
        !meta[item.cacheKey] &&
        !pendingMeta.current.has(item.cacheKey) &&
        !failedMeta.current.has(item.cacheKey),
    );
  const missingSignature = missingMeta.map((item) => item.cacheKey).join("\u0001");
  metaQueue.current = missingMeta;

  useEffect(() => {
    if (!missingSignature) return;
    const timer = window.setTimeout(() => {
      const queue = metaQueue.current;
      if (!queue.length) return;
      const groupsBySource = new Map<string, typeof queue>();
      for (const item of queue) {
        const id = `${item.connectionId}\u0000${item.db}`;
        const list = groupsBySource.get(id) ?? [];
        list.push(item);
        groupsBySource.set(id, list);
      }
      void (async () => {
        for (const items of groupsBySource.values()) {
          const { connectionId, db } = items[0];
          for (let offset = 0; offset < items.length; offset += 50) {
            const chunk = items.slice(offset, offset + 50);
            for (const item of chunk) pendingMeta.current.add(item.cacheKey);
            try {
              const result = await ipc.keyMetaBatch({
                connectionId,
                db,
                keys: chunk.map((item) => item.key),
              });
              setMeta((prev) => {
                const next = { ...prev };
                for (const item of result) {
                  next[`${connectionId}:${db}:${item.key}`] = item;
                }
                return capRecord(next, META_CACHE_LIMIT);
              });
            } catch (e) {
              for (const item of chunk) failedMeta.current.add(item.cacheKey);
              onLog(t("tree.typeTtlFailed", { error: errMessage(e) }), "error");
            } finally {
              for (const item of chunk) pendingMeta.current.delete(item.cacheKey);
            }
          }
        }
      })();
    }, 220);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingSignature]);

  // ---- interactions ------------------------------------------------------

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    onNotify(t("tree.copied", { text }));
  };

  const stopLiveDb = async (connectionId: string, dbIndex: number) => {
    const key = dbKeyOf(connectionId, dbIndex);
    // Drop the queued reload timer even if live update was already disabled;
    // otherwise it fires once after the subscription has been stopped.
    const timer = liveTimers.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete liveTimers.current[key];
    }
    if (!liveDbsRef.current.has(key)) return;
    liveDbsRef.current.delete(key);
    setLiveDbs((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    await ipc.stopLiveUpdate({ connectionId, db: dbIndex }).catch(() => undefined);
  };

  const stopServerLive = async (connectionId: string) => {
    const prefix = `${connectionId}:`;
    const keys = [...liveDbsRef.current].filter((key) => key.startsWith(prefix));
    for (const key of keys) {
      const dbIndex = Number(key.slice(prefix.length));
      await stopLiveDb(connectionId, dbIndex);
    }
  };

  const toggleLive = async (connection: ConnectionSummary, db: DbView) => {
    const key = dbKeyOf(connection.id, db.index);
    if (liveDbs.has(key)) {
      await stopLiveDb(connection.id, db.index);
      onNotify(t("tree.liveDisabled", { db: db.index }));
      return;
    }
    if (db.keys > settings.liveUpdateKeysLimit) {
      onNotify(
        t("tree.liveDisabledLimit", {
          db: db.index,
          count: db.keys,
          limit: settings.liveUpdateKeysLimit,
        }),
      );
      return;
    }
    try {
      await ipc.startLiveUpdate({ connectionId: connection.id, db: db.index });
      setLiveDbs((prev) => new Set(prev).add(key));
      onNotify(t("tree.liveEnabled", { db: db.index }));
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
      onLog(t("tree.liveListenerFailed", { error: errMessage(e) }), "error");
    }
  };

  /**
   * "Close Connection": releases the pooled Redis connections and the
   * Live Update / MONITOR subscriptions of one server, collapses its subtree
   * and drops cached TYPE/TTL data. The saved connection config is untouched,
   * so expanding it again reconnects with the same settings.
   */
  const closeConnection = async (connection: ConnectionSummary) => {
    if (onBeforeCloseConnection && !onBeforeCloseConnection(connection.id)) return;
    try {
      await ipc.closeConnection(connection.id);
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
      onLog(t("tree.closeConnectionFailed", { error: errMessage(e) }), "error");
    }
    resetClosedConnection(connection.id);
    onConnectionClosed?.(connection.id);
    onNotify(t("tree.closedConnection", { name: connection.name }));
  };

  /** Drops the in-memory view (pool/subscriptions are already released). */
  const resetClosedConnection = (connectionId: string) => {
    forgetConnectionExpansion(connectionId);
    const prefix = `${connectionId}:`;
    for (const key of Object.keys(liveTimers.current)) {
      if (!key.startsWith(prefix)) continue;
      window.clearTimeout(liveTimers.current[key]);
      delete liveTimers.current[key];
    }
    const remaining = new Set([...liveDbsRef.current].filter((key) => !key.startsWith(prefix)));
    liveDbsRef.current = remaining;
    setLiveDbs(remaining);
    setExpandedNs((prev) => {
      const next = new Set<string>();
      let changed = false;
      for (const id of prev) {
        if (id.startsWith(`ns:${prefix}`)) changed = true;
        else next.add(id);
      }
      return changed ? next : prev;
    });
    setMeta((prev) => {
      const matching = Object.keys(prev).filter((key) => key.startsWith(prefix));
      if (!matching.length) return prev;
      const next = { ...prev };
      for (const key of matching) delete next[key];
      return next;
    });
    updateServer(connectionId, () => emptyServerView());
    setSelectedId((prev) => {
      if (!prev) return prev;
      if (prev === `server:${connectionId}` || prev.includes(`:${prefix}`)) return null;
      return prev;
    });
  };

  useEffect(() => {
    if (!externalClose) return;
    resetClosedConnection(externalClose.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalClose]);

  const deleteKeyRow = (row: Extract<TreeRowData, { kind: "node" }>) => {
    const connection = connections.find((item) => item.id === row.connectionId);
    if (!connection) return;
    setDanger({
      action: {
        kind: "deleteKey",
        connectionId: row.connectionId,
        dbIndex: row.dbIndex,
        key: row.node.full,
      },
      title: t("danger.deleteKeyTitle"),
      description: t("danger.deleteKeyDescription", {
        key: row.node.full,
        db: row.dbIndex,
      }),
      serverName: connection.name,
      database: row.dbIndex,
      keyCount: dbKeyCount(row.connectionId, row.dbIndex),
      confirmLabel: t("tree.deleteKey"),
    });
  };

  const deleteByPattern = (connectionId: string, dbIndex: number, pattern: string) => {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) return;
    setDanger({
      action: { kind: "deletePattern", connectionId, dbIndex, pattern },
      title: t("danger.deletePatternTitle"),
      description: t("danger.deletePatternDescription", { pattern, db: dbIndex }),
      serverName: connection.name,
      database: dbIndex,
      keyCount: dbKeyCount(connectionId, dbIndex),
      requireText: connection.name,
      confirmLabel: t("tree.deleteWithFilter"),
    });
  };

  const flushDatabase = (connectionId: string, dbIndex: number) => {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) return;
    setDanger({
      action: { kind: "flushDb", connectionId, dbIndex },
      title: t("danger.flushDbTitle", { db: dbIndex }),
      description: t("danger.flushDbDescription", { db: dbIndex }),
      serverName: connection.name,
      database: dbIndex,
      keyCount: dbKeyCount(connectionId, dbIndex),
      requireText: connection.name,
      confirmLabel: t("tree.flushDatabase"),
    });
  };

  const flushAllDatabases = (connection: ConnectionSummary) => {
    setDanger({
      action: { kind: "flushAll", connectionId: connection.id },
      title: t("danger.flushAllTitle", { name: connection.name }),
      description: t("danger.flushAllDescription"),
      serverName: connection.name,
      fullServer: true,
      requireText: connection.name,
      confirmLabel: t("danger.flushAllConfirm"),
    });
  };

  const runDanger = async () => {
    if (!danger || dangerBusy) return;
    const action = danger.action;
    setDangerBusy(true);
    try {
      switch (action.kind) {
        case "deleteKey": {
          await ipc.deleteKey({
            connectionId: action.connectionId,
            db: action.dbIndex,
            key: action.key,
          });
          onNotify(t("tree.deleted", { key: action.key }));
          setMeta((prev) => {
            const next = { ...prev };
            delete next[`${dbKeyOf(action.connectionId, action.dbIndex)}:${action.key}`];
            return next;
          });
          await loadDb(action.connectionId, action.dbIndex, true);
          break;
        }
        case "deletePattern": {
          const deleted = await ipc.deleteKeysByPattern({
            connectionId: action.connectionId,
            db: action.dbIndex,
            pattern: action.pattern,
            limit: settings.scanLimit,
          });
          onNotify(t("tree.deletedMatching", { count: deleted, pattern: action.pattern }));
          await loadDb(action.connectionId, action.dbIndex, true);
          break;
        }
        case "flushDb": {
          await ipc.flushDatabase({ connectionId: action.connectionId, db: action.dbIndex });
          onNotify(t("tree.flushed", { db: action.dbIndex }));
          await loadDb(action.connectionId, action.dbIndex, true);
          break;
        }
        case "flushAll": {
          const databases = await ipc.listDatabases(action.connectionId);
          for (const db of databases) {
            await ipc.flushDatabase({ connectionId: action.connectionId, db: db.index });
          }
          onNotify(t("tree.flushedAll", { count: databases.length }));
          updateServer(action.connectionId, (view) => ({
            ...emptyServerView(),
            expanded: view.expanded,
            databases: databases.map((db) => ({
              ...emptyDb(db.index, configs[action.connectionId]?.keysPattern ?? "*"),
              keys: 0,
              loaded: true,
              expanded: false,
            })),
            loaded: true,
            facts: view.facts,
          }));
          break;
        }
      }
      setDanger(null);
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    } finally {
      setDangerBusy(false);
    }
  };

  const toggleFavorite = (connectionId: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(connectionId)) next.delete(connectionId);
      else next.add(connectionId);
      saveFavoriteConnections(next);
      return next;
    });
  };

  const duplicateConnection = async (connection: ConnectionSummary) => {
    setDuplicatePrompt(null);
    try {
      const copy = await ipc.duplicateConnection(connection.id);
      onNotify(t("tree.created", { name: copy.name }));
      onConnectionsChanged();
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    }
  };

  const moveConnection = async (connectionId: string, groupId: string | null) => {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection || (connection.groupId ?? null) === groupId) return;
    try {
      await ipc.moveConnection(connectionId, groupId);
      const target = groupId
        ? (groups.find((group) => group.id === groupId)?.name ?? t("tree.groupName"))
        : t("tree.ungrouped");
      onNotify(t("tree.moved", { name: connection.name, group: target }));
      onConnectionsChanged();
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    }
  };

  const serverMenu = (connection: ConnectionSummary, view: ServerView): MenuItem[] => {
    const liveCount = [...liveDbs].filter((key) => key.startsWith(`${connection.id}:`)).length;
    return [
      {
        key: "reload",
        label: t("tree.reloadDatabases"),
        shortcut: "Ctrl+R",
        icon: "refresh",
        onClick: () => {
          updateServer(connection.id, () => emptyServerView());
          setExpandedNs(new Set());
          void loadServer(connection);
        },
      },
      {
        key: "unload",
        label: t("tree.unloadAll"),
        shortcut: "Ctrl+U",
        icon: "unload",
        onClick: () => {
          void stopServerLive(connection.id);
          updateServer(connection.id, () => emptyServerView());
          forgetConnectionExpansion(connection.id);
          setExpandedNs(new Set());
        },
      },
      {
        key: "close",
        label: t("tree.closeConnection"),
        icon: "x",
        onClick: () => void closeConnection(connection),
      },
      {
        key: "favorite",
        label: favorites.has(connection.id) ? t("tree.unfavorite") : t("tree.favorite"),
        icon: favorites.has(connection.id) ? "star-filled" : "star",
        onClick: () => toggleFavorite(connection.id),
      },
      {
        key: "edit",
        label: t("tree.editConnection"),
        shortcut: "Ctrl+E",
        icon: "edit",
        separatorBefore: true,
        onClick: () => onEditConnection(connection.id),
      },
      {
        key: "duplicate",
        label: t("tree.duplicateConnection"),
        icon: "copy",
        onClick: () => setDuplicatePrompt(connection),
      },
      {
        key: "export",
        label: t("tree.exportConnection"),
        icon: "export",
        onClick: () => onExportConnection(connection),
      },
      {
        key: "console",
        label: t("server.view.console"),
        shortcut: "Ctrl+T",
        icon: "terminal",
        separatorBefore: true,
        onClick: () => onOpenConsole(connection, 0),
      },
      {
        key: "server-info",
        label: t("server.view.info"),
        icon: "server",
        onClick: () => onOpenServerActions(connection, "info"),
      },
      {
        key: "server-monitor",
        label: t("server.view.monitor"),
        icon: "eye",
        onClick: () => onOpenServerActions(connection, "monitor"),
      },
      {
        key: "server-slowlog",
        label: t("server.view.slowlog"),
        icon: "log",
        onClick: () => onOpenServerActions(connection, "slowlog"),
      },
      {
        key: "server-clients",
        label: t("server.view.clients"),
        icon: "group",
        onClick: () => onOpenServerActions(connection, "clients"),
      },
      {
        key: "server-stats",
        label: t("server.view.stats"),
        icon: "activity",
        onClick: () => onOpenServerActions(connection, "stats"),
      },
      {
        key: "memory",
        label: t("tree.analyzeMemory"),
        icon: "database",
        onClick: () => onOpenServerActions(connection, "memory"),
      },
      {
        key: "copy",
        label: t("tree.copyHost"),
        icon: "copy",
        separatorBefore: true,
        onClick: () => copyText(`${connection.host}:${connection.port}`),
      },
      ...(connection.groupId
        ? ([
            {
              key: "ungroup",
              label: t("tree.removeFromGroup"),
              icon: "group",
              onClick: () => void moveConnection(connection.id, null),
            },
          ] as MenuItem[])
        : []),
      ...(liveCount > 0
        ? ([
            {
              key: "stop-live",
              label: t("tree.stopLive", { count: liveCount }),
              icon: "activity",
              separatorBefore: true,
              onClick: () => void stopServerLive(connection.id),
            },
          ] as MenuItem[])
        : []),
      {
        key: "flush-all",
        label: t("tree.flushAllDatabases"),
        icon: "trash",
        danger: true,
        separatorBefore: true,
        onClick: () => flushAllDatabases(connection),
      },
      {
        key: "delete",
        label: t("tree.deleteConnection"),
        icon: "trash",
        danger: true,
        separatorBefore: true,
        onClick: () =>
          setConfirmDelete({ kind: "connection", id: connection.id, name: connection.name }),
      },
      ...(view.error
        ? ([
            {
              key: "error",
              label: view.error,
              disabled: true,
              onClick: () => undefined,
            },
          ] as MenuItem[])
        : []),
    ];
  };

  const dbMenu = (connection: ConnectionSummary, db: DbView): MenuItem[] => {
    const dbKey = dbKeyOf(connection.id, db.index);
    const live = liveDbs.has(dbKey);
    return [
      {
        key: "filter",
        label: t("tree.filterKeys"),
        shortcut: "Ctrl+F",
        icon: "filter",
        onClick: () => {
          setFilterDb(dbKey);
          void refreshHistory(connection.id);
        },
      },
      {
        key: "reload",
        label: t("tree.reloadKeys"),
        shortcut: "Ctrl+R",
        icon: "refresh",
        onClick: () => void loadDb(connection.id, db.index, true),
      },
      {
        key: "add",
        label: t("tree.addNewKey"),
        shortcut: "Ctrl+N",
        icon: "plus",
        onClick: () => setAddKey({ connectionId: connection.id, db: db.index }),
      },
      {
        key: "live",
        label: live ? t("tree.disableLive") : t("tree.enableLive"),
        shortcut: "Ctrl+L",
        icon: "activity",
        onClick: () => void toggleLive(connection, db),
      },
      {
        key: "console",
        label: t("server.view.console"),
        shortcut: "Ctrl+T",
        icon: "terminal",
        separatorBefore: true,
        onClick: () => onOpenConsole(connection, db.index),
      },
      {
        key: "memory",
        label: t("tree.analyzeMemory"),
        icon: "database",
        onClick: () => onOpenServerActions(connection, "memory"),
      },
      {
        key: "bulk-ttl",
        label: t("tree.setTtlMultiple"),
        icon: "key",
        separatorBefore: true,
        onClick: () => setBulk({ kind: "ttl", connectionId: connection.id, dbIndex: db.index }),
      },
      {
        key: "bulk-copy",
        label: t("tree.copyKeys"),
        icon: "copy",
        onClick: () => setBulk({ kind: "copy", connectionId: connection.id, dbIndex: db.index }),
      },
      {
        key: "delete-filter",
        label: t("tree.deleteWithFilter"),
        danger: true,
        separatorBefore: true,
        onClick: () => deleteByPattern(connection.id, db.index, db.filter || "*"),
      },
      {
        key: "flush",
        label: t("tree.flushDatabase"),
        danger: true,
        onClick: () => flushDatabase(connection.id, db.index),
      },
    ];
  };

  const namespaceMenu = (
    connection: ConnectionSummary,
    db: DbView,
    node: Extract<TreeRowData, { kind: "node" }>,
  ): MenuItem[] => {
    const separator = configs[connection.id]?.namespaceSeparator ?? ":";
    return [
      {
        key: "reload",
        label: t("tree.reloadNamespace"),
        shortcut: "Ctrl+R",
        icon: "refresh",
        onClick: () => {
          setExpandedNs((prev) => {
            const next = new Set(prev);
            next.add(node.node.id);
            return next;
          });
          updateDb(connection.id, db.index, (d) => {
            const next = { ...d.nsData };
            delete next[node.node.full];
            return { ...d, nsData: next };
          });
          void loadNamespace(connection.id, db.index, node.node.full);
        },
      },
      {
        key: "add",
        label: t("tree.addNewKey"),
        shortcut: "Ctrl+N",
        icon: "plus",
        onClick: () =>
          setAddKey({
            connectionId: connection.id,
            db: db.index,
            initialName: `${node.node.full}${separator}`,
          }),
      },
      {
        key: "copy",
        label: t("tree.copyNamespacePattern"),
        icon: "copy",
        onClick: () => copyText(`${node.node.full}${separator}*`),
      },
      {
        key: "memory",
        label: t("tree.analyzeMemory"),
        icon: "database",
        onClick: () => onOpenServerActions(connection, "memory"),
      },
      {
        key: "delete",
        label: t("tree.deleteNamespace"),
        danger: true,
        separatorBefore: true,
        onClick: () =>
          deleteByPattern(connection.id, db.index, `${node.node.full}${separator}*`),
      },
    ];
  };

  const keyMenu = (row: Extract<TreeRowData, { kind: "node" }>): MenuItem[] => [
    {
      key: "open",
      label: t("tree.openKey"),
      shortcut: "Enter",
      icon: "eye",
      onClick: () => onOpenKey(row.connectionId, row.dbIndex, row.node.full),
    },
    {
      key: "copy",
      label: t("tree.copyKeyName"),
      shortcut: "Ctrl+C",
      icon: "copy",
      onClick: () => copyText(row.node.full),
    },
    {
      key: "delete",
      label: t("tree.deleteKey"),
      shortcut: "Del",
      icon: "trash",
      danger: true,
      separatorBefore: true,
      onClick: () => void deleteKeyRow(row),
    },
  ];

  const groupMenu = (group: ConnectionGroup): MenuItem[] => [
    {
      key: "edit",
      label: t("tree.editGroup"),
      icon: "edit",
      onClick: () => setGroupDialog({ mode: "edit", group, name: group.name }),
    },
    {
      key: "delete",
      label: t("tree.deleteGroup"),
      icon: "trash",
      danger: true,
      separatorBefore: true,
      onClick: () => setConfirmDelete({ kind: "group", id: group.id, name: group.name }),
    },
  ];

  const menuFor = (row: TreeRowData): MenuItem[] => {
    switch (row.kind) {
      case "server":
        return serverMenu(row.connection, row.view);
      case "database":
        return dbMenu(row.connection, row.db);
      case "node": {
        if (row.node.kind !== "namespace") return keyMenu(row);
        const connection = connections.find((c) => c.id === row.connectionId);
        const db = servers[row.connectionId]?.databases.find((d) => d.index === row.dbIndex);
        return connection && db ? namespaceMenu(connection, db, row) : [];
      }
      case "group":
        return groupMenu(row.group);
      default:
        return [];
    }
  };

  const toggleRow = (row: TreeRowData) => {
    switch (row.kind) {
      case "group":
        setCollapsedGroups((prev) => {
          const next = new Set(prev);
          if (next.has(row.group.id)) next.delete(row.group.id);
          else next.add(row.group.id);
          saveCollapsedGroups(next);
          return next;
        });
        break;
      case "server": {
        const willExpand = !row.view.expanded;
        updateServer(row.connection.id, (view) => ({ ...view, expanded: willExpand }));
        rememberServerExpanded(row.connection.id, willExpand);
        if (willExpand && !row.view.loaded) void loadServer(row.connection);
        break;
      }
      case "database": {
        const willExpand = !row.db.expanded;
        updateDb(row.connection.id, row.db.index, (db) => ({ ...db, expanded: willExpand }));
        rememberDbExpanded(row.connection.id, row.db.index, willExpand);
        if (willExpand) {
          pendingAutoExpand.current.delete(dbKeyOf(row.connection.id, row.db.index));
          if (!row.db.loaded) void loadDb(row.connection.id, row.db.index, false);
          if (row.db.loaded && row.db.cursor !== "0" && !row.db.rootKeys.length) {
            void loadDb(row.connection.id, row.db.index, false);
          }
        }
        break;
      }
      case "node": {
        if (row.node.kind !== "namespace") {
          // Double-click on a key opens its value tab.
          if (row.node.kind === "key") {
            onOpenKey(row.connectionId, row.dbIndex, row.node.full);
          }
          return;
        }
        const isOpen = expandedNs.has(row.node.id);
        setExpandedNs((prev) => {
          const next = new Set(prev);
          if (isOpen) next.delete(row.node.id);
          else next.add(row.node.id);
          return next;
        });
        if (!isOpen && !row.node.loaded) {
          void loadNamespace(row.connectionId, row.dbIndex, row.node.full);
        }
        break;
      }
      default:
        break;
    }
  };

  const activateRow = (row: TreeRowData) => {
    setSelectedId(row.id);
    switch (row.kind) {
      case "server":
        if (!row.view.loaded && !row.view.loading) void loadServer(row.connection);
        onOpenServerTab(row.connection);
        break;
      case "database":
        if (!row.db.loaded) void loadDb(row.connection.id, row.db.index, false);
        else if (!row.db.expanded) {
          updateDb(row.connection.id, row.db.index, (db) => ({ ...db, expanded: true }));
        }
        break;
      case "node":
        if (row.node.kind === "namespace") {
          const isOpen = expandedNs.has(row.node.id);
          if (!isOpen) {
            setExpandedNs((prev) => new Set(prev).add(row.node.id));
            if (!row.node.loaded) {
              void loadNamespace(row.connectionId, row.dbIndex, row.node.full);
            }
          }
        } else {
          onOpenKey(row.connectionId, row.dbIndex, row.node.full);
        }
        break;
      case "loadmore":
        void loadMore(row);
        break;
      default:
        break;
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
    const selected = rows.find((row) => row.id === selectedId);
    if (!selected) return;

    const dbContext = (): { connectionId: string; dbIndex: number } | null => {
      if (selected.kind === "database") {
        return { connectionId: selected.connection.id, dbIndex: selected.db.index };
      }
      if (selected.kind === "node" || selected.kind === "loadmore") {
        return { connectionId: selected.connectionId, dbIndex: selected.dbIndex };
      }
      return null;
    };

    const openFilter = () => {
      const context = dbContext();
      if (!context) return;
      setFilterDb(dbKeyOf(context.connectionId, context.dbIndex));
      void refreshHistory(context.connectionId);
    };

    if (event.key === "Enter") {
      const selected = rows.find((row) => row.id === selectedId);
      if (selected?.kind === "node" && selected.node.kind === "key") {
        event.preventDefault();
        onOpenKey(selected.connectionId, selected.dbIndex, selected.node.full);
      }
    } else if (event.ctrlKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFilter();
    } else if (event.ctrlKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      if (selected.kind === "server") void loadServer(selected.connection);
      else if (selected.kind === "database")
        void loadDb(selected.connection.id, selected.db.index, true);
      else if (selected.kind === "node" && selected.node.kind === "namespace") {
        void loadNamespace(selected.connectionId, selected.dbIndex, selected.node.full);
      }
    } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "e") {
      if (selected.kind === "server") onEditConnection(selected.connection.id);
    } else if (event.ctrlKey && event.key.toLowerCase() === "u") {
      if (selected.kind === "server") {
        void stopServerLive(selected.connection.id);
        updateServer(selected.connection.id, () => emptyServerView());
        forgetConnectionExpansion(selected.connection.id);
      }
    } else if (event.ctrlKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (selected.kind === "database") {
        setAddKey({ connectionId: selected.connection.id, db: selected.db.index });
      } else if (selected.kind === "node" && selected.node.kind === "namespace") {
        const separator = configs[selected.connectionId]?.namespaceSeparator ?? ":";
        setAddKey({
          connectionId: selected.connectionId,
          db: selected.dbIndex,
          initialName: `${selected.node.full}${separator}`,
        });
      }
    } else if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      const context = dbContext();
      if (context) {
        const connection = connections.find((item) => item.id === context.connectionId);
        const db = servers[context.connectionId]?.databases.find(
          (item) => item.index === context.dbIndex,
        );
        if (connection && db) void toggleLive(connection, db);
      }
    } else if (event.ctrlKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      const context = dbContext();
      const connection = context
        ? connections.find((item) => item.id === context.connectionId)
        : selected.kind === "server"
          ? selected.connection
          : undefined;
      if (connection) onOpenConsole(connection, context?.dbIndex ?? 0);
    } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
      if (selected.kind === "node") copyText(selected.node.full);
    } else if (event.key === "Delete") {
      if (selected.kind === "node" && selected.node.kind === "key") {
        event.preventDefault();
        void deleteKeyRow(selected);
      }
    }
  };

  const saveGroup = async () => {
    if (!groupDialog) return;
    const name = groupDialog.name.trim();
    if (!name) return;
    try {
      await ipc.saveGroup(groupDialog.group?.id ?? null, name);
      setGroupDialog(null);
      onGroupsChanged();
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    }
  };

  const deleteConfirmed = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.kind === "connection") {
        await ipc.deleteConnection(confirmDelete.id);
        onConnectionsChanged();
        onDeleteConnection(confirmDelete.id);
      } else {
        await ipc.deleteGroup(confirmDelete.id);
        onGroupsChanged();
      }
    } catch (e) {
      onNotify(t("common.operationFailed", { error: errMessage(e) }));
    } finally {
      setConfirmDelete(null);
    }
  };

  const totalHeight = rows.length * rowHeight;
  const searchNeedle = query.trim().toLowerCase();
  const searchActive = searchNeedle.length > 0;
  const searchMatchCount = searchActive
    ? connections.filter(
        (connection) =>
          connection.name.toLowerCase().includes(searchNeedle) ||
          `${connection.host}:${connection.port}`.toLowerCase().includes(searchNeedle) ||
          connection.host.toLowerCase().includes(searchNeedle),
      ).length
    : connections.length;

  const bulkConnection = bulk
    ? connections.find((item) => item.id === bulk.connectionId)
    : undefined;
  const bulkDb = bulk
    ? servers[bulk.connectionId]?.databases.find((item) => item.index === bulk.dbIndex)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <span className="text-muted">
          <Icon name="search" />
        </span>
        <input
          value={query}
          spellCheck={false}
          placeholder={t("tree.searchPlaceholder")}
          className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-base px-2 t-12 outline-none placeholder:text-muted focus:border-highlight"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
          aria-label={t("tree.searchPlaceholder")}
        />
        {searchActive ? (
          <>
            <span className="shrink-0 font-mono t-11 text-muted">{searchMatchCount}</span>
            <button
              type="button"
              className="shrink-0 rounded-sm p-1 text-muted hover:bg-surface hover:text-text"
              onClick={() => setQuery("")}
              title={t("tree.searchClear")}
              aria-label={t("tree.searchClear")}
            >
              <Icon name="x" />
            </button>
          </>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className={`min-h-0 flex-1 overflow-auto outline-none ${
          rootDropActive ? "ring-1 ring-inset ring-accent" : ""
        }`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onScroll={(e) => handleScroll(e.currentTarget.scrollTop)}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("application/x-resp-connection")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setRootDropActive(true);
        }}
        onDragLeave={() => setRootDropActive(false)}
        onDrop={(event) => {
          const connectionId = event.dataTransfer.getData("application/x-resp-connection");
          setRootDropActive(false);
          if (!connectionId) return;
          event.preventDefault();
          void moveConnection(connectionId, null);
        }}
      >
        {rows.length === 0 ? (
          searchActive ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="text-muted">
                <Icon name="search" />
              </span>
              <p className="t-13 text-muted">{t("tree.searchNoMatch")}</p>
              <Button variant="ghost" onClick={() => setQuery("")}>
                {t("tree.searchClear")}
              </Button>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <span className="text-muted">
                <Icon name="database" />
              </span>
              <p className="t-13 text-muted">{t("tree.noConnections")}</p>
              <Button variant="primary" onClick={onAddConnection}>
                <Icon name="plus" />
                {t("toolbar.connect")}
              </Button>
            </div>
          )
        ) : (
          <div className="relative" style={{ height: totalHeight }}>
            {windowRows.map((row, index) => {
              const absoluteIndex = startIndex + index;
              const expanded =
                row.kind === "server"
                  ? row.view.expanded
                  : row.kind === "database"
                    ? row.db.expanded
                    : row.kind === "node" && row.node.kind === "namespace"
                      ? expandedNs.has(row.node.id)
                      : row.kind === "group"
                        ? !collapsedGroups.has(row.group.id) || searchActive
                        : false;
              const metaEntry =
                row.kind === "node" && row.node.kind === "key"
                  ? meta[`${row.dbKey}:${row.node.full}`]
                  : undefined;
              const connection =
                row.kind === "server"
                  ? row.connection
                  : row.kind === "database"
                    ? row.connection
                    : row.kind === "filter"
                      ? row.connection
                      : null;
              const iconColor = connection
                ? configs[connection.id]?.iconColor
                : row.kind === "node"
                  ? configs[row.connectionId]?.iconColor
                  : undefined;
              return (
                <div
                  key={row.id}
                  className="absolute left-0 right-0"
                  style={{ top: absoluteIndex * rowHeight }}
                >
                  <TreeRow
                    row={row}
                    selected={selectedId === row.id}
                    expanded={expanded}
                    meta={metaEntry}
                    iconColor={iconColor}
                    filterHistory={connection ? (history[connection.id] ?? []) : []}
                    filterBusy={
                      row.kind === "filter"
                        ? filterBusy === `${row.connection.id}:${row.db.index}`
                        : false
                    }
                    menuItems={menuFor(row)}
                    onSelect={activateRow}
                    onContextSelect={(target) => setSelectedId(target.id)}
                    onToggle={toggleRow}
                    onApplyFilter={(dbKey, pattern) => void applyFilter(dbKey, pattern)}
                    onResetFilter={(dbKey) => void resetFilter(dbKey)}
                    onCloseFilter={() => setFilterDb(null)}
                    onLoadMore={(loadRow) => void loadMore(loadRow)}
                    dragEnabled={regroupMode}
                    onDropConnection={(connectionId, groupId) =>
                      void moveConnection(connectionId, groupId)
                    }
                    query={query}
                    favorite={row.kind === "server" ? favorites.has(row.connection.id) : false}
                    onToggleFavorite={toggleFavorite}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          onClick={() => setGroupDialog({ mode: "add", group: null, name: "" })}
        >
          <Icon name="plus" />
          {t("tree.addGroup")}
        </Button>
        <Button
          variant={regroupMode ? "primary" : "ghost"}
          onClick={() => setRegroupMode((prev) => !prev)}
          title={t("tree.regroupHint")}
        >
          <Icon name="group" />
          {t("tree.regroup")}
        </Button>
      </div>

      {groupDialog ? (
        <Dialog
          title={groupDialog.mode === "add" ? t("tree.newGroup") : t("tree.editGroup")}
          width={380}
          onClose={() => setGroupDialog(null)}
          footer={
            <>
              <Button variant="primary" onClick={() => void saveGroup()}>
                {t("common.save")}
              </Button>
              <Button onClick={() => setGroupDialog(null)}>{t("common.cancel")}</Button>
            </>
          }
        >
          <TextInput
            value={groupDialog.name}
            autoFocus
            placeholder={t("tree.groupName")}
            onChange={(e) =>
              setGroupDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveGroup();
            }}
          />
        </Dialog>
      ) : null}

      {addKey ? (
        <AddKeyDialog
          connectionId={addKey.connectionId}
          db={addKey.db}
          initialName={addKey.initialName}
          onClose={() => setAddKey(null)}
          onCreated={() => void loadDb(addKey.connectionId, addKey.db, true)}
          onNotify={onNotify}
        />
      ) : null}

      {bulk && bulkConnection ? (
        bulk.kind === "ttl" ? (
          <BulkTtlDialog
            connectionId={bulk.connectionId}
            dbIndex={bulk.dbIndex}
            connectionName={bulkConnection.name}
            defaultPattern={bulkDb?.filter || "*"}
            scanLimit={settings.scanLimit}
            dbKeyCount={bulkDb?.keys ?? null}
            onClose={() => setBulk(null)}
            onDone={(changed) => {
              onNotify(t("tree.updatedTtl", { count: changed }));
              void loadDb(bulk.connectionId, bulk.dbIndex, true, bulkDb?.filter ?? "");
            }}
            onNotify={onNotify}
          />
        ) : (
          <CopyKeysDialog
            sourceConnectionId={bulk.connectionId}
            sourceDb={bulk.dbIndex}
            sourceName={bulkConnection.name}
            connections={connections}
            defaultPattern={bulkDb?.filter || "*"}
            scanLimit={settings.scanLimit}
            onClose={() => setBulk(null)}
            onDone={(copied) => {
              onNotify(t("tree.copiedKeys", { count: copied }));
              void loadDb(bulk.connectionId, bulk.dbIndex, true, bulkDb?.filter ?? "");
            }}
            onNotify={onNotify}
          />
        )
      ) : null}

      {confirmDelete ? (
        <Dialog
          title={
            confirmDelete.kind === "connection" ? t("tree.deleteConnection") : t("tree.deleteGroup")
          }
          width={420}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button variant="primary" onClick={() => void deleteConfirmed()}>
                {t("common.delete")}
              </Button>
              <Button onClick={() => setConfirmDelete(null)}>{t("common.cancel")}</Button>
            </>
          }
        >
          <p className="t-13">
            {confirmDelete.kind === "connection"
              ? t("tree.deleteConnectionConfirm", { name: confirmDelete.name })
              : t("tree.deleteGroupConfirm", { name: confirmDelete.name })}
          </p>
        </Dialog>
      ) : null}

      {duplicatePrompt ? (
        <Dialog
          title={t("tree.duplicateConnection")}
          width={440}
          onClose={() => setDuplicatePrompt(null)}
          footer={
            <>
              <Button variant="primary" onClick={() => void duplicateConnection(duplicatePrompt)}>
                {t("tree.duplicateConnection")}
              </Button>
              <Button onClick={() => setDuplicatePrompt(null)}>{t("common.cancel")}</Button>
            </>
          }
        >
          <p className="t-13">{t("tree.duplicateCredentialsHint", { name: duplicatePrompt.name })}</p>
        </Dialog>
      ) : null}

      {danger ? (
        <DangerDialog
          title={danger.title}
          description={danger.description}
          serverName={danger.serverName}
          database={danger.database}
          keyCount={danger.keyCount}
          fullServer={danger.fullServer}
          requireText={danger.requireText}
          confirmLabel={danger.confirmLabel}
          busy={dangerBusy}
          onConfirm={() => void runDanger()}
          onClose={() => {
            if (!dangerBusy) setDanger(null);
          }}
        />
      ) : null}
    </div>
  );
}
