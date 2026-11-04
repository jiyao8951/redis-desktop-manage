use tauri::State;

use crate::error::AppResult;
use crate::models::tree::{DatabaseInfo, KeyMeta, ScanPage, ServerFacts};
use crate::state::AppState;

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<DatabaseInfo>> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, 0, &config).await?;
    crate::redis::list_databases(&mut conn, &config).await
}

#[tauri::command]
pub async fn server_facts(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<ServerFacts> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, 0, &config).await?;
    crate::redis::server_facts(&mut conn, &config).await
}

#[tauri::command]
pub async fn scan_keys(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    cursor: String,
    namespace: Option<String>,
    filter: Option<String>,
    page_size: u32,
) -> AppResult<ScanPage> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::scan_keys(
        &mut conn,
        &config,
        &cursor,
        namespace.as_deref(),
        filter.as_deref(),
        page_size,
    )
    .await
}

#[tauri::command]
pub async fn key_meta_batch(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    keys: Vec<String>,
) -> AppResult<Vec<KeyMeta>> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::key_meta_batch(&conn, &config, &keys).await
}

#[tauri::command]
pub async fn key_exists(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
) -> AppResult<bool> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::key_exists(&mut conn, &config, &key).await
}
