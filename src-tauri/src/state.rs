use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::redis::{LiveRegistry, MonitorRegistry, RedisPool};

/// Shared application state. SQLite lives behind a std mutex and is only
/// touched through `spawn_blocking`; Redis managers are cloneable handles kept
/// in `RedisPool`.
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub pool: RedisPool,
    /// Dedicated pub/sub connections for Live Update (never pooled).
    pub live: LiveRegistry,
    /// Dedicated MONITOR connection per server (never pooled).
    pub monitor: MonitorRegistry,
    /// In-memory copy of the persisted connection configs. Value editor/tree
    /// commands read the config on every call; without this cache each of the
    /// 24 chunked reads opened another SQLite round trip. Entries are dropped
    /// when a connection is saved, deleted, duplicated or imported.
    configs: Arc<AsyncMutex<HashMap<String, ConnectionConfig>>>,
    /// Guards the shutdown path so a second CloseRequested cannot release the
    /// same connections twice.
    shutting_down: AtomicBool,
}

impl AppState {
    pub fn new(connection: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(connection)),
            pool: RedisPool::new(),
            live: LiveRegistry::default(),
            monitor: MonitorRegistry::default(),
            configs: Arc::new(AsyncMutex::new(HashMap::new())),
            shutting_down: AtomicBool::new(false),
        }
    }

    /// Returns `true` only for the first caller, so the window-close handler
    /// can run the release pass exactly once even if the event fires twice.
    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    /// Releases every connection-related resource held by this process:
    /// MONITOR streams, Live Update subscriptions, pooled Redis connections
    /// and the in-memory config cache (which keeps credentials).
    pub async fn shutdown(&self) {
        self.monitor.stop_all().await;
        self.live.stop_all().await;
        self.pool.invalidate_all().await;
        self.invalidate_all_configs().await;
    }

    /// Reads a connection config, using the cache when possible. Concurrent
    /// misses may load the row twice (SQLite is cheap for a single row); the
    /// insert keeps the first winner.
    pub async fn connection_config(&self, connection_id: &str) -> AppResult<ConnectionConfig> {
        if let Some(config) = self.configs.lock().await.get(connection_id).cloned() {
            return Ok(config);
        }

        let database = self.db.clone();
        let id = connection_id.to_string();
        let loaded = tokio::task::spawn_blocking(move || {
            let connection = database
                .lock()
                .map_err(|_| AppError::Message("database lock poisoned".to_string()))?;
            crate::db::get_config(&connection, &id)
        })
        .await??;

        let mut guard = self.configs.lock().await;
        Ok(guard
            .entry(connection_id.to_string())
            .or_insert(loaded)
            .clone())
    }

    /// Drops one cached config after it was saved or deleted.
    pub async fn invalidate_config(&self, connection_id: &str) {
        self.configs.lock().await.remove(connection_id);
    }

    /// Drops every cached config after an import replaced the connection list.
    pub async fn invalidate_all_configs(&self) {
        self.configs.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_database() -> AppState {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut connection).unwrap();
        AppState::new(connection)
    }

    async fn save(state: &AppState, config: ConnectionConfig) -> ConnectionConfig {
        let database = state.db.clone();
        tokio::task::spawn_blocking(move || {
            let connection = database.lock().unwrap();
            crate::db::save_config(&connection, config).unwrap()
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn config_cache_is_dropped_on_invalidation() {
        let state = state_with_database();

        let mut config = ConnectionConfig::default();
        config.name = "first".to_string();
        let saved = save(&state, config).await;
        let id = saved.id.clone();

        let cached = state.connection_config(&id).await.unwrap();
        assert_eq!(cached.name, "first");

        // Rewrite the row behind the cache's back: the cache must still win.
        let mut updated = saved.clone();
        updated.name = "second".to_string();
        save(&state, updated).await;
        assert_eq!(state.connection_config(&id).await.unwrap().name, "first");

        state.invalidate_config(&id).await;
        assert_eq!(state.connection_config(&id).await.unwrap().name, "second");

        state.invalidate_all_configs().await;
        assert_eq!(state.connection_config(&id).await.unwrap().name, "second");
    }

    #[tokio::test]
    async fn unknown_connection_is_an_error_not_a_cache_entry() {
        let state = state_with_database();
        assert!(state.connection_config("missing").await.is_err());
    }

    #[tokio::test]
    async fn shutdown_runs_once() {
        let state = state_with_database();
        assert!(state.begin_shutdown());
        // A second CloseRequested must not release the same handles again.
        assert!(!state.begin_shutdown());

        state.shutdown().await;
        // The cache is cleared, so the next read repopulates from SQLite.
        assert!(state.connection_config("missing").await.is_err());
    }
}
