use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::error::AppResult;
use crate::models::connection::ConnectionConfig;
use crate::redis::manager::{build_url, connection_timeout};

/// Keyspace notifications are buffered for this window and emitted as one
/// `live-update` event per (connection, db). A bulk write of 1000 keys would
/// otherwise cross the IPC boundary 1000 times; 60ms keeps the tree feeling
/// live (the frontend reload debounce is measured in seconds).
pub const LIVE_FLUSH_INTERVAL: Duration = Duration::from_millis(60);

/// Delay before re-subscribing after the pub/sub stream ends.
const LIVE_RECONNECT_DELAY: Duration = Duration::from_millis(500);
const LIVE_RECONNECT_MAX_DELAY: Duration = Duration::from_secs(5);

/// Payload emitted on the `live-update` Tauri event. `key`/`event` keep the
/// first notification of the window for backwards compatibility, while `keys`
/// lists every key affected by the coalesced batch; the tree only needs the
/// connection/db pair to schedule its debounced reload.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveUpdateEvent {
    pub connection_id: String,
    pub db: u32,
    pub key: String,
    pub event: String,
    pub keys: Vec<String>,
    pub count: usize,
}

/// Emitted when the subscription stream stops. The task immediately tries to
/// re-subscribe, but the UI must not keep showing "live" without a socket.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEnded {
    pub connection_id: String,
    pub db: u32,
    pub reason: Option<String>,
}

/// Small accumulator used by the pub/sub task; kept separate so the coalescing
/// behaviour is unit-testable without a Redis server.
#[derive(Default)]
struct LiveBatcher {
    first_key: String,
    first_event: String,
    keys: Vec<String>,
}

impl LiveBatcher {
    fn push(&mut self, key: String, event: String) {
        if self.keys.is_empty() {
            self.first_key = key.clone();
            self.first_event = event;
        }
        self.keys.push(key);
    }

    fn take_payload(&mut self, connection_id: &str, db: u32) -> Option<LiveUpdateEvent> {
        if self.keys.is_empty() {
            return None;
        }
        let keys = std::mem::take(&mut self.keys);
        let payload = LiveUpdateEvent {
            connection_id: connection_id.to_string(),
            db,
            key: std::mem::take(&mut self.first_key),
            event: std::mem::take(&mut self.first_event),
            count: keys.len(),
            keys,
        };
        Some(payload)
    }
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

    /// Aborts every subscription task during application shutdown. Each task
    /// owns its `PubSub` connection, so aborting drops the socket and the
    /// server-side subscription.
    pub async fn stop_all(&self) {
        let handles: Vec<JoinHandle<()>> =
            self.inner.lock().await.drain().map(|(_, handle)| handle).collect();
        for handle in handles {
            handle.abort();
        }
    }
}

async fn subscribe(config: &ConnectionConfig, db: u32) -> AppResult<redis::aio::PubSub> {
    let pattern = format!("__keyspace@{db}__:*");
    let url = build_url(config, db, false);
    let client = redis::Client::open(url.as_str())?;
    let mut pubsub = tokio::time::timeout(connection_timeout(config), client.get_async_pubsub())
        .await??;
    pubsub.psubscribe(&pattern).await?;
    Ok(pubsub)
}

/// Starts (or restarts) live update for one database. The pattern follows the
/// Redis keyspace notification channel layout, e.g. `__keyspace@0__:*`.
///
/// The initial connection is opened eagerly so a bad host/password rejects the
/// command. Once running, the task coalesces notifications and re-subscribes
/// with a capped exponential backoff if the stream ends.
pub async fn start_live_update(
    app: AppHandle,
    registry: &LiveRegistry,
    config: &ConnectionConfig,
    connection_id: &str,
    db: u32,
) -> AppResult<()> {
    let initial = subscribe(config, db).await?;

    let config = config.clone();
    let connection_id = connection_id.to_string();
    let emit_connection = connection_id.clone();
    let ended_connection = connection_id.clone();

    let handle = tokio::spawn(async move {
        let mut next = Some(initial);
        let mut reconnect_delay = LIVE_RECONNECT_DELAY;

        loop {
            let mut pubsub = match next.take() {
                Some(pubsub) => pubsub,
                None => match subscribe(&config, db).await {
                    Ok(pubsub) => {
                        reconnect_delay = LIVE_RECONNECT_DELAY;
                        pubsub
                    }
                    Err(error) => {
                        let _ = app.emit(
                            "live-ended",
                            LiveEnded {
                                connection_id: ended_connection.clone(),
                                db,
                                reason: Some(error.to_string()),
                            },
                        );
                        tokio::time::sleep(reconnect_delay).await;
                        reconnect_delay = (reconnect_delay * 2).min(LIVE_RECONNECT_MAX_DELAY);
                        continue;
                    }
                },
            };

            let mut stream = pubsub.on_message();
            let mut batcher = LiveBatcher::default();
            let mut ticker = tokio::time::interval(LIVE_FLUSH_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            let end_reason: Option<String> = loop {
                tokio::select! {
                    message = stream.next() => {
                        match message {
                            Some(message) => {
                                let channel: String = match message.get_channel() {
                                    Ok(channel) => channel,
                                    Err(_) => continue,
                                };
                                let event: String = message.get_payload().unwrap_or_default();
                                let key = channel
                                    .split_once(':')
                                    .map(|(_, key)| key.to_string())
                                    .unwrap_or_else(|| channel.clone());
                                batcher.push(key, event);
                            }
                            None => {
                                break Some("subscription stream ended".to_string());
                            }
                        }
                    }
                    _ = ticker.tick() => {
                        if let Some(payload) = batcher.take_payload(&emit_connection, db) {
                            if app.emit("live-update", payload).is_err() {
                                // The window is gone; stop retrying.
                                return;
                            }
                        }
                    }
                }
            };

            if let Some(payload) = batcher.take_payload(&emit_connection, db) {
                let _ = app.emit("live-update", payload);
            }
            let _ = app.emit(
                "live-ended",
                LiveEnded {
                    connection_id: ended_connection.clone(),
                    db,
                    reason: end_reason,
                },
            );

            // Re-subscribe after a short pause; a server restart usually
            // recovers within one or two attempts.
            tokio::time::sleep(LIVE_RECONNECT_DELAY).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batcher_groups_keys_and_keeps_the_first_notification() {
        let mut batcher = LiveBatcher::default();
        assert!(batcher.take_payload("conn", 0).is_none());

        batcher.push("a".into(), "set".into());
        batcher.push("b".into(), "del".into());
        batcher.push("a".into(), "expire".into());

        let payload = batcher.take_payload("conn", 3).expect("payload");
        assert_eq!(payload.connection_id, "conn");
        assert_eq!(payload.db, 3);
        assert_eq!(payload.key, "a");
        assert_eq!(payload.event, "set");
        assert_eq!(payload.count, 3);
        assert_eq!(payload.keys, vec!["a", "b", "a"]);

        // The buffer is drained, so the next window starts fresh.
        assert!(batcher.take_payload("conn", 3).is_none());
        batcher.push("c".into(), "set".into());
        let payload = batcher.take_payload("conn", 3).expect("payload");
        assert_eq!(payload.key, "c");
        assert_eq!(payload.count, 1);
    }

    #[test]
    fn coalescing_window_is_50_to_100_ms() {
        let millis = LIVE_FLUSH_INTERVAL.as_millis();
        assert!((50..=100).contains(&millis), "{millis}ms");
    }
}
