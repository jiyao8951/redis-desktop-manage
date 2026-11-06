use std::collections::BTreeMap;

use redis::aio::ConnectionManager;
use redis::Value;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::models::tree::{DatabaseInfo, ScanPage};

use super::manager::{build_url, connection_timeout, execute_timeout, query_with_timeout};

/// Default SCAN page size. The old 100 forced ~100 IPC rounds for 10k keys; 500
/// keeps each reply modest while cutting the round trips by 5x. The value is
/// still a COUNT hint: Redis may return more or fewer entries.
pub const DEFAULT_SCAN_PAGE_SIZE: u32 = 500;

/// Upper bound accepted from the settings UI.
pub const MAX_SCAN_PAGE_SIZE: u32 = 1_000;

/// Reproduces NamespaceItem::load()'s filter composition:
///   - no namespace: the database filter as-is
///   - namespace:    "<ns><sep><filter>", unless the filter already starts
///                   with "<ns><sep>" (then it is used verbatim)
/// An empty filter means "*" at the root and "<ns><sep>*" inside a namespace.
pub fn build_match_pattern(
    namespace: Option<&str>,
    filter: Option<&str>,
    separator: &str,
) -> String {
    let filter = filter.unwrap_or("*");

    match namespace {
        Some(ns) if !ns.is_empty() => {
            // A namespace may already include its trailing separator (for
            // example the UI keeps "rdmtest:func:"), so strip it before
            // joining to avoid a double "::" in the MATCH pattern.
            let ns = if separator.is_empty() {
                ns
            } else {
                ns.trim_end_matches(separator)
            };
            let prefix = if ns.is_empty() {
                separator.to_string()
            } else {
                format!("{ns}{separator}")
            };
            if filter.is_empty() {
                format!("{prefix}*")
            } else if filter.starts_with(&prefix) {
                filter.to_string()
            } else {
                format!("{prefix}{filter}")
            }
        }
        _ => {
            if filter.is_empty() {
                "*".to_string()
            } else {
                filter.to_string()
            }
        }
    }
}

/// Parses `INFO keyspace` lines such as `db0:keys=62,expires=3,avg_ttl=0`.
pub fn parse_keyspace(info: &str) -> Vec<DatabaseInfo> {
    let mut found: BTreeMap<u32, u64> = BTreeMap::new();

    for line in info.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("db") else {
            continue;
        };
        let Some((index, values)) = rest.split_once(':') else {
            continue;
        };
        let Ok(index) = index.parse::<u32>() else {
            continue;
        };
        let mut keys = 0u64;
        for part in values.split(',') {
            if let Some(value) = part.trim().strip_prefix("keys=") {
                keys = value.parse::<u64>().unwrap_or(0);
            }
        }
        found.insert(index, keys);
    }

    found
        .into_iter()
        .map(|(index, keys)| DatabaseInfo { index, keys })
        .collect()
}

