use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::models::value::{KeyValueChunk, KeyValueInfo, ValueCell, ValuePage, ValueRow};
use crate::redis::manager::{execute_timeout, query_with_timeout};

/// Upper bound on concurrent value requests. The UI only reads one page at a
/// time, but several tabs can be open, so keep the same cap as metadata reads.
static VALUE_SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();

fn limiter() -> &'static Semaphore {
    VALUE_SEMAPHORE.get_or_init(|| Semaphore::new(8))
}

fn clamp_page(count: u32) -> u32 {
    count.clamp(1, 1000)
}

fn clamp_chunk(limit: u32) -> u32 {
    limit.clamp(1024, 5_000_000)
}

/// Text when the bytes are valid UTF-8 with only printable control characters;
/// base64 otherwise. This mirrors the original editor's "binary value" rule and
/// keeps IPC payloads safe for arbitrary bytes.
fn encode_bytes(bytes: &[u8]) -> ValueCell {
    if is_text(bytes) {
        ValueCell {
            encoding: "utf8".into(),
            payload: String::from_utf8_lossy(bytes).into_owned(),
        }
    } else {
        ValueCell {
            encoding: "base64".into(),
            payload: STANDARD.encode(bytes),
        }
    }
}

fn is_text(bytes: &[u8]) -> bool {
    if std::str::from_utf8(bytes).is_err() {
        return false;
    }
    bytes.iter().all(|byte| {
        *byte >= 0x20 || *byte == b'\t' || *byte == b'\n' || *byte == b'\r'
    })
}

fn as_bytes(value: &redis::Value) -> Option<Vec<u8>> {
    match value {
        redis::Value::BulkString(bytes) => Some(bytes.clone()),
        redis::Value::SimpleString(text) => Some(text.as_bytes().to_vec()),
        redis::Value::Int(number) => Some(number.to_string().into_bytes()),
        redis::Value::Double(number) => Some(number.to_string().into_bytes()),
        _ => None,
    }
}

/// HSCAN/SSCAN/ZRANGE replies come as either a flat pair list (RESP2) or nested
/// two-element arrays (RESP3). Normalise both shapes.
fn pair_list(value: redis::Value) -> Vec<(redis::Value, redis::Value)> {
    let mut pairs = Vec::new();
    match value {
        redis::Value::Array(items) => collect_pairs(items, &mut pairs),
        redis::Value::Map(entries) => pairs.extend(entries),
        _ => {}
    }
    pairs
}

fn collect_pairs(items: Vec<redis::Value>, pairs: &mut Vec<(redis::Value, redis::Value)>) {
    let mut iterator = items.into_iter();
    while let Some(first) = iterator.next() {
        if let redis::Value::Array(inner) = first {
            if inner.len() == 2 {
                let mut inner_iterator = inner.into_iter();
                if let (Some(a), Some(b)) = (inner_iterator.next(), inner_iterator.next()) {
                    pairs.push((a, b));
                    continue;
                }
            }
            continue;
        }
        match iterator.next() {
            Some(second) => pairs.push((first, second)),
            None => break,
        }
    }
}

async fn command_i64(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    command: &str,
    args: &[&str],
) -> AppResult<i64> {
    let mut cmd = redis::cmd(command);
    for arg in args {
        cmd.arg(*arg);
    }
    Ok(query_with_timeout(execute_timeout(config), cmd.query_async(conn)).await?)
}

fn length_command(key_type: &str) -> Option<&'static str> {
    match key_type {
        "string" => Some("STRLEN"),
        "list" => Some("LLEN"),
        "set" => Some("SCARD"),
        "zset" => Some("ZCARD"),
        "hash" => Some("HLEN"),
        "stream" => Some("XLEN"),
        _ => None,
    }
}

fn is_supported(key_type: &str) -> bool {
    matches!(key_type, "string" | "list" | "set" | "zset" | "hash" | "stream")
}

/// Cursor for HSCAN/SSCAN pages. SCAN only returns an opaque server cursor, so
/// when a batch is larger than the requested page size the surplus rows travel
/// back to the client inside this cursor instead of being dropped.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanCursorState {
    /// Server cursor for the *next* HSCAN/SSCAN call.
    scan: String,
    /// Rows read from the server but not yet emitted to the UI.
    rest: Vec<Vec<ValueCell>>,
}

