//! The real `genes/tavily-web-search` module against a fake Tavily.
//!
//! Strict-Test per ADR-264 §5, like `hybrid_wasm_tests`: the gene is built
//! from its source with `cargo build --target wasm32-unknown-unknown`, runs
//! in real wasmtime through `execute_gated`, and talks to a real HTTP server
//! on a loopback listener. The fake records every request byte it receives,
//! so the tests can check where the API key went — and where it did not.
//!
//! The run with a real key against api.tavily.com is not here: it needs the
//! user's own key and is done by hand (see the gene's README).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use super::wasmtime_sandbox::WasmtimeSandbox;
use super::{ConstraintSet, Sandbox, SandboxError};
use crate::types::gene::Phenotype;
use crate::types::{Context, ErrorCode, GeneResult, PermissionSet};

const SENTINEL: &str = "tvly-t93-sentinel-never-printed";

fn gene_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../genes/tavily-web-search")
}

/// Build the gene from source once per test run. Always rebuilt (cargo is
/// incremental), so the tests never run a stale module; a missing
/// `wasm32-unknown-unknown` target fails here with the fix, never skips.
fn gene_wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        let dir = gene_dir();
        let target = dir.join("target");
        let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path"])
            .arg(dir.join("Cargo.toml"))
            .arg("--target-dir")
            .arg(&target)
            // The outer test build's flags (coverage instrumentation, say)
            // are for the host, not for the gene.
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .status()
            .expect("could not run cargo to build genes/tavily-web-search");
        assert!(
            status.success(),
            "building genes/tavily-web-search failed — is the target installed? \
             `rustup target add wasm32-unknown-unknown`"
        );
        std::fs::read(target.join("wasm32-unknown-unknown/release/tavily_web_search.wasm")).unwrap()
    })
}

fn phenotype() -> Phenotype {
    serde_json::from_slice(&std::fs::read(gene_dir().join("phenotype.json")).unwrap()).unwrap()
}

/// The shipped phenotype, with the fake's address added to the whitelist
/// and to the dependency's domains — the only way a request can reach it.
fn phenotype_allowing_fake() -> Phenotype {
    let mut p = phenotype();
    p.network.as_mut().unwrap().allowed_domains.push("127.0.0.1".into());
    let dep = &mut p.external_dependencies.as_mut().unwrap()[0];
    dep.domains.as_mut().unwrap().push("127.0.0.1".into());
    p
}

struct FakeTavily {
    port: u16,
    /// Each request as received: request line, headers and body.
    requests: Arc<Mutex<Vec<String>>>,
}

impl FakeTavily {
    fn spawn(status: u16, body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let body = body.as_bytes().to_vec();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut req = Vec::new();
                let mut buf = [0u8; 8192];
                // Headers, then exactly Content-Length bytes of body.
                let body_start = loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break None;
                    }
                    req.extend_from_slice(&buf[..n]);
                    if let Some(i) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                        break Some(i + 4);
                    }
                };
                if let Some(start) = body_start {
                    let head = String::from_utf8_lossy(&req[..start]).to_ascii_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    while req.len() < start + len {
                        let n = stream.read(&mut buf).unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        req.extend_from_slice(&buf[..n]);
                    }
                }
                seen.lock().unwrap().push(String::from_utf8_lossy(&req).into_owned());
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len(),
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self { port, requests }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

/// A sandbox wired the way the CLI wires one — except that it may reach the
/// loopback fake, and `TAVILY_BASE_URL` points the gene at it.
fn run(
    fake: &FakeTavily,
    phenotype: &Phenotype,
    key: Option<&str>,
    input: serde_json::Value,
) -> Result<GeneResult, SandboxError> {
    let mut sandbox = WasmtimeSandbox::new(ConstraintSet {
        max_memory_bytes: 64 * 1024 * 1024,
        max_fuel: 4_000_000_000,
        max_execution_time_ms: 30_000,
        allowed_host_functions: Vec::new(),
        denied_host_functions: Vec::new(),
    })
    .unwrap();
    sandbox.set_insecure_loopback(true);
    let plain = HashMap::from([("TAVILY_BASE_URL".to_string(), fake.base_url())]);
    let secret = key
        .map(|k| HashMap::from([("TAVILY_API_KEY".to_string(), k.to_string())]))
        .unwrap_or_default();
    sandbox.set_hybrid_env(plain, secret);
    let context = Context {
        agent_id: "tavily-test".into(),
        timestamp: 1000,
        permissions: PermissionSet::declared_by(phenotype),
        trace_id: None,
        binding_extensions: None,
    };
    sandbox.execute_gated(gene_wasm(), &context, input, phenotype)
}

fn error_code(result: Result<GeneResult, SandboxError>) -> i32 {
    let message = match result {
        Err(e) => e.to_string(),
        Ok(other) => panic!("expected a gene error code, got {other:?}"),
    };
    message
        .split("gene returned error code: ")
        .nth(1)
        .and_then(|t| t.trim().parse().ok())
        .unwrap_or_else(|| panic!("no gene error code in: {message}"))
}

