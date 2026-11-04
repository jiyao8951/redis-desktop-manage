import { invoke } from "@tauri-apps/api/core";
import type {
  ClientEntry,
  ConfigEntry,
  ConnectionConfig,
  ConnectionGroup,
  ConnectionSummary,
  ConsoleReply,
  DatabaseInfo,
  FilterHistoryEntry,
  KeyMeta,
  KeyValueChunk,
  KeyValueInfo,
  MemoryReport,
  NewKeyRequest,
  RowEditRequest,
  ScanPage,
  ServerFacts,
  ServerInfo,
  Settings,
  SlowlogEntry,
  TestResult,
  ValueCell,
  ValuePage,
} from "./types";

/**
 * Thin typed wrapper around Tauri's invoke. Keeping every command in one file
 * makes it obvious which backend capabilities exist in this stage.
 */

export const ipc = {
  listConnections: () => invoke<ConnectionSummary[]>("list_connections"),
  listGroups: () => invoke<ConnectionGroup[]>("list_groups"),
  saveGroup: (id: string | null, name: string) =>
    invoke<ConnectionGroup>("save_group", { id, name }),
  deleteGroup: (id: string) => invoke<void>("delete_group", { id }),
  getConnection: (id: string) => invoke<ConnectionConfig>("get_connection", { id }),
  saveConnection: (config: ConnectionConfig) =>
    invoke<ConnectionConfig>("save_connection", { config }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  /** Releases pooled connections + Live Update/Monitor subscriptions, keeps the config. */
  closeConnection: (id: string) => invoke<void>("close_connection", { id }),
  moveConnection: (id: string, groupId: string | null) =>
    invoke<void>("move_connection", { id, groupId }),
  duplicateConnection: (id: string) => invoke<ConnectionConfig>("duplicate_connection", { id }),
  testConnection: (config: ConnectionConfig) => invoke<TestResult>("test_connection", { config }),
  parseRedisUrl: (url: string) => invoke<ConnectionConfig>("parse_redis_url", { url }),
  importConnections: (path: string) => invoke<number>("import_connections", { path }),
  exportConnections: (path: string) => invoke<void>("export_connections", { path }),

  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),

  listDatabases: (connectionId: string) =>
    invoke<DatabaseInfo[]>("list_databases", { connectionId }),
  serverFacts: (connectionId: string) => invoke<ServerFacts>("server_facts", { connectionId }),
  scanKeys: (args: {
    connectionId: string;
    db: number;
    cursor: string;
    namespace: string | null;
    filter: string | null;
    pageSize: number;
  }) => invoke<ScanPage>("scan_keys", args),
  keyMetaBatch: (args: { connectionId: string; db: number; keys: string[] }) =>
    invoke<KeyMeta[]>("key_meta_batch", args),
  keyExists: (args: { connectionId: string; db: number; key: string }) =>
    invoke<boolean>("key_exists", args),

  keyValueInfo: (args: { connectionId: string; db: number; key: string }) =>
    invoke<KeyValueInfo>("key_value_info", args),
  readStringChunk: (args: {
    connectionId: string;
    db: number;
    key: string;
    offset: number;
    limit: number;
    /** Total length already reported by the first chunk; skips STRLEN. */
    knownTotal?: number;
  }) => invoke<KeyValueChunk>("read_string_chunk", args),
  readValuePage: (args: {
    connectionId: string;
    db: number;
    key: string;
    keyType: string;
    cursor: string;
    start: number;
    count: number;
    reverse: boolean;
  }) => invoke<ValuePage>("read_value_page", args),

  // Write path (original KeyModel mutations). The UI always confirms first.
  deleteKey: (args: { connectionId: string; db: number; key: string }) =>
    invoke<number>("delete_key", args),
  deleteKeys: (args: { connectionId: string; db: number; keys: string[] }) =>
    invoke<number>("delete_keys", args),
  deleteKeysByPattern: (args: {
    connectionId: string;
    db: number;
    pattern: string;
    limit: number;
  }) => invoke<number>("delete_keys_by_pattern", args),
  flushDatabase: (args: { connectionId: string; db: number }) =>
    invoke<void>("flush_database", args),
  setTtlByPattern: (args: {
    connectionId: string;
    db: number;
    pattern: string;
    ttl: number;
    limit: number;
  }) => invoke<number>("set_ttl_by_pattern", args),
  copyKeys: (args: {
    sourceConnectionId: string;
    sourceDb: number;
    pattern: string;
    targetConnectionId: string;
    targetDb: number;
    ttl: number;
    replace: boolean;
    limit: number;
  }) => invoke<number>("copy_keys", args),
  createKey: (args: { connectionId: string; db: number; request: NewKeyRequest }) =>
    invoke<void>("create_key", args),
  saveStringValue: (args: { connectionId: string; db: number; key: string; value: ValueCell }) =>
    invoke<void>("save_string_value", args),
  updateValueRow: (args: {
    connectionId: string;
    db: number;
    key: string;
    keyType: string;
    request: RowEditRequest;
  }) => invoke<void>("update_value_row", args),
  addValueRow: (args: {
    connectionId: string;
    db: number;
    key: string;
    keyType: string;
    cells: ValueCell[];
  }) => invoke<void>("add_value_row", args),
  deleteValueRow: (args: {
    connectionId: string;
    db: number;
    key: string;
    keyType: string;
    old: ValueCell[];
    position: number | null;
  }) => invoke<void>("delete_value_row", args),
  setKeyTtl: (args: { connectionId: string; db: number; key: string; ttl: number }) =>
    invoke<void>("set_key_ttl", args),
  persistKey: (args: { connectionId: string; db: number; key: string }) =>
    invoke<void>("persist_key", args),
  renameKey: (args: {
    connectionId: string;
    db: number;
    key: string;
    newKey: string;
    ttl: number;
  }) => invoke<void>("rename_key", args),

  startLiveUpdate: (args: { connectionId: string; db: number }) =>
    invoke<void>("start_live_update", args),
  stopLiveUpdate: (args: { connectionId: string; db: number }) =>
    invoke<void>("stop_live_update", args),

  filterHistory: (connectionId: string) =>
    invoke<FilterHistoryEntry[]>("filter_history", { connectionId }),
  rememberFilter: (connectionId: string, pattern: string) =>
    invoke<void>("remember_filter", { connectionId, pattern }),

  // Server Actions (read-only) and the command console.
  serverInfo: (connectionId: string) => invoke<ServerInfo>("server_info", { connectionId }),
  serverSlowlog: (connectionId: string, count = 15) =>
    invoke<SlowlogEntry[]>("server_slowlog", { connectionId, count }),
  serverClients: (connectionId: string) =>
    invoke<ClientEntry[]>("server_clients", { connectionId }),
  serverConfigGet: (connectionId: string) =>
    invoke<ConfigEntry[]>("server_config_get", { connectionId }),
  serverMemory: (connectionId: string) => invoke<MemoryReport>("server_memory", { connectionId }),
  consoleExecute: (args: { connectionId: string; db: number; command: string }) =>
    invoke<ConsoleReply>("console_execute", args),
  startMonitor: (connectionId: string) => invoke<void>("start_monitor", { connectionId }),
  stopMonitor: (connectionId: string) => invoke<void>("stop_monitor", { connectionId }),
};
