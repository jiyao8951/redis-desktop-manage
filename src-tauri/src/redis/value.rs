use std::sync::OnceLock;
use std::time::{Duration, Instant};

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

/// Upper bound on the serialized payload of one `read_value_page` response.
/// Pages stop early instead of putting tens of megabytes into a single IPC.
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;

/// Full-value search budget for one IPC request: compare at most this many
/// entries, or spend at most this much wall-clock time (whichever comes first).
const SEARCH_SCAN_BUDGET: u64 = 20_000;
const SEARCH_TIME_BUDGET: Duration = Duration::from_secs(2);

/// Entries fetched per HSCAN/SSCAN/ZSCAN/LRANGE slice while searching.
const SEARCH_BATCH: u32 = 500;

/// Approximate serialized size of one cell (payload + encoding + field names).
fn cell_bytes(cell: &ValueCell) -> usize {
    cell.payload.len() + cell.encoding.len() + 16
}

fn row_bytes(columns: &[ValueCell]) -> usize {
    columns.iter().map(cell_bytes).sum()
}

/// Drops trailing rows once the page payload budget is exhausted. Returns true
/// when rows were dropped; at least one row is always kept so a single huge
/// value cannot make paging stall forever.
fn cap_rows(rows: &mut Vec<ValueRow>) -> bool {
    let mut bytes = 0usize;
    let mut keep = 0usize;
    for row in rows.iter() {
        let next = row_bytes(&row.columns);
        if keep > 0 && bytes + next > MAX_PAGE_BYTES {
            break;
        }
        bytes += next;
        keep += 1;
    }
    if keep < rows.len() {
        rows.truncate(keep);
        true
    } else {
        false
    }
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

/// End bound for a reverse `XREVRANGE` page (`XREVRANGE key end start`).
/// The first request starts at `+` (newest); later pages use an exclusive
/// `(id` end, so the previous page's last entry is not returned again.
fn stream_end_bound(cursor: &str) -> String {
    if cursor.is_empty() || cursor == "0" {
        "+".to_string()
    } else {
        format!("({cursor}")
    }
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

/// Which part of a hash entry a search compares. Set/zset/list have a single
/// value component, so they always match the member/element itself.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SearchTarget {
    Field,
    Value,
}

/// Search is active only when both a pattern and a target were supplied; an
/// absent target keeps ordinary paging byte-for-byte unchanged.
fn resolve_search<'a>(
    match_pattern: Option<&'a str>,
    match_target: Option<&'a str>,
) -> Option<(SearchTarget, &'a str)> {
    let pattern = match_pattern?;
    let target = match match_target {
        Some("field") => SearchTarget::Field,
        Some("value") => SearchTarget::Value,
        _ => return None,
    };
    Some((target, pattern))
}

/// Cursor for a full-value search. A request can stop early because it filled
/// the page, hit the scan budget or hit the time budget, so the server cursor
/// (or next list offset), leftover matched rows and the emitted-row counter all
/// travel back to the client in this cursor.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCursorState {
    scan: String,
    #[serde(default)]
    rest: Vec<Vec<ValueCell>>,
    /// Number of matched rows already emitted, so row numbers stay unique and
    /// stable when the frontend appends the next page.
    #[serde(default)]
    emitted: u64,
}

impl Default for SearchCursorState {
    fn default() -> Self {
        Self {
            scan: "0".into(),
            rest: Vec::new(),
            emitted: 0,
        }
    }
}

fn decode_search_cursor(cursor: &str) -> SearchCursorState {
    if cursor.is_empty() || cursor == "0" {
        return SearchCursorState::default();
    }
    serde_json::from_str(cursor).unwrap_or_else(|_| SearchCursorState {
        scan: cursor.to_string(),
        ..SearchCursorState::default()
    })
}

fn encode_search_cursor(state: &SearchCursorState, exhausted: bool) -> String {
    if exhausted && state.rest.is_empty() {
        "0".into()
    } else {
        serde_json::to_string(state).unwrap_or_else(|_| state.scan.clone())
    }
}

