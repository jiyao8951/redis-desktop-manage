use tauri::State;

use crate::db;
use crate::error::AppResult;
use crate::models::settings::Settings;
use crate::state::AppState;

use super::with_db;

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    with_db(state.inner(), |conn| db::settings_repo::load(conn)).await
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> AppResult<Settings> {
    with_db(state.inner(), move |conn| db::settings_repo::save(conn, &settings)).await
}
