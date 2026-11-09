use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::connection::{
    ConnectionConfig, ConnectionGroup, ConnectionSummary, FilterHistoryEntry,
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

const COLUMNS: &str = "
    id, group_id, name, host, port, auth, username,
    ssl_enabled, ssl_local_cert_path, ssl_private_key_path, ssl_ca_cert_path,
    ignore_ssl_errors,
    ssh_host, ssh_port, ssh_user, ssh_password, ssh_private_key, ssh_agent,
    ssh_agent_path, ask_for_ssh_password,
    keys_pattern, namespace_separator, execute_timeout, connection_timeout,
    db_scan_limit, override_cluster_host, default_formatter, icon_color, protocol,
    sort_order, created_at, updated_at
";

fn row_to_config(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionConfig> {
    Ok(ConnectionConfig {
        id: row.get(0)?,
        group_id: row.get(1)?,
        name: row.get(2)?,
        host: row.get(3)?,
        port: row.get::<_, i64>(4)? as u16,
        auth: row.get(5)?,
        username: row.get(6)?,
        ssl_enabled: row.get::<_, i64>(7)? != 0,
        ssl_local_cert_path: row.get(8)?,
        ssl_private_key_path: row.get(9)?,
        ssl_ca_cert_path: row.get(10)?,
        ignore_ssl_errors: row.get::<_, i64>(11)? != 0,
        ssh_host: row.get(12)?,
        ssh_port: row.get::<_, i64>(13)? as u16,
        ssh_user: row.get(14)?,
        ssh_password: row.get(15)?,
        ssh_private_key: row.get(16)?,
        ssh_agent: row.get::<_, i64>(17)? != 0,
        ssh_agent_path: row.get(18)?,
        ask_for_ssh_password: row.get::<_, i64>(19)? != 0,
        keys_pattern: row.get(20)?,
        namespace_separator: row.get(21)?,
        execute_timeout: row.get::<_, i64>(22)? as u32,
        connection_timeout: row.get::<_, i64>(23)? as u32,
        db_scan_limit: row.get::<_, i64>(24)? as u32,
        override_cluster_host: row.get::<_, i64>(25)? != 0,
        default_formatter: row.get(26)?,
        icon_color: row.get(27)?,
        protocol: row.get(28)?,
    })
}

pub fn list_summaries(conn: &Connection) -> AppResult<Vec<ConnectionSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, group_id, name, host, port, ssl_enabled, ssh_host, sort_order
         FROM connections ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConnectionSummary {
            id: row.get(0)?,
            group_id: row.get(1)?,
            name: row.get(2)?,
            host: row.get(3)?,
            port: row.get::<_, i64>(4)? as u16,
            ssl_enabled: row.get::<_, i64>(5)? != 0,
            ssh_host: row.get(6)?,
            sort_order: row.get(7)?,
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn get_config(conn: &Connection, id: &str) -> AppResult<ConnectionConfig> {
    let sql = format!("SELECT {COLUMNS} FROM connections WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_config)
        .optional()?
        .ok_or_else(|| AppError::Message(format!("Connection {id} not found")))
}

pub fn list_configs(conn: &Connection) -> AppResult<Vec<ConnectionConfig>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM connections ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_config)?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn next_sort_order(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connections",
        [],
        |row| row.get::<_, i64>(0),
    )?)
}

pub fn save_config(conn: &Connection, mut config: ConnectionConfig) -> AppResult<ConnectionConfig> {
    if config.id.trim().is_empty() {
        config.id = Uuid::new_v4().to_string();
    }
    let existing: Option<i64> = conn
        .query_row(
            "SELECT sort_order FROM connections WHERE id = ?1",
            params![config.id],
            |row| row.get(0),
        )
        .optional()?;

    let now = now_ms();
    if let Some(_sort_order) = existing {
        conn.execute(
            "UPDATE connections SET
                group_id = ?2, name = ?3, host = ?4, port = ?5, auth = ?6, username = ?7,
                ssl_enabled = ?8, ssl_local_cert_path = ?9, ssl_private_key_path = ?10,
                ssl_ca_cert_path = ?11, ignore_ssl_errors = ?12,
                ssh_host = ?13, ssh_port = ?14, ssh_user = ?15, ssh_password = ?16,
                ssh_private_key = ?17, ssh_agent = ?18, ssh_agent_path = ?19,
                ask_for_ssh_password = ?20,
                keys_pattern = ?21, namespace_separator = ?22, execute_timeout = ?23,
                connection_timeout = ?24, db_scan_limit = ?25, override_cluster_host = ?26,
                default_formatter = ?27, icon_color = ?28, protocol = ?29,
                updated_at = ?30
             WHERE id = ?1",
            params![
                config.id,
                config.group_id,
                config.name,
                config.host,
                config.port as i64,
                config.auth,
                config.username,
                config.ssl_enabled as i64,
                config.ssl_local_cert_path,
                config.ssl_private_key_path,
                config.ssl_ca_cert_path,
                config.ignore_ssl_errors as i64,
                config.ssh_host,
                config.ssh_port as i64,
                config.ssh_user,
                config.ssh_password,
                config.ssh_private_key,
                config.ssh_agent as i64,
                config.ssh_agent_path,
                config.ask_for_ssh_password as i64,
                config.keys_pattern,
                config.namespace_separator,
                config.execute_timeout as i64,
                config.connection_timeout as i64,
                config.db_scan_limit as i64,
                config.override_cluster_host as i64,
                config.default_formatter,
                config.icon_color,
                config.protocol,
                now,
            ],
        )?;
    } else {
        let sort_order = next_sort_order(conn)?;
        conn.execute(
            "INSERT INTO connections (
                id, group_id, name, host, port, auth, username,
                ssl_enabled, ssl_local_cert_path, ssl_private_key_path, ssl_ca_cert_path,
                ignore_ssl_errors,
                ssh_host, ssh_port, ssh_user, ssh_password, ssh_private_key, ssh_agent,
                ssh_agent_path, ask_for_ssh_password,
                keys_pattern, namespace_separator, execute_timeout, connection_timeout,
                db_scan_limit, override_cluster_host, default_formatter, icon_color, protocol,
                sort_order, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7,
                ?8, ?9, ?10, ?11,
                ?12,
                ?13, ?14, ?15, ?16, ?17, ?18,
                ?19, ?20,
                ?21, ?22, ?23, ?24,
                ?25, ?26, ?27, ?28, ?29,
                ?30, ?31, ?32
             )",
            params![
                config.id,
                config.group_id,
                config.name,
                config.host,
                config.port as i64,
                config.auth,
                config.username,
                config.ssl_enabled as i64,
                config.ssl_local_cert_path,
                config.ssl_private_key_path,
                config.ssl_ca_cert_path,
                config.ignore_ssl_errors as i64,
                config.ssh_host,
                config.ssh_port as i64,
                config.ssh_user,
                config.ssh_password,
                config.ssh_private_key,
                config.ssh_agent as i64,
                config.ssh_agent_path,
                config.ask_for_ssh_password as i64,
                config.keys_pattern,
                config.namespace_separator,
                config.execute_timeout as i64,
                config.connection_timeout as i64,
                config.db_scan_limit as i64,
                config.override_cluster_host as i64,
                config.default_formatter,
                config.icon_color,
                config.protocol,
                sort_order,
                now,
                now,
            ],
        )?;
    }
    Ok(config)
}

