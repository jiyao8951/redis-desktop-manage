/**
 * IPC data contracts shared with the Rust backend (src-tauri/src/models).
 * Field names mirror the original QML property names, adapted to camelCase.
 */

export interface ConnectionGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface ConnectionSummary {
  id: string;
  groupId: string | null;
  name: string;
  host: string;
  port: number;
  sslEnabled: boolean;
  sshHost: string;
  sortOrder: number;
}

export interface ConnectionConfig {
  id: string;
  groupId: string | null;
  name: string;
  host: string;
  port: number;
  auth: string;
  username: string;

  // Security: SSL/TLS (original "SSL/TLS" radio group)
  sslEnabled: boolean;
  sslLocalCertPath: string;
  sslPrivateKeyPath: string;
  sslCaCertPath: string;
  ignoreSslErrors: boolean;

  // Security: SSH tunnel (original "SSH Tunnel" radio group).
  // The original derives "tunnel enabled" from a non-empty sshHost.
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPassword: string;
  sshPrivateKey: string;
  sshAgent: boolean;
  sshAgentPath: string;
  askForSshPassword: boolean;

  // Advanced settings
  keysPattern: string;
  namespaceSeparator: string;
  executeTimeout: number; // ms
  connectionTimeout: number; // ms
  dbScanLimit: number;
  overrideClusterHost: boolean;
  defaultFormatter: string;
  iconColor: string;

  // Added for Redis 8: RESP protocol selection (see report; not in the
  // original UI, which only used RESP2 through qredisclient).
  protocol: "resp2" | "resp3";
}

export interface DatabaseInfo {
  index: number;
  keys: number;
}

export interface ServerFacts {
  version: string;
  redisMode: string;
  clusterEnabled: boolean;
  configuredDatabases: number;
  keyspace: DatabaseInfo[];
  modules: string[];
  commandCount: number;
}

export interface TestResult {
  success: boolean;
  message: string;
  warning: string | null;
  facts: ServerFacts | null;
}

export interface ScanPage {
  /** SCAN cursors are unsigned 64-bit; transported as a decimal string to
   * avoid precision loss in JavaScript numbers. */
  cursor: string;
  keys: string[];
  pageSize: number;
}

export interface KeyMeta {
  key: string;
  keyType: string;
  /** -1 = no expiry, -2 = key vanished, >=0 seconds remaining */
  ttl: number;
}

/** Header data for the value editor (original KeyModel metadata + extras). */
export interface KeyValueInfo {
  key: string;
  keyType: string;
  ttl: number;
  encoding: string;
  length: number | null;
  memoryBytes: number | null;
  supported: boolean;
  singleRow: boolean;
}

/** One table cell. Binary columns arrive base64 encoded. */
export interface ValueCell {
  encoding: "utf8" | "base64";
  payload: string;
}

export interface ValueRow {
  row: number;
  columns: ValueCell[];
}

/** A page of a multi-row key. */
export interface ValuePage {
  key: string;
  keyType: string;
  /** SCAN cursor for hash/set; "0" when exhausted. */
  cursor: string;
  start: number;
  pageSize: number;
  rows: ValueRow[];
  total: number | null;
  done: boolean;
  columns: string[];
}

export interface NewKeyRequest {
  key: string;
  keyType: string;
  value?: string | null;
  field?: string | null;
  score?: number | null;
  members?: string[] | null;
  /** Stream entry id; "*" lets the server generate one. */
  id?: string | null;
}

/** One row edit: cached row, edited row and absolute list position. */
export interface RowEditRequest {
  old: ValueCell[];
  new: ValueCell[];
  position: number | null;
}

export interface Settings {
  showNamespacesOnTop: boolean;
  reopenNamespacesOnReload: boolean;
  namespacedKeysShortName: boolean;
  scanLimit: number;
  treeItemMaxChilds: number;
  scanPageSize: number;
  liveUpdateKeysLimit: number;
  liveUpdateInterval: number;
  darkMode: "auto" | "on" | "off";
  valueSizeLimit: number;
  valueEditorPageSize: number;
  appFont: string;
  appFontSize: number;
  valueEditorFont: string;
  valueEditorFontSize: number;
  /** "" = not chosen yet (falls back to the OS locale), "en", "zh-CN". */
  language: string;
}

export interface FilterHistoryEntry {
  pattern: string;
  useCount: number;
  lastUsedAt: number;
}

/**
 * A slice of a string value. The value is never sent whole; callers page
 * through chunks of `chunkSize` bytes.
 */
export interface KeyValueChunk {
  key: string;
  chunkIndex: number;
  chunkSize: number;
  totalChunks: number | null;
  totalBytes: number | null;
  encoding: "utf8" | "base64";
  payload: string;
  truncated: boolean;
}

/** Pages of the Server Actions tab (original ServerActionTabs.qml tiles). */
export type ServerActionView =
  | "stats"
  | "info"
  | "slowlog"
  | "clients"
  | "monitor"
  | "console"
  | "config"
  | "memory";

/** Payload of the `monitor-line` Tauri event emitted by the backend. */
export interface MonitorLineEvent {
  connectionId: string;
  line: string;
}

/** Payload of `monitor-ended` (socket closed, ACL revoked or task aborted). */
export interface MonitorEndedEvent {
  connectionId: string;
  reason: string | null;
}

/** INFO `# Section` block (original ServerConfig.qml tab per section). */
export interface InfoField {
  name: string;
  value: string;
}

export interface InfoSection {
  name: string;
  fields: InfoField[];
}

export interface ServerInfo {
  sections: InfoSection[];
  raw: string;
}

/** `SLOWLOG GET` row (serverstatsmodel.cpp maps time/exec_time/cmd). */
export interface SlowlogEntry {
  id: number;
  time: number;
  durationUs: number;
  command: string[];
}

/** One `CLIENT LIST` line; `fields` keeps every raw key=value pair. */
export interface ClientEntry {
  addr: string;
  name: string;
  db: string;
  cmd: string;
  flags: string;
  age: string;
  idle: string;
  fields: InfoField[];
}

export interface ConfigEntry {
  name: string;
  value: string;
}

export interface MemoryReport {
  stats: InfoField[];
  doctor: string;
}

/** Result of one console command; `error` is set for server-side errors. */
export interface ConsoleReply {
  command: string;
  output: string;
  error: string | null;
  db: number;
  durationMs: number;
}

/** Payload of the Tauri `live-update` event (keyspace notification). */
export interface LiveUpdateEvent {
  connectionId: string;
  db: number;
  key: string;
  event: string;
}
