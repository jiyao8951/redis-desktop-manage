use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use redis::aio::ConnectionManager;
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::redis::manager::{execute_timeout, query_with_timeout};

/// Placeholder used to remove an item at a position: LSET the slot to an
/// unpredictable marker, then LREM it by value (Redis has no positional list
/// delete). The marker carries a UUID so a value that already exists in the
/// list can never be removed by accident.
fn list_removal_token() -> String {
    format!("__resp_deleted_{}__", uuid::Uuid::new_v4().simple())
}

/// A single RESP command with binary-safe arguments (command name excluded).
/// Builders return these so the argument order can be unit-tested without a
/// live server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Command {
    pub name: &'static str,
    pub args: Vec<Vec<u8>>,
}

impl Command {
    fn new(name: &'static str, args: Vec<Vec<u8>>) -> Self {
        Self { name, args }
    }
}

fn arg(value: impl AsRef<[u8]>) -> Vec<u8> {
    value.as_ref().to_vec()
}

/// A value cell as sent by the editor. Text is UTF-8; binary data is base64.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellInput {
    pub encoding: String,
    pub payload: String,
}

impl CellInput {
    pub fn to_bytes(&self) -> AppResult<Vec<u8>> {
        if self.encoding.eq_ignore_ascii_case("base64") {
            STANDARD
                .decode(&self.payload)
                .map_err(|_| AppError::Invalid("Invalid base64 value".into()))
        } else {
            Ok(self.payload.as_bytes().to_vec())
        }
    }

    #[cfg(test)]
    fn text(value: &str) -> Self {
        Self {
            encoding: "utf8".into(),
            payload: value.into(),
        }
    }
}

fn decode_cells(cells: &[CellInput]) -> AppResult<Vec<Vec<u8>>> {
    cells.iter().map(CellInput::to_bytes).collect()
}

/// One row edit from the value table: the cached row, the edited row and the
/// absolute list position (only used by lists).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEditRequest {
    pub old: Vec<CellInput>,
    pub new: Vec<CellInput>,
    pub position: Option<i64>,
}

fn expect_cells(cells: &[Vec<u8>], count: usize, key_type: &str) -> AppResult<()> {
    if cells.len() != count {
        return Err(AppError::Invalid(format!(
            "A {key_type} row must have {count} column(s), got {}",
            cells.len()
        )));
    }
    Ok(())
}

fn require_position(position: Option<i64>) -> AppResult<i64> {
    position.ok_or_else(|| AppError::Invalid("The list row position is required".into()))
}

fn parse_score(score: &[u8]) -> AppResult<()> {
    let text = std::str::from_utf8(score)
        .map_err(|_| AppError::Invalid("The score must be a number".into()))?;
    text.parse::<f64>()
        .map_err(|_| AppError::Invalid("The score must be a number".into()))?;
    Ok(())
}

/// XADD takes a flat list of field/value pairs. The editor sends the entry as
/// a JSON object; nested arrays/objects are serialized compactly, matching
/// StreamKeyModel::addRow.
pub fn stream_fields(json: &[u8]) -> AppResult<Vec<Vec<u8>>> {
    let value: serde_json::Value = serde_json::from_slice(json)
        .map_err(|_| AppError::Invalid("The stream entry must be a JSON object".into()))?;
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Invalid("The stream entry must be a JSON object".into()))?;

    let mut fields = Vec::new();
    for (field, value) in object {
        fields.push(field.as_bytes().to_vec());
        let text = match value {
            serde_json::Value::String(text) => text.clone(),
            serde_json::Value::Null => String::new(),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                serde_json::to_string(value)?
            }
            _ => value.to_string(),
        };
        fields.push(text.into_bytes());
    }

    if fields.is_empty() {
        return Err(AppError::Invalid(
            "The stream entry needs at least one field".into(),
        ));
    }
    Ok(fields)
}

pub fn build_save_string(key: &str, value: &[u8]) -> Vec<Command> {
    vec![Command::new("SET", vec![arg(key), value.to_vec()])]
}

