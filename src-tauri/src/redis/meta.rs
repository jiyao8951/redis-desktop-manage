use std::collections::HashMap;

use redis::aio::ConnectionManager;
use redis::Value;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::models::server::{InfoField, InfoSection};
use crate::models::tree::{KeyMeta, ServerFacts, TestResult};

use super::manager::{connect, execute_timeout, query_with_timeout, SSH_UNSUPPORTED_MESSAGE};
use super::scan::parse_keyspace;

/// A TYPE+TTL pair per key, in key order.
const COMMANDS_PER_KEY: usize = 2;

/// Shared INFO parser: both Server Facts (flat key lookup) and Server Actions
/// (ordered sections) read the same Redis reply through this function.
pub fn parse_info_sections(info: &str) -> Vec<InfoSection> {
    let mut sections: Vec<InfoSection> = Vec::new();
    for raw in info.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('#') {
            sections.push(InfoSection {
                name: name.trim().to_string(),
                fields: Vec::new(),
            });
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if let Some(section) = sections.last_mut() {
            section.fields.push(InfoField {
                name: key.trim().to_string(),
                value: value.trim().to_string(),
            });
        }
    }
    sections.retain(|section| !section.fields.is_empty());
    sections
}

fn parse_info(info: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for section in parse_info_sections(info) {
        for field in section.fields {
            map.entry(field.name).or_insert(field.value);
        }
    }
    map
}

/// Loaded modules appear in INFO as `module:name=<name>,ver=...` lines.
fn module_names(info: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in info.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("module:name=") {
            let name = rest.split(',').next().unwrap_or(rest).trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
    }
    names
}

pub async fn server_facts(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
) -> AppResult<ServerFacts> {
    let info: String = query_with_timeout(
        execute_timeout(config),
        redis::cmd("INFO").query_async(conn),
    )
    .await?;
    let parsed = parse_info(&info);

    let command_count: u64 = query_with_timeout(
        execute_timeout(config),
        redis::cmd("COMMAND").arg("COUNT").query_async(conn),
    )
    .await
    .unwrap_or(0);

    let configured_databases = super::scan::configured_databases(conn, config).await;
    let keyspace = parse_keyspace(&info);

    Ok(ServerFacts {
        version: parsed.get("redis_version").cloned().unwrap_or_default(),
        redis_mode: parsed.get("redis_mode").cloned().unwrap_or_else(|| "standalone".into()),
        cluster_enabled: parsed.get("cluster_enabled").map(|v| v == "1").unwrap_or(false),
        configured_databases,
        keyspace,
        modules: module_names(&info),
        command_count,
    })
}

pub async fn test_connection(config: &ConnectionConfig) -> AppResult<TestResult> {
    if config.uses_ssh_tunnel() {
        return Ok(TestResult {
            success: false,
            message: SSH_UNSUPPORTED_MESSAGE.to_string(),
            warning: None,
            facts: None,
        });
    }

    let (mut conn, used_resp3) = match connect(config, 0).await {
        Ok(value) => value,
        Err(err) => {
            return Ok(TestResult {
                success: false,
                message: err.to_string(),
                warning: None,
                facts: None,
            })
        }
    };

    let facts = server_facts(&mut conn, config).await.ok();

    let mut warnings = Vec::new();
    if config.uses_resp3() && !used_resp3 {
        warnings.push("RESP3 was requested but the server fell back to RESP2.".to_string());
    }
    if config.uses_tls()
        && (!config.ssl_ca_cert_path.is_empty()
            || !config.ssl_local_cert_path.is_empty()
            || !config.ssl_private_key_path.is_empty())
    {
        warnings.push(
            "Custom TLS certificate files are stored but not loaded in this stage; \
             the system trust store is used instead."
                .to_string(),
        );
    }

    let message = match facts.as_ref() {
        Some(facts) if !facts.version.is_empty() => format!(
            "Connected to Redis {} ({})",
            facts.version,
            if facts.redis_mode.is_empty() {
                "standalone"
            } else {
                facts.redis_mode.as_str()
            }
        ),
        _ => "Connected to Redis server".to_string(),
    };

    Ok(TestResult {
        success: true,
        message,
        warning: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" "))
        },
        facts,
    })
}

/// Builds one pipeline with `TYPE key` + `TTL key` for every key. The
/// first pipeline stays at 50 so the first screen paints quickly; later
/// pipelines are larger to amortise round trips over the rest of the page.
fn meta_pipeline(keys: &[String]) -> redis::Pipeline {
    let mut pipe = redis::pipe();
    for key in keys {
        pipe.cmd("TYPE").arg(key).cmd("TTL").arg(key);
    }
    pipe
}