/// Redis-style glob matching (`*`, `?`, `[...]` with ranges and `^` negation).
/// SCAN's MATCH uses the same semantics, so that path reuses the server-side
/// filter; this local matcher covers values and list elements, which Redis
/// cannot filter server-side.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    let mut pattern_index = 0usize;
    let mut text_index = 0usize;
    let mut star_pattern: Option<usize> = None;
    let mut star_text = 0usize;

    while text_index < text.len() {
        if pattern_index < pattern.len() {
            match pattern[pattern_index] {
                b'*' => {
                    star_pattern = Some(pattern_index);
                    star_text = text_index;
                    pattern_index += 1;
                    continue;
                }
                b'?' => {
                    pattern_index += 1;
                    text_index += 1;
                    continue;
                }
                b'\\' if pattern_index + 1 < pattern.len() => {
                    if pattern[pattern_index + 1] == text[text_index] {
                        pattern_index += 2;
                        text_index += 1;
                        continue;
                    }
                }
                b'[' => match glob_class_match(pattern, pattern_index, text[text_index]) {
                    Some((true, next)) => {
                        pattern_index = next;
                        text_index += 1;
                        continue;
                    }
                    Some((false, _)) => {}
                    None => {
                        if text[text_index] == b'[' {
                            pattern_index += 1;
                            text_index += 1;
                            continue;
                        }
                    }
                },
                byte if byte == text[text_index] => {
                    pattern_index += 1;
                    text_index += 1;
                    continue;
                }
                _ => {}
            }
        }

        // Mismatch: backtrack to the last `*`, which may absorb one more byte.
        match star_pattern {
            Some(star) => {
                pattern_index = star + 1;
                star_text += 1;
                text_index = star_text;
            }
            None => return false,
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

/// Parses one `[...]` character class starting at `start`. Returns
/// `(matched, index_after_class)`, or `None` when the class is unterminated.
fn glob_class_match(pattern: &[u8], start: usize, byte: u8) -> Option<(bool, usize)> {
    let mut index = start + 1;
    let mut negate = false;
    if index < pattern.len() && pattern[index] == b'^' {
        negate = true;
        index += 1;
    }
    let mut matched = false;
    while index < pattern.len() && pattern[index] != b']' {
        if index + 2 < pattern.len() && pattern[index + 1] == b'-' && pattern[index + 2] != b']' {
            let low = pattern[index];
            let high = pattern[index + 2];
            if byte >= low && byte <= high {
                matched = true;
            }
            index += 3;
        } else {
            if pattern[index] == byte {
                matched = true;
            }
            index += 1;
        }
    }
    if index >= pattern.len() {
        return None;
    }
    Some((matched != negate, index + 1))
}

/// Splits an HSCAN/SSCAN/ZSCAN reply into `(next cursor, raw items)`.
fn scan_reply(reply: redis::Value) -> (String, Vec<redis::Value>) {
    if let redis::Value::Array(parts) = reply {
        let mut iterator = parts.into_iter();
        let cursor = iterator
            .next()
            .map(|value| String::from_utf8_lossy(&as_bytes(&value).unwrap_or_default()).into_owned())
            .unwrap_or_else(|| "0".into());
        let payload = match iterator.next() {
            Some(redis::Value::Array(values)) => values,
            Some(redis::Value::Set(values)) => values,
            _ => Vec::new(),
        };
        return (cursor, payload);
    }
    ("0".into(), Vec::new())
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
    // A chunked read spans several IPC calls and the value can be rewritten in
    // between. Always ask for the current length and compare it with the length
    // the caller saw on the previous chunk; concatenating chunks from two
    // versions would silently produce a corrupted string. This deliberately
    // stays on GETRANGE (never a full GET) so huge values are not materialised.
    let total = command_i64(conn, config, "STRLEN", &[key]).await?.max(0) as u64;
    if let Some(known) = known_total {
        if known != total {
            return Err(AppError::Invalid(format!(
                "The value changed while it was being read (expected {known} bytes, found {total}); reload it"
            )));
        }
    }

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

    // A shorter-than-expected chunk means the value shrank between STRLEN and
    // GETRANGE; report it instead of handing the UI a truncated concatenation.
    let expected = if offset >= total {
        0
    } else {
        (total - offset).min(u64::from(limit)) as usize
    };
    if payload.len() < expected {
        return Err(AppError::Invalid(
            "The value changed while it was being read; reload it".into(),
        ));
    }

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
    match_pattern: Option<&str>,
    match_target: Option<&str>,
) -> AppResult<ValuePage> {
    let _permit = limiter().acquire().await.map_err(|_| AppError::Timeout)?;
    let count = clamp_page(count);
    let timeout = execute_timeout(config);

    if let Some((target, pattern)) = resolve_search(match_pattern, match_target) {
        return search_value_page(
            conn, config, key, key_type, cursor, count, target, pattern,
        )
        .await;
    }

    let page = match key_type {
        "list" => {
            let total = command_i64(conn, config, "LLEN", &[key]).await?.max(0) as u64;
            let start = start.min(total);
            let mut rows = if start >= total {
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
            let truncated = cap_rows(&mut rows);
            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: "0".into(),
                start,
                page_size: count,
                rows,
                total: Some(total),
                done: !truncated,
                columns: vec!["rowNumber".into(), "value".into()],
                scanned: None,
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
            let mut page_bytes = 0usize;

            // SCAN treats COUNT as a hint, so a single reply can contain far
            // more rows than the page size. Emit exactly `count` rows and keep
            // the surplus in the cursor for the next request. Stop once the
            // page payload budget is reached; leftover rows stay in the cursor.
            'rows: while rows.len() < count as usize {
                while rows.len() < count as usize && !state.rest.is_empty() {
                    let next_bytes = row_bytes(&state.rest[0]);
                    if !rows.is_empty() && page_bytes + next_bytes > MAX_PAGE_BYTES {
                        break 'rows;
                    }
                    let columns = state.rest.remove(0);
                    page_bytes += next_bytes;
                    rows.push(ValueRow {
                        row: start + rows.len() as u64,
                        columns,
                    });
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

                let (next_cursor, payload) = scan_reply(reply);

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
                scanned: None,
            }
        }
        "zset" => {
            let total = command_i64(conn, config, "ZCARD", &[key]).await?.max(0) as u64;
            let start = start.min(total);
            let mut rows = if start >= total {
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
            let truncated = cap_rows(&mut rows);
            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: "0".into(),
                start,
                page_size: count,
                rows,
                total: Some(total),
                done: !truncated,
                columns: vec!["rowNumber".into(), "value".into(), "score".into()],
                scanned: None,
            }
        }
        "stream" => {
            let total = command_i64(conn, config, "XLEN", &[key]).await?.max(0) as u64;
            // XREVRANGE takes (end, start). `+ -` reads the newest page;
            // `(cursor -` continues strictly below the last emitted id, so
            // pages neither repeat the cursor entry nor skip one.
            let end = stream_end_bound(cursor);
            let reply = query_with_timeout(
                timeout,
                redis::cmd("XREVRANGE")
                    .arg(key)
                    .arg(&end)
                    .arg("-")
                    .arg("COUNT")
                    .arg(count)
                    .query_async::<redis::Value>(conn),
            )
            .await?;

            let mut rows = Vec::new();
            let mut done = true;
            if let redis::Value::Array(entries) = reply {
                done = entries.len() < count as usize;
                for entry in entries.iter() {
                    let fields = match entry {
                        redis::Value::Array(fields) => fields,
                        _ => continue,
                    };
                    let id = fields
                        .first()
                        .and_then(as_bytes)
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                        .unwrap_or_default();

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

            // Cap the page payload; the cursor (last emitted id) continues
            // strictly below whatever survived, so no entry is skipped.
            if cap_rows(&mut rows) {
                done = false;
            }
            let next_cursor = rows
                .last()
                .and_then(|row| row.columns.first())
                .map(|cell| cell.payload.clone())
                .unwrap_or_else(|| cursor.to_string());
            ValuePage {
                key: key.to_string(),
                key_type: key_type.to_string(),
                cursor: next_cursor,
                start,
                page_size: count,
                rows,
                total: Some(total),
                done,
                columns: vec!["rowNumber".into(), "id".into(), "value".into()],
                scanned: None,
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

/// Full-value search for hash/set/zset/list. Hit counts are paged through the
/// same cursor mechanism as ordinary reads: `done = false` means the scan
/// budget (20 000 entries or 2 seconds) stopped this request and later requests
/// may still find matches.
#[allow(clippy::too_many_arguments)]
async fn search_value_page(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    key_type: &str,
    cursor: &str,
    count: u32,
    target: SearchTarget,
    pattern: &str,
) -> AppResult<ValuePage> {
    let timeout = execute_timeout(config);
    let started = Instant::now();

    let columns: Vec<String> = match key_type {
        "hash" => vec!["rowNumber".into(), "key".into(), "value".into()],
        "set" | "list" => vec!["rowNumber".into(), "value".into()],
        "zset" => vec!["rowNumber".into(), "value".into(), "score".into()],
        // string and stream have nothing to search. Their UI entry is hidden,
        // but IPC callers still get an empty page instead of an error.
        _ => Vec::new(),
    };
    if columns.is_empty() {
        return Ok(ValuePage {
            key: key.to_string(),
            key_type: key_type.to_string(),
            cursor: "0".into(),
            start: 0,
            page_size: count,
            rows: Vec::new(),
            total: None,
            done: true,
            columns,
            scanned: Some(0),
        });
    }

    // `cursor == "0"` is a fresh search; an encoded cursor whose server cursor
    // is already "0" only carries leftover matches and must not rescan from the
    // beginning (the same subtlety as ordinary hash/set paging).
    let first_request = cursor.is_empty() || cursor == "0";
    let mut state = decode_search_cursor(cursor);
    let mut exhausted = !first_request && state.scan == "0";
    let mut rows: Vec<ValueRow> = Vec::new();
    let mut page_bytes = 0usize;
    let mut scanned = 0u64;

    loop {
        // Emit matches buffered by the previous request, then stop if the page
        // (row count or byte budget) is full.
        let mut page_full = false;
        while rows.len() < count as usize && !state.rest.is_empty() {
            let next_bytes = row_bytes(&state.rest[0]);
            if !rows.is_empty() && page_bytes + next_bytes > MAX_PAGE_BYTES {
                page_full = true;
                break;
            }
            let row_columns = state.rest.remove(0);
            page_bytes += next_bytes;
            rows.push(ValueRow {
                row: state.emitted,
                columns: row_columns,
            });
            state.emitted += 1;
        }
        if page_full || rows.len() >= count as usize || exhausted {
            break;
        }
        if scanned >= SEARCH_SCAN_BUDGET || started.elapsed() >= SEARCH_TIME_BUDGET {
            break;
        }

        let budget = SEARCH_SCAN_BUDGET.saturating_sub(scanned).max(1) as u32;
        let batch = SEARCH_BATCH.min(budget).max(1);
        match key_type {
            "hash" => {
                let mut command = redis::cmd("HSCAN");
                command.arg(key).arg(&state.scan);
                if target == SearchTarget::Field {
                    command.arg("MATCH").arg(pattern);
                }
                command.arg("COUNT").arg(batch);
                let reply: redis::Value =
                    query_with_timeout(timeout, command.query_async(conn)).await?;
                let (next_cursor, payload) = scan_reply(reply);
                let pairs = pair_list(redis::Value::Array(payload));
                let mut fetched = Vec::new();
                for (field, value) in pairs {
                    scanned += 1;
                    // Field matching is already done server-side; value matching
                    // has to compare every hash value locally.
                    let matched = target == SearchTarget::Field
                        || glob_match(
                            pattern.as_bytes(),
                            as_bytes(&value).unwrap_or_default().as_slice(),
                        );
                    if matched {
                        fetched.push(vec![
                            encode_bytes(as_bytes(&field).unwrap_or_default().as_slice()),
                            encode_bytes(as_bytes(&value).unwrap_or_default().as_slice()),
                        ]);
                    }
                }
                state.rest.extend(fetched);
                exhausted = next_cursor == "0";
                state.scan = next_cursor;
            }
            "set" => {
                let mut command = redis::cmd("SSCAN");
                command
                    .arg(key)
                    .arg(&state.scan)
                    .arg("MATCH")
                    .arg(pattern)
                    .arg("COUNT")
                    .arg(batch);
                let reply: redis::Value =
                    query_with_timeout(timeout, command.query_async(conn)).await?;
                let (next_cursor, payload) = scan_reply(reply);
                let fetched: Vec<Vec<ValueCell>> = payload
                    .iter()
                    .map(|member| {
                        scanned += 1;
                        vec![encode_bytes(as_bytes(member).unwrap_or_default().as_slice())]
                    })
                    .collect();
                state.rest.extend(fetched);
                exhausted = next_cursor == "0";
                state.scan = next_cursor;
            }
            "zset" => {
                let mut command = redis::cmd("ZSCAN");
                command
                    .arg(key)
                    .arg(&state.scan)
                    .arg("MATCH")
                    .arg(pattern)
                    .arg("COUNT")
                    .arg(batch);
                let reply: redis::Value =
                    query_with_timeout(timeout, command.query_async(conn)).await?;
                let (next_cursor, payload) = scan_reply(reply);
                let mut fetched = Vec::new();
                for (member, score) in pair_list(redis::Value::Array(payload)) {
                    scanned += 1;
                    fetched.push(vec![
                        encode_bytes(as_bytes(&member).unwrap_or_default().as_slice()),
                        encode_bytes(as_bytes(&score).unwrap_or_default().as_slice()),
                    ]);
                }
                state.rest.extend(fetched);
                exhausted = next_cursor == "0";
                state.scan = next_cursor;
            }
            "list" => {
                // Lists have no SCAN cursor; the cursor carries the next index
                // and LRANGE pages are matched locally.
                let offset = state.scan.parse::<i64>().unwrap_or(0);
                let stop = offset + i64::from(batch) - 1;
                let values: Vec<redis::Value> = query_with_timeout(
                    timeout,
                    redis::cmd("LRANGE")
                        .arg(key)
                        .arg(offset)
                        .arg(stop)
                        .query_async::<Vec<redis::Value>>(conn),
                )
                .await?;
                let fetched_len = values.len();
                let mut fetched = Vec::new();
                for value in values {
                    scanned += 1;
                    if glob_match(
                        pattern.as_bytes(),
                        as_bytes(&value).unwrap_or_default().as_slice(),
                    ) {
                        fetched.push(vec![encode_bytes(
                            as_bytes(&value).unwrap_or_default().as_slice(),
                        )]);
                    }
                }
                state.rest.extend(fetched);
                state.scan = (offset + fetched_len as i64).to_string();
                exhausted = fetched_len < batch as usize;
            }
            _ => unreachable!("searchable types were filtered above"),
        }
    }

    let total = match key_type {
        "hash" => command_i64(conn, config, "HLEN", &[key]).await.ok(),
        "set" => command_i64(conn, config, "SCARD", &[key]).await.ok(),
        "zset" => command_i64(conn, config, "ZCARD", &[key]).await.ok(),
        "list" => command_i64(conn, config, "LLEN", &[key]).await.ok(),
        _ => None,
    }
    .map(|value| value.max(0) as u64);

    let done = exhausted && state.rest.is_empty();
    Ok(ValuePage {
        key: key.to_string(),
        key_type: key_type.to_string(),
        cursor: encode_search_cursor(&state, done),
        start: 0,
        page_size: count,
        rows,
        total,
        done,
        columns,
        scanned: Some(scanned),
    })
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

    #[test]
    fn stream_end_bound_uses_exclusive_cursor() {
        // First page reads from the newest end; later pages must exclude the
        // previous page's last id, otherwise the next page repeats newer
        // entries instead of moving backwards.
        assert_eq!(stream_end_bound(""), "+");
        assert_eq!(stream_end_bound("0"), "+");
        assert_eq!(stream_end_bound("1700000000000-0"), "(1700000000000-0");
    }

    #[test]
    fn glob_matching_follows_redis_scan_semantics() {
        assert!(glob_match(b"*", b"anything"));
        assert!(glob_match(b"a*c", b"abbbc"));
        assert!(glob_match(b"?", b"x"));
        assert!(!glob_match(b"?", b""));
        assert!(glob_match(b"[abc]", b"b"));
        assert!(!glob_match(b"[^abc]", b"b"));
        assert!(glob_match(b"[a-c]", b"b"));
        assert!(glob_match(b"foo?[0-9]", b"fooX7"));
        // Escaped wildcard matches the literal character.
        assert!(glob_match(b"\\*", b"*"));
        assert!(!glob_match(b"\\*", b"x"));
        // Unterminated class is treated as a literal bracket.
        assert!(glob_match(b"[", b"["));
    }

    #[test]
    fn search_requires_both_pattern_and_target() {
        assert!(resolve_search(None, None).is_none());
        assert!(resolve_search(Some("a*"), None).is_none());
        assert!(resolve_search(None, Some("value")).is_none());
        assert!(resolve_search(Some("a*"), Some("field")).is_some());
        assert!(resolve_search(Some("a*"), Some("value")).is_some());
    }

    #[test]
    fn search_cursor_keeps_leftovers_and_row_counter() {
        let state = SearchCursorState {
            scan: "77".into(),
            rest: vec![vec![ValueCell {
                encoding: "utf8".into(),
                payload: "v".into(),
            }]],
            emitted: 3,
        };
        let encoded = encode_search_cursor(&state, false);
        let decoded = decode_search_cursor(&encoded);
        assert_eq!(decoded.scan, "77");
        assert_eq!(decoded.emitted, 3);
        assert_eq!(decoded.rest.len(), 1);
        // A finished search collapses to the plain "0" cursor.
        let finished = SearchCursorState {
            scan: "0".into(),
            rest: Vec::new(),
            emitted: 9,
        };
        assert_eq!(encode_search_cursor(&finished, true), "0");
    }

    #[test]
    fn page_byte_cap_keeps_at_least_one_row() {
        let cell = ValueCell {
            encoding: "base64".into(),
            payload: "A".repeat(MAX_PAGE_BYTES + 1),
        };
        let mut rows = vec![ValueRow {
            row: 0,
            columns: vec![cell],
        }];
        assert!(!cap_rows(&mut rows));
        assert_eq!(rows.len(), 1);
    }
}
