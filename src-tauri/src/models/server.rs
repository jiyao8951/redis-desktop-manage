use serde::Serialize;

/// One `key:value` line inside an INFO section (original ServerInfo parsed map).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoField {
    pub name: String,
    pub value: String,
}

/// INFO `# Section` blocks, kept in server order so the UI can show the same
/// tabs as the original Server Info page.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoSection {
    pub name: String,
    pub fields: Vec<InfoField>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub sections: Vec<InfoSection>,
}

/// Mirrors serverstatsmodel.cpp: `SLOWLOG GET 15` keeps id/time/duration and
/// the command argument list.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowlogEntry {
    pub id: i64,
    /// Unix timestamp in seconds (original `time` column).
    pub time: i64,
    /// Execution time in microseconds (original `exec_time` column).
    pub duration_us: i64,
    pub command: Vec<String>,
}

/// One `CLIENT LIST` line. Derived columns match ServerClients.qml
/// (addr/age/idle/flags/db); `fields` keeps every raw pair for inspection.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientEntry {
    pub addr: String,
    pub name: String,
    pub db: String,
    pub cmd: String,
    pub flags: String,
    pub age: String,
    pub idle: String,
    pub fields: Vec<InfoField>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub name: String,
    pub value: String,
}

/// `MEMORY STATS` (flattened pairs) plus the `MEMORY DOCTOR` verdict, used by
/// the memory analysis entry.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub stats: Vec<InfoField>,
    pub doctor: String,
}

/// Result of one console command. Server-side errors are returned as Ok with
/// `error` set so the console can print a red line without an IPC rejection.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleReply {
    /// The exact command line the user submitted (for the CLI echo).
    pub command: String,
    /// redis-cli style formatting of the reply (`(integer)`, `1) "x"`, ...).
    pub output: String,
    pub error: Option<String>,
    /// Database index to use for the following prompt (SELECT changes it).
    pub db: u32,
    pub duration_ms: u64,
}