pub fn build_update_row(
    key_type: &str,
    key: &str,
    old: &[Vec<u8>],
    new: &[Vec<u8>],
    position: Option<i64>,
) -> AppResult<Vec<Command>> {
    match key_type {
        "string" => {
            expect_cells(new, 1, key_type)?;
            Ok(vec![Command::new("SET", vec![arg(key), new[0].clone()])])
        }
        "hash" => {
            expect_cells(old, 2, key_type)?;
            expect_cells(new, 2, key_type)?;
            if old[0] != new[0] {
                Ok(vec![
                    Command::new("HDEL", vec![arg(key), old[0].clone()]),
                    Command::new(
                        "HSET",
                        vec![arg(key), new[0].clone(), new[1].clone()],
                    ),
                ])
            } else {
                Ok(vec![Command::new(
                    "HSET",
                    vec![arg(key), new[0].clone(), new[1].clone()],
                )])
            }
        }
        "set" => {
            expect_cells(old, 1, key_type)?;
            expect_cells(new, 1, key_type)?;
            Ok(vec![
                Command::new("SREM", vec![arg(key), old[0].clone()]),
                Command::new("SADD", vec![arg(key), new[0].clone()]),
            ])
        }
        "zset" => {
            expect_cells(old, 2, key_type)?;
            expect_cells(new, 2, key_type)?;
            parse_score(&new[1])?;
            if old[0] != new[0] {
                Ok(vec![
                    Command::new("ZREM", vec![arg(key), old[0].clone()]),
                    Command::new(
                        "ZADD",
                        vec![arg(key), new[1].clone(), new[0].clone()],
                    ),
                ])
            } else {
                Ok(vec![Command::new(
                    "ZADD",
                    vec![arg(key), arg("XX"), new[1].clone(), new[0].clone()],
                )])
            }
        }
        "list" => {
            expect_cells(new, 1, key_type)?;
            let position = require_position(position)?;
            Ok(vec![Command::new(
                "LSET",
                vec![arg(key), arg(position.to_string()), new[0].clone()],
            )])
        }
        "stream" => Err(AppError::Unsupported(
            "Redis Streams entries cannot be edited".into(),
        )),
        other => Err(AppError::Unsupported(format!(
            "The value editor does not support type \"{other}\""
        ))),
    }
}

pub fn build_add_row(
    key_type: &str,
    key: &str,
    cells: &[Vec<u8>],
) -> AppResult<Vec<Command>> {
    match key_type {
        "string" => {
            expect_cells(cells, 1, key_type)?;
            Ok(vec![Command::new("SET", vec![arg(key), cells[0].clone()])])
        }
        "hash" => {
            expect_cells(cells, 2, key_type)?;
            Ok(vec![Command::new(
                "HSETNX",
                vec![arg(key), cells[0].clone(), cells[1].clone()],
            )])
        }
        "set" => {
            expect_cells(cells, 1, key_type)?;
            Ok(vec![Command::new("SADD", vec![arg(key), cells[0].clone()])])
        }
        "zset" => {
            expect_cells(cells, 2, key_type)?;
            parse_score(&cells[1])?;
            Ok(vec![Command::new(
                "ZADD",
                vec![arg(key), cells[1].clone(), cells[0].clone()],
            )])
        }
        "list" => {
            expect_cells(cells, 1, key_type)?;
            Ok(vec![Command::new("LPUSH", vec![arg(key), cells[0].clone()])])
        }
        "stream" => {
            expect_cells(cells, 2, key_type)?;
            let id = if cells[0].is_empty() {
                "*".to_string()
            } else {
                String::from_utf8_lossy(&cells[0]).into_owned()
            };
            let fields = stream_fields(&cells[1])?;
            let mut args = vec![arg(key), arg(id)];
            args.extend(fields);
            Ok(vec![Command::new("XADD", args)])
        }
        other => Err(AppError::Unsupported(format!(
            "Cannot create a key of type \"{other}\""
        ))),
    }
}

pub fn build_delete_row(
    key_type: &str,
    key: &str,
    old: &[Vec<u8>],
    position: Option<i64>,
) -> AppResult<Vec<Command>> {
    match key_type {
        "string" => Ok(vec![Command::new("DEL", vec![arg(key)])]),
        "hash" => {
            expect_cells(old, 2, key_type)?;
            Ok(vec![Command::new("HDEL", vec![arg(key), old[0].clone()])])
        }
        "set" => {
            expect_cells(old, 1, key_type)?;
            Ok(vec![Command::new("SREM", vec![arg(key), old[0].clone()])])
        }
        "zset" => {
            expect_cells(old, 2, key_type)?;
            Ok(vec![Command::new("ZREM", vec![arg(key), old[0].clone()])])
        }
        "list" => {
            expect_cells(old, 1, key_type)?;
            let position = require_position(position)?;
            let token = list_removal_token();
            Ok(vec![
                Command::new(
                    "LSET",
                    vec![arg(key), arg(position.to_string()), arg(&token)],
                ),
                Command::new("LREM", vec![arg(key), arg("0"), arg(&token)]),
            ])
        }
        "stream" => {
            expect_cells(old, 2, key_type)?;
            Ok(vec![Command::new("XDEL", vec![arg(key), old[0].clone()])])
        }
        other => Err(AppError::Unsupported(format!(
            "The value editor does not support type \"{other}\""
        ))),
    }
}

