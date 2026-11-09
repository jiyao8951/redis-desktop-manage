use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use redis::aio::ConnectionManager;
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::redis::manager::{execute_timeout, query_with_timeout};

/// Placeholder used by the atomic list-delete script: the target slot is
/// overwritten with an unpredictable marker, then the marker is removed by
/// value. The UUID guarantees it can never collide with an existing element.
fn list_removal_token() -> String {
    format!("__resp_deleted_{}__", uuid::Uuid::new_v4().simple())
}

/// Deletes one list element at `position` atomically. Redis has no positional
/// list delete, so the script validates the key type and index, overwrites the
/// slot with a per-call UUID marker, and removes exactly that marker with
/// `LREM <marker> 1`. Sending `LREM 0 <value>` on the real element would also
/// delete duplicates elsewhere in the list.
const LIST_DELETE_SCRIPT: &str = r#"
local key = KEYS[1]
local marker = ARGV[1]
local position = tonumber(ARGV[2])
if redis.call('TYPE', key)['ok'] ~= 'list' then
  return -3
end
local length = redis.call('LLEN', key)
if position < 0 then
  position = length + position
end
if position < 0 or position >= length then
  return -2
end
redis.call('LSET', key, position, marker)
redis.call('LREM', key, 1, marker)
return 1
"#;