fn decode_scan_cursor(cursor: &str) -> ScanCursorState {
    if cursor.is_empty() || cursor == "0" {
        return ScanCursorState {
            scan: "0".into(),
            rest: Vec::new(),
        };
    }
    serde_json::from_str(cursor).unwrap_or_else(|_| ScanCursorState {
        scan: cursor.to_string(),
        rest: Vec::new(),
    })
}

fn encode_scan_cursor(state: &ScanCursorState) -> String {
    if state.scan == "0" && state.rest.is_empty() {
        "0".into()
    } else {
        serde_json::to_string(state).unwrap_or_else(|_| state.scan.clone())
    }
}

pub async fn key_value_info(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
) -> AppResult<KeyValueInfo> {
    let key_type = query_with_timeout(
        execute_timeout(config),
        redis::cmd("TYPE").arg(key).query_async::<String>(conn),
    )
    .await?;

    if key_type == "none" {
        return Err(AppError::Message(format!("Key \"{key}\" does not exist")));
    }

    let ttl = command_i64(conn, config, "TTL", &[key]).await?;

    let encoding = query_with_timeout(
        execute_timeout(config),
        redis::cmd("OBJECT").arg("ENCODING").arg(key).query_async::<String>(conn),
    )
    .await
    .unwrap_or_default();

    let memory_bytes = query_with_timeout(
        execute_timeout(config),
        redis::cmd("MEMORY").arg("USAGE").arg(key).query_async::<Option<i64>>(conn),
    )
    .await
    .ok()
    .flatten()
    .map(|bytes| bytes.max(0) as u64);

    let length = match length_command(&key_type) {
        Some(command) => command_i64(conn, config, command, &[key])
            .await
            .ok()
            .map(|value| value.max(0) as u64),
        None => None,
    };

    Ok(KeyValueInfo {
        key: key.to_string(),
        key_type: key_type.clone(),
        ttl,
        encoding,
        length,
        memory_bytes,
        supported: is_supported(&key_type),
        single_row: key_type == "string",
    })
}

pub async fn read_string_chunk(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    offset: u64,
    limit: u32,
    known_total: Option<u64>,
) -> AppResult<KeyValueChunk> {
    let _permit = limiter().acquire().await.map_err(|_| AppError::Timeout)?;
    let limit = clamp_chunk(limit);
    // Chunked reads previously sent STRLEN for every chunk; the caller already
    // knows the length after the first chunk, so reuse it when provided.
    let total = match known_total {
        Some(total) => total,
        None => command_i64(conn, config, "STRLEN", &[key]).await?.max(0) as u64,
    };

    let payload = if offset >= total {
        Vec::new()
    } else {
        let end = (offset + u64::from(limit)).saturating_sub(1);
        query_with_timeout(
            execute_timeout(config),
            redis::cmd("GETRANGE")
                .arg(key)
                .arg(offset)
                .arg(end)
                .query_async::<Vec<u8>>(conn),
        )
        .await?
    };

    let cell = encode_bytes(&payload);
    let loaded = offset + payload.len() as u64;
    let total_chunks = if total == 0 {
        Some(0)
    } else {
        Some((total.div_ceil(u64::from(limit))) as u32)
    };

    Ok(KeyValueChunk {
        key: key.to_string(),
        chunk_index: (offset / u64::from(limit)) as u32,
        chunk_size: limit,
        total_chunks,
        total_bytes: Some(total),
        encoding: cell.encoding,
        payload: cell.payload,
        truncated: loaded < total,
    })
}