pub fn build_set_ttl(key: &str, ttl: i64) -> Command {
    Command::new("EXPIRE", vec![arg(key), arg(ttl.to_string())])
}

pub fn build_persist(key: &str) -> Command {
    Command::new("PERSIST", vec![arg(key)])
}

pub fn build_restore(key: &str, ttl: i64, payload: &[u8]) -> Command {
    let ttl = if ttl > 0 { ttl } else { 0 };
    Command::new("RESTORE", vec![arg(key), arg(ttl.to_string()), arg(payload)])
}

pub fn build_delete_keys(keys: &[String]) -> Command {
    let mut args = Vec::with_capacity(keys.len());
    for key in keys {
        args.push(arg(key));
    }
    Command::new("DEL", args)
}

pub fn build_flush_db() -> Command {
    Command::new("FLUSHDB", Vec::new())
}

/// Copy destination uses RESTORE, whose TTL unit is milliseconds; the original
/// CopyOperation multiplies the seconds entered in the dialog by 1000.
/// REPLACE is only appended when the user confirmed overwriting target keys.
pub fn build_copy_restore(key: &str, ttl_seconds: i64, payload: &[u8], replace: bool) -> Command {
    let ttl_ms = ttl_seconds.max(0).saturating_mul(1000);
    let mut args = vec![arg(key), arg(ttl_ms.to_string()), arg(payload)];
    if replace {
        args.push(arg("REPLACE"));
    }
    Command::new("RESTORE", args)
}

/// Add Key mirrors KeyFactory::submitNewKeyRequest -> Model::addRow.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewKeyRequest {
    pub key: String,
    pub key_type: String,
    pub value: Option<String>,
    pub field: Option<String>,
    pub score: Option<f64>,
    pub members: Option<Vec<String>>,
    pub id: Option<String>,
}

pub fn build_new_key(request: &NewKeyRequest) -> AppResult<Vec<Command>> {
    let key = request.key.as_str();
    let value = request.value.clone().unwrap_or_default();

    match request.key_type.as_str() {
        "string" => Ok(vec![Command::new("SET", vec![arg(key), arg(&value)])]),
        "hash" => {
            let field = request.field.clone().unwrap_or_default();
            Ok(vec![Command::new(
                "HSETNX",
                vec![arg(key), arg(field), arg(&value)],
            )])
        }
        "zset" => {
            let score = request.score.unwrap_or(0.0);
            Ok(vec![Command::new(
                "ZADD",
                vec![arg(key), arg(score.to_string()), arg(&value)],
            )])
        }
        "list" => {
            let members = request
                .members
                .clone()
                .filter(|members| !members.is_empty())
                .unwrap_or_else(|| vec![value]);
            let mut args = vec![arg(key)];
            for member in &members {
                args.push(arg(member));
            }
            Ok(vec![Command::new("LPUSH", args)])
        }
        "set" => {
            let members = request
                .members
                .clone()
                .filter(|members| !members.is_empty())
                .unwrap_or_else(|| vec![value]);
            let mut args = vec![arg(key)];
            for member in &members {
                args.push(arg(member));
            }
            Ok(vec![Command::new("SADD", args)])
        }
        "stream" => {
            let id = request
                .id
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "*".to_string());
            let fields = stream_fields(value.as_bytes())?;
            let mut args = vec![arg(key), arg(id)];
            args.extend(fields);
            Ok(vec![Command::new("XADD", args)])
        }
        other => Err(AppError::Unsupported(format!(
            "Cannot create a key of type \"{other}\""
        ))),
    }
}

