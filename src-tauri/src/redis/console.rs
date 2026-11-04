use std::time::Instant;

use redis::aio::ConnectionManager;
use redis::Value;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::models::server::ConsoleReply;

use super::manager::{connect, execute_timeout, query_with_timeout};

/// Commands that turn the connection into a long-lived listener. The original
/// console keeps a dedicated connection open for them; this stage returns a
/// readable error instead of silently hanging the prompt.
const STREAMING_COMMANDS: &[&str] = &[
    "MONITOR",
    "SUBSCRIBE",
    "PSUBSCRIBE",
    "SSUBSCRIBE",
    "UNSUBSCRIBE",
    "PUNSUBSCRIBE",
    "SUNSUBSCRIBE",
];

/// Stateful commands would leak MULTI/WATCH state into the shared pool used by
/// the tree and value tabs, so they are rejected instead of executed unsafely.
const STATEFUL_COMMANDS: &[&str] = &["MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH"];

/// redis-cli style tokenizer: whitespace separates arguments, single and
/// double quotes group them, and `\n`, `\r`, `\t`, `\xHH` escapes work inside
/// double quotes.
pub fn split_command(input: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut has_token = false;
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\\' if in_double => {
                let Some(next) = chars.next() else {
                    current.push('\\');
                    break;
                };
                match next {
                    'n' => current.push('\n'),
                    'r' => current.push('\r'),
                    't' => current.push('\t'),
                    'x' => {
                        let mut hex = String::new();
                        for _ in 0..2 {
                            match chars.peek() {
                                Some(value) if value.is_ascii_hexdigit() => {
                                    if let Some(value) = chars.next() {
                                        hex.push(value);
                                    }
                                }
                                _ => break,
                            }
                        }
                        match u8::from_str_radix(&hex, 16) {
                            Ok(byte) => current.push(byte as char),
                            Err(_) => {
                                current.push('\\');
                                current.push('x');
                                current.push_str(&hex);
                            }
                        }
                    }
                    other => current.push(other),
                }
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            value if value.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    args.push(current.clone());
                    current.clear();
                    has_token = false;
                }
            }
            value => {
                current.push(value);
                has_token = true;
            }
        }
    }

    if in_single || in_double {
        return Err("Unbalanced quotes in command".to_string());
    }
    if has_token {
        args.push(current);
    }
    Ok(args)
}

fn quote_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn hex_preview(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn bulk_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => format!("(binary) {}", hex_preview(bytes)),
    }
}

fn format_list(items: &[Value], indent: usize) -> String {
    if items.is_empty() {
        return "(empty array)".to_string();
    }
    let pad = " ".repeat(indent);
    let mut out = String::new();
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push('\n');
            out.push_str(&pad);
        }
        out.push_str(&format!(
            "{}) {}",
            index + 1,
            format_value(item, indent + 3, true)
        ));
    }
    out
}

fn format_value(value: &Value, indent: usize, quoted: bool) -> String {
    match value {
        Value::Nil => "(nil)".to_string(),
        Value::Int(number) => format!("(integer) {number}"),
        Value::BulkString(bytes) => {
            let text = bulk_text(bytes);
            if quoted && !text.starts_with("(binary)") {
                quote_text(&text)
            } else {
                text
            }
        }
        Value::SimpleString(text) => {
            if quoted {
                quote_text(text)
            } else {
                text.clone()
            }
        }
        Value::Okay => "OK".to_string(),
        Value::Array(items) => format_list(items, indent),
        Value::Set(items) => format_list(items, indent),
        Value::Map(entries) => {
            if entries.is_empty() {
                return "(empty map)".to_string();
            }
            let pad = " ".repeat(indent);
            let mut out = String::new();
            for (index, (name, value)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push('\n');
                    out.push_str(&pad);
                }
                out.push_str(&format!(
                    "{}) {} => {}",
                    index + 1,
                    format_value(name, indent + 3, true),
                    format_value(value, indent + 3, true)
                ));
            }
            out
        }
        Value::Attribute { data, .. } => format_value(data, indent, quoted),
        Value::Push { data, .. } => format_list(data, indent),
        Value::Double(number) => format!("(double) {number}"),
        Value::Boolean(value) => format!("(boolean) {value}"),
        Value::VerbatimString { text, .. } => text.clone(),
        Value::ServerError(error) => format!("(error) {error:?}"),
        other => format!("(unsupported reply) {other:?}"),
    }
}

