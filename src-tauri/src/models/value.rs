use serde::ser::{SerializeSeq, SerializeStruct, Serializer};
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

#[derive(Clone, Debug)]
pub struct ValueRow {
    /// Absolute row index in the whole key (0-based), so paging stays stable.
    pub row: u64,
    pub columns: Vec<ValueCell>,
}

/// Prefix that marks a base64 cell in the compact row wire format. It is a
/// control character because accepted UTF-8 text payloads never contain
/// control bytes below 0x20 other than tab/LF/CR, so it cannot collide.
const BINARY_CELL_PREFIX: char = '\u{1}';

/// Rows are serialized as `{"r": <row>, "c": [<payload>, ...]}`: the per-cell
/// `encoding` key and the per-row field names are not repeated for every row,
/// which is what dominated payload size for small values. Binary cells keep
/// their base64 payload behind a leading `\u{1}` marker; see
/// `decodeValuePage` on the frontend for the matching decode.
impl Serialize for ValueRow {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("ValueRow", 2)?;
        state.serialize_field("r", &self.row)?;
        state.serialize_field("c", &CompactColumns(&self.columns))?;
        state.end()
    }
}

struct CompactColumns<'a>(&'a [ValueCell]);

impl Serialize for CompactColumns<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for cell in self.0 {
            if cell.encoding == "base64" {
                let payload = format!("{BINARY_CELL_PREFIX}{}", cell.payload);
                sequence.serialize_element(&payload)?;
            } else {
                sequence.serialize_element(&cell.payload)?;
            }
        }
        sequence.end()
    }
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
    /// Number of entries scanned/compared by a full-value search. `None` for
    /// ordinary paging, so existing callers keep the same wire shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned: Option<u64>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_row_uses_compact_columns() {
        let row = ValueRow {
            row: 7,
            columns: vec![
                ValueCell {
                    encoding: "utf8".into(),
                    payload: "field".into(),
                },
                ValueCell {
                    encoding: "base64".into(),
                    payload: "AAE=".into(),
                },
                ValueCell {
                    encoding: "utf8".into(),
                    payload: String::new(),
                },
            ],
        };
        // Text cells stay plain strings, binary cells carry the \u0001 marker
        // and empty values stay empty strings.
        assert_eq!(
            serde_json::to_string(&row).unwrap(),
            "{\"r\":7,\"c\":[\"field\",\"\\u0001AAE=\",\"\"]}"
        );
    }

    #[test]
    fn value_page_keeps_column_names() {
        let page = ValuePage {
            key: "k".into(),
            key_type: "hash".into(),
            cursor: "0".into(),
            start: 0,
            page_size: 1,
            rows: vec![ValueRow {
                row: 0,
                columns: vec![
                    ValueCell {
                        encoding: "utf8".into(),
                        payload: "f".into(),
                    },
                    ValueCell {
                        encoding: "utf8".into(),
                        payload: "v".into(),
                    },
                ],
            }],
            total: Some(1),
            done: true,
            columns: vec!["rowNumber".into(), "key".into(), "value".into()],
            scanned: None,
        };
        let json = serde_json::to_string(&page).unwrap();
        assert!(json.contains("\"rows\":[{\"r\":0,\"c\":[\"f\",\"v\"]}]"));
        assert!(json.contains("\"columns\":[\"rowNumber\",\"key\",\"value\"]"));
    }
}
