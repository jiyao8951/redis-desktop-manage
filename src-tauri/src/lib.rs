mod commands;
mod db;
mod error;
mod models;
mod redis;
mod state;

pub use error::{AppError, AppResult};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let database_path = data_dir.join("resp.sqlite3");
            let mut connection = rusqlite::Connection::open(&database_path)?;
            db::migrate(&mut connection)?;

            // Settings defaults are migrated once, keyed by a stored schema
            // version. A failure is logged but never blocks startup.
            if let Err(error) = db::settings_repo::migrate(&mut connection) {
                eprintln!("settings migration skipped: {error}");
            }

            app.manage(state::AppState::new(connection));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::get_connection,
            commands::save_connection,
            commands::delete_connection,
            commands::move_connection,
            commands::duplicate_connection,
            commands::test_connection,
            commands::parse_redis_url,
            commands::import_connections,
            commands::export_connections,
            commands::list_groups,
            commands::save_group,
            commands::delete_group,
            commands::filter_history,
            commands::remember_filter,
            commands::get_settings,
            commands::update_settings,
            commands::list_databases,
            commands::server_facts,
            commands::scan_keys,
            commands::key_meta_batch,
            commands::key_exists,
            commands::key_value_info,
            commands::read_string_chunk,
            commands::read_value_page,
            commands::delete_key,
            commands::delete_keys,
            commands::delete_keys_by_pattern,
            commands::flush_database,
            commands::set_ttl_by_pattern,
            commands::copy_keys,
            commands::save_string_value,
            commands::update_value_row,
            commands::add_value_row,
            commands::delete_value_row,
            commands::set_key_ttl,
            commands::persist_key,
            commands::rename_key,
            commands::create_key,
            commands::start_live_update,
            commands::stop_live_update,
            commands::server_info,
            commands::server_slowlog,
            commands::server_clients,
            commands::server_config_get,
            commands::server_memory,
            commands::start_monitor,
            commands::stop_monitor,
            commands::console_execute,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RESP.app");
}
