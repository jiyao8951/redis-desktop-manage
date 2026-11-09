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

/// MONITOR output is buffered for this window and sent as one `monitor-line`
/// event. The payload keeps its string shape (lines joined with `\n`, rendered
/// by the existing `whitespace-pre-wrap` pane), so a busy server no longer
/// triggers one IPC call per executed command.
pub const MONITOR_FLUSH_INTERVAL: Duration = Duration::from_millis(60);

/// Flush early when the buffer grows past this many lines.
const MONITOR_BATCH_MAX_LINES: usize = 200;

/// One MONITOR output payload. `line` may contain several Redis lines
/// separated by `\n` when the batch window caught more than one command; the
/// line already contains Redis' own timestamp and database/address prefix.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorLine {
    pub connection_id: String,
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorEnded {
    pub connection_id: String,
    pub reason: Option<String>,
}

/// Tracks the dedicated MONITOR connection per connection id.
///
/// MONITOR switches the connection into a streaming mode, so it can never
/// borrow a manager from `RedisPool`: the pool is multiplexed and shared by the
/// tree, console and value tabs. Stopping aborts the task, which drops the
/// socket and releases the connection on the server.
#[derive(Clone, Default)]
pub struct MonitorRegistry {
    inner: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
}

impl MonitorRegistry {
    pub async fn stop(&self, connection_id: &str) {
        if let Some(handle) = self.inner.lock().await.remove(connection_id) {
            handle.abort();
        }
    }

    /// Aborts every MONITOR task during application shutdown. The task owns the
    /// dedicated streaming connection, so aborting closes that socket.
    pub async fn stop_all(&self) {
        let handles: Vec<JoinHandle<()>> =
            self.inner.lock().await.drain().map(|(_, handle)| handle).collect();
        for handle in handles {
            handle.abort();
        }
    }
}

fn join_batch(lines: &[String]) -> String {
    lines.join("\n")
}

/// Starts MONITOR on a dedicated connection. Replacing an existing monitor for
/// the same connection stops the previous one first.
///
/// `get_async_monitor` opens a non-multiplexed connection, performs the RESP
/// handshake and issues `MONITOR` before returning, so the stream is already
/// in command-feed mode. MONITOR needs a connection that is not shared with
/// request/response traffic, which is why this never borrows from `RedisPool`.
pub async fn start_monitor(
    app: AppHandle,
    registry: &MonitorRegistry,
    config: &ConnectionConfig,
    connection_id: &str,
) -> AppResult<()> {
    let url = build_url(config, 0, false);
    let client = redis::Client::open(url.as_str())?;
    let monitor = tokio::time::timeout(connection_timeout(config), client.get_async_monitor())
        .await??;

    let event_connection = connection_id.to_string();
    let ended_connection = event_connection.clone();
    let handle = tokio::spawn(async move {
        let mut stream = monitor.into_on_message::<String>();
        let mut pending: Vec<String> = Vec::new();
        let mut ticker = tokio::time::interval(MONITOR_FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                message = stream.next() => {
                    match message {
                        Some(line) => {
                            pending.push(line);
                            if pending.len() >= MONITOR_BATCH_MAX_LINES
                                && !flush(&app, &event_connection, &mut pending)
                            {
                                return;
                            }
                        }
                        None => break,
                    }
                }
                _ = ticker.tick() => {
                    if !flush(&app, &event_connection, &mut pending) {
                        return;
                    }
                }
            }
        }

        // The stream ended because the socket closed, the server revoked the
        // command or the task was aborted; the UI decides what to show.
        flush(&app, &event_connection, &mut pending);
        let _ = app.emit(
            "monitor-ended",
            MonitorEnded {
                connection_id: ended_connection,
                reason: None,
            },
        );
    });

    registry.stop(connection_id).await;
    registry
        .inner
        .lock()
        .await
        .insert(connection_id.to_string(), handle);
    Ok(())
}

fn flush(app: &AppHandle, connection_id: &str, pending: &mut Vec<String>) -> bool {
    if pending.is_empty() {
        return true;
    }
    let line = join_batch(pending);
    pending.clear();
    app.emit(
        "monitor-line",
        MonitorLine {
            connection_id: connection_id.to_string(),
            line,
        },
    )
    .is_ok()
}

pub async fn stop_monitor(registry: &MonitorRegistry, connection_id: &str) {
    registry.stop(connection_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffered_lines_are_joined_with_newlines() {
        let lines = vec![
            "1 \"PING\"".to_string(),
            "2 \"GET\" \"a\"".to_string(),
            "3 \"SET\" \"b\" \"1\"".to_string(),
        ];
        assert_eq!(join_batch(&lines), "1 \"PING\"\n2 \"GET\" \"a\"\n3 \"SET\" \"b\" \"1\"");
    }

    #[test]
    fn flush_window_and_threshold_are_bounded() {
        let millis = MONITOR_FLUSH_INTERVAL.as_millis();
        assert!((50..=100).contains(&millis), "{millis}ms");
        assert!(MONITOR_BATCH_MAX_LINES > 0);
    }
}