/// Sends one built command with the connection's execute timeout.
async fn run(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    command: &Command,
) -> AppResult<redis::Value> {
    let mut cmd = redis::cmd(command.name);
    for value in &command.args {
        cmd.arg(value);
    }
    Ok(query_with_timeout(execute_timeout(config), cmd.query_async(conn)).await?)
}

async fn run_all(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    commands: &[Command],
) -> AppResult<()> {
    for command in commands {
        run(conn, config, command).await?;
    }
    Ok(())
}

fn integer(value: &redis::Value) -> i64 {
    redis::from_redis_value::<i64>(value).unwrap_or(0)
}

pub async fn save_string_value(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    value: &[u8],
) -> AppResult<()> {
    run_all(conn, config, &build_save_string(key, value)).await
}

pub async fn update_row(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    key_type: &str,
    request: &RowEditRequest,
) -> AppResult<()> {
    let old = decode_cells(&request.old)?;
    let new = decode_cells(&request.new)?;
    let commands = build_update_row(key_type, key, &old, &new, request.position)?;
    run_all(conn, config, &commands).await
}

pub async fn add_row(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    key_type: &str,
    cells: &[CellInput],
) -> AppResult<()> {
    let cells = decode_cells(cells)?;
    let commands = build_add_row(key_type, key, &cells)?;
    for command in &commands {
        let reply = run(conn, config, command).await?;
        if command.name == "HSETNX" && integer(&reply) == 0 {
            return Err(AppError::Message(
                "Value with the same key already exists".into(),
            ));
        }
    }
    Ok(())
}

pub async fn delete_row(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    key_type: &str,
    old: &[CellInput],
    position: Option<i64>,
) -> AppResult<()> {
    let old = decode_cells(old)?;
    let commands = build_delete_row(key_type, key, &old, position)?;
    run_all(conn, config, &commands).await
}

pub async fn set_ttl(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    ttl: i64,
) -> AppResult<()> {
    let reply = run(conn, config, &build_set_ttl(key, ttl)).await?;
    if integer(&reply) == 0 {
        return Err(AppError::Message(format!(
            "Cannot set TTL for key {key}"
        )));
    }
    Ok(())
}

pub async fn persist_key(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
) -> AppResult<()> {
    let reply = run(conn, config, &build_persist(key)).await?;
    if integer(&reply) == 0 {
        return Err(AppError::Message(format!(
            "Cannot persist key '{key}'. Key does not exist or does not have an assigned TTL value"
        )));
    }
    Ok(())
}

/// DUMP + RESTORE + DEL, the cluster-compatible rename used by the original
/// KeyModel::setKeyName.
pub async fn rename_key(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    old_key: &str,
    new_key: &str,
    ttl: i64,
) -> AppResult<()> {
    let payload: Vec<u8> = query_with_timeout(
        execute_timeout(config),
        redis::cmd("DUMP").arg(old_key).query_async(conn),
    )
    .await?;
    if payload.is_empty() {
        return Err(AppError::Message(format!("Key {old_key} does not exist")));
    }

    let restore = build_restore(new_key, ttl, &payload);
    let reply = run(conn, config, &restore).await?;
    if let redis::Value::SimpleString(text) = &reply {
        if text != "OK" {
            return Err(AppError::Message(format!(
                "Cannot rename key {old_key}: {text}"
            )));
        }
    }

    let delete = Command::new("DEL", vec![arg(old_key)]);
    run_all(conn, config, &[delete]).await?;
    Ok(())
}

pub async fn delete_key(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
) -> AppResult<i64> {
    let reply = run(conn, config, &Command::new("DEL", vec![arg(key)])).await?;
    Ok(integer(&reply))
}

pub async fn delete_keys(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    keys: &[String],
) -> AppResult<u64> {
    let mut deleted = 0u64;
    for chunk in keys.chunks(500) {
        if chunk.is_empty() {
            continue;
        }
        let reply = run(conn, config, &build_delete_keys(chunk)).await?;
        deleted += integer(&reply).max(0) as u64;
    }
    Ok(deleted)
}

