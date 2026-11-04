use std::sync::{Arc, Mutex};

use rusqlite::Connection;

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
}

impl AppState {
    pub fn new(connection: Connection) -> Self {
        Self {
            db: Arc::new(Mutex::new(connection)),
            pool: RedisPool::new(),
            live: LiveRegistry::default(),
            monitor: MonitorRegistry::default(),
        }
    }
}