pub fn delete_config(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn duplicate_config(conn: &Connection, id: &str) -> AppResult<ConnectionConfig> {
    let mut config = get_config(conn, id)?;
    config.id = String::new();
    config.name = format!("{} copy", config.name);
    save_config(conn, config)
}

// ---- groups ---------------------------------------------------------------

pub fn list_groups(conn: &Connection) -> AppResult<Vec<ConnectionGroup>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, sort_order FROM connection_groups
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConnectionGroup {
            id: row.get(0)?,
            name: row.get(1)?,
            sort_order: row.get(2)?,
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn save_group(
    conn: &Connection,
    id: Option<String>,
    name: &str,
) -> AppResult<ConnectionGroup> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("Group name is required".into()));
    }
    let existing = id.filter(|value| !value.trim().is_empty());
    let group_id = existing.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_ms();

    if existing.is_some() {
        conn.execute(
            "UPDATE connection_groups SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![group_id, name, now],
        )?;
    } else {
        let sort_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connection_groups",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "INSERT INTO connection_groups (id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![group_id, name, sort_order, now],
        )?;
    }

    conn.query_row(
        "SELECT id, name, sort_order FROM connection_groups WHERE id = ?1",
        params![group_id],
        |row| {
            Ok(ConnectionGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
            })
        },
    )
    .map_err(AppError::from)
}

