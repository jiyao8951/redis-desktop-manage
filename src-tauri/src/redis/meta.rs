use std::collections::HashMap;
use std::sync::Arc;

use redis::aio::ConnectionManager;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;
use crate::models::server::{InfoField, InfoSection};
use crate::models::tree::{KeyMeta, ServerFacts, TestResult};

use super::manager::{
    connect, execute_timeout, query_with_timeout, SSH_UNSUPPORTED_MESSAGE,
};
use super::scan::parse_keyspace;

/// TYPE / TTL requests issued in parallel, matching the stage requirement of a
/// bounded async fan-out from the Rust side.
const META_CONCURRENCY: usize = 8;

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

pub async fn key_meta_batch(
    conn: &ConnectionManager,
    config: &ConnectionConfig,
    keys: &[String],
) -> AppResult<Vec<KeyMeta>> {
    let semaphore = Arc::new(Semaphore::new(META_CONCURRENCY));
    let timeout = execute_timeout(config);
    let mut set: JoinSet<(usize, KeyMeta)> = JoinSet::new();

    for (index, key) in keys.iter().enumerate() {
        let mut conn = conn.clone();
        let semaphore = semaphore.clone();
        let key = key.clone();

        set.spawn(async move {
            let unknown = |key: String| {
                (
                    index,
                    KeyMeta {
                        key,
                        key_type: "unknown".to_string(),
                        ttl: -2,
                    },
                )
            };

            let Ok(permit) = semaphore.acquire_owned().await else {
                return unknown(key);
            };
            let _permit = permit;

            let response = tokio::time::timeout(
                timeout,
                redis::pipe()
                    .cmd("TYPE")
                    .arg(&key)
                    .cmd("TTL")
                    .arg(&key)
                    .query_async::<(String, i64)>(&mut conn),
            )
            .await;

            match response {
                Ok(Ok((key_type, ttl))) => (
                    index,
                    KeyMeta {
                        key,
                        key_type,
                        ttl,
                    },
                ),
                _ => unknown(key),
            }
        });
    }

    let mut slots: Vec<Option<KeyMeta>> = vec![None; keys.len()];
    while let Some(joined) = set.join_next().await {
        if let Ok((index, meta)) = joined {
            if let Some(slot) = slots.get_mut(index) {
                *slot = Some(meta);
            }
        }
    }

    Ok(slots.into_iter().flatten().collect())
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
