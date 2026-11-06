mod console;
mod live;
mod manager;
mod meta;
mod monitor;
mod scan;
mod server;
mod value;
mod write;

pub use console::execute_console;
pub use live::{start_live_update, stop_live_update, LiveRegistry};
pub use manager::RedisPool;
pub use meta::{key_exists, key_meta_batch, parse_redis_url, server_facts, test_connection};
pub use monitor::{start_monitor, stop_monitor, MonitorRegistry};
pub use scan::{list_databases, scan_keys};
pub use server::{clients, config_get, memory_report, server_info, slowlog};
pub use value::{key_value_info, read_string_chunk, read_value_page};
pub use write::{
    add_row, copy_keys, create_key, delete_key, delete_keys, delete_keys_by_pattern, delete_row,
    flush_db, persist_key, rename_key, save_string_value, set_ttl, set_ttl_by_pattern, update_row,
    CellInput, NewKeyRequest, RowEditRequest,
};

/// Read-only smoke test against a real server. Disabled unless explicitly run:
///
/// ```text
/// RESP_TEST_HOST=... RESP_TEST_PASSWORD=... cargo test --lib read_only_smoke -- --ignored --nocapture
/// ```
///
/// It only issues INFO / CONFIG GET / COMMAND COUNT / SCAN / TYPE / TTL / EXISTS.
#[cfg(test)]
mod smoke_tests {
    use super::*;
    use crate::models::connection::ConnectionConfig;

