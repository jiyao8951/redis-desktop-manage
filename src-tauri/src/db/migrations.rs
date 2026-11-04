use rusqlite::Connection;

use crate::error::AppResult;

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS connection_groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
    id                      TEXT PRIMARY KEY,
    group_id                TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
    name                    TEXT NOT NULL,
    host                    TEXT NOT NULL,
    port                    INTEGER NOT NULL,
    auth                    TEXT NOT NULL DEFAULT '',
    username                TEXT NOT NULL DEFAULT '',

    ssl_enabled             INTEGER NOT NULL DEFAULT 0,
    ssl_local_cert_path     TEXT NOT NULL DEFAULT '',
    ssl_private_key_path    TEXT NOT NULL DEFAULT '',
    ssl_ca_cert_path        TEXT NOT NULL DEFAULT '',
    ignore_ssl_errors       INTEGER NOT NULL DEFAULT 0,

    ssh_host                TEXT NOT NULL DEFAULT '',
    ssh_port                INTEGER NOT NULL DEFAULT 22,
    ssh_user                TEXT NOT NULL DEFAULT '',
    ssh_password            TEXT NOT NULL DEFAULT '',
    ssh_private_key         TEXT NOT NULL DEFAULT '',
    ssh_agent               INTEGER NOT NULL DEFAULT 0,
    ssh_agent_path          TEXT NOT NULL DEFAULT '',
    ask_for_ssh_password    INTEGER NOT NULL DEFAULT 0,

    keys_pattern            TEXT NOT NULL DEFAULT '*',
    namespace_separator     TEXT NOT NULL DEFAULT ':',
    execute_timeout         INTEGER NOT NULL DEFAULT 10000,
    connection_timeout      INTEGER NOT NULL DEFAULT 10000,
    db_scan_limit           INTEGER NOT NULL DEFAULT 20,
    override_cluster_host   INTEGER NOT NULL DEFAULT 0,
    default_formatter       TEXT NOT NULL DEFAULT 'auto',
    icon_color              TEXT NOT NULL DEFAULT '',
    protocol                TEXT NOT NULL DEFAULT 'resp2',

    sort_order              INTEGER NOT NULL DEFAULT 0,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS filter_history (
    connection_id   TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    pattern         TEXT NOT NULL,
    use_count       INTEGER NOT NULL DEFAULT 1,
    last_used_at    INTEGER NOT NULL,
    PRIMARY KEY (connection_id, pattern)
);

CREATE TABLE IF NOT EXISTS app_settings (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connections_group ON connections(group_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_filter_history_recent
    ON filter_history(connection_id, last_used_at DESC);
"#;

pub fn migrate(conn: &mut Connection) -> AppResult<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(MIGRATION_V1)?;
        conn.execute_batch("PRAGMA user_version = 1;")?;
    }
    Ok(())
}