/// Formats a reply the way redis-cli prints it: `(integer)`, `(nil)`, numbered
/// array entries, `(error) ...` etc.
pub fn format_reply(value: &Value) -> String {
    format_value(value, 0, false)
}

fn rejected(input: &str, db: u32, message: String) -> ConsoleReply {
    ConsoleReply {
        command: input.to_string(),
        output: format!("(error) {message}"),
        error: Some(message),
        db,
        duration_ms: 0,
    }
}

pub async fn execute_console(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    db: u32,
    input: &str,
) -> AppResult<ConsoleReply> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("Console command is empty".to_string()));
    }

    let args = match split_command(trimmed) {
        Ok(args) if !args.is_empty() => args,
        Ok(_) => return Err(AppError::Invalid("Console command is empty".to_string())),
        Err(message) => return Ok(rejected(trimmed, db, message)),
    };

    let name = args[0].to_ascii_uppercase();

    if STREAMING_COMMANDS.contains(&name.as_str()) {
        return Ok(rejected(
            trimmed,
            db,
            format!(
                "{name} switches the connection to a listening mode. This stage cannot stream \
                 replies into the console; close the tab and use the dedicated Pub/Sub view once \
                 it is implemented."
            ),
        ));
    }

    if STATEFUL_COMMANDS.contains(&name.as_str()) {
        return Ok(rejected(
            trimmed,
            db,
            format!(
                "{name} needs a per-tab connection. The console reuses the shared connection \
                 pool in this stage, so transactions and WATCH are not executed."
            ),
        ));
    }

    // SELECT must not change the database of the shared pooled connection:
    // the pool key is the db index, and other tabs depend on it. Reconnecting
    // to the requested db gives the same user-visible behaviour.
    if name == "SELECT" {
        let target = args.get(1).ok_or_else(|| {
            AppError::Invalid("SELECT requires a database index".to_string())
        })?;
        let target_db: u32 = target
            .parse()
            .map_err(|_| AppError::Invalid(format!("Invalid database index: {target}")))?;
        connect(config, target_db).await?;
        return Ok(ConsoleReply {
            command: trimmed.to_string(),
            output: "OK".to_string(),
            error: None,
            db: target_db,
            duration_ms: 0,
        });
    }

    let mut command = redis::cmd(&args[0]);
    for arg in &args[1..] {
        command.arg(arg);
    }

    let started = Instant::now();
    let result: Result<Value, AppError> =
        query_with_timeout(execute_timeout(config), command.query_async(conn)).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(value) => Ok(ConsoleReply {
            command: trimmed.to_string(),
            output: format_reply(&value),
            error: None,
            db,
            duration_ms,
        }),
        Err(AppError::Redis(error)) => {
            let message = error.to_string();
            Ok(ConsoleReply {
                command: trimmed.to_string(),
                output: format!("(error) {message}"),
                error: Some(message),
                db,
                duration_ms,
            })
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_arguments() {
        assert_eq!(
            split_command("SET key \"hello world\"").unwrap(),
            vec!["SET", "key", "hello world"]
        );
        assert_eq!(
            split_command(r#"SET key "line\nnext""#).unwrap(),
            vec!["SET", "key", "line\nnext"]
        );
        assert_eq!(
            split_command("GET 'a b'").unwrap(),
            vec!["GET", "a b"]
        );
        assert!(split_command("SET key \"unbalanced").is_err());
        assert!(split_command("   ").unwrap().is_empty());
    }

    #[test]
    fn formats_replies_like_redis_cli() {
        assert_eq!(format_reply(&Value::Nil), "(nil)");
        assert_eq!(format_reply(&Value::Int(5)), "(integer) 5");
        assert_eq!(format_reply(&Value::Okay), "OK");
        assert_eq!(
            format_reply(&Value::Array(vec![
                Value::BulkString(b"a".to_vec()),
                Value::Int(1)
            ])),
            "1) \"a\"\n2) (integer) 1"
        );
    }
}