fn build_list_delete(key: &str, position: i64) -> Command {
    Command::new(
        "EVAL",
        vec![
            arg(LIST_DELETE_SCRIPT),
            arg("1"),
            arg(key),
            arg(list_removal_token()),
            arg(position.to_string()),
        ],
    )
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

/// Scores must be finite. `f64::from_str` accepts `NaN`, `inf` and `-inf`, but
/// Redis rejects those as "not a valid float", so both create and edit paths
/// validate with `is_finite()` before sending anything.
fn parse_score(score: &[u8]) -> AppResult<f64> {
    let text = std::str::from_utf8(score)
        .map_err(|_| AppError::Invalid("The score must be a number".into()))?;
    let value = text
        .parse::<f64>()
        .map_err(|_| AppError::Invalid("The score must be a number".into()))?;
    if !value.is_finite() {
        return Err(AppError::Invalid(
            "The score must be a finite number".into(),
        ));
    }
    Ok(value)
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

/// `KEEPTTL` keeps the key's expiry when the editor saves a string. Without it
/// an `SET` clears the TTL, so editing a value silently makes the key persist.
pub fn build_save_string(key: &str, value: &[u8]) -> Vec<Command> {
    vec![Command::new(
        "SET",
        vec![arg(key), value.to_vec(), arg("KEEPTTL")],
    )]
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
            // Same TTL rule as the string editor: an edit must not clear the
            // key's expiry.
            Ok(vec![Command::new(
                "SET",
                vec![arg(key), new[0].clone(), arg("KEEPTTL")],
            )])
        }
        "hash" => {
            expect_cells(old, 2, key_type)?;
            expect_cells(new, 2, key_type)?;
            if old[0] != new[0] {
                // Add the new field before removing the old one so a failed
                // HSET cannot silently drop the only copy of the value.
                Ok(vec![
                    Command::new(
                        "HSET",
                        vec![arg(key), new[0].clone(), new[1].clone()],
                    ),
                    Command::new("HDEL", vec![arg(key), old[0].clone()]),
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
            if old[0] == new[0] {
                return Ok(Vec::new());
            }
            // Add the new member before removing the old one; otherwise a
            // failed SADD after SREM would lose the member entirely.
            Ok(vec![
                Command::new("SADD", vec![arg(key), new[0].clone()]),
                Command::new("SREM", vec![arg(key), old[0].clone()]),
            ])
        }
        "zset" => {
            expect_cells(old, 2, key_type)?;
            expect_cells(new, 2, key_type)?;
            parse_score(&new[1])?;
            if old[0] != new[0] {
                // Add the new member before removing the old one so a failed
                // ZADD cannot silently drop the only copy of the value.
                Ok(vec![
                    Command::new(
                        "ZADD",
                        vec![arg(key), new[1].clone(), new[0].clone()],
                    ),
                    Command::new("ZREM", vec![arg(key), old[0].clone()]),
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
        "stream" => Err(AppError::Unsupported(
            "Redis Streams entries are read-only in the value editor".into(),
        )),
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
            Ok(vec![build_list_delete(key, position)])
        }
        "stream" => Err(AppError::Unsupported(
            "Redis Streams entries are read-only in the value editor".into(),
        )),
        other => Err(AppError::Unsupported(format!(
            "The value editor does not support type \"{other}\""
        ))),
    }
}

pub fn build_set_ttl(key: &str, ttl: i64) -> Command {
    Command::new("EXPIRE", vec![arg(key), arg(ttl.to_string())])
}

/// Bulk TTL semantic: `0` removes the expiry instead of `EXPIRE 0` (which
/// deletes the key), while negative values keep the Redis delete behaviour.
pub fn build_ttl_command(key: &str, ttl: i64) -> Command {
    if ttl == 0 {
        build_persist(key)
    } else {
        build_set_ttl(key, ttl)
    }
}

pub fn build_persist(key: &str) -> Command {
    Command::new("PERSIST", vec![arg(key)])
}

/// Atomic rename that refuses to overwrite: `RENAMENX` returns 0 when the
/// destination exists, so nothing is modified in that case.
pub fn build_rename(old_key: &str, new_key: &str) -> Command {
    Command::new("RENAMENX", vec![arg(old_key), arg(new_key)])
}

/// Re-applies a hash field's remaining TTL after the value edit. `HEXPIRE`
/// takes the field list as `FIELDS 1 <field>` (Redis 7.4+).
pub fn build_hexpire_field(key: &str, field: &[u8], ttl: i64) -> Command {
    Command::new(
        "HEXPIRE",
        vec![
            arg(key),
            arg(ttl.to_string()),
            arg("FIELDS"),
            arg("1"),
            field.to_vec(),
        ],
    )
}

/// Millisecond-precision variant of [`build_hexpire_field`] (Redis 7.4+).
pub fn build_hpexpire_field(key: &str, field: &[u8], ttl_ms: i64) -> Command {
    Command::new(
        "HPEXPIRE",
        vec![
            arg(key),
            arg(ttl_ms.to_string()),
            arg("FIELDS"),
            arg("1"),
            field.to_vec(),
        ],
    )
}

pub fn build_delete_keys(keys: &[String]) -> Command {
    let mut args = Vec::with_capacity(keys.len());
    for key in keys {
        args.push(arg(key));
    }
    Command::new("DEL", args)
}

/// Estimated request-byte ceiling for one pipeline/DEL round trip. A small
/// batch of very long key names can still build a multi-megabyte request, so
/// bulk operations split by both item count and estimated bytes.
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;

/// End index of a key batch bounded by `max_count` and `MAX_BATCH_BYTES`.
/// Always advances by at least one key, so callers cannot loop forever.
fn batch_end(keys: &[String], start: usize, max_count: usize) -> usize {
    let mut bytes = 0usize;
    let mut end = start;
    while end < keys.len() && end - start < max_count {
        let cost = keys[end].len() + 16; // command name + RESP framing overhead
        if end > start && bytes + cost > MAX_BATCH_BYTES {
            break;
        }
        bytes += cost;
        end += 1;
    }
    end
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
            if !score.is_finite() {
                return Err(AppError::Invalid(
                    "The score must be a finite number".into(),
                ));
            }
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

/// Sends several integer-reply commands in one round trip (bulk TTL updates).
async fn run_pipeline(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    commands: &[Command],
) -> AppResult<Vec<i64>> {
    let mut pipe = redis::pipe();
    for command in commands {
        let item = pipe.cmd(command.name);
        for value in &command.args {
            item.arg(value);
        }
    }
    let replies: Vec<i64> = query_with_timeout(execute_timeout(config), pipe.query_async(conn)).await?;
    Ok(replies)
}

fn integer(value: &redis::Value) -> i64 {
    redis::from_redis_value::<i64>(value.clone()).unwrap_or(0)
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

    // Hash field TTLs are per-field (Redis 7.4+). Read the remaining TTL before
    // the write and re-apply it to the (possibly renamed) field afterwards, so
    // editing a value cannot silently turn an expiring field into a permanent
    // one. Older servers without HPTTL/HPEXPIRE fall back to seconds.
    let field_ttl = if key_type == "hash" {
        hash_field_ttl(conn, config, key, &old[0]).await
    } else {
        None
    };

    run_all(conn, config, &commands).await?;

    if let Some(ttl) = field_ttl {
        let command = match ttl {
            FieldTtl::Millis(millis) => build_hpexpire_field(key, &new[0], millis),
            FieldTtl::Seconds(seconds) => build_hexpire_field(key, &new[0], seconds),
        };
        run_all(conn, config, &[command]).await?;
    }
    Ok(())
}

/// Remaining expiry of a hash field, with the unit the server reported.
enum FieldTtl {
    Millis(i64),
    Seconds(i64),
}

/// Prefer `HPTTL` (milliseconds, Redis 7.4+) and fall back to `HTTL` when the
/// server does not know the command. Errors are swallowed on purpose:
/// preserving a field TTL is best-effort and must never block the value edit.
async fn hash_field_ttl(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    field: &[u8],
) -> Option<FieldTtl> {
    if let Some(ttl) = field_ttl_command(conn, config, key, field, "HPTTL").await {
        return (ttl > 0).then_some(FieldTtl::Millis(ttl));
    }
    let ttl = field_ttl_command(conn, config, key, field, "HTTL").await?;
    (ttl > 0).then_some(FieldTtl::Seconds(ttl))
}

/// Runs `<command> key FIELDS 1 field` and returns the raw TTL. `None` means the
/// command itself failed (e.g. an older server without field expiration); a
/// negative TTL (-1 no expiry, -2 missing field) is returned as-is.
async fn field_ttl_command(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    field: &[u8],
    command: &str,
) -> Option<i64> {
    let reply: redis::Value = query_with_timeout(
        execute_timeout(config),
        redis::cmd(command)
            .arg(key)
            .arg("FIELDS")
            .arg(1)
            .arg(field)
            .query_async(conn),
    )
    .await
    .ok()?;
    match reply {
        redis::Value::Array(items) => items
            .first()
            .and_then(|value| redis::from_redis_value::<i64>(value.clone()).ok()),
        redis::Value::Int(value) => Some(value),
        _ => None,
    }
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

    // The list delete is a single atomic EVAL; surface index/type errors that
    // the script reports instead of pretending every reply is success.
    if let [command] = commands.as_slice() {
        if command.name == "EVAL" {
            let reply = run(conn, config, command).await?;
            return match integer(&reply) {
                1 => Ok(()),
                -2 => Err(AppError::Message(
                    "The list row index is out of range".into(),
                )),
                -3 => Err(AppError::Message(
                    "The key is no longer a list".into(),
                )),
                status => Err(AppError::Message(format!(
                    "Deleting the list row failed (status {status})"
                ))),
            };
        }
    }

    run_all(conn, config, &commands).await
}

pub async fn set_ttl(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
    ttl: i64,
) -> AppResult<()> {
    if ttl <= 0 {
        return Err(AppError::Invalid(
            "TTL must be greater than zero; use PERSIST to remove an expiry".into(),
        ));
    }
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

/// Atomic `RENAMENX`. A rename is only performed when the destination is free:
/// an existing destination is reported as an error and neither key is touched.
/// On success the value and its TTL move with the key.
pub async fn rename_key(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    old_key: &str,
    new_key: &str,
    _ttl: i64,
) -> AppResult<()> {
    let reply = match run(conn, config, &build_rename(old_key, new_key)).await {
        Ok(reply) => reply,
        // Redis answers "ERR no such key"; wrap it so the dialog explains which
        // key failed instead of showing a bare server error.
        Err(error) => {
            return Err(AppError::Message(format!(
                "Cannot rename key {old_key}: {error}"
            )))
        }
    };

    match reply {
        redis::Value::Int(1) => Ok(()),
        redis::Value::Int(_) => Err(AppError::Message(format!(
            "Cannot rename key {old_key}: target key {new_key} already exists"
        ))),
        other => Err(AppError::Message(format!(
            "Cannot rename key {old_key}: unexpected reply {other:?}"
        ))),
    }
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
    let mut start = 0usize;
    while start < keys.len() {
        // 500 keys per DEL, but also stay under the request-byte ceiling.
        let end = batch_end(keys, start, 500);
        let reply = run(conn, config, &build_delete_keys(&keys[start..end])).await?;
        deleted += integer(&reply).max(0) as u64;
        start = end;
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
    if limit == 0 {
        return Ok(0);
    }
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
            // SCAN returns a page of up to COUNT keys, so deleting the whole
            // page could exceed the safety limit. Delete only what is left.
            let remaining = usize::try_from(limit.saturating_sub(deleted)).unwrap_or(usize::MAX);
            let take = keys.len().min(remaining);
            if take > 0 {
                let reply = run(conn, config, &build_delete_keys(&keys[..take])).await?;
                deleted += integer(&reply).max(0) as u64;
            }
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

/// Negative TTLs are rejected before reaching Redis: `EXPIRE key -1` deletes
/// the key, which is never what "set TTL in bulk" should do.
fn validate_bulk_ttl(ttl: i64) -> AppResult<()> {
    if ttl < 0 {
        return Err(AppError::Invalid(
            "The TTL must be 0 (persist) or a positive number of seconds".into(),
        ));
    }
    Ok(())
}

/// Bulk "Set TTL for multiple keys": SCAN the pattern, then send EXPIRE/PERSIST
/// in small pipelines. `0` means PERSIST (never `EXPIRE 0`, which would delete
/// the key); negative values are rejected instead of deleting keys.
///
/// `limit` counts keys that were *attempted*, not keys whose expiry changed:
/// PERSIST returns 0 for a key without a TTL, and using the changed count as
/// the limit would keep scanning the entire database in that case.
pub async fn set_ttl_by_pattern(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    pattern: &str,
    ttl: i64,
    limit: u64,
) -> AppResult<u64> {
    validate_bulk_ttl(ttl)?;
    if limit == 0 {
        return Ok(0);
    }
    const PIPELINE_BATCH: usize = 200;
    let mut cursor = 0u64;
    let mut processed = 0u64;
    let mut changed = 0u64;

    loop {
        let (next, keys) = scan_pattern_page(conn, config, cursor, pattern).await?;

        // Truncate the page to how many keys we may still attempt, then split
        // that slice by both count and estimated request bytes.
        let remaining = usize::try_from(limit.saturating_sub(processed)).unwrap_or(usize::MAX);
        let keys = &keys[..keys.len().min(remaining)];

        let mut start = 0usize;
        while start < keys.len() {
            let end = batch_end(keys, start, PIPELINE_BATCH);
            let batch: Vec<Command> = keys[start..end]
                .iter()
                .map(|key| build_ttl_command(key, ttl))
                .collect();
            let replies = run_pipeline(conn, config, &batch).await?;
            changed += replies.iter().filter(|reply| **reply > 0).count() as u64;
            processed += (end - start) as u64;
            start = end;
        }

        if processed >= limit || next == 0 {
            break;
        }
        cursor = next;
    }

    Ok(changed)
}

/// Sends a pipeline and returns one raw reply per command. Server errors are
/// raised by the pipeline as a single error, so callers that need per-key
/// attribution replay the batch on failure.
async fn run_value_pipeline(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    commands: &[Command],
) -> AppResult<Vec<redis::Value>> {
    let mut pipe = redis::pipe();
    for command in commands {
        let item = pipe.cmd(command.name);
        for value in &command.args {
            item.arg(value);
        }
    }
    let replies: Vec<redis::Value> =
        query_with_timeout(execute_timeout(config), pipe.query_async(conn)).await?;
    Ok(replies)
}

/// Keys per SCAN/DUMP batch before the byte ceiling is applied.
const COPY_SCAN_BATCH: usize = 150;

/// End index of a RESTORE batch bounded by `COPY_SCAN_BATCH` and
/// `MAX_BATCH_BYTES`. DUMP payloads dominate the request size.
fn restore_batch_end(payloads: &[(String, Vec<u8>)], start: usize) -> usize {
    let mut bytes = 0usize;
    let mut end = start;
    while end < payloads.len() && end - start < COPY_SCAN_BATCH {
        let cost = payloads[end].0.len() + payloads[end].1.len() + 24;
        if end > start && bytes + cost > MAX_BATCH_BYTES {
            break;
        }
        bytes += cost;
        end += 1;
    }
    end
}

fn finish_copy(copied: u64, skipped: u64, failures: &[String]) -> AppResult<u64> {
    if failures.is_empty() {
        return Ok(copied);
    }
    let shown = failures
        .iter()
        .take(5)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    Err(AppError::Message(format!(
        "Copied {copied} key(s), skipped {skipped}; {} key(s) failed: {shown}",
        failures.len()
    )))
}

/// Copy keys to another connection/database: DUMP on the source, RESTORE on
/// the target (CopyOperation's cluster-compatible approach), batched into
/// pipelines so a 10k-key copy does not cost 20k round trips.
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
    if limit == 0 {
        return Ok(0);
    }
    let mut cursor = 0u64;
    let mut copied = 0u64;
    let mut skipped = 0u64;
    let mut failures: Vec<String> = Vec::new();

    loop {
        let (next, keys) = scan_pattern_page(source, source_config, cursor, pattern).await?;
        let mut start = 0usize;
        while start < keys.len() {
            let remaining = usize::try_from(limit.saturating_sub(copied)).unwrap_or(usize::MAX);
            if remaining == 0 {
                return finish_copy(copied, skipped, &failures);
            }
            let end = batch_end(&keys, start, COPY_SCAN_BATCH.min(remaining));
            let batch = &keys[start..end];
            start = end;

            // One DUMP pipeline for the whole batch.
            let dump_commands: Vec<Command> = batch
                .iter()
                .map(|key| Command::new("DUMP", vec![arg(key)]))
                .collect();
            let dump_replies = run_value_pipeline(source, source_config, &dump_commands).await?;

            let mut payloads: Vec<(String, Vec<u8>)> = Vec::new();
            for (key, reply) in batch.iter().zip(dump_replies.iter()) {
                match reply {
                    redis::Value::BulkString(payload) if !payload.is_empty() => {
                        payloads.push((key.clone(), payload.clone()));
                    }
                    // The key vanished between SCAN and DUMP.
                    _ => skipped += 1,
                }
            }
            if payloads.is_empty() {
                continue;
            }

            // Keep the "do not overwrite" semantics: filter existing targets
            // before RESTORE so a BUSYKEY never has to be guessed from a
            // pipeline-wide error.
            if !replace {
                let exists_commands: Vec<Command> = payloads
                    .iter()
                    .map(|(key, _)| Command::new("EXISTS", vec![arg(key)]))
                    .collect();
                let exists_replies =
                    run_value_pipeline(target, target_config, &exists_commands).await?;
                payloads = payloads
                    .into_iter()
                    .zip(exists_replies.iter())
                    .filter_map(|((key, payload), reply)| {
                        if integer(reply) > 0 {
                            skipped += 1;
                            None
                        } else {
                            Some((key, payload))
                        }
                    })
                    .collect();
            }

            let mut index = 0usize;
            while index < payloads.len() {
                let end = restore_batch_end(&payloads, index);
                let slice = &payloads[index..end];
                index = end;
                let restore_commands: Vec<Command> = slice
                    .iter()
                    .map(|(key, payload)| build_copy_restore(key, ttl_seconds, payload, replace))
                    .collect();

                match run_value_pipeline(target, target_config, &restore_commands).await {
                    Ok(_) => copied += slice.len() as u64,
                    Err(_) => {
                        // The pipeline reports only the first server error. Replay
                        // this slice one key at a time to attribute failures.
                        // Existing targets were filtered above, so a BUSYKEY here
                        // means the failed pipeline already restored this key.
                        for (key, payload) in slice {
                            match run(
                                target,
                                target_config,
                                &build_copy_restore(key, ttl_seconds, payload, replace),
                            )
                            .await
                            {
                                Ok(_) => copied += 1,
                                Err(AppError::Redis(error))
                                    if error.to_string().contains("BUSYKEY") =>
                                {
                                    copied += 1;
                                }
                                Err(error) => failures.push(format!("{key}: {error}")),
                            }
                        }
                    }
                }

                if copied >= limit {
                    return finish_copy(copied, skipped, &failures);
                }
            }
        }

        if next == 0 {
            break;
        }
        cursor = next;
    }

    finish_copy(copied, skipped, &failures)
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
    fn string_save_uses_set_and_keeps_ttl() {
        let commands = build_save_string("k", b"hello");
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "SET");
        assert_eq!(commands[0].args, plain(&["k", "hello", "KEEPTTL"]));
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
        assert_eq!(renamed[0].name, "HSET");
        assert_eq!(renamed[0].args, plain(&["h", "new", "value"]));
        assert_eq!(renamed[1].name, "HDEL");
        assert_eq!(renamed[1].args, plain(&["h", "old"]));
    }

    #[test]
    fn hash_add_uses_hsetnx() {
        let commands =
            build_add_row("hash", "h", &plain(&["field", "value"])).unwrap();
        assert_eq!(commands[0].name, "HSETNX");
        assert_eq!(commands[0].args, plain(&["h", "field", "value"]));
    }

    #[test]
    fn set_update_adds_then_removes() {
        let commands =
            build_update_row("set", "s", &plain(&["old"]), &plain(&["new"]), None).unwrap();
        assert_eq!(commands[0].name, "SADD");
        assert_eq!(commands[0].args, plain(&["s", "new"]));
        assert_eq!(commands[1].name, "SREM");
        assert_eq!(commands[1].args, plain(&["s", "old"]));
    }

    #[test]
    fn set_update_with_unchanged_member_is_a_noop() {
        let commands =
            build_update_row("set", "s", &plain(&["same"]), &plain(&["same"]), None).unwrap();
        assert!(commands.is_empty());
    }

    #[test]
    fn zset_update_member_change_adds_then_removes() {
        let commands = build_update_row(
            "zset",
            "z",
            &plain(&["old", "1"]),
            &plain(&["new", "2"]),
            None,
        )
        .unwrap();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].name, "ZADD");
        assert_eq!(commands[0].args, plain(&["z", "2", "new"]));
        assert_eq!(commands[1].name, "ZREM");
        assert_eq!(commands[1].args, plain(&["z", "old"]));
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
    fn zset_rejects_non_finite_scores() {
        for score in ["NaN", "inf", "-inf", "Infinity"] {
            assert!(
                build_update_row(
                    "zset",
                    "z",
                    &plain(&["member", "1"]),
                    &plain(&["member", score]),
                    None
                )
                .is_err(),
                "{score} must be rejected"
            );
            assert!(parse_score(score.as_bytes()).is_err(), "{score} must be rejected");
        }
        assert!(parse_score(b"2.5").is_ok());
    }

    #[test]
    fn new_zset_key_rejects_non_finite_score() {
        let mut request = NewKeyRequest {
            key: "z".into(),
            key_type: "zset".into(),
            value: Some("member".into()),
            field: None,
            score: Some(f64::NAN),
            members: None,
            id: None,
        };
        assert!(build_new_key(&request).is_err());
        request.score = Some(f64::INFINITY);
        assert!(build_new_key(&request).is_err());
        request.score = Some(1.5);
        assert!(build_new_key(&request).is_ok());
    }

    #[test]
    fn list_update_uses_lset_with_position() {
        let update =
            build_update_row("list", "l", &plain(&["old"]), &plain(&["new"]), Some(3)).unwrap();
        assert_eq!(update[0].name, "LSET");
        assert_eq!(update[0].args, plain(&["l", "3", "new"]));
    }

    #[test]
    fn list_delete_uses_one_atomic_lua_script() {
        let delete = build_delete_row("list", "l", &plain(&["old"]), Some(-1)).unwrap();
        assert_eq!(delete.len(), 1, "a single EVAL keeps LSET+LREM atomic");
        let command = &delete[0];
        assert_eq!(command.name, "EVAL");
        assert_eq!(command.args[0], LIST_DELETE_SCRIPT.as_bytes().to_vec());
        assert_eq!(command.args[1], b"1".to_vec(), "one key");
        assert_eq!(command.args[2], b"l".to_vec());
        assert_eq!(command.args[4], b"-1".to_vec());

        let token = command.args[3].clone();
        let token_text = String::from_utf8(token.clone()).unwrap();
        // A random marker can never collide with a value already in the list.
        assert!(token_text.starts_with("__resp_deleted_"));
        assert!(token_text.ends_with("__"));

        // Two deletions must never share a marker.
        let second = build_delete_row("list", "l", &plain(&["old"]), Some(0)).unwrap();
        assert_ne!(second[0].args[3], token);
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
    fn stream_add_is_rejected_by_the_value_editor() {
        let cells = vec![
            CellInput::text("1-1"),
            CellInput::text(r#"{"name":"alice"}"#),
        ];
        let bytes: Vec<Vec<u8>> = cells.iter().map(|cell| cell.to_bytes().unwrap()).collect();
        assert!(build_add_row("stream", "st", &bytes).is_err());
    }

    #[test]
    fn stream_update_and_delete_are_rejected() {
        assert!(build_update_row(
            "stream",
            "st",
            &plain(&["1-1", "{}"]),
            &plain(&["1-1", "{}"]),
            None
        )
        .is_err());
        assert!(build_delete_row("stream", "st", &plain(&["1-1", "{}"]), None).is_err());
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
    fn rename_is_atomic_and_refuses_to_overwrite() {
        let rename = build_rename("old", "new");
        assert_eq!(rename.name, "RENAMENX");
        assert_eq!(rename.args, plain(&["old", "new"]));
        // A separate RESTORE/DEL sequence must no longer be built for rename.
        assert!(!rename.args.iter().any(|value| value == b"RESTORE"));
    }

    #[test]
    fn hash_field_ttl_restore_uses_hexpire_fields() {
        let restore = build_hexpire_field("h", b"f", 120);
        assert_eq!(restore.name, "HEXPIRE");
        assert_eq!(restore.args, plain(&["h", "120", "FIELDS", "1", "f"]));
    }

    #[test]
    fn hash_field_ttl_restore_prefers_milliseconds() {
        let restore = build_hpexpire_field("h", b"f", 120_500);
        assert_eq!(restore.name, "HPEXPIRE");
        assert_eq!(
            restore.args,
            plain(&["h", "120500", "FIELDS", "1", "f"])
        );
    }

    #[test]
    fn key_batches_respect_count_and_byte_limits() {
        let keys: Vec<String> = vec!["a".into(), "b".into(), "c".into()];
        assert_eq!(batch_end(&keys, 0, 2), 2);
        assert_eq!(batch_end(&keys, 2, 2), 3);

        // One huge key is still returned alone so batching always progresses.
        let long = "x".repeat(MAX_BATCH_BYTES + 1);
        let huge = vec![long.clone(), "tail".into()];
        assert_eq!(batch_end(&huge, 0, 500), 1);
        assert_eq!(batch_end(&huge, 1, 500), 2);
    }

    #[test]
    fn bulk_ttl_zero_means_persist() {
        assert_eq!(build_ttl_command("k", 0).name, "PERSIST");
        assert_eq!(build_ttl_command("k", 0).args, plain(&["k"]));
        assert_eq!(build_ttl_command("k", 30).name, "EXPIRE");
        assert_eq!(build_ttl_command("k", 30).args, plain(&["k", "30"]));
        // The raw builder still maps a negative TTL to EXPIRE, but the public
        // bulk API rejects it before any command is sent.
        assert_eq!(build_ttl_command("k", -1).name, "EXPIRE");
        assert_eq!(build_ttl_command("k", -1).args, plain(&["k", "-1"]));
    }

    #[test]
    fn negative_bulk_ttl_is_rejected() {
        assert!(validate_bulk_ttl(-1).is_err());
        assert!(validate_bulk_ttl(0).is_ok());
        assert!(validate_bulk_ttl(60).is_ok());
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
