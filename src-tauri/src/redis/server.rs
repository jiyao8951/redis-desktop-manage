use redis::aio::ConnectionManager;
use redis::Value;

use crate::error::AppResult;
use crate::models::connection::ConnectionConfig;
use crate::models::server::{
    ClientEntry, ConfigEntry, InfoField, MemoryReport, ServerInfo, SlowlogEntry,
};

use super::manager::{execute_timeout, query_with_timeout};
use super::meta::parse_info_sections;

/// Same default as serverstatsmodel.cpp (`SLOWLOG GET 15`).
const SLOWLOG_DEFAULT: u32 = 15;

/// Read-only CONFIG GET whitelist. Deliberately excludes `requirepass`,
/// `masterauth`, `aclfile` and any other credential-bearing directive.
const CONFIG_KEYS: &[&str] = &[
    "maxmemory",
    "maxmemory-policy",
    "maxmemory-samples",
    "timeout",
    "databases",
    "appendonly",
    "appendfsync",
    "save",
    "dir",
    "dbfilename",
    "maxclients",
    "slowlog-log-slower-than",
    "slowlog-max-len",
    "tcp-keepalive",
    "hz",
    "lazyfree-lazy-eviction",
];

fn value_to_string(value: &Value) -> String {
    match value {
        Value::Nil => String::new(),
        Value::Int(number) => number.to_string(),
        Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        Value::SimpleString(text) => text.clone(),
        Value::Okay => "OK".to_string(),
        Value::Double(number) => number.to_string(),
        Value::Boolean(value) => value.to_string(),
        Value::VerbatimString { text, .. } => text.clone(),
        Value::ServerError(error) => format!("{error:?}"),
        other => format!("{other:?}"),
    }
}

/// Flattens a positional name/value array (RESP2) or a map (RESP3) into pairs.
fn pairs(value: &Value) -> Vec<(String, String)> {
    match value {
        Value::Array(items) => items
            .chunks(2)
            .filter_map(|chunk| {
                if chunk.len() == 2 {
                    Some((value_to_string(&chunk[0]), value_to_string(&chunk[1])))
                } else {
                    None
                }
            })
            .collect(),
        Value::Map(entries) => entries
            .iter()
            .map(|(name, value)| (value_to_string(name), value_to_string(value)))
            .collect(),
        _ => Vec::new(),
    }
}

pub async fn server_info(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<ServerInfo> {
    let raw: String = query_with_timeout(
        execute_timeout(config),
        redis::cmd("INFO").arg("all").query_async(conn),
    )
    .await?;
    // Only the parsed sections cross the IPC boundary; the raw INFO text was
    // an exact duplicate of the same data and doubled the payload.
    Ok(ServerInfo {
        sections: parse_info_sections(&raw),
    })
}

pub async fn slowlog(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    count: Option<u32>,
) -> AppResult<Vec<SlowlogEntry>> {
    let count = count.unwrap_or(SLOWLOG_DEFAULT).clamp(1, 128);
    let reply: Value = query_with_timeout(
        execute_timeout(config),
        redis::cmd("SLOWLOG").arg("GET").arg(count).query_async(conn),
    )
    .await?;

    let Value::Array(entries) = reply else {
        return Ok(Vec::new());
    };

    let mut rows = Vec::new();
    for entry in entries {
        let Value::Array(fields) = entry else {
            continue;
        };
        let id = fields
            .first()
            .map(value_to_string)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let time = fields
            .get(1)
            .map(value_to_string)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let duration_us = fields
            .get(2)
            .map(value_to_string)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let command = match fields.get(3) {
            Some(Value::Array(args)) => args.iter().map(value_to_string).collect(),
            _ => Vec::new(),
        };
        rows.push(SlowlogEntry {
            id,
            time,
            duration_us,
            command,
        });
    }
    Ok(rows)
}

/// Parses `CLIENT LIST` exactly like the original: one client per line, then
/// `key=value` tokens. `split_once` keeps values that contain `=` intact.
pub async fn clients(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<Vec<ClientEntry>> {
    let raw: String = query_with_timeout(
        execute_timeout(config),
        redis::cmd("CLIENT").arg("LIST").query_async(conn),
    )
    .await?;

    let mut rows = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut fields = Vec::new();
        for token in line.split_whitespace() {
            let (name, value) = token.split_once('=').unwrap_or((token, ""));
            fields.push(InfoField {
                name: name.to_string(),
                value: value.to_string(),
            });
        }
        let field = |name: &str| {
            fields
                .iter()
                .find(|field| field.name == name)
                .map(|field| field.value.clone())
                .unwrap_or_default()
        };
        rows.push(ClientEntry {
            addr: field("addr"),
            name: field("name"),
            db: field("db"),
            cmd: field("cmd"),
            flags: field("flags"),
            age: field("age"),
            idle: field("idle"),
            fields,
        });
    }
    Ok(rows)
}

pub async fn config_get(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<Vec<ConfigEntry>> {
    // `CONFIG GET key1 key2 ...` was only added in Redis 7; older servers
    // reject the multi-argument form. A pipeline of single-key GETs keeps the
    // reply to one round trip while working on Redis <= 6.2 as well.
    let mut pipe = redis::pipe();
    for key in CONFIG_KEYS {
        pipe.cmd("CONFIG").arg("GET").arg(*key);
    }
    let replies: Vec<Value> =
        query_with_timeout(execute_timeout(config), pipe.query_async(conn)).await?;

    let mut entries: Vec<ConfigEntry> = replies
        .iter()
        .flat_map(pairs)
        .map(|(name, value)| ConfigEntry { name, value })
        .collect();
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

/// `MEMORY STATS` is missing on Redis < 4; a failure yields an empty table
/// instead of breaking the whole page. `MEMORY DOCTOR` is best effort too.
pub async fn memory_report(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<MemoryReport> {
    let stats = match query_with_timeout::<Value, _>(
        execute_timeout(config),
        redis::cmd("MEMORY").arg("STATS").query_async(conn),
    )
    .await
    {
        Ok(reply) => pairs(&reply)
            .into_iter()
            .map(|(name, value)| InfoField { name, value })
            .collect(),
        Err(_) => Vec::new(),
    };

    let doctor = query_with_timeout::<String, _>(
        execute_timeout(config),
        redis::cmd("MEMORY").arg("DOCTOR").query_async(conn),
    )
    .await
    .unwrap_or_default();

    Ok(MemoryReport { stats, doctor })
}
