use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::{Client, ErrorKind};
use tokio::sync::{Mutex, OnceCell};

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;

/// The original open-source build refuses SSH tunnels
/// (Connection::SSHSupportException). Keep the same behaviour and message.
pub const SSH_UNSUPPORTED_MESSAGE: &str = "The open source build of RESP.app does not support SSH tunneling. \
     Remove the SSH host from the connection settings to connect directly.";

/// Connection-manager retry policy. The redis-rs default (6 retries with a
/// 100ms * 2^n backoff) can hide an auth/network failure for seconds; asking
/// "Test Connection" then freezes the dialog. Two retries capped at one second
/// keep transient reconnects working while failing fast.
const MANAGER_RETRIES: usize = 2;
const MANAGER_RETRY_FACTOR: u64 = 100;
const MANAGER_RETRY_EXPONENT: u64 = 2;
const MANAGER_RETRY_MAX_DELAY_MS: u64 = 1_000;

/// One multiplexed, auto-reconnecting Redis connection per (connection id, db).
/// Redis-rs' ConnectionManager can be cloned cheaply and is safe to use from
/// many concurrent tasks, so no extra locking is needed while querying.
#[derive(Clone, Default)]
pub struct RedisPool {
    inner: Arc<Mutex<PoolInner>>,
}

#[derive(Default)]
struct PoolInner {
    managers: HashMap<String, ConnectionManager>,
    /// In-flight connection attempts, shared so concurrent cache misses only
    /// open one socket instead of one per caller.
    pending: HashMap<String, Arc<OnceCell<ConnectionManager>>>,
}

impl RedisPool {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns a cached manager, creating it on first use. The db index is part
    /// of the connection URL, so no SELECT command (and no cross-task db race)
    /// is involved. Concurrent misses share one connect future.
    pub async fn get(
        &self,
        connection_id: &str,
        db: u32,
        config: &ConnectionConfig,
    ) -> AppResult<ConnectionManager> {
        let key = pool_key(connection_id, db);

        let pending = {
            let mut guard = self.inner.lock().await;
            if let Some(manager) = guard.managers.get(&key) {
                return Ok(manager.clone());
            }
            guard
                .pending
                .entry(key.clone())
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };

        let connected = pending
            .get_or_try_init(|| async { connect(config, db).await.map(|(manager, _)| manager) })
            .await;

        let manager = match connected {
            Ok(manager) => manager.clone(),
            Err(error) => {
                // Leave the cell uninitialised so the next caller can retry
                // after the server/config is fixed.
                self.inner.lock().await.pending.remove(&key);
                return Err(error);
            }
        };

        let mut guard = self.inner.lock().await;
        guard.pending.remove(&key);
        Ok(guard.managers.entry(key).or_insert(manager).clone())
    }

    /// Drops cached connections after a config edit/delete so the next access
    /// reconnects with the new host/password/protocol.
    pub async fn invalidate(&self, connection_id: &str) {
        let prefix = format!("{connection_id}:");
        let mut guard = self.inner.lock().await;
        guard.managers.retain(|key, _| !key.starts_with(&prefix));
        guard.pending.retain(|key, _| !key.starts_with(&prefix));
    }

    pub async fn invalidate_all(&self) {
        let mut guard = self.inner.lock().await;
        guard.managers.clear();
        guard.pending.clear();
    }
}

fn pool_key(connection_id: &str, db: u32) -> String {
    format!("{connection_id}:{db}")
}

/// Connects a fresh manager without touching the pool (used by "Test
/// Connection" for unsaved settings). Returns whether RESP3 was effectively
/// negotiated. A RESP3 request only falls back to RESP2 when the server itself
/// rejects the HELLO handshake; auth/network errors are returned as-is so a
/// typo in the password is not masked by a second connection attempt.
pub async fn connect(config: &ConnectionConfig, db: u32) -> AppResult<(ConnectionManager, bool)> {
    if config.uses_ssh_tunnel() {
        return Err(AppError::Unsupported(SSH_UNSUPPORTED_MESSAGE.into()));
    }

    if config.uses_resp3() {
        match connect_once(config, db, true).await {
            Ok(manager) => return Ok((manager, true)),
            Err(error) if matches!(error.kind(), ErrorKind::RESP3NotSupported) => {
                // Redis < 6.0 (or a proxy without HELLO): retry in RESP2.
            }
            Err(error) => return Err(error.into()),
        }
    }
    let manager = connect_once(config, db, false).await?;
    Ok((manager, false))
}

async fn connect_once(
    config: &ConnectionConfig,
    db: u32,
    resp3: bool,
) -> redis::RedisResult<ConnectionManager> {
    let url = build_url(config, db, resp3);
    let client = Client::open(url.as_str())?;
    let manager = tokio::time::timeout(
        connection_timeout(config),
        client.get_connection_manager_with_config(manager_config(config)),
    )
    .await
    .map_err(|_| -> redis::RedisError {
        (ErrorKind::IoError, "connection attempt timed out").into()
    })??;
    Ok(manager)
}

/// Builds the manager policy from the per-connection timeouts: the manager
/// response timeout matches `executeTimeout` (so a stalled command is bounded
/// even without the outer `query_with_timeout` wrapper) and connection attempts
/// use `connection_timeout`.
pub fn manager_config(config: &ConnectionConfig) -> ConnectionManagerConfig {
    ConnectionManagerConfig::new()
        .set_connection_timeout(connection_timeout(config))
        .set_response_timeout(execute_timeout(config))
        .set_number_of_retries(MANAGER_RETRIES)
        .set_factor(MANAGER_RETRY_FACTOR)
        .set_exponent_base(MANAGER_RETRY_EXPONENT)
        .set_max_delay(MANAGER_RETRY_MAX_DELAY_MS)
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
        let host = if trimmed.is_empty() {
            "127.0.0.1"
        } else {
            trimmed
        };
        // IPv6 literals must be bracketed inside a URL authority. A bare
        // `::1:6379` would otherwise be parsed as host `::1` + port 6379 only
        // by accident, and longer addresses fail outright.
        if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> ConnectionConfig {
        ConnectionConfig::default()
    }

    #[test]
    fn ipv6_literal_is_bracketed_once() {
        let mut config = default_config();
        config.host = "::1".into();
        let url = build_url(&config, 0, false);
        assert!(url.contains("redis://[::1]:6379/0"), "{url}");

        config.host = "[2001:db8::2]".into();
        let url = build_url(&config, 0, false);
        assert!(url.contains("redis://[2001:db8::2]:6379/0"), "{url}");
    }

    #[test]
    fn manager_config_aligns_with_execute_timeout() {
        let mut config = default_config();
        config.execute_timeout = 5_000;
        config.connection_timeout = 2_000;
        // ConnectionManagerConfig keeps its fields private; its Debug impl
        // prints every timeout we care about.
        let rendered = format!("{:?}", manager_config(&config));
        assert!(
            rendered.contains(&format!("response_timeout: Some({:?})", execute_timeout(&config))),
            "{rendered}"
        );
        assert!(
            rendered.contains(&format!(
                "connection_timeout: Some({:?})",
                connection_timeout(&config)
            )),
            "{rendered}"
        );
        assert!(rendered.contains("number_of_retries: 2"), "{rendered}");
    }
}
