use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use redis::aio::ConnectionManager;
use redis::Client;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;

/// The original open-source build refuses SSH tunnels
/// (Connection::SSHSupportException). Keep the same behaviour and message.
pub const SSH_UNSUPPORTED_MESSAGE: &str = "The open source build of RESP.app does not support SSH tunneling. \
     Remove the SSH host from the connection settings to connect directly.";

/// One multiplexed, auto-reconnecting Redis connection per (connection id, db).
/// Redis-rs' ConnectionManager can be cloned cheaply and is safe to use from
/// many concurrent tasks, so no extra locking is needed while querying.
#[derive(Clone, Default)]
pub struct RedisPool {
    inner: Arc<Mutex<HashMap<String, ConnectionManager>>>,
}

impl RedisPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a cached manager, creating it on first use. The db index is part
    /// of the connection URL, so no SELECT command (and no cross-task db race)
    /// is involved.
    pub async fn get(
        &self,
        connection_id: &str,
        db: u32,
        config: &ConnectionConfig,
    ) -> AppResult<ConnectionManager> {
        let key = pool_key(connection_id, db);
        {
            let guard = self.inner.lock().await;
            if let Some(manager) = guard.get(&key) {
                return Ok(manager.clone());
            }
        }

        let (manager, _used_resp3) = connect(config, db).await?;

        let mut guard = self.inner.lock().await;
        // Another task may have created the same connection while we were
        // waiting; reuse it instead of keeping two managers alive.
        let entry = guard.entry(key).or_insert(manager);
        Ok(entry.clone())
    }

    /// Drops cached connections after a config edit/delete so the next access
    /// reconnects with the new host/password/protocol.
    pub async fn invalidate(&self, connection_id: &str) {
        let prefix = format!("{connection_id}:");
        let mut guard = self.inner.lock().await;
        guard.retain(|key, _| !key.starts_with(&prefix));
    }

    pub async fn invalidate_all(&self) {
        self.inner.lock().await.clear();
    }
}

fn pool_key(connection_id: &str, db: u32) -> String {
    format!("{connection_id}:{db}")
}

/// Connects a fresh manager without touching the pool (used by "Test
/// Connection" for unsaved settings). Returns whether RESP3 was effectively
/// negotiated; a RESP3 request silently falls back to RESP2 when the server or
/// the client rejects it.
pub async fn connect(config: &ConnectionConfig, db: u32) -> AppResult<(ConnectionManager, bool)> {
    if config.uses_ssh_tunnel() {
        return Err(AppError::Unsupported(SSH_UNSUPPORTED_MESSAGE.into()));
    }

    if config.uses_resp3() {
        if let Ok(manager) = connect_once(config, db, true).await {
            return Ok((manager, true));
        }
    }
    let manager = connect_once(config, db, false).await?;
    Ok((manager, false))
}

async fn connect_once(
    config: &ConnectionConfig,
    db: u32,
    resp3: bool,
) -> AppResult<ConnectionManager> {
    let url = build_url(config, db, resp3);
    let client = Client::open(url.as_str())?;
    let manager = tokio::time::timeout(connection_timeout(config), client.get_connection_manager())
        .await??;
    Ok(manager)
}

pub fn build_url(config: &ConnectionConfig, db: u32, resp3: bool) -> String {
    let scheme = if config.uses_tls() { "rediss" } else { "redis" };

    let mut userinfo = String::new();
    if !config.username.is_empty() || !config.auth.is_empty() {
        if !config.username.is_empty() {
            userinfo.push_str(&encode_component(&config.username));
        }
        if !config.auth.is_empty() {
            userinfo.push(':');
            userinfo.push_str(&encode_component(&config.auth));
        }
        userinfo.push('@');
    }

    let host = {
        let trimmed = config.host.trim();
        if trimmed.is_empty() {
            "127.0.0.1"
        } else {
            trimmed
        }
    };

    let mut url = format!("{scheme}://{userinfo}{host}:{}/{}", config.port, db);
    if resp3 {
        url.push_str("?protocol=resp3");
    }
    if config.uses_tls() && config.ignore_ssl_errors {
        // redis-rs accepts the `#insecure` fragment to skip certificate checks.
        url.push_str("#insecure");
    }
    url
}

fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn connection_timeout(config: &ConnectionConfig) -> Duration {
    Duration::from_millis(config.connection_timeout.clamp(500, 600_000) as u64)
}

/// `executeTimeout` in the original settings; applied to every command so one
/// stalled call cannot freeze a tree operation.
pub fn execute_timeout(config: &ConnectionConfig) -> Duration {
    Duration::from_millis(config.execute_timeout.clamp(500, 600_000) as u64)
}

pub async fn query_with_timeout<T, F>(duration: Duration, future: F) -> AppResult<T>
where
    F: Future<Output = redis::RedisResult<T>>,
{
    match tokio::time::timeout(duration, future).await {
        Ok(result) => Ok(result?),
        Err(_) => Err(AppError::Timeout),
    }
}