    fn env_config() -> Option<ConnectionConfig> {
        let host = std::env::var("RESP_TEST_HOST").ok()?;
        let password = std::env::var("RESP_TEST_PASSWORD").unwrap_or_default();
        let port = std::env::var("RESP_TEST_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(6379);

        let mut config = ConnectionConfig::default();
        config.name = "read-only smoke".to_string();
        config.host = host;
        config.port = port;
        config.auth = password;
        Some(config)
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires RESP_TEST_HOST/RESP_TEST_PASSWORD and a read-only test server"]
    async fn read_only_smoke() {
        let Some(config) = env_config() else {
            eprintln!("skipped: RESP_TEST_HOST is not set");
            return;
        };

        let tested = test_connection(&config).await.expect("test_connection");
        println!(
            "test_connection: success={} message={} warning={:?}",
            tested.success, tested.message, tested.warning
        );
        assert!(tested.success);
        let facts = tested.facts.expect("server facts");
        println!(
            "facts: version={} mode={} cluster={} dbs={} commands={} modules={:?} keyspace={:?}",
            facts.version,
            facts.redis_mode,
            facts.cluster_enabled,
            facts.configured_databases,
            facts.command_count,
            facts.modules,
            facts
                .keyspace
                .iter()
                .map(|db| (db.index, db.keys))
                .collect::<Vec<_>>()
        );

        let (mut manager, used_resp3) = super::manager::connect(&config, 0)
            .await
            .expect("connect");
        println!("connected: resp3_negotiated={used_resp3} url_scheme_ok=true");

        let databases = list_databases(&mut manager, &config)
            .await
            .expect("list_databases");
        println!(
            "databases: {:?}",
            databases
                .iter()
                .map(|db| (db.index, db.keys))
                .collect::<Vec<_>>()
        );
        assert!(databases.iter().any(|db| db.index == 0));

        let page = scan_keys(&mut manager, &config, "0", None, Some("*"), 100)
            .await
            .expect("scan_keys");
        println!(
            "scan page: cursor={} keys={} request_page_size={}",
            page.cursor,
            page.keys.len(),
            page.page_size
        );
        assert!(!page.keys.is_empty());

        let sample: Vec<String> = page.keys.iter().take(10).cloned().collect();
        let metadata = key_meta_batch(&manager, &config, &sample)
            .await
            .expect("key_meta_batch");
        println!(
            "metadata: count={} types={:?}",
            metadata.len(),
            metadata.iter().map(|item| &item.key_type).collect::<Vec<_>>()
        );
        assert_eq!(metadata.len(), sample.len());

        let exists = key_exists(&mut manager, &config, &sample[0])
            .await
            .expect("key_exists");
        println!("key_exists(sampled_key)={exists}");
        assert!(exists);

        // Value editor read path. All commands are read-only (TYPE/TTL/OBJECT/
        // MEMORY/STRLEN/GETRANGE/HSCAN/ZRANGE). Keys are never printed because
        // the test data contains sensitive names.
        let mut seen_types = std::collections::BTreeSet::new();
        let mut string_checked = false;
        let mut hash_checked = false;
        let mut zset_checked = false;
        for key in &page.keys {
            let info = match key_value_info(&mut manager, &config, key).await {
                Ok(info) => info,
                Err(error) => {
                    eprintln!("key_value_info failed for a sampled key: {error}");
                    continue;
                }
            };
            seen_types.insert(info.key_type.clone());
            match info.key_type.as_str() {
                "string" if !string_checked => {
                    let chunk = read_string_chunk(&mut manager, &config, key, 0, 4096, None)
                        .await
                        .expect("read_string_chunk");
                    println!(
                        "string: len={:?} chunk_bytes={} total_chunks={:?} encoding={} truncated={}",
                        info.length,
                        chunk.payload.len(),
                        chunk.total_chunks,
                        chunk.encoding,
                        chunk.truncated
                    );
                    string_checked = true;
                }
                "hash" if !hash_checked => {
                    let page = read_value_page(&mut manager, &config, key, "hash", "0", 0, 10, false)
                        .await
                        .expect("hash page");
                    println!(
                        "hash: total={:?} rows={} columns={:?} cursor={} done={}",
                        page.total,
                        page.rows.len(),
                        page.columns,
                        page.cursor,
                        page.done
                    );
                    hash_checked = true;
                }
                "zset" if !zset_checked => {
                    let page = read_value_page(&mut manager, &config, key, "zset", "0", 0, 10, false)
                        .await
                        .expect("zset page");
                    println!(
                        "zset: total={:?} rows={} columns={:?} done={}",
                        page.total,
                        page.rows.len(),
                        page.columns,
                        page.done
                    );
                    zset_checked = true;
                }
                _ => {}
            }
        }
        println!("value types seen in sample: {seen_types:?}");
        println!(
            "value read path checked: string={string_checked} hash={hash_checked} zset={zset_checked}"
        );
        assert!(string_checked || hash_checked || zset_checked);

        // Stage 3: Server Actions (read-only) and a few console commands. No
        // write command is sent and sampled key names are never printed.
        let info = super::server_info(&mut manager, &config)
            .await
            .expect("server_info");
        println!(
            "server info sections: {:?}",
            info.sections
                .iter()
                .map(|section| (section.name.as_str(), section.fields.len()))
                .collect::<Vec<_>>()
        );
        assert!(info
            .sections
            .iter()
            .any(|section| section.name.eq_ignore_ascii_case("server")));
        assert!(info
            .sections
            .iter()
            .any(|section| section.name.eq_ignore_ascii_case("memory")));

        let slow = super::slowlog(&mut manager, &config, Some(15))
            .await
            .expect("slowlog");
        println!("slowlog entries: {}", slow.len());

        let clients = super::clients(&mut manager, &config)
            .await
            .expect("clients");
        println!("clients listed: {}", clients.len());
        assert!(!clients.is_empty());

        let config_rows = super::config_get(&mut manager, &config)
            .await
            .expect("config_get");
        println!(
            "config entries: {} ({:?})",
            config_rows.len(),
            config_rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>()
        );
        assert!(config_rows.iter().any(|row| row.name == "maxmemory"));

        let memory = super::memory_report(&mut manager, &config)
            .await
            .expect("memory_report");
        println!(
            "memory stats fields: {} doctor_chars: {}",
            memory.stats.len(),
            memory.doctor.len()
        );

        for command in ["DBSIZE", "SCAN 0 COUNT 5", "COMMAND INFO GET", "INFO server"] {
            let reply = super::execute_console(&mut manager, &config, 0, command)
                .await
                .expect("console read-only command");
            // Only counts are printed: SCAN/INFO output contains real key
            // names from the test database and must stay out of logs.
            println!(
                "console {:?}: ok={} error={:?} db={} lines={}",
                command,
                reply.error.is_none(),
                reply.error,
                reply.db,
                reply.output.lines().count()
            );
            assert!(reply.error.is_none());
        }


        let mut resp3_config = config.clone();
        resp3_config.protocol = "resp3".to_string();
        let resp3 = test_connection(&resp3_config)
            .await
            .expect("resp3 test_connection");
        println!(
            "resp3 request: success={} message={} warning={:?}",
            resp3.success, resp3.message, resp3.warning
        );
    }
}