pub async fn read_value_page(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    key_type: &str,
    cursor: &str,
    start: u64,
    count: u32,
    reverse: bool,
) -> AppResult<ValuePage> {
    let _permit = limiter().acquire().await.map_err(|_| AppError::Timeout)?;
    let count = clamp_page(count);
    let timeout = execute_timeout(config);

    let page = match key_type {
        "list" => {
            let total = command_i64(conn, config, "LLEN", &[key]).await?.max(0) as u64;
            let start = start.min(total);
            let rows = if start >= total {
                Vec::new()
            } else {
                let (from, to) = if reverse {
                    let from = total.saturating_sub(start + u64::from(count));
                    (from as i64, (total - start - 1) as i64)
                } else {
                    (start as i64, (start + u64::from(count) - 1).min(total - 1) as i64)
                };
                let mut values = query_with_timeout(
                    timeout,
                    redis::cmd("LRANGE").arg(key).arg(from).arg(to).query_async::<Vec<redis::Value>>(conn),
                )
                .await?;
                // LRANGE always returns head-to-tail order. Reversing here keeps
                // the UI row index aligned with the tail-relative position used
                // by LSET/LREM (`-(row + 1)`).
                if reverse {
                    values.reverse();
                }
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| ValueRow {
                        row: start + index as u64,
                        columns: vec![encode_bytes(as_bytes(value).unwrap_or_default().as_slice())],
                    })
                    .collect()
            };
            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: "0".into(),
                start,
                page_size: count,
                rows,
                total: Some(total),
                done: true,
                columns: vec!["rowNumber".into(), "value".into()],
            }
        }
        "hash" | "set" => {
            let load_command = if key_type == "hash" { "HSCAN" } else { "SSCAN" };
            // An encoded cursor that carries leftover rows may also carry the
            // server cursor "0". Without this flag the drained request would
            // treat "0" as a fresh scan and replay every field from the start.
            let first_request = cursor.is_empty() || cursor == "0";
            let mut state = decode_scan_cursor(cursor);
            let mut rows: Vec<ValueRow> = Vec::new();
            let mut iterations = 0u32;

            // SCAN treats COUNT as a hint, so a single reply can contain far
            // more rows than the page size. Emit exactly `count` rows and keep
            // the surplus in the cursor for the next request.
            while rows.len() < count as usize {
                while rows.len() < count as usize && !state.rest.is_empty() {
                    let take = (count as usize - rows.len()).min(state.rest.len());
                    let drained: Vec<Vec<ValueCell>> = state.rest.drain(..take).collect();
                    for columns in drained {
                        rows.push(ValueRow {
                            row: start + rows.len() as u64,
                            columns,
                        });
                    }
                }
                if rows.len() >= count as usize
                    || (state.scan == "0" && (iterations > 0 || !first_request))
                {
                    break;
                }
                iterations += 1;
                if iterations > 1000 {
                    break;
                }

                let want = (count as usize).saturating_sub(rows.len()).max(1) as u32;
                let reply = query_with_timeout(
                    timeout,
                    redis::cmd(load_command)
                        .arg(key)
                        .arg(&state.scan)
                        .arg("COUNT")
                        .arg(want)
                        .query_async::<redis::Value>(conn),
                )
                .await?;

                let mut next_cursor = "0".to_string();
                let mut payload = Vec::new();
                if let redis::Value::Array(parts) = reply {
                    let mut iterator = parts.into_iter();
                    if let Some(cursor_value) = iterator.next() {
                        next_cursor =
                            String::from_utf8_lossy(&as_bytes(&cursor_value).unwrap_or_default())
                                .into_owned();
                    }
                    if let Some(items) = iterator.next() {
                        payload = match items {
                            redis::Value::Array(values) => values,
                            redis::Value::Set(values) => values,
                            _ => Vec::new(),
                        };
                    }
                }

                // HSCAN returns field/value pairs; SSCAN returns one member per
                // element. Both replies are flat arrays in RESP2.
                let fetched: Vec<Vec<ValueCell>> = if key_type == "hash" {
                    pair_list(redis::Value::Array(payload))
                        .into_iter()
                        .map(|(field, value)| {
                            vec![
                                encode_bytes(as_bytes(&field).unwrap_or_default().as_slice()),
                                encode_bytes(as_bytes(&value).unwrap_or_default().as_slice()),
                            ]
                        })
                        .collect()
                } else {
                    payload
                        .iter()
                        .map(|member| {
                            vec![encode_bytes(
                                as_bytes(member).unwrap_or_default().as_slice(),
                            )]
                        })
                        .collect()
                };
                state.rest.extend(fetched);
                state.scan = next_cursor;
            }

            let total = command_i64(
                conn,
                config,
                if key_type == "hash" { "HLEN" } else { "SCARD" },
                &[key],
            )
            .await
            .ok()
            .map(|value| value.max(0) as u64);

            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: encode_scan_cursor(&state),
                start,
                page_size: count,
                rows,
                total,
                done: state.scan == "0" && state.rest.is_empty(),
                columns: if key_type == "hash" {
                    vec!["rowNumber".into(), "key".into(), "value".into()]
                } else {
                    vec!["rowNumber".into(), "value".into()]
                },
            }
        }
        "zset" => {
            let total = command_i64(conn, config, "ZCARD", &[key]).await?.max(0) as u64;
            let start = start.min(total);
            let rows = if start >= total {
                Vec::new()
            } else {
                let command = if reverse { "ZREVRANGE" } else { "ZRANGE" };
                let stop = (start + u64::from(count) - 1).min(total - 1);
                let reply = query_with_timeout(
                    timeout,
                    redis::cmd(command)
                        .arg(key)
                        .arg(start as i64)
                        .arg(stop as i64)
                        .arg("WITHSCORES")
                        .query_async::<redis::Value>(conn),
                )
                .await?;
                pair_list(reply)
                    .iter()
                    .enumerate()
                    .map(|(index, (member, score))| ValueRow {
                        row: start + index as u64,
                        columns: vec![
                            encode_bytes(as_bytes(member).unwrap_or_default().as_slice()),
                            encode_bytes(as_bytes(score).unwrap_or_default().as_slice()),
                        ],
                    })
                    .collect()
            };
            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: "0".into(),
                start,
                page_size: count,
                rows,
                total: Some(total),
                done: true,
                columns: vec!["rowNumber".into(), "value".into(), "score".into()],
            }
        }
        "stream" => {
            let total = command_i64(conn, config, "XLEN", &[key]).await?.max(0) as u64;
            let start_id = if cursor.is_empty() { "+".to_string() } else { cursor.to_string() };
            let reply = query_with_timeout(
                timeout,
                redis::cmd("XREVRANGE")
                    .arg(key)
                    .arg("+")
                    .arg(&start_id)
                    .arg("COUNT")
                    .arg(count)
                    .query_async::<redis::Value>(conn),
            )
            .await?;

            let mut rows = Vec::new();
            let mut done = true;
            if let redis::Value::Array(entries) = reply {
                done = entries.len() < count as usize;
                for (index, entry) in entries.iter().enumerate() {
                    let fields = match entry {
                        redis::Value::Array(fields) => fields,
                        _ => continue,
                    };
                    let id = fields
                        .first()
                        .and_then(as_bytes)
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                        .unwrap_or_default();
                    // XREVRANGE's start id is inclusive; the cursor is the last
                    // id of the previous page, so skip the repeated entry.
                    if !cursor.is_empty() && index == 0 && id == cursor {
                        continue;
                    }

                    let mut object = serde_json::Map::new();
                    let mut field_iterator = fields.iter().skip(1);
                    while let (Some(field), Some(value)) = (field_iterator.next(), field_iterator.next()) {
                        let name = String::from_utf8_lossy(&as_bytes(field).unwrap_or_default()).into_owned();
                        let cell = encode_bytes(as_bytes(value).unwrap_or_default().as_slice());
                        let json_value = if cell.encoding == "base64" {
                            serde_json::Value::String(format!("base64:{}", cell.payload))
                        } else {
                            serde_json::Value::String(cell.payload)
                        };
                        object.insert(name, json_value);
                    }
                    let value = serde_json::Value::Object(object);

                    // Count emitted rows instead of the source index: the
                    // repeated cursor entry is skipped, so using `index` would
                    // leave a gap in the row numbering.
                    rows.push(ValueRow {
                        row: start + rows.len() as u64,
                        columns: vec![
                            ValueCell {
                                encoding: "utf8".into(),
                                payload: id,
                            },
                            ValueCell {
                                encoding: "utf8".into(),
                                payload: value.to_string(),
                            },
                        ],
                    });
                }
            }

            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: rows.last().and_then(|row| row.columns.first()).map(|cell| cell.payload.clone()).unwrap_or_default(),
                start,
                page_size: count,
                rows,
                total: Some(total),
                done,
                columns: vec!["rowNumber".into(), "id".into(), "value".into()],
            }
        }
        other => {
            return Err(AppError::Unsupported(format!(
                "The value editor does not support type \"{other}\""
            )))
        }
    };

    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_cursor_round_trips_leftover_rows() {
        let state = ScanCursorState {
            scan: "42".into(),
            rest: vec![vec![ValueCell {
                encoding: "utf8".into(),
                payload: "field".into(),
            }]],
        };
        let encoded = encode_scan_cursor(&state);
        let decoded = decode_scan_cursor(&encoded);
        assert_eq!(decoded.scan, "42");
        assert_eq!(decoded.rest.len(), 1);
        assert_eq!(decoded.rest[0][0].payload, "field");
    }

    #[test]
    fn scan_cursor_zero_is_plain() {
        assert_eq!(encode_scan_cursor(&decode_scan_cursor("0")), "0");
        assert_eq!(encode_scan_cursor(&decode_scan_cursor("")), "0");
    }

    #[test]
    fn scan_cursor_preserves_unknown_legacy_values() {
        // A plain server cursor (not produced by this build) still works.
        let decoded = decode_scan_cursor("123");
        assert_eq!(decoded.scan, "123");
        assert!(decoded.rest.is_empty());
    }
}

