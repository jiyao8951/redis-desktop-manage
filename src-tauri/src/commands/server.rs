use redis::aio::ConnectionManager;
use tauri::State;

use crate::error::AppResult;
use crate::models::connection::ConnectionConfig;
use crate::models::server::{ClientEntry, ConfigEntry, MemoryReport, ServerInfo, SlowlogEntry};
use crate::state::AppState;

use super::with_db;

async fn load_config(app: &AppState, connection_id: &str) -> AppResult<ConnectionConfig> {
    let id = connection_id.to_string();
    with_db(app, move |conn| crate::db::get_config(conn, &id)).await
}

/// Server Actions are read-only and do not depend on the selected database,
/// so they reuse the pooled connection for db 0.
async fn pool_connection(
    app: &AppState,
    connection_id: &str,
) -> AppResult<(ConnectionConfig, ConnectionManager)> {
    let config = load_config(app, connection_id).await?;
    let conn = app.pool.get(connection_id, 0, &config).await?;
    Ok((config, conn))
}

#[tauri::command]
pub async fn server_info(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ServerInfo> {
    let app = state.inner();
    let (config, mut conn) = pool_connection(app, &connection_id).await?;
    crate::redis::server_info(&mut conn, &config).await
}

#[tauri::command]
pub async fn server_slowlog(
    state: State<'_, AppState>,
    connection_id: String,
    count: Option<u32>,
) -> AppResult<Vec<SlowlogEntry>> {
    let app = state.inner();
    let (config, mut conn) = pool_connection(app, &connection_id).await?;
    crate::redis::slowlog(&mut conn, &config, count).await
}

#[tauri::command]
pub async fn server_clients(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<ClientEntry>> {
    let app = state.inner();
    let (config, mut conn) = pool_connection(app, &connection_id).await?;
    crate::redis::clients(&mut conn, &config).await
}

#[tauri::command]
pub async fn server_config_get(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<ConfigEntry>> {
    let app = state.inner();
    let (config, mut conn) = pool_connection(app, &connection_id).await?;
    crate::redis::config_get(&mut conn, &config).await
}

#[tauri::command]
pub async fn server_memory(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<MemoryReport> {
    let app = state.inner();
    let (config, mut conn) = pool_connection(app, &connection_id).await?;
    crate::redis::memory_report(&mut conn, &config).await
}

/// Opens a dedicated connection and switches it to MONITOR. Output arrives as
/// `monitor-line` events; the connection is never taken from the shared pool.
#[tauri::command]
pub async fn start_monitor(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    connection_id: String,
) -> AppResult<()> {
    let app = state.inner();
    let config = load_config(app, &connection_id).await?;
    crate::redis::start_monitor(app_handle, &app.monitor, &config, &connection_id).await
}

#[tauri::command]
pub async fn stop_monitor(state: State<'_, AppState>, connection_id: String) -> AppResult<()> {
    crate::redis::stop_monitor(&state.inner().monitor, &connection_id).await;
    Ok(())
}