/// First screen size (kept identical to the old fixed batching).
const META_FIRST_BATCH: usize = 50;

/// Follow-up pipeline size. 500 keys means 1000 short commands per round trip,
/// which still fits comfortably in one TCP reply while cutting the 5000-key
/// case from ~100 calls to ~11.
const META_BATCH: usize = 500;

/// Splits the requested keys into `[0..50, 50..550, 550..1050, ...]`.
fn meta_batch_ranges(total: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut size = META_FIRST_BATCH;
    while start < total {
        let end = (start + size).min(total);
        ranges.push((start, end));
        start = end;
        size = META_BATCH;
    }
    ranges
}

/// TYPE replies are simple strings in RESP2 and RESP3; accept the other string
/// shapes defensively so a proxy that returns bulk strings still works.
fn type_reply(value: &Value) -> Option<String> {
    match value {
        Value::SimpleString(text) => Some(text.clone()),
        Value::BulkString(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        _ => None,
    }
}

/// Maps the flat pipeline reply (`[TYPE k0, TTL k0, TYPE k1, TTL k1, ...]`)
/// back to one `KeyMeta` per requested key. Anything unexpected degrades the
/// affected key to `unknown` / `-2`, matching the previous per-key behaviour.
fn meta_from_replies(keys: &[String], replies: Vec<Value>) -> Vec<KeyMeta> {
    keys.iter()
        .enumerate()
        .map(|(index, key)| {
            let type_index = index * COMMANDS_PER_KEY;
            let ttl_index = type_index + 1;
            let key_type = replies
                .get(type_index)
                .and_then(type_reply)
                .unwrap_or_else(|| "unknown".to_string());
            let ttl = match replies.get(ttl_index) {
                Some(Value::Int(value)) => *value,
                _ => -2,
            };
            KeyMeta {
                key: key.clone(),
                key_type,
                ttl,
            }
        })
        .collect()
}

fn unknown_metas(keys: &[String]) -> Vec<KeyMeta> {
    keys.iter()
        .map(|key| KeyMeta {
            key: key.clone(),
            key_type: "unknown".to_string(),
            ttl: -2,
        })
        .collect()
}

pub async fn key_meta_batch(
    conn: &ConnectionManager,
    config: &ConnectionConfig,
    keys: &[String],
) -> AppResult<Vec<KeyMeta>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }

    let mut conn = conn.clone();
    let mut metas = Vec::with_capacity(keys.len());

    for (start, end) in meta_batch_ranges(keys.len()) {
        let slice = &keys[start..end];
        let response = tokio::time::timeout(
            execute_timeout(config),
            meta_pipeline(slice).query_async::<Vec<Value>>(&mut conn),
        )
        .await;

        match response {
            Ok(Ok(replies)) => metas.extend(meta_from_replies(slice, replies)),
            // One transport/timeout failure only degrades that pipeline; the
            // other batches still return real metadata.
            _ => metas.extend(unknown_metas(slice)),
        }
    }

    Ok(metas)
}

pub async fn key_exists(
    conn: &mut ConnectionManager,
    config: &ConnectionConfig,
    key: &str,
) -> AppResult<bool> {
    let count: i64 = query_with_timeout(
        execute_timeout(config),
        redis::cmd("EXISTS").arg(key).query_async(conn),
    )
    .await?;
    Ok(count > 0)
}

// ---- Redis URL parsing ----------------------------------------------------

/// Mirrors ConnectionsManager::parseConfigFromRedisConnectionString(): the
/// host defaults to 127.0.0.1 for empty/localhost, the port to 6379, the
/// password may come from the userinfo or the `password` query item, and
/// `rediss://` or `?ssl=true` enables TLS. The path (db index) is ignored,
/// exactly like the original.
pub fn parse_redis_url(input: &str) -> AppResult<ConnectionConfig> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(AppError::Invalid("Redis URL is empty".to_string()));
    }

    let (scheme, rest) = match raw.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("redis".to_string(), raw),
    };
    if scheme != "redis" && scheme != "rediss" {
        return Err(AppError::Invalid(format!(
            "Unsupported Redis URL scheme: {scheme}"
        )));
    }

    let without_fragment = rest.split('#').next().unwrap_or(rest);
    let (authority_with_path, query) = match without_fragment.split_once('?') {
        Some((authority, query)) => (authority, query),
        None => (without_fragment, ""),
    };
    let authority = authority_with_path.split('/').next().unwrap_or("");

    let mut config = ConnectionConfig::default();
    config.ssl_enabled = scheme == "rediss";

    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "password" => config.auth = percent_decode(value),
            "ssl" => config.ssl_enabled = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }

    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((userinfo, hostport)) => (Some(userinfo), hostport),
        None => (None, authority),
    };

    if let Some(userinfo) = userinfo {
        let (username, password) = userinfo.split_once(':').unwrap_or((userinfo, ""));
        if !username.is_empty() {
            config.username = percent_decode(username);
        }
        if !password.is_empty() {
            config.auth = percent_decode(password);
        }
    }

    let (host, port) = split_host_port(hostport);
    config.host = if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1".to_string()
    } else {
        host
    };
    config.port = port;

    Ok(config)
}

