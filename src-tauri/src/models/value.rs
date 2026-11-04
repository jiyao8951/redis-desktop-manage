use serde::{Deserialize, Serialize};

/// Metadata shown above the value editor. Mirrors the information the original
/// `KeyModel` exposes (type/TTL) plus the read-only extras requested for this
/// stage (encoding, length, memory usage).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueInfo {
    pub key: String,
    pub key_type: String,
    /// -1 = no expiry, -2 = key vanished between TYPE and TTL.
    pub ttl: i64,
    /// OBJECT ENCODING (for example `embstr`, `quicklist`, `listpack`).
    pub encoding: String,
    /// STRLEN / LLEN / SCARD / ZCARD / HLEN / XLEN, when the type has one.
    pub length: Option<u64>,
    /// MEMORY USAGE, when the server reports it.
    pub memory_bytes: Option<u64>,
    /// False for module types and anything the value editor does not model.
    pub supported: bool,
    /// True for string keys: the editor shows one value instead of a table.
    pub single_row: bool,
}

/// One cell of a table row. Binary content is base64 encoded; UTF-8 text is
/// sent as-is. `truncated` only applies to the single-value (string) editor.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueCell {
    pub encoding: String,
    pub payload: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueRow {
    /// Absolute row index in the whole key (0-based), so paging stays stable.
    pub row: u64,
    pub columns: Vec<ValueCell>,
}

/// A page of a multi-row key. For hash/set the cursor is a SCAN cursor and rows
/// are append-only; for list/zset/stream rows are addressable by `start`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuePage {
    pub key: String,
    pub key_type: String,
    pub cursor: String,
    pub start: u64,
    pub page_size: u32,
    pub rows: Vec<ValueRow>,
    pub total: Option<u64>,
    /// False when another SCAN/XREVRANGE page may exist.
    pub done: bool,
    pub columns: Vec<String>,
}

/// A slice of a string value. The frontend never receives the whole value in a
/// single IPC call.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueChunk {
    pub key: String,
    pub chunk_index: u32,
    pub chunk_size: u32,
    pub total_chunks: Option<u32>,
    pub total_bytes: Option<u64>,
    pub encoding: String,
    pub payload: String,
    pub truncated: bool,
}
