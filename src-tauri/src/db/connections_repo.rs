use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::models::connection::{
    ConnectionConfig, ConnectionGroup, ConnectionSummary, FilterHistoryEntry, ImportConflict,
    ImportPreview, ImportSummary,
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

/// Marker written into exported backups.
const BACKUP_FORMAT: &str = "redis-desktop-manager.connections";
const BACKUP_VERSION: u32 = 2;

fn group_name_of(value: &serde_json::Value) -> Option<String> {
    let map = value.as_object()?;
    ["groupName", "group_name", "group"]
        .into_iter()
        .find_map(|key| map.get(key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// Duplicate identity used by import: the same name on the same host/port is
/// treated as the connection that is already saved.
fn connection_key(config: &ConnectionConfig) -> (String, String, u16) {
    (
        config.name.trim().to_lowercase(),
        config.host.trim().to_lowercase(),
        config.port,
    )
}

/// A parsed backup connection plus the group name it belongs to.
type BackupEntry = (Option<String>, ConnectionConfig);

/// Reads either the wrapped backup layout or the original RESP.app flat array
/// and validates every entry before any database write happens.
fn read_backup(path: &Path) -> AppResult<(Vec<String>, Vec<BackupEntry>)> {
    let text = fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&text)?;

    let (groups_value, items) = match value {
        serde_json::Value::Array(items) => (Vec::new(), items),
        serde_json::Value::Object(mut map) => {
            let groups = map
                .remove("groups")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let items = map
                .remove("connections")
                .or_else(|| map.remove("items"))
                .and_then(|value| value.as_array().cloned())
                .ok_or_else(|| AppError::Invalid("No connections array in file".into()))?;
            (groups, items)
        }
        _ => return Err(AppError::Invalid("Unsupported import file".into())),
    };

    let mut group_names = Vec::new();
    for group in &groups_value {
        let name = match group {
            serde_json::Value::String(name) => name.clone(),
            serde_json::Value::Object(map) => map
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            _ => continue,
        };
        let name = name.trim();
        if !name.is_empty() {
            group_names.push(name.to_string());
        }
    }

    // Parse and validate every entry before touching the database, then write
    // them in one transaction. A single bad row or a failure halfway through
    // rolls the whole import back instead of leaving the list half updated.
    let mut entries: Vec<BackupEntry> = Vec::with_capacity(items.len());
    for item in items {
        let group_name = group_name_of(&item);
        let mut config: ConnectionConfig = serde_json::from_value(item)?;
        config.id = String::new();
        config.group_id = None;
        if config.name.trim().is_empty() {
            config.name = format!("{}:{}", config.host, config.port);
        }
        entries.push((group_name, config));
    }

    Ok((group_names, entries))
}

/// Dry run used by the restore dialog: reports every backup entry that would
/// collide with an already saved connection.
pub fn preview_import_file(conn: &Connection, path: &Path) -> AppResult<ImportPreview> {
    let (_, entries) = read_backup(path)?;
    let existing: HashSet<(String, String, u16)> = list_configs(conn)?
        .iter()
        .map(connection_key)
        .collect();
    let conflicts = entries
        .iter()
        .filter(|(_, config)| existing.contains(&connection_key(config)))
        .map(|(_, config)| ImportConflict {
            name: config.name.clone(),
            host: config.host.clone(),
            port: config.port,
        })
        .collect();
    Ok(ImportPreview {
        total: entries.len(),
        conflicts,
    })
}

/// `overwrite = false` skips colliding entries; `overwrite = true` updates the
/// existing row in place, keeping its id so it stays the same tree item.
pub fn import_file(conn: &Connection, path: &Path, overwrite: bool) -> AppResult<ImportSummary> {
    let (group_names, entries) = read_backup(path)?;

    let transaction = conn.unchecked_transaction()?;

    // Group ids are local to each installation, so backups reference groups by
    // name. Reuse an existing group with the same name (case-insensitive) or
    // create the missing ones.
    let mut group_ids: HashMap<String, String> = list_groups(&transaction)?
        .into_iter()
        .map(|group| (group.name.trim().to_lowercase(), group.id))
        .collect();
    let mut groups_created = 0usize;

    for name in &group_names {
        let key = name.to_lowercase();
        if let std::collections::hash_map::Entry::Vacant(entry) = group_ids.entry(key) {
            let created = save_group(&transaction, None, name)?;
            entry.insert(created.id);
            groups_created += 1;
        }
    }

    // Key -> existing id, so a collision can be skipped or overwritten in place.
    let mut existing: HashMap<(String, String, u16), String> = list_configs(&transaction)?
        .into_iter()
        .map(|config| (connection_key(&config), config.id))
        .collect();

    let mut imported = 0usize;
    let mut overwritten = 0usize;
    let mut skipped = 0usize;
    for (group_name, mut config) in entries {
        if let Some(name) = group_name {
            let key = name.trim().to_lowercase();
            if let std::collections::hash_map::Entry::Vacant(entry) = group_ids.entry(key.clone()) {
                let created = save_group(&transaction, None, name.trim())?;
                entry.insert(created.id);
                groups_created += 1;
            }
            config.group_id = group_ids.get(&key).cloned();
        }

        let key = connection_key(&config);
        if let Some(existing_id) = existing.get(&key) {
            if overwrite {
                config.id = existing_id.clone();
                save_config(&transaction, config)?;
                overwritten += 1;
            } else {
                skipped += 1;
            }
            continue;
        }

        let saved = save_config(&transaction, config)?;
        existing.insert(key, saved.id);
        imported += 1;
    }

    transaction.commit()?;
    Ok(ImportSummary {
        imported,
        overwritten,
        skipped,
        groups: groups_created,
    })
}

fn write_backup(
    path: &Path,
    configs: &[ConnectionConfig],
    groups: &[ConnectionGroup],
) -> AppResult<()> {
    let group_names: HashMap<&str, &str> = groups
        .iter()
        .map(|group| (group.id.as_str(), group.name.as_str()))
        .collect();

    let connections: Vec<serde_json::Value> = configs
        .iter()
        .map(|config| {
            let mut value = config.to_legacy_json();
            if let serde_json::Value::Object(map) = &mut value {
                // Backup fidelity: the legacy schema carries neither the
                // protocol nor the group, so add both as extra keys. Legacy
                // importers ignore unknown keys.
                map.insert("protocol".into(), serde_json::json!(config.protocol));
                if let Some(name) = config
                    .group_id
                    .as_deref()
                    .and_then(|id| group_names.get(id))
                {
                    map.insert("groupName".into(), serde_json::json!(name));
                }
            }
            value
        })
        .collect();

    let payload = serde_json::json!({
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exportedAt": now_ms(),
        "groups": groups
            .iter()
            .map(|group| serde_json::json!({ "name": group.name, "sortOrder": group.sort_order }))
            .collect::<Vec<_>>(),
        "connections": connections,
    });
    fs::write(path, serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

pub fn export_file(conn: &Connection, path: &Path) -> AppResult<()> {
    let configs = list_configs(conn)?;
    let groups = list_groups(conn)?;
    write_backup(path, &configs, &groups)
}

/// Exports a single saved connection together with the group it belongs to.
pub fn export_connection(conn: &Connection, id: &str, path: &Path) -> AppResult<()> {
    let config = get_config(conn, id)?;
    let groups: Vec<ConnectionGroup> = list_groups(conn)?
        .into_iter()
        .filter(|group| Some(group.id.as_str()) == config.group_id.as_deref())
        .collect();
    write_backup(path, std::slice::from_ref(&config), &groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&mut conn).unwrap();
        conn
    }

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("rdm-connections-{}.json", Uuid::new_v4()))
    }

    #[test]
    fn export_and_import_restore_groups_and_protocol() {
        let source = memory_db();
        let group = save_group(&source, None, "Production").unwrap();
        let config = save_config(
            &source,
            ConnectionConfig {
                name: "cache".into(),
                host: "10.0.0.5".into(),
                port: 6380,
                group_id: Some(group.id.clone()),
                protocol: "resp3".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(config.protocol, "resp3");

        let path = temp_path();
        export_file(&source, &path).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["format"], BACKUP_FORMAT);
        assert_eq!(value["groups"][0]["name"], "Production");
        assert_eq!(value["connections"][0]["protocol"], "resp3");
        assert_eq!(value["connections"][0]["groupName"], "Production");

        let target = memory_db();
        let summary = import_file(&target, &path, false).unwrap();
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.skipped, 0);
        assert_eq!(summary.groups, 1);

        let restored = list_configs(&target).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].protocol, "resp3");
        let groups = list_groups(&target).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Production");
        assert_eq!(
            restored[0].group_id.as_deref(),
            Some(groups[0].id.as_str())
        );

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn importing_the_same_backup_twice_is_idempotent() {
        let source = memory_db();
        save_config(
            &source,
            ConnectionConfig {
                name: "main".into(),
                host: "127.0.0.1".into(),
                ..Default::default()
            },
        )
        .unwrap();

        let path = temp_path();
        export_file(&source, &path).unwrap();

        let target = memory_db();
        let first = import_file(&target, &path, false).unwrap();
        assert_eq!((first.imported, first.skipped), (1, 0));

        let second = import_file(&target, &path, false).unwrap();
        assert_eq!((second.imported, second.skipped), (0, 1));
        assert_eq!(list_configs(&target).unwrap().len(), 1);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn legacy_flat_array_files_stay_importable() {
        let path = temp_path();
        fs::write(
            &path,
            r#"[{"name":"legacy","host":"192.168.1.10","port":6379,"auth":"secret","ssl":true,"ssh_host":"bastion"}]"#,
        )
        .unwrap();

        let db = memory_db();
        let summary = import_file(&db, &path, false).unwrap();
        assert_eq!(summary.imported, 1);

        let configs = list_configs(&db).unwrap();
        assert_eq!(configs[0].name, "legacy");
        assert_eq!(configs[0].auth, "secret");
        assert!(configs[0].ssl_enabled);
        assert_eq!(configs[0].ssh_host, "bastion");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn preview_reports_conflicts_and_overwrite_updates_in_place() {
        let source = memory_db();
        save_config(
            &source,
            ConnectionConfig {
                name: "main".into(),
                host: "127.0.0.1".into(),
                auth: "from-backup".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let path = temp_path();
        export_file(&source, &path).unwrap();

        let target = memory_db();
        let existing = save_config(
            &target,
            ConnectionConfig {
                name: "main".into(),
                host: "127.0.0.1".into(),
                auth: "local".into(),
                ..Default::default()
            },
        )
        .unwrap();

        let preview = preview_import_file(&target, &path).unwrap();
        assert_eq!(preview.total, 1);
        assert_eq!(preview.conflicts.len(), 1);
        assert_eq!(preview.conflicts[0].name, "main");

        let skipped = import_file(&target, &path, false).unwrap();
        assert_eq!((skipped.imported, skipped.overwritten, skipped.skipped), (0, 0, 1));
        assert_eq!(get_config(&target, &existing.id).unwrap().auth, "local");

        let overwrite = import_file(&target, &path, true).unwrap();
        assert_eq!(
            (overwrite.imported, overwrite.overwritten, overwrite.skipped),
            (0, 1, 0)
        );
        let restored = get_config(&target, &existing.id).unwrap();
        assert_eq!(restored.auth, "from-backup");
        assert_eq!(list_configs(&target).unwrap().len(), 1);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn single_connection_export_contains_only_that_entry() {
        let source = memory_db();
        let group = save_group(&source, None, "Team").unwrap();
        save_config(
            &source,
            ConnectionConfig {
                name: "first".into(),
                host: "10.1.1.1".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let second = save_config(
            &source,
            ConnectionConfig {
                name: "second".into(),
                host: "10.1.1.2".into(),
                group_id: Some(group.id.clone()),
                ..Default::default()
            },
        )
        .unwrap();

        let path = temp_path();
        export_connection(&source, &second.id, &path).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["connections"].as_array().unwrap().len(), 1);
        assert_eq!(value["connections"][0]["name"], "second");
        assert_eq!(value["groups"].as_array().unwrap().len(), 1);
        assert_eq!(value["groups"][0]["name"], "Team");

        let target = memory_db();
        let summary = import_file(&target, &path, false).unwrap();
        assert_eq!(summary.imported, 1);
        assert_eq!(list_configs(&target).unwrap()[0].name, "second");

        let _ = fs::remove_file(&path);
    }
}
