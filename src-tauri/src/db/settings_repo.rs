use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::AppResult;
use crate::models::settings::Settings;

const SETTINGS_KEY: &str = "app_settings";
const VERSION_KEY: &str = "settings_schema_version";

/// Bumped whenever a persisted default changes. The migration below is keyed
/// by this value, so it runs at most once per database and is idempotent.
pub const SETTINGS_SCHEMA_VERSION: u64 = 3;

pub fn load(conn: &Connection) -> AppResult<Settings> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        Some(json) => Ok(serde_json::from_str::<Settings>(&json)
            .unwrap_or_default()
            .sanitized()),
        None => Ok(Settings::default()),
    }
}

pub fn save(conn: &Connection, settings: &Settings) -> AppResult<Settings> {
    let settings = settings.clone().sanitized();
    let json = serde_json::to_string(&settings)?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SETTINGS_KEY, json],
    )?;
    Ok(settings)
}

fn stored_version(conn: &Connection) -> AppResult<u64> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![VERSION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|value| value.parse::<u64>().ok()).unwrap_or(1))
}

/// Applies the stage-five default corrections to a persisted settings object.
/// Only exact historical defaults are rewritten, so a value the user chose
/// explicitly (for example 5000) is never overwritten. Returns whether the
/// object changed.
pub fn apply_settings_migration(value: &mut Value, from_version: u64) -> bool {
    let mut changed = false;

    if from_version < 2 {
        // GlobalSettings.qml default was 1000; an earlier build persisted
        // 10,000, so old profiles would silently keep the wrong limit.
        if value.get("liveUpdateKeysLimit").and_then(Value::as_u64) == Some(10_000) {
            value["liveUpdateKeysLimit"] = Value::from(1_000u64);
            changed = true;
        }
    }

    if from_version < 3 {
        // Raised the SCAN page size default from 100 to 500 (fewer IPC rounds
        // for large keyspaces). Only the exact historical default is rewritten,
        // so an explicit user choice is preserved.
        if value.get("scanPageSize").and_then(Value::as_u64) == Some(100) {
            value["scanPageSize"] = Value::from(500u64);
            changed = true;
        }
    }

    changed
}

/// One-time settings migration executed at startup. Writes the settings row
/// and the schema version in a single transaction; on any error the
/// transaction rolls back and the caller may continue starting the app.
pub fn migrate(conn: &mut Connection) -> AppResult<bool> {
    let version = stored_version(conn)?;
    if version >= SETTINGS_SCHEMA_VERSION {
        return Ok(false);
    }

    let tx = conn.transaction()?;
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;

    let mut changed = false;
    if let Some(json) = raw {
        let mut value: Value = serde_json::from_str(&json)?;
        changed = apply_settings_migration(&mut value, version);
        if changed {
            let migrated = serde_json::to_string(&value)?;
            tx.execute(
                "UPDATE app_settings SET value = ?2 WHERE key = ?1",
                params![SETTINGS_KEY, migrated],
            )?;
        }
    }

    tx.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![VERSION_KEY, SETTINGS_SCHEMA_VERSION.to_string()],
    )?;
    tx.commit()?;

    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        conn
    }

    fn insert_settings(conn: &Connection, json: &str) {
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
            params![SETTINGS_KEY, json],
        )
        .unwrap();
    }

    fn read_settings(conn: &Connection) -> String {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn old_default_limit_is_migrated_once() {
        let mut conn = memory_db();
        insert_settings(&conn, r#"{"liveUpdateKeysLimit":10000}"#);

        assert!(migrate(&mut conn).unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&read_settings(&conn)).unwrap()
                ["liveUpdateKeysLimit"],
            1_000
        );
        assert_eq!(stored_version(&conn).unwrap(), SETTINGS_SCHEMA_VERSION);

        // Second startup: version is already current, nothing changes.
        assert!(!migrate(&mut conn).unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&read_settings(&conn)).unwrap()
                ["liveUpdateKeysLimit"],
            1_000
        );
    }

    #[test]
    fn old_default_scan_page_size_is_migrated_once() {
        let mut conn = memory_db();
        insert_settings(&conn, r#"{"scanPageSize":100}"#);

        assert!(migrate(&mut conn).unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&read_settings(&conn)).unwrap()["scanPageSize"],
            500
        );
        // Second startup is a no-op.
        assert!(!migrate(&mut conn).unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&read_settings(&conn)).unwrap()["scanPageSize"],
            500
        );
    }

    #[test]
    fn explicit_scan_page_size_is_preserved() {
        let mut conn = memory_db();
        insert_settings(&conn, r#"{"scanPageSize":1000}"#);

        assert!(!migrate(&mut conn).unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&read_settings(&conn)).unwrap()["scanPageSize"],
            1_000
        );
    }

    #[test]
    fn user_selected_limit_is_preserved() {
        let mut conn = memory_db();
        insert_settings(&conn, r#"{"liveUpdateKeysLimit":5000}"#);

        assert!(!migrate(&mut conn).unwrap());
        assert_eq!(
            serde_json::from_str::<Value>(&read_settings(&conn)).unwrap()
                ["liveUpdateKeysLimit"],
            5_000
        );
        assert_eq!(stored_version(&conn).unwrap(), SETTINGS_SCHEMA_VERSION);
    }

    #[test]
    fn missing_settings_row_only_records_the_version() {
        let mut conn = memory_db();
        assert!(!migrate(&mut conn).unwrap());
        assert_eq!(stored_version(&conn).unwrap(), SETTINGS_SCHEMA_VERSION);
    }

    #[test]
    fn unparsable_settings_returns_an_error_without_bumping_the_version() {
        let mut conn = memory_db();
        insert_settings(&conn, "not json");
        assert!(migrate(&mut conn).is_err());
        assert_eq!(stored_version(&conn).unwrap(), 1);
    }
}
