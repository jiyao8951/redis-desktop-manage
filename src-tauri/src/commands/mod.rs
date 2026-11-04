mod connections;
mod console;
mod server;
mod settings;
mod tree;
mod value;

pub use connections::*;
pub use console::*;
pub use server::*;
pub use settings::*;
pub use tree::*;
pub use value::*;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Runs a blocking SQLite operation on the blocking pool. The UI thread and the
/// async runtime never wait on the SQLite mutex directly.
pub(crate) async fn with_db<T, F>(state: &AppState, operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&rusqlite::Connection) -> AppResult<T> + Send + 'static,
{
    let database = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let connection = database
            .lock()
            .map_err(|_| AppError::Message("database lock poisoned".to_string()))?;
        operation(&connection)
    })
    .await?
}
