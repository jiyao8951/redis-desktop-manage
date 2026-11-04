use std::collections::HashMap;
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::error::AppResult;
use crate::models::connection::ConnectionConfig;
use crate::redis::manager::{build_url, connection_timeout};

/// Payload emitted on the `live-update` Tauri event. The frontend debounces
/// reloads itself, so one event per keyspace notification is enough.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUpdateEvent {
    pub connection_id: String,
    pub db: u32,
    pub key: String,
    pub event: String,
}

/// Tracks one dedicated PSUBSCRIBE connection per (connection id, db). The
/// subscription deliberately does not use RedisPool: a pub/sub connection
/// cannot run normal commands and must never be recycled for reads.
#[derive(Clone, Default)]
pub struct LiveRegistry {
    inner: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

fn live_key(connection_id: &str, db: u32) -> String {
    format!("{connection_id}:{db}")
}

impl LiveRegistry {
    async fn replace(&self, key: String, handle: JoinHandle<()>) {
        if let Some(previous) = self.inner.lock().await.insert(key, handle) {
            previous.abort();
        }
    }

    pub async fn stop(&self, connection_id: &str, db: u32) {
        if let Some(handle) = self.inner.lock().await.remove(&live_key(connection_id, db)) {
            handle.abort();
        }
    }

    pub async fn stop_connection(&self, connection_id: &str) {
        let prefix = format!("{connection_id}:");
        let mut guard = self.inner.lock().await;
        let keys: Vec<String> = guard
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        for key in keys {
            if let Some(handle) = guard.remove(&key) {
                handle.abort();
            }
        }
    }
}

/// Starts (or restarts) live update for one database. The pattern follows the
/// Redis keyspace notification channel layout, e.g. `__keyspace@0__:*`.
pub async fn start_live_update(
    app: AppHandle,
    registry: &LiveRegistry,
    config: &ConnectionConfig,
    connection_id: &str,
    db: u32,
) -> AppResult<()> {
    let pattern = format!("__keyspace@{db}__:*");
    let url = build_url(config, db, false);
    let client = redis::Client::open(url.as_str())?;
    let mut pubsub = tokio::time::timeout(connection_timeout(config), client.get_async_pubsub())
        .await??;
    pubsub.psubscribe(&pattern).await?;

    let connection_id = connection_id.to_string();
    let event_connection = connection_id.clone();
    let handle = tokio::spawn(async move {
        let mut stream = pubsub.on_message();
        while let Some(message) = stream.next().await {
            let channel: String = match message.get_channel() {
                Ok(channel) => channel,
                Err(_) => continue,
            };
            let event: String = message.get_payload().unwrap_or_default();
            let key = channel
                .split_once(':')
                .map(|(_, key)| key.to_string())
                .unwrap_or_else(|| channel.clone());

            let _ = app.emit(
                "live-update",
                LiveUpdateEvent {
                    connection_id: event_connection.clone(),
                    db,
                    key,
                    event,
                },
            );
        }
    });

    registry
        .replace(live_key(&connection_id, db), handle)
        .await;
    Ok(())
}

/// Commands sharing the registry; kept here so the Tauri layer stays thin.
pub async fn stop_live_update(registry: &LiveRegistry, connection_id: &str, db: u32) {
    registry.stop(connection_id, db).await;
}