const TAVILY_OK: &str = r#"{
  "query": "rotifer protocol",
  "answer": null,
  "images": [],
  "response_time": 0.84,
  "results": [
    {"title": "Rotifer Protocol", "url": "https://rotifer.dev/", "content": "An evolution framework for AI agents.", "score": 0.91, "raw_content": null},
    {"title": "Rotifers", "url": "https://en.wikipedia.org/wiki/Rotifer", "content": "Rotifers are microscopic animals.", "score": 0.72, "raw_content": null}
  ]
}"#;

#[test]
fn the_key_goes_only_into_the_authorization_header_sent_to_tavily() {
    let fake = FakeTavily::spawn(200, TAVILY_OK);
    let result = run(
        &fake,
        &phenotype_allowing_fake(),
        Some(SENTINEL),
        serde_json::json!({"query": "rotifer protocol", "maxResults": 2}),
    );

    let (data, metadata) = match result {
        Ok(GeneResult::Success { data, metadata }) => (data, metadata),
        other => panic!("expected success, got {other:?}"),
    };
    assert_eq!(
        data,
        serde_json::json!({
            "results": [
                {"title": "Rotifer Protocol", "url": "https://rotifer.dev/", "snippet": "An evolution framework for AI agents."},
                {"title": "Rotifers", "url": "https://en.wikipedia.org/wiki/Rotifer", "snippet": "Rotifers are microscopic animals."}
            ],
            "totalResults": 2,
            "searchTime": 840.0
        })
    );

    let requests = fake.requests();
    assert_eq!(requests.len(), 1, "one search, one request");
    let req = &requests[0];
    assert!(req.starts_with("POST /search HTTP/1.1\r\n"), "{req}");
    let (head, body) = req.split_once("\r\n\r\n").unwrap();
    let auth: Vec<&str> = head
        .lines()
        .filter(|l| l.to_ascii_lowercase().starts_with("authorization:"))
        .collect();
    assert_eq!(auth.len(), 1, "{head}");
    assert_eq!(auth[0].split_once(':').unwrap().1.trim(), format!("Bearer {SENTINEL}"));
    assert_eq!(head.matches(SENTINEL).count(), 1, "the key appears once, in that header");
    assert!(!body.contains(SENTINEL), "the key is not in the request body");

    let sent: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(sent["query"], "rotifer protocol");
    assert_eq!(sent["max_results"], 2);
    assert_eq!(sent["include_answer"], false);
    assert_eq!(sent["include_raw_content"], false);

    for (what, text) in [("output", data.to_string()), ("metadata", format!("{metadata:?}"))] {
        assert!(!text.contains(SENTINEL), "the key leaked into the {what}: {text}");
    }
}

#[test]
fn a_key_tavily_rejects_is_reported_as_minus_201() {
    let fake = FakeTavily::spawn(401, r#"{"detail":{"error":"Unauthorized: missing or invalid API key."}}"#);
    let result = run(&fake, &phenotype_allowing_fake(), Some(SENTINEL), serde_json::json!({"query": "q"}));
    assert_eq!(error_code(result), -201);
    assert_eq!(fake.requests().len(), 1);
}

#[test]
fn a_usage_limit_is_reported_as_minus_202() {
    let fake = FakeTavily::spawn(432, r#"{"detail":{"error":"This request exceeds your plan's set usage limit."}}"#);
    let result = run(&fake, &phenotype_allowing_fake(), Some(SENTINEL), serde_json::json!({"query": "q"}));
    assert_eq!(error_code(result), -202);
}

/// The shipped phenotype whitelists api.tavily.com only. Pointing the gene
/// anywhere else is refused by the host (-3) before a byte is sent.
#[test]
fn a_host_outside_the_whitelist_is_refused_before_anything_is_sent() {
    let fake = FakeTavily::spawn(200, TAVILY_OK);
    let result = run(&fake, &phenotype(), Some(SENTINEL), serde_json::json!({"query": "q"}));
    assert_eq!(error_code(result), -3);
    assert!(fake.requests().is_empty(), "nothing reached the host outside the whitelist");
}

/// The CLI refuses earlier (it checks the environment before the run); this
/// is the sandbox's own backstop: an unresolvable `${env:…}` is -2, and the
/// request never leaves.
#[test]
fn without_a_key_the_request_never_leaves() {
    let fake = FakeTavily::spawn(200, TAVILY_OK);
    let result = run(&fake, &phenotype_allowing_fake(), None, serde_json::json!({"query": "q"}));
    assert_eq!(error_code(result), -2);
    assert!(fake.requests().is_empty());
}

#[test]
fn an_input_without_a_query_is_refused_without_a_search() {
    let fake = FakeTavily::spawn(200, TAVILY_OK);
    let result = run(&fake, &phenotype_allowing_fake(), Some(SENTINEL), serde_json::json!({"maxResults": 3}));
    match result {
        Ok(GeneResult::Error { code, message, .. }) => {
            assert_eq!(code, ErrorCode::InvalidInput);
            assert!(message.contains("query"), "{message}");
        }
        other => panic!("expected INVALID_INPUT, got {other:?}"),
    }
    assert!(fake.requests().is_empty());
}
