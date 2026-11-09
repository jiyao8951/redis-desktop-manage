use std::fmt;

use serde::{Deserialize, Serialize};

/// Persisted connection settings. Field names are the camelCase form of the
/// QML properties in ConnectionSettignsDialog.qml; the serde aliases accept the
/// original snake_case keys used by RESP.app's connections.json export.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    #[serde(alias = "group_id")]
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub auth: String,
    pub username: String,

    #[serde(alias = "ssl")]
    pub ssl_enabled: bool,
    #[serde(alias = "ssl_local_cert_path")]
    pub ssl_local_cert_path: String,
    #[serde(alias = "ssl_private_key_path")]
    pub ssl_private_key_path: String,
    #[serde(alias = "ssl_ca_cert_path")]
    pub ssl_ca_cert_path: String,
    #[serde(alias = "ignore_ssl_errors")]
    pub ignore_ssl_errors: bool,

    #[serde(alias = "ssh_host")]
    pub ssh_host: String,
    #[serde(alias = "ssh_port")]
    pub ssh_port: u16,
    #[serde(alias = "ssh_user")]
    pub ssh_user: String,
    #[serde(alias = "ssh_password")]
    pub ssh_password: String,
    #[serde(alias = "ssh_private_key")]
    pub ssh_private_key: String,
    #[serde(alias = "ssh_agent")]
    pub ssh_agent: bool,
    #[serde(alias = "ssh_agent_path")]
    pub ssh_agent_path: String,
    #[serde(alias = "ask_for_ssh_password")]
    pub ask_for_ssh_password: bool,

    #[serde(alias = "keys_pattern")]
    pub keys_pattern: String,
    #[serde(alias = "namespace_separator")]
    pub namespace_separator: String,
    #[serde(alias = "execute_timeout")]
    pub execute_timeout: u32,
    #[serde(alias = "connection_timeout")]
    pub connection_timeout: u32,
    #[serde(alias = "db_scan_limit")]
    pub db_scan_limit: u32,
    #[serde(alias = "override_cluster_host")]
    pub override_cluster_host: bool,
    #[serde(alias = "default_formatter")]
    pub default_formatter: String,
    #[serde(alias = "icon_color")]
    pub icon_color: String,

    /// RESP2 is the default. RESP3 is opt-in; Redis 8 supports both.
    pub protocol: String,
}

/// Credentials must never leak through a `{:?}` log line. `Serialize` is
/// untouched so the frontend/settings contract keeps every field.
impl fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        const REDACTED: &str = "[REDACTED]";
        f.debug_struct("ConnectionConfig")
            .field("id", &self.id)
            .field("group_id", &self.group_id)
            .field("name", &self.name)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("auth", &REDACTED)
            .field("username", &self.username)
            .field("ssl_enabled", &self.ssl_enabled)
            .field("ssl_local_cert_path", &self.ssl_local_cert_path)
            .field("ssl_private_key_path", &self.ssl_private_key_path)
            .field("ssl_ca_cert_path", &self.ssl_ca_cert_path)
            .field("ignore_ssl_errors", &self.ignore_ssl_errors)
            .field("ssh_host", &self.ssh_host)
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &self.ssh_user)
            .field("ssh_password", &REDACTED)
            .field("ssh_private_key", &REDACTED)
            .field("ssh_agent", &self.ssh_agent)
            .field("ssh_agent_path", &self.ssh_agent_path)
            .field("ask_for_ssh_password", &self.ask_for_ssh_password)
            .field("keys_pattern", &self.keys_pattern)
            .field("namespace_separator", &self.namespace_separator)
            .field("execute_timeout", &self.execute_timeout)
            .field("connection_timeout", &self.connection_timeout)
            .field("db_scan_limit", &self.db_scan_limit)
            .field("override_cluster_host", &self.override_cluster_host)
            .field("default_formatter", &self.default_formatter)
            .field("icon_color", &self.icon_color)
            .field("protocol", &self.protocol)
            .finish()
    }
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            group_id: None,
            name: String::new(),
            host: "127.0.0.1".into(),
            port: 6379,
            auth: String::new(),
            username: String::new(),

            ssl_enabled: false,
            ssl_local_cert_path: String::new(),
            ssl_private_key_path: String::new(),
            ssl_ca_cert_path: String::new(),
            ignore_ssl_errors: false,

            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_private_key: String::new(),
            ssh_agent: false,
            ssh_agent_path: String::new(),
            ask_for_ssh_password: false,

            keys_pattern: "*".into(),
            namespace_separator: ":".into(),
            // Inferred defaults: the QML spin boxes start at 10 seconds.
            execute_timeout: 10_000,
            connection_timeout: 10_000,
            db_scan_limit: 20,
            override_cluster_host: false,
            default_formatter: "auto".into(),
            icon_color: String::new(),

            protocol: "resp2".into(),
        }
    }
}

impl ConnectionConfig {
    /// Serialize using the original RESP.app key names so exported files stay
    /// importable by the C++/Qt build. `protocol` is deliberately not exported
    /// because the original schema has no such field.
    pub fn to_legacy_json(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "host": self.host,
            "port": self.port,
            "auth": self.auth,
            "username": self.username,
            "ssl": self.ssl_enabled,
            "ssl_local_cert_path": self.ssl_local_cert_path,
            "ssl_private_key_path": self.ssl_private_key_path,
            "ssl_ca_cert_path": self.ssl_ca_cert_path,
            "ignore_ssl_errors": self.ignore_ssl_errors,
            "ssh_host": self.ssh_host,
            "ssh_port": self.ssh_port,
            "ssh_user": self.ssh_user,
            "ssh_password": self.ssh_password,
            "ssh_private_key": self.ssh_private_key,
            "ssh_agent": self.ssh_agent,
            "ssh_agent_path": self.ssh_agent_path,
            "ask_for_ssh_password": self.ask_for_ssh_password,
            "keys_pattern": self.keys_pattern,
            "namespace_separator": self.namespace_separator,
            "execute_timeout": self.execute_timeout,
            "connection_timeout": self.connection_timeout,
            "db_scan_limit": self.db_scan_limit,
            "override_cluster_host": self.override_cluster_host,
            "default_formatter": self.default_formatter,
            "icon_color": self.icon_color,
        })
    }

    /// The original derives the SSH tunnel switch from a non-empty sshHost.
    pub fn uses_ssh_tunnel(&self) -> bool {
        !self.ssh_host.trim().is_empty()
    }

    pub fn uses_tls(&self) -> bool {
        self.ssl_enabled
    }

    pub fn uses_resp3(&self) -> bool {
        self.protocol.eq_ignore_ascii_case("resp3")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub ssl_enabled: bool,
    pub ssh_host: String,
    pub sort_order: i64,
}

impl Default for ConnectionSummary {
    fn default() -> Self {
        Self {
            id: String::new(),
            group_id: None,
            name: String::new(),
            host: String::new(),
            port: 6379,
            ssl_enabled: false,
            ssh_host: String::new(),
            sort_order: 0,
        }
    }
}

impl From<&ConnectionConfig> for ConnectionSummary {
    fn from(config: &ConnectionConfig) -> Self {
        Self {
            id: config.id.clone(),
            group_id: config.group_id.clone(),
            name: config.name.clone(),
            host: config.host.clone(),
            port: config.port,
            ssl_enabled: config.ssl_enabled,
            ssh_host: config.ssh_host.clone(),
            sort_order: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

impl Default for ConnectionGroup {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            sort_order: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterHistoryEntry {
    pub pattern: String,
    pub use_count: i64,
    pub last_used_at: i64,
}