pub fn delete_group(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM connection_groups WHERE id = ?1", params![id])?;
    Ok(())
}

/// Moves a server between groups without touching its other settings.
pub fn move_connection(conn: &Connection, id: &str, group_id: Option<&str>) -> AppResult<()> {
    if let Some(group) = group_id {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM connection_groups WHERE id = ?1",
                params![group],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::Invalid(format!("Group {group} not found")));
        }
    }

    let updated = conn.execute(
        "UPDATE connections SET group_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, group_id, now_ms()],
    )?;
    if updated == 0 {
        return Err(AppError::Message(format!("Connection {id} not found")));
    }
    Ok(())
}

// ---- filter history -------------------------------------------------------

pub fn list_filter_history(
    conn: &Connection,
    connection_id: &str,
) -> AppResult<Vec<FilterHistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT pattern, use_count, last_used_at FROM filter_history
         WHERE connection_id = ?1 ORDER BY last_used_at DESC LIMIT 50",
    )?;
    let rows = stmt.query_map(params![connection_id], |row| {
        Ok(FilterHistoryEntry {
            pattern: row.get(0)?,
            use_count: row.get(1)?,
            last_used_at: row.get(2)?,
        })
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

pub fn remember_filter(
    conn: &Connection,
    connection_id: &str,
    pattern: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO filter_history (connection_id, pattern, use_count, last_used_at)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(connection_id, pattern)
         DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at",
        params![connection_id, pattern, now_ms()],
    )?;
    Ok(())
}

// ---- import / export ------------------------------------------------------

pub fn import_file(conn: &Connection, path: &Path) -> AppResult<usize> {
    let text = fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&text)?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(mut map) => map
            .remove("connections")
            .or_else(|| map.remove("items"))
            .and_then(|value| value.as_array().cloned())
            .ok_or_else(|| AppError::Invalid("No connections array in file".into()))?,
        _ => return Err(AppError::Invalid("Unsupported import file".into())),
    };

    // Parse and validate every entry before touching the database, then write
    // them in one transaction. A single bad row or a failure halfway through
    // rolls the whole import back instead of leaving the list half updated.
    let mut configs: Vec<ConnectionConfig> = Vec::with_capacity(items.len());
    for item in items {
        let mut config: ConnectionConfig = serde_json::from_value(item)?;
        config.id = String::new();
        config.group_id = None;
        if config.name.trim().is_empty() {
            config.name = format!("{}:{}", config.host, config.port);
        }
        configs.push(config);
    }

    let transaction = conn.unchecked_transaction()?;
    for config in &configs {
        save_config(&transaction, config.clone())?;
    }
    transaction.commit()?;
    Ok(configs.len())
}

pub fn export_file(conn: &Connection, path: &Path) -> AppResult<()> {
    let configs = list_configs(conn)?;
    let payload: Vec<serde_json::Value> = configs
        .iter()
        .map(ConnectionConfig::to_legacy_json)
        .collect();
    fs::write(path, serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}