/// Bulk "Delete keys with filter": SCAN the pattern and DEL each page. The
/// original uses BulkOperations::Manager with the same SCAN+DEL flow.
pub async fn delete_keys_by_pattern(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    pattern: &str,
    limit: u64,
) -> AppResult<u64> {
    let mut cursor = 0u64;
    let mut deleted = 0u64;

    loop {
        let (next, keys): (String, Vec<String>) = query_with_timeout(
            execute_timeout(config),
            redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(500)
                .query_async(conn),
        )
        .await?;

        if !keys.is_empty() {
            let reply = run(conn, config, &build_delete_keys(&keys)).await?;
            deleted += integer(&reply).max(0) as u64;
        }

        let next = next.parse::<u64>().unwrap_or(0);
        if next == 0 || deleted >= limit {
            break;
        }
        cursor = next;
    }

    Ok(deleted)
}

pub async fn flush_db(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<()> {
    run_all(conn, config, &[build_flush_db()]).await
}

async fn scan_pattern_page(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    cursor: u64,
    pattern: &str,
) -> AppResult<(u64, Vec<String>)> {
    let (next, keys): (String, Vec<String>) = query_with_timeout(
        execute_timeout(config),
        redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(500)
            .query_async(conn),
    )
    .await?;
    Ok((next.parse::<u64>().unwrap_or(0), keys))
}

/// Bulk "Set TTL for multiple keys": SCAN the pattern, then EXPIRE every hit.
/// Mirrors TtlOperation, which pipelines EXPIRE for the affected keys. A
/// negative TTL is passed through because Redis treats EXPIRE < 0 as a delete
/// (the original dialog offered -1..10,000,000).
pub async fn set_ttl_by_pattern(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    pattern: &str,
    ttl: i64,
    limit: u64,
) -> AppResult<u64> {
    let mut cursor = 0u64;
    let mut changed = 0u64;

    loop {
        let (next, keys) = scan_pattern_page(conn, config, cursor, pattern).await?;
        for key in &keys {
            let reply = run(conn, config, &build_set_ttl(key, ttl)).await?;
            if integer(&reply) > 0 {
                changed += 1;
            }
            if changed >= limit {
                return Ok(changed);
            }
        }
        if next == 0 {
            break;
        }
        cursor = next;
    }

    Ok(changed)
}

/// Copy keys to another connection/database: DUMP on the source, RESTORE on
/// the target (CopyOperation's cluster-compatible approach).
#[allow(clippy::too_many_arguments)]
pub async fn copy_keys(
    source: &mut ConnectionManager,
    source_config: &ConnectionConfig,
    pattern: &str,
    limit: u64,
    target: &mut ConnectionManager,
    target_config: &ConnectionConfig,
    ttl_seconds: i64,
    replace: bool,
) -> AppResult<u64> {
    let mut cursor = 0u64;
    let mut copied = 0u64;

    loop {
        let (next, keys) = scan_pattern_page(source, source_config, cursor, pattern).await?;
        for key in &keys {
            let payload: Vec<u8> = query_with_timeout(
                execute_timeout(source_config),
                redis::cmd("DUMP").arg(key).query_async(source),
            )
            .await?;
            if payload.is_empty() {
                continue;
            }
            run(
                target,
                target_config,
                &build_copy_restore(key, ttl_seconds, &payload, replace),
            )
            .await?;
            copied += 1;
            if copied >= limit {
                return Ok(copied);
            }
        }
        if next == 0 {
            break;
        }
        cursor = next;
    }

    Ok(copied)
}

pub async fn create_key(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    request: &NewKeyRequest,
) -> AppResult<()> {
    run_all(conn, config, &build_new_key(request)?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(cells: &[&str]) -> Vec<Vec<u8>> {
        cells.iter().map(|value| value.as_bytes().to_vec()).collect()
    }

    #[test]
    fn string_save_uses_set() {
        let commands = build_save_string("k", b"hello");
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "SET");
        assert_eq!(commands[0].args, plain(&["k", "hello"]));
    }

    #[test]
    fn hash_update_only_touches_changed_field() {
        let same = build_update_row(
            "hash",
            "h",
            &plain(&["field", "value"]),
            &plain(&["field", "value2"]),
            None,
        )
        .unwrap();
        assert_eq!(same.len(), 1);
        assert_eq!(same[0].name, "HSET");

        let renamed = build_update_row(
            "hash",
            "h",
            &plain(&["old", "value"]),
            &plain(&["new", "value"]),
            None,
        )
        .unwrap();
        assert_eq!(renamed[0].name, "HDEL");
        assert_eq!(renamed[0].args, plain(&["h", "old"]));
        assert_eq!(renamed[1].name, "HSET");
        assert_eq!(renamed[1].args, plain(&["h", "new", "value"]));
    }

    #[test]
    fn hash_add_uses_hsetnx() {
        let commands =
            build_add_row("hash", "h", &plain(&["field", "value"])).unwrap();
        assert_eq!(commands[0].name, "HSETNX");
        assert_eq!(commands[0].args, plain(&["h", "field", "value"]));
    }

    #[test]
    fn set_update_is_srem_then_sadd() {
        let commands =
            build_update_row("set", "s", &plain(&["old"]), &plain(&["new"]), None).unwrap();
        assert_eq!(commands[0].name, "SREM");
        assert_eq!(commands[1].name, "SADD");
        assert_eq!(commands[1].args, plain(&["s", "new"]));
    }

    #[test]
    fn zset_update_member_change_removes_then_adds() {
        let commands = build_update_row(
            "zset",
            "z",
            &plain(&["old", "1"]),
            &plain(&["new", "2"]),
            None,
        )
        .unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "ZREM");
        assert_eq!(commands[1].name, "ZADD");
        assert_eq!(commands[1].args, plain(&["z", "2", "new"]));
    }

    #[test]
    fn zset_score_only_update_uses_xx() {
        let commands = build_update_row(
            "zset",
            "z",
            &plain(&["member", "1"]),
            &plain(&["member", "2.5"]),
            None,
        )
        .unwrap();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "ZADD");
        assert_eq!(commands[0].args, plain(&["z", "XX", "2.5", "member"]));
    }

    #[test]
    fn zset_rejects_non_numeric_score() {
        assert!(build_update_row(
            "zset",
            "z",
            &plain(&["member", "1"]),
            &plain(&["member", "abc"]),
            None
        )
        .is_err());
    }

    #[test]
    fn list_update_uses_lset_with_position() {
        let update =
            build_update_row("list", "l", &plain(&["old"]), &plain(&["new"]), Some(3)).unwrap();
        assert_eq!(update[0].name, "LSET");
        assert_eq!(update[0].args, plain(&["l", "3", "new"]));
    }

    #[test]
    fn list_delete_uses_unique_placeholder_then_lrem() {
        let delete = build_delete_row("list", "l", &plain(&["old"]), Some(-1)).unwrap();
        assert_eq!(delete[0].name, "LSET");
        assert_eq!(delete[0].args[0], b"l".to_vec());
        assert_eq!(delete[0].args[1], b"-1".to_vec());

        let token = delete[0].args[2].clone();
        let token_text = String::from_utf8(token.clone()).unwrap();
        // A random marker can never collide with a value already in the list.
        assert!(token_text.starts_with("__resp_deleted_"));
        assert!(token_text.ends_with("__"));
        assert!(token_text.len() > "__resp_deleted____".len());

        assert_eq!(delete[1].name, "LREM");
        assert_eq!(delete[1].args[0], b"l".to_vec());
        assert_eq!(delete[1].args[1], b"0".to_vec());
        assert_eq!(delete[1].args[2], token, "LREM must use the same marker");

        // Two deletions must never share a marker.
        let second = build_delete_row("list", "l", &plain(&["old"]), Some(0)).unwrap();
        assert_ne!(second[0].args[2], token);
    }

    #[test]
    fn copy_restore_uses_millisecond_ttl_and_optional_replace() {
        let plain_copy = build_copy_restore("k", 60, b"dump", false);
        assert_eq!(plain_copy.name, "RESTORE");
        assert_eq!(plain_copy.args, plain(&["k", "60000", "dump"]));

        let replace_copy = build_copy_restore("k", -1, b"dump", true);
        assert_eq!(
            replace_copy.args,
            plain(&["k", "0", "dump", "REPLACE"])
        );
    }

    #[test]
    fn bulk_ttl_reuses_expire() {
        assert_eq!(build_set_ttl("k", 30).name, "EXPIRE");
        assert_eq!(build_set_ttl("k", 30).args, plain(&["k", "30"]));
    }

    #[test]
    fn list_add_uses_lpush_like_the_original() {
        let commands = build_add_row("list", "l", &plain(&["value"])).unwrap();
        assert_eq!(commands[0].name, "LPUSH");
    }

    #[test]
    fn list_operations_require_position() {
        assert!(build_update_row("list", "l", &plain(&["a"]), &plain(&["b"]), None).is_err());
        assert!(build_delete_row("list", "l", &plain(&["a"]), None).is_err());
    }

    #[test]
    fn stream_add_flattens_json_object() {
        let cells = vec![
            CellInput::text("1-1"),
            CellInput::text(r#"{"name":"alice","meta":{"level":3}}"#),
        ];
        let bytes: Vec<Vec<u8>> = cells.iter().map(|cell| cell.to_bytes().unwrap()).collect();
        let commands = build_add_row("stream", "st", &bytes).unwrap();
        assert_eq!(commands[0].name, "XADD");
        assert_eq!(commands[0].args[0], b"st".to_vec());
        assert_eq!(commands[0].args[1], b"1-1".to_vec());
        // serde_json maps may be ordered by key, so assert on pairs.
        let fields = &commands[0].args[2..];
        assert_eq!(fields.len(), 4);
        let position = fields
            .chunks(2)
            .position(|pair| pair[0] == b"name")
            .expect("name field");
        assert_eq!(fields[position * 2 + 1], b"alice".to_vec());
        let meta = fields
            .chunks(2)
            .position(|pair| pair[0] == b"meta")
            .expect("meta field");
        assert_eq!(fields[meta * 2 + 1], br#"{"level":3}"#.to_vec());
    }

    #[test]
    fn stream_add_defaults_to_auto_id() {
        let cells = vec![CellInput::text(""), CellInput::text(r#"{"f":"v"}"#)];
        let bytes: Vec<Vec<u8>> = cells.iter().map(|cell| cell.to_bytes().unwrap()).collect();
        let commands = build_add_row("stream", "st", &bytes).unwrap();
        assert_eq!(commands[0].args[1], b"*".to_vec());
    }

    #[test]
    fn stream_update_is_rejected() {
        assert!(build_update_row(
            "stream",
            "st",
            &plain(&["1-1", "{}"]),
            &plain(&["1-1", "{}"]),
            None
        )
        .is_err());
    }

    #[test]
    fn stream_delete_uses_xdel() {
        let commands =
            build_delete_row("stream", "st", &plain(&["1-1", "{}"]), None).unwrap();
        assert_eq!(commands[0].name, "XDEL");
        assert_eq!(commands[0].args, plain(&["st", "1-1"]));
    }

    #[test]
    fn ttl_persist_and_delete_builders() {
        assert_eq!(build_set_ttl("k", 60).args, plain(&["k", "60"]));
        assert_eq!(build_persist("k").args, plain(&["k"]));
        assert_eq!(
            build_delete_keys(&["a".into(), "b".into()]).args,
            plain(&["a", "b"])
        );
    }

    #[test]
    fn restore_uses_zero_ttl_when_missing() {
        assert_eq!(
            build_restore("k", -1, b"payload").args,
            plain(&["k", "0", "payload"])
        );
    }

    #[test]
    fn add_key_builders_match_the_original_models() {
        let base = NewKeyRequest {
            key: "k".into(),
            key_type: "string".into(),
            value: Some("v".into()),
            field: None,
            score: None,
            members: None,
            id: None,
        };
        assert_eq!(build_new_key(&base).unwrap()[0].name, "SET");

        let mut hash = base.clone();
        hash.key_type = "hash".into();
        hash.field = Some("f".into());
        assert_eq!(build_new_key(&hash).unwrap()[0].name, "HSETNX");

        let mut zset = base.clone();
        zset.key_type = "zset".into();
        zset.score = Some(2.0);
        assert_eq!(build_new_key(&zset).unwrap()[0].name, "ZADD");

        let mut list = base.clone();
        list.key_type = "list".into();
        assert_eq!(build_new_key(&list).unwrap()[0].name, "LPUSH");

        let mut set = base.clone();
        set.key_type = "set".into();
        assert_eq!(build_new_key(&set).unwrap()[0].name, "SADD");

        let mut stream = base;
        stream.key_type = "stream".into();
        stream.value = Some(r#"{"f":"v"}"#.into());
        stream.id = Some("1-1".into());
        assert_eq!(build_new_key(&stream).unwrap()[0].name, "XADD");
    }

    #[test]
    fn base64_cells_round_trip() {
        let cell = CellInput {
            encoding: "base64".into(),
            payload: STANDARD.encode([0u8, 255, 1]),
        };
        assert_eq!(cell.to_bytes().unwrap(), vec![0, 255, 1]);
    }
}
