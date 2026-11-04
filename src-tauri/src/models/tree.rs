use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub index: u32,
    pub keys: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFacts {
    pub version: String,
    pub redis_mode: String,
    pub cluster_enabled: bool,
    pub configured_databases: u32,
    pub keyspace: Vec<DatabaseInfo>,
    pub modules: Vec<String>,
    pub command_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub success: bool,
    pub message: String,
    pub warning: Option<String>,
    pub facts: Option<ServerFacts>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPage {
    /// Redis cursors are u64; keep them as decimal strings for JS safety.
    pub cursor: String,
    pub keys: Vec<String>,
    pub page_size: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMeta {
    pub key: String,
    pub key_type: String,
    /// -1 = persistent, -2 = missing, >= 0 = seconds remaining.
    pub ttl: i64,
}
