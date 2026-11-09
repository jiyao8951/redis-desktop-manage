use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::models::value::{KeyValueChunk, KeyValueInfo, ValuePage};
use crate::state::AppState;

#[tauri::command]
pub async fn key_value_info(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
) -> AppResult<KeyValueInfo> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::key_value_info(&mut conn, &config, &key).await
}

#[tauri::command]
pub async fn read_string_chunk(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    offset: u64,
    limit: u32,
    known_total: Option<u64>,
) -> AppResult<KeyValueChunk> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::read_string_chunk(&mut conn, &config, &key, offset, limit, known_total).await
}

#[tauri::command]
pub async fn read_value_page(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    key_type: String,
    cursor: String,
    start: u64,
    count: u32,
    reverse: bool,
    match_pattern: Option<String>,
    match_target: Option<Option<String>>,
) -> AppResult<ValuePage> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    let match_target = match_target.flatten();
    crate::redis::read_value_page(
        &mut conn,
        &config,
        &key,
        &key_type,
        &cursor,
        start,
        count,
        reverse,
        match_pattern.as_deref(),
        match_target.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn save_string_value(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    value: crate::redis::CellInput,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::save_string_value(&mut conn, &config, &key, &value.to_bytes()?).await
}

#[tauri::command]
pub async fn update_value_row(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    key_type: String,
    request: crate::redis::RowEditRequest,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::update_row(&mut conn, &config, &key, &key_type, &request).await
}

#[tauri::command]
pub async fn add_value_row(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    key_type: String,
    cells: Vec<crate::redis::CellInput>,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::add_row(&mut conn, &config, &key, &key_type, &cells).await
}

#[tauri::command]
pub async fn delete_value_row(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    key_type: String,
    old: Vec<crate::redis::CellInput>,
    position: Option<i64>,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::delete_row(&mut conn, &config, &key, &key_type, &old, position).await
}

#[tauri::command]
pub async fn set_key_ttl(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    ttl: i64,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::set_ttl(&mut conn, &config, &key, ttl).await
}

#[tauri::command]
pub async fn persist_key(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::persist_key(&mut conn, &config, &key).await
}

#[tauri::command]
pub async fn rename_key(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
    new_key: String,
    ttl: i64,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::rename_key(&mut conn, &config, &key, &new_key, ttl).await
}

#[tauri::command]
pub async fn delete_key(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    key: String,
) -> AppResult<i64> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::delete_key(&mut conn, &config, &key).await
}

#[tauri::command]
pub async fn delete_keys(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    keys: Vec<String>,
) -> AppResult<u64> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::delete_keys(&mut conn, &config, &keys).await
}

#[tauri::command]
pub async fn delete_keys_by_pattern(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    pattern: String,
    limit: u64,
) -> AppResult<u64> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::delete_keys_by_pattern(&mut conn, &config, &pattern, limit).await
}

#[tauri::command]
pub async fn flush_database(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::flush_db(&mut conn, &config).await
}

/// Bulk "Set TTL for multiple keys" (original BulkOperations TtlOperation).
#[tauri::command]
pub async fn set_ttl_by_pattern(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    pattern: String,
    ttl: i64,
    limit: u64,
) -> AppResult<u64> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::set_ttl_by_pattern(&mut conn, &config, &pattern, ttl, limit).await
}

/// Bulk "Copy keys to another database" (original BulkOperations
/// CopyOperation): DUMP on the source, RESTORE on the target.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn copy_keys(
    state: State<'_, AppState>,
    source_connection_id: String,
    source_db: u32,
    pattern: String,
    target_connection_id: String,
    target_db: u32,
    ttl: i64,
    replace: bool,
    limit: u64,
) -> AppResult<u64> {
    let app = state.inner();
    let source_config = app.connection_config(&source_connection_id).await?;
    let target_config = app.connection_config(&target_connection_id).await?;
    let mut source = app
        .pool
        .get(&source_connection_id, source_db, &source_config)
        .await?;
    let mut target = app
        .pool
        .get(&target_connection_id, target_db, &target_config)
        .await?;
    crate::redis::copy_keys(
        &mut source,
        &source_config,
        &pattern,
        limit,
        &mut target,
        &target_config,
        ttl,
        replace,
    )
    .await
}

#[tauri::command]
pub async fn create_key(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    request: crate::redis::NewKeyRequest,
) -> AppResult<()> {
    let app = state.inner();
    let config = app.connection_config(&connection_id).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::create_key(&mut conn, &config, &request).await
}

#[tauri::command]
pub async fn start_live_update(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
) -> AppResult<()> {
    let app_state = state.inner();
    let config = app_state.connection_config(&connection_id).await?;
    crate::redis::start_live_update(app, &app_state.live, &config, &connection_id, db).await
}

#[tauri::command]
pub async fn stop_live_update(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
) -> AppResult<()> {
    crate::redis::stop_live_update(&state.inner().live, &connection_id, db).await;
    Ok(())
}
