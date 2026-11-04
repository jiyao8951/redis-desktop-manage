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

/// One MONITOR output line. The line already contains Redis' own timestamp and
/// database/address prefix, so it is emitted verbatim.
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
}

/// Starts MONITOR on a dedicated connection. Replacing an existing monitor for
/// the same connection stops the previous one first.
///
/// `aio::Connection` is deprecated, but `MultiplexedConnection` cannot be
/// converted into a monitor stream: MONITOR needs a connection that is not
/// shared with request/response traffic.
#[allow(deprecated)]
pub async fn start_monitor(
    app: AppHandle,
    registry: &MonitorRegistry,
    config: &ConnectionConfig,
    connection_id: &str,
) -> AppResult<()> {
    let url = build_url(config, 0, false);
    let client = redis::Client::open(url.as_str())?;
    let connection = tokio::time::timeout(connection_timeout(config), client.get_async_connection())
        .await??;

    let mut monitor = connection.into_monitor();
    // `MONITOR` answers +OK and then streams every command the server executes.
    monitor.monitor().await?;

    let event_connection = connection_id.to_string();
    let ended_connection = event_connection.clone();
    let handle = tokio::spawn(async move {
        let mut stream = monitor.into_on_message::<String>();
        while let Some(line) = stream.next().await {
            if app
                .emit(
                    "monitor-line",
                    MonitorLine {
                        connection_id: event_connection.clone(),
                        line,
                    },
                )
                .is_err()
            {
                break;
            }
        }
        // The stream ended because the socket closed, the server revoked the
        // command or the task was aborted; the UI decides what to show.
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

pub async fn stop_monitor(registry: &MonitorRegistry, connection_id: &str) {
    registry.stop(connection_id).await;
}
