use std::collections::BTreeMap;

use redis::aio::ConnectionManager;

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
            let prefix = format!("{ns}{separator}");
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
    let pair: Vec<String> = match query_with_timeout(
        execute_timeout(config),
        redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Vec<String>>(conn),
    )
    .await
    {
        Ok(values) => values,
        Err(_) => return 0,
    };

    pair.get(1)
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0)
}

/// Mirrors TreeOperations::loadDatabases(): non-empty databases come from
/// INFO keyspace, then empty databases are appended from the last index + 1 up
/// to `databaseScanLimit`. Empty databases are detected with CONFIG GET when
/// possible, otherwise by probing SELECT on a dedicated connection (never on
/// the shared multiplexed manager, which would change its selected db).
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

    let start = match databases.keys().next_back() {
        Some(index) => index.saturating_add(1),
        None => 0,
    };
    let limit = config.db_scan_limit.max(1);

    let configured = configured_databases(conn, config).await;
    if configured > 0 {
        let cap = configured.min(limit);
        for index in start..cap {
            databases.entry(index).or_insert(0);
        }
    } else if start < limit {
        for index in probe_empty_databases(config, start, limit).await {
            databases.entry(index).or_insert(0);
        }
    }

    Ok(databases
        .into_iter()
        .map(|(index, keys)| DatabaseInfo { index, keys })
        .collect())
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

    let (next_cursor, keys): (String, Vec<String>) = query_with_timeout(
        execute_timeout(config),
        redis::cmd("SCAN")
            .arg(cursor_value)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(count)
            .query_async::<(String, Vec<String>)>(conn),
    )
    .await?;

    Ok(ScanPage {
        cursor: next_cursor,
        keys,
        page_size: count,
    })
}
