use std::path::PathBuf;

use tauri::State;

use crate::db;
use crate::error::AppResult;
use crate::models::connection::{
    ConnectionConfig, ConnectionGroup, ConnectionSummary, FilterHistoryEntry,
};
use crate::models::tree::TestResult;
use crate::state::AppState;

use super::with_db;

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionSummary>> {
    with_db(state.inner(), |conn| db::list_summaries(conn)).await
}

#[tauri::command]
pub async fn get_connection(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ConnectionConfig> {
    with_db(state.inner(), move |conn| db::get_config(conn, &id)).await
}

#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
) -> AppResult<ConnectionConfig> {
    if config.name.trim().is_empty() {
        config.name = format!("{}:{}", config.host, config.port);
    }

    let app = state.inner();
    let saved = with_db(app, move |conn| db::save_config(conn, config)).await?;

    // Force the next tree expansion to reconnect with the new settings, and
    // drop every long-lived subscription that still holds the previous host,
    // password or protocol. Order matters: pooled managers and subscriptions
    // first, then the cached config so a concurrent reader cannot reconnect
    // with the old settings and repopulate the cache.
    app.pool.invalidate(&saved.id).await;
    app.live.stop_connection(&saved.id).await;
    app.monitor.stop(&saved.id).await;
    app.invalidate_config(&saved.id).await;
    Ok(saved)
}

/// Releases the pooled Redis connections plus the Live Update and MONITOR
/// subscriptions of one server without touching its saved configuration. The
/// frontend collapses the tree subtree afterwards; expanding it reconnects.
#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let app = state.inner();
    app.pool.invalidate(&id).await;
    app.live.stop_connection(&id).await;
    app.monitor.stop(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let app = state.inner();
    let connection_id = id.clone();
    with_db(app, move |conn| db::delete_config(conn, &connection_id)).await?;
    app.pool.invalidate(&id).await;
    app.invalidate_config(&id).await;
    app.live.stop_connection(&id).await;
    app.monitor.stop(&id).await;
    Ok(())
}

/// Regroup drag & drop: moves one server to another group (or to the
/// ungrouped bucket when `group_id` is None). Mirrors
/// ConnectionsManager::dropItemAt -> Model::addServer.
#[tauri::command]
pub async fn move_connection(
    state: State<'_, AppState>,
    id: String,
    group_id: Option<String>,
) -> AppResult<()> {
    with_db(state.inner(), move |conn| {
        db::move_connection(conn, &id, group_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn duplicate_connection(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<ConnectionConfig> {
    let app = state.inner();
    let copy = with_db(app, move |conn| db::duplicate_config(conn, &id)).await?;
    app.pool.invalidate(&copy.id).await;
    app.invalidate_config(&copy.id).await;
    Ok(copy)
}

#[tauri::command]
pub async fn test_connection(
    config: ConnectionConfig,
) -> AppResult<TestResult> {
    crate::redis::test_connection(&config).await
}

#[tauri::command]
pub fn parse_redis_url(url: String) -> AppResult<ConnectionConfig> {
    crate::redis::parse_redis_url(&url)
}

#[tauri::command]
pub async fn import_connections(state: State<'_, AppState>, path: String) -> AppResult<usize> {
    let app = state.inner();
    let imported = with_db(app, move |conn| db::import_file(conn, &PathBuf::from(path))).await?;
    // An import replaces the whole connection list, so every pooled manager,
    // Live Update subscription and MONITOR stream may belong to a config that
    // no longer matches what the file contained.
    app.pool.invalidate_all().await;
    app.live.stop_all().await;
    app.monitor.stop_all().await;
    app.invalidate_all_configs().await;
    Ok(imported)
}

#[tauri::command]
pub async fn export_connections(state: State<'_, AppState>, path: String) -> AppResult<()> {
    with_db(state.inner(), move |conn| {
        db::export_file(conn, &PathBuf::from(path))
    })
    .await
}

// ---- groups ---------------------------------------------------------------

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> AppResult<Vec<ConnectionGroup>> {
    with_db(state.inner(), |conn| db::list_groups(conn)).await
}

#[tauri::command]
pub async fn save_group(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
) -> AppResult<ConnectionGroup> {
    with_db(state.inner(), move |conn| db::save_group(conn, id, &name)).await
}

#[tauri::command]
pub async fn delete_group(state: State<'_, AppState>, id: String) -> AppResult<()> {
    with_db(state.inner(), move |conn| db::delete_group(conn, &id)).await
}

// ---- filter history -------------------------------------------------------

#[tauri::command]
pub async fn filter_history(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<FilterHistoryEntry>> {
    with_db(state.inner(), move |conn| {
        db::list_filter_history(conn, &connection_id)
    })
    .await
}

#[tauri::command]
pub async fn remember_filter(
    state: State<'_, AppState>,
    connection_id: String,
    pattern: String,
) -> AppResult<()> {
    with_db(state.inner(), move |conn| {
        db::remember_filter(conn, &connection_id, &pattern)
    })
    .await
}