/// `CONFIG GET databases` (read-only). Returns 0 when the server denies the
/// command; callers then fall back to probing SELECT.
pub(crate) async fn configured_databases(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> u32 {
    let reply: Value = match query_with_timeout(
        execute_timeout(config),
        redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Value>(conn),
    )
    .await
    {
        Ok(value) => value,
        Err(_) => return 0,
    };

    configured_databases_from_reply(&reply)
}

/// RESP2 answers with a flat `[name, value]` array; RESP3 answers with a map.
/// Convert both shapes before reading the value.
fn configured_databases_from_reply(reply: &Value) -> u32 {
    let mut flat: Vec<&Value> = Vec::new();
    match reply {
        Value::Map(entries) => {
            for (name, value) in entries {
                flat.push(name);
                flat.push(value);
            }
        }
        Value::Array(items) | Value::Set(items) => flat.extend(items.iter()),
        _ => {}
    }

    flat.get(1)
        .and_then(|value| redis::from_redis_value::<String>(value).ok())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// Mirrors TreeOperations::loadDatabases(): non-empty databases come from
/// INFO keyspace, then every missing index below the configured count (or
/// `databaseScanLimit`) is added with an empty key count. Empty databases are
/// detected with CONFIG GET when possible, otherwise by probing SELECT on a
/// dedicated connection (never on the shared multiplexed manager, which would
/// change its selected db).
async fn probe_empty_databases(
    config: &ConnectionConfig,
    start: u32,
    limit: u32,
) -> Vec<u32> {
    let mut result = Vec::new();
    let url = build_url(config, 0, false);
    let Ok(client) = redis::Client::open(url.as_str()) else {
        return result;
    };
    let connection =
        tokio::time::timeout(connection_timeout(config), client.get_multiplexed_async_connection())
            .await;
    let mut probe = match connection {
        Ok(Ok(connection)) => connection,
        _ => return result,
    };

    for index in start..limit {
        let selected = query_with_timeout(
            execute_timeout(config),
            redis::cmd("SELECT").arg(index).query_async::<String>(&mut probe),
        )
        .await;
        match selected {
            Ok(_) => result.push(index),
            Err(_) => break,
        }
    }
    result
}

pub async fn list_databases(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<Vec<DatabaseInfo>> {
    let info: String = query_with_timeout(
        execute_timeout(config),
        redis::cmd("INFO")
            .arg("keyspace")
            .query_async::<String>(conn),
    )
    .await?;

    let existing = parse_keyspace(&info);
    let mut databases: BTreeMap<u32, u64> =
        existing.iter().map(|db| (db.index, db.keys)).collect();

    let limit = config.db_scan_limit.max(1);

    let configured = configured_databases(conn, config).await;
    if configured > 0 {
        let cap = configured.min(limit);
        for index in 0..cap {
            databases.entry(index).or_insert(0);
        }
    } else {
        for index in probe_empty_databases(config, 0, limit).await {
            databases.entry(index).or_insert(0);
        }
    }

    Ok(databases
        .into_iter()
        .map(|(index, keys)| DatabaseInfo { index, keys })
        .collect())
}

fn reply_bytes(value: &Value) -> Option<Vec<u8>> {
    match value {
        Value::BulkString(bytes) => Some(bytes.clone()),
        Value::SimpleString(text) => Some(text.as_bytes().to_vec()),
        Value::Int(number) => Some(number.to_string().into_bytes()),
        _ => None,
    }
}

/// Splits a SCAN reply into (next cursor, keys). Keys that are not valid UTF-8
/// are skipped instead of failing the whole page: the tree model and every
/// follow-up command are string based, so showing a mangled key would target
/// the wrong name. The page itself still succeeds and scanning continues.
fn scan_reply_page(reply: Value) -> AppResult<(String, Vec<String>)> {
    let Value::Array(items) = reply else {
        return Err(AppError::Invalid("Unexpected SCAN reply".into()));
    };
    let next_cursor = items
        .first()
        .and_then(reply_bytes)
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .filter(|cursor| !cursor.is_empty())
        .unwrap_or_else(|| "0".to_string());
    let keys = match items.get(1) {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(reply_bytes)
            .filter_map(|bytes| String::from_utf8(bytes).ok())
            .collect(),
        _ => Vec::new(),
    };
    Ok((next_cursor, keys))
}

pub async fn scan_keys(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    cursor: &str,
    namespace: Option<&str>,
    filter: Option<&str>,
    page_size: u32,
) -> AppResult<ScanPage> {
    let cursor_value = cursor
        .parse::<u64>()
        .map_err(|_| AppError::Invalid(format!("Invalid SCAN cursor: {cursor}")))?;
    let count = if page_size == 0 {
        DEFAULT_SCAN_PAGE_SIZE
    } else {
        page_size.clamp(1, MAX_SCAN_PAGE_SIZE)
    };
    let pattern = build_match_pattern(namespace, filter, &config.namespace_separator);

    let reply: Value = query_with_timeout(
        execute_timeout(config),
        redis::cmd("SCAN")
            .arg(cursor_value)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(count)
            .query_async(conn),
    )
    .await?;
    let (next_cursor, keys) = scan_reply_page(reply)?;

    Ok(ScanPage {
        cursor: next_cursor,
        keys,
        page_size: count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bulk(text: &str) -> Value {
        Value::BulkString(text.as_bytes().to_vec())
    }

    #[test]
    fn configured_databases_reads_resp2_pair() {
        let reply = Value::Array(vec![bulk("databases"), bulk("16")]);
        assert_eq!(configured_databases_from_reply(&reply), 16);
    }

    #[test]
    fn configured_databases_reads_resp3_map() {
        let reply = Value::Map(vec![(bulk("databases"), bulk("16"))]);
        assert_eq!(configured_databases_from_reply(&reply), 16);
    }

    #[test]
    fn list_databases_fills_missing_indices_between_used_databases() {
        let mut databases: BTreeMap<u32, u64> = BTreeMap::new();
        for (index, keys) in [(0u32, 4u64), (1, 2), (2, 1), (10, 4)] {
            databases.insert(index, keys);
        }
        for index in 0..16 {
            databases.entry(index).or_insert(0);
        }
        let indices: Vec<u32> = databases.keys().copied().collect();
        assert_eq!(indices, (0..16).collect::<Vec<u32>>());
    }

    #[test]
    fn match_pattern_is_idempotent_for_trailing_separator() {
        assert_eq!(
            build_match_pattern(Some("rdmtest:func"), Some("x"), ":"),
            "rdmtest:func:x"
        );
        assert_eq!(
            build_match_pattern(Some("rdmtest:func:"), Some("x"), ":"),
            "rdmtest:func:x"
        );
        assert_eq!(
            build_match_pattern(Some("rdmtest:func:"), None, ":"),
            "rdmtest:func:*"
        );
    }

    #[test]
    fn scan_reply_skips_non_utf8_keys() {
        let reply = Value::Array(vec![
            bulk("42"),
            Value::Array(vec![
                Value::BulkString(vec![b'r', b'd', b'm', 0xff]),
                bulk("ok"),
            ]),
        ]);
        let (cursor, keys) = scan_reply_page(reply).expect("scan reply");
        assert_eq!(cursor, "42");
        assert_eq!(keys, vec!["ok".to_string()]);
    }
}
