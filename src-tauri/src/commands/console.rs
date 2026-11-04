use tauri::State;

use crate::error::AppResult;
use crate::models::server::ConsoleReply;
use crate::state::AppState;

use super::with_db;

#[tauri::command]
pub async fn console_execute(
    state: State<'_, AppState>,
    connection_id: String,
    db: u32,
    command: String,
) -> AppResult<ConsoleReply> {
    let app = state.inner();
    let id = connection_id.clone();
    let config = with_db(app, move |conn| crate::db::get_config(conn, &id)).await?;
    let mut conn = app.pool.get(&connection_id, db, &config).await?;
    crate::redis::execute_console(&mut conn, &config, db, &command).await
}