fn split_host_port(value: &str) -> (String, u16) {
    if let Some(rest) = value.strip_prefix('[') {
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail
                .strip_prefix(':')
                .and_then(|port| port.parse::<u16>().ok())
                .unwrap_or(6379);
            return (format!("[{host}]"), port);
        }
    }

    match value.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse::<u16>().unwrap_or(6379))
        }
        _ => (value.to_string(), 6379),
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(hex);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_pipeline_emits_type_and_ttl_in_key_order() {
        let keys = vec!["alpha".to_string(), "beta".to_string()];
        let pipe = meta_pipeline(&keys);
        // redis 2.0 yields opaque `CmdRef` values from `cmd_iter`, so the
        // argument extraction is inlined instead of going through a helper
        // that would need to name that private type.
        let commands: Vec<Vec<String>> = pipe
            .cmd_iter()
            .map(|command| {
                command
                    .args_iter()
                    .filter_map(|arg| match arg {
                        redis::Arg::Simple(bytes) => {
                            Some(String::from_utf8_lossy(bytes).into_owned())
                        }
                        redis::Arg::Cursor => None,
                        _ => None,
                    })
                    .collect()
            })
            .collect();

        assert_eq!(commands.len(), keys.len() * COMMANDS_PER_KEY);
        assert_eq!(commands[0], vec!["TYPE", "alpha"]);
        assert_eq!(commands[1], vec!["TTL", "alpha"]);
        assert_eq!(commands[2], vec!["TYPE", "beta"]);
        assert_eq!(commands[3], vec!["TTL", "beta"]);
    }

    #[test]
    fn meta_from_replies_maps_each_pair_back_to_its_key() {
        let keys = vec!["alpha".to_string(), "beta".to_string()];
        let replies = vec![
            Value::SimpleString("string".into()),
            Value::Int(120),
            Value::BulkString(b"hash".to_vec()),
            Value::Int(-1),
        ];
        let metas = meta_from_replies(&keys, replies);

        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].key, "alpha");
        assert_eq!(metas[0].key_type, "string");
        assert_eq!(metas[0].ttl, 120);
        assert_eq!(metas[1].key, "beta");
        assert_eq!(metas[1].key_type, "hash");
        assert_eq!(metas[1].ttl, -1);
    }

    #[test]
    fn short_or_failed_reply_degrades_to_unknown() {
        let keys = vec!["alpha".to_string(), "beta".to_string()];
        // Only the first key came back (e.g. a truncated proxy reply).
        let replies = vec![Value::SimpleString("string".into()), Value::Int(10)];
        let metas = meta_from_replies(&keys, replies);
        assert_eq!(metas[1].key_type, "unknown");
        assert_eq!(metas[1].ttl, -2);

        let metas = unknown_metas(&keys);
        assert_eq!(metas.len(), 2);
        assert!(metas.iter().all(|meta| meta.ttl == -2));
        assert!(metas.iter().all(|meta| meta.key_type == "unknown"));
    }

    #[test]
    fn batches_keep_the_first_screen_at_fifty_then_grow() {
        assert_eq!(meta_batch_ranges(0), Vec::<(usize, usize)>::new());
        assert_eq!(meta_batch_ranges(50), vec![(0, 50)]);
        assert_eq!(meta_batch_ranges(51), vec![(0, 50), (50, 51)]);
        assert_eq!(meta_batch_ranges(5000), {
            let mut ranges = vec![(0, 50)];
            let mut start = 50;
            while start < 5000 {
                let end = (start + META_BATCH).min(5000);
                ranges.push((start, end));
                start = end;
            }
            ranges
        });
    }
}
