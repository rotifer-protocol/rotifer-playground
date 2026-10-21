//! WASM-boundary integration tests for the hybrid host functions.
//!
//! Strict-Test per ADR-264 §5 (Gene WASM boundary): real wasmtime, real
//! local HTTP server over a loopback TcpListener — no mocks, no per-case
//! parameter tuning (all cases share the SUITE_* constants below), and every
//! rejection path asserts an explicit error code rather than a fallback.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::hybrid::{constants, errors, HybridConfig, NetPolicy};
use super::wasmtime_sandbox::WasmtimeSandbox;
use super::{ConstraintSet, Sandbox};
use crate::types::gene::{
    ExternalDependency, Fidelity, GeneTransparency, NetworkConfig, Phenotype,
};
use crate::types::{Context, GeneResult, PermissionSet};

// ── suite-wide constants (no-overfit: one parameter set for every case) ──

/// Fuel budget covering the net-fetch base surcharge (1e9) plus guest work.
const SUITE_FUEL: u64 = 4_000_000_000;
/// Matches the protocol-default `ResourceLimits.max_execution_time_ms` so the
/// L0 gate's limit comparison passes for default permissions.
const SUITE_TIMEOUT_MS: u64 = 30_000;
/// Where test genes keep their data segment (input JSON lands at offset 0).
const DATA: i32 = 1024;
/// Guest output buffer.
const OUT: i32 = 16384;
const OUT_CAP: i32 = 131072;

fn suite_constraints() -> ConstraintSet {
    ConstraintSet {
        max_memory_bytes: 64 * 1024 * 1024,
        max_fuel: SUITE_FUEL,
        max_execution_time_ms: SUITE_TIMEOUT_MS,
        allowed_host_functions: Vec::new(),
        denied_host_functions: Vec::new(),
    }
}

fn sandbox() -> WasmtimeSandbox {
    WasmtimeSandbox::new(suite_constraints()).unwrap()
}

fn ctx(network_access: bool) -> Context {
    Context {
        agent_id: "hybrid-test".into(),
        timestamp: 1000,
        permissions: PermissionSet { network_access, ..Default::default() },
        trace_id: None,
        binding_extensions: None,
    }
}

fn loopback_policy() -> NetPolicy {
    NetPolicy {
        allowed_domains: vec!["127.0.0.1".into()],
        dependency_domains: vec!["127.0.0.1".into()],
        max_timeout_ms: 5_000,
        max_response_bytes: 1_048_576,
        max_requests: 10,
    }
}

fn loopback_config() -> HybridConfig {
    HybridConfig {
        net: Some(loopback_policy()),
        env_plain: HashMap::new(),
        env_secret: HashMap::new(),
        allow_insecure_loopback: true,
    }
}

// ── minimal real HTTP server on a loopback listener ─────────────────────

struct TestServer {
    port: u16,
    hits: Arc<AtomicUsize>,
    requests_seen: Arc<Mutex<Vec<String>>>,
}

impl TestServer {
    /// Serve `status` + `body` for every request; optional redirect Location;
    /// optional artificial delay before responding.
    fn spawn(status: u16, body: Vec<u8>, location: Option<String>, delay_ms: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let requests_seen = Arc::new(Mutex::new(Vec::new()));
        let (hits_t, seen_t) = (hits.clone(), requests_seen.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                hits_t.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 8192];
                let mut req = Vec::new();
                // Read until end of headers (test genes send no bodies large
                // enough to matter).
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&buf[..n]);
                            if req.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                seen_t.lock().unwrap().push(String::from_utf8_lossy(&req).to_string());
                if delay_ms > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
                let extra = location
                    .as_ref()
                    .map(|l| format!("Location: {l}\r\n"))
                    .unwrap_or_default();
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    body.len(),
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self { port, hits, requests_seen }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
}

// ── test gene builder ───────────────────────────────────────────────────

struct HostImport {
    module: &'static str,
    name: &'static str,
    n_params: usize,
}

/// Build a direct-ABI gene: `express(i32, i32) -> i32`, one data segment at
/// DATA, two scratch i32 locals, the given body (builder appends `End`).
fn build_gene(imports: &[HostImport], data: &[u8], body: Vec<wasm_encoder::Instruction>) -> Vec<u8> {
    use wasm_encoder::*;

    let mut module = Module::new();

    let mut types = TypeSection::new();
    for imp in imports {
        types
            .ty()
            .function(vec![ValType::I32; imp.n_params], vec![ValType::I32]);
    }
    types
        .ty()
        .function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);

    let mut import_sec = ImportSection::new();
    for (i, imp) in imports.iter().enumerate() {
        import_sec.import(imp.module, imp.name, EntityType::Function(i as u32));
    }
    module.section(&import_sec);

    let mut functions = FunctionSection::new();
    functions.function(imports.len() as u32); // express
    module.section(&functions);

    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 4,
        maximum: Some(16),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);

    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, imports.len() as u32);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);

    let mut code = CodeSection::new();
    let mut f = Function::new(vec![(2, ValType::I32)]); // locals 2,3
    for ins in &body {
        f.instruction(ins);
    }
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);

    if !data.is_empty() {
        let mut data_sec = DataSection::new();
        data_sec.active(0, &ConstExpr::i32_const(DATA), data.iter().copied());
        module.section(&data_sec);
    }

    module.finish()
}

/// Body fragment: call import `func_idx` with the given i32 const args, keep
/// the result in local 2, and early-return it when negative.
fn call_and_bail_if_negative(
    func_idx: u32,
    args: &[i32],
) -> Vec<wasm_encoder::Instruction<'static>> {
    use wasm_encoder::Instruction as I;
    let mut v: Vec<I> = args.iter().map(|&a| I::I32Const(a)).collect();
    v.push(I::Call(func_idx));
    v.push(I::LocalSet(2));
    v.push(I::LocalGet(2));
    v.push(I::I32Const(0));
    v.push(I::I32LtS);
    v.push(I::If(wasm_encoder::BlockType::Empty));
    v.push(I::LocalGet(2));
    v.push(I::Return);
    v.push(I::End);
    v
}

fn fetch_import() -> HostImport {
    HostImport { module: "rotifer.net", name: "fetch", n_params: 4 }
}

/// A gene that performs one fetch of the envelope in its data segment and
/// returns the response envelope (or the negative error code).
fn build_fetch_gene(envelope: &str) -> Vec<u8> {
    use wasm_encoder::Instruction as I;
    let mut body = call_and_bail_if_negative(0, &[DATA, envelope.len() as i32, OUT, OUT_CAP]);
    body.push(I::I32Const(OUT));
    build_gene(&[fetch_import()], envelope.as_bytes(), body)
}

fn envelope_for(url: &str) -> String {
    format!(r#"{{"method":"GET","url":"{url}"}}"#)
}

fn run(
    sb: &WasmtimeSandbox,
    wasm: &[u8],
    config: HybridConfig,
) -> Result<GeneResult, super::SandboxError> {
    sb.execute_inner(wasm, &ctx(true), serde_json::json!({}), config)
}

fn expect_success(result: Result<GeneResult, super::SandboxError>) -> (serde_json::Value, crate::types::ExecutionMetadata) {
    match result.expect("execution should not error") {
        GeneResult::Success { data, metadata } => (data, metadata),
        GeneResult::Error { code, message, .. } => panic!("gene errored: {code}: {message}"),
    }
}

fn expect_error_code(result: Result<GeneResult, super::SandboxError>, code: i32) {
    let err = result.expect_err("execution should fail");
    let msg = err.to_string();
    assert!(
        msg.contains(&format!("error code: {code}")),
        "expected guest error code {code}, got: {msg}"
    );
}

fn body_of(envelope: &serde_json::Value) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(envelope["bodyBase64"].as_str().unwrap())
        .unwrap()
}

// ── rotifer.net ─────────────────────────────────────────────────────────

#[test]
fn wasm_fetch_success_returns_envelope_and_meters() {
    let server = TestServer::spawn(200, br#"{"hello":"world"}"#.to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/v1")));
    let (data, metadata) = expect_success(run(&sandbox(), &wasm, loopback_config()));

    assert_eq!(data["status"], 200);
    assert_eq!(body_of(&data), br#"{"hello":"world"}"#);
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);

    // Metering (ADR-327 D4): the surcharge is on the fuel bill, and the
    // host-side channel is reported.
    assert!(
        metadata.resource_cost >= constants::BASE_CALL_FUEL_NET_FETCH as f64,
        "fuel bill must include the fetch surcharge, got {}",
        metadata.resource_cost
    );
    let host = metadata.host.expect("host metering must be present");
    assert_eq!(host.host_calls, 1);
    assert!(host.host_bytes_in > 0);
    assert!(host.host_bytes_out > 0);
}

#[test]
fn wasm_fetch_denied_without_network_permission() {
    // Regression required by v0.9.3 §3.5 acceptance: the permission-denied
    // path. Config with net: None is exactly what a deployer who granted no
    // network produces.
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/")));
    let config = HybridConfig { net: None, allow_insecure_loopback: true, ..Default::default() };
    expect_error_code(run(&sandbox(), &wasm, config), errors::ERR_PERMISSION_DENIED);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0, "no network I/O may happen");
}

#[test]
fn wasm_fetch_not_whitelisted() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/")));
    let mut config = loopback_config();
    config.net.as_mut().unwrap().allowed_domains = vec!["api.example.com".into()];
    expect_error_code(run(&sandbox(), &wasm, config), errors::ERR_NOT_WHITELISTED);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[test]
fn wasm_fetch_undeclared_dependency() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/")));
    let mut config = loopback_config();
    config.net.as_mut().unwrap().dependency_domains = vec![];
    expect_error_code(run(&sandbox(), &wasm, config), errors::ERR_UNDECLARED_DEPENDENCY);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[test]
fn wasm_fetch_rate_limited() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let envelope = envelope_for(&server.url("/"));
    use wasm_encoder::Instruction as I;
    // Three sequential fetches; returns the first negative code, else OUT.
    let mut body = Vec::new();
    for _ in 0..3 {
        body.extend(call_and_bail_if_negative(0, &[DATA, envelope.len() as i32, OUT, OUT_CAP]));
    }
    body.push(I::I32Const(OUT));
    let wasm = build_gene(&[fetch_import()], envelope.as_bytes(), body);

    let mut config = loopback_config();
    config.net.as_mut().unwrap().max_requests = 2;
    expect_error_code(run(&sandbox(), &wasm, config), errors::ERR_RATE_LIMITED);
    assert_eq!(server.hits.load(Ordering::SeqCst), 2, "third request must not reach the wire");
}

#[test]
fn wasm_fetch_buffer_too_small_retry_reuses_response() {
    let server = TestServer::spawn(200, br#"{"payload":"sized-beyond-eight-bytes"}"#.to_vec(), None, 0);
    let envelope = envelope_for(&server.url("/"));
    use wasm_encoder::Instruction as I;

    // First call with an 8-byte buffer must yield -1; the retry with a real
    // buffer must succeed WITHOUT a second network round-trip (retained
    // response, ADR-327 §2.1).
    let mut body: Vec<I> = vec![
        I::I32Const(DATA),
        I::I32Const(envelope.len() as i32),
        I::I32Const(OUT),
        I::I32Const(8),
        I::Call(0),
        I::LocalSet(2),
        I::LocalGet(2),
        I::I32Const(errors::ERR_BUFFER_TOO_SMALL),
        I::I32Ne,
        I::If(wasm_encoder::BlockType::Empty),
        I::I32Const(-98), // sentinel: first call was supposed to be -1
        I::Return,
        I::End,
    ];
    body.extend(call_and_bail_if_negative(0, &[DATA, envelope.len() as i32, OUT, OUT_CAP]));
    body.push(I::I32Const(OUT));
    let wasm = build_gene(&[fetch_import()], envelope.as_bytes(), body);

    let (data, _) = expect_success(run(&sandbox(), &wasm, loopback_config()));
    assert_eq!(data["status"], 200);
    assert_eq!(
        server.hits.load(Ordering::SeqCst),
        1,
        "retry must be served from the retained response, not the network"
    );
}

#[test]
fn wasm_fetch_response_too_large() {
    let server = TestServer::spawn(200, vec![b'x'; 4096], None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/")));
    let mut config = loopback_config();
    config.net.as_mut().unwrap().max_response_bytes = 1024;
    expect_error_code(run(&sandbox(), &wasm, config), errors::ERR_RESPONSE_TOO_LARGE);
}

#[test]
fn wasm_fetch_redirect_outside_whitelist_rejected() {
    let server = TestServer::spawn(
        302,
        Vec::new(),
        Some("https://evil.example.com/steal".into()),
        0,
    );
    let wasm = build_fetch_gene(&envelope_for(&server.url("/")));
    expect_error_code(run(&sandbox(), &wasm, loopback_config()), errors::ERR_NOT_WHITELISTED);
}

#[test]
fn wasm_fetch_request_timeout() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 1_500);
    // Envelope-level timeoutMs — a request budget, not a per-case suite tweak.
    let envelope = format!(
        r#"{{"method":"GET","url":"{}","timeoutMs":300}}"#,
        server.url("/slow")
    );
    let wasm = build_fetch_gene(&envelope);
    expect_error_code(run(&sandbox(), &wasm, loopback_config()), errors::ERR_TIMEOUT);
}

// ── rotifer.kv ──────────────────────────────────────────────────────────

#[test]
fn wasm_kv_put_get_roundtrip() {
    use wasm_encoder::Instruction as I;
    // data: key "cache-key" (9 bytes) at DATA, value {"ok":true} (11) at DATA+9.
    let mut data = Vec::new();
    data.extend_from_slice(b"cache-key");
    data.extend_from_slice(br#"{"ok":true}"#);

    let imports = [
        HostImport { module: "rotifer.kv", name: "put", n_params: 4 },
        HostImport { module: "rotifer.kv", name: "get", n_params: 4 },
    ];
    let mut body = call_and_bail_if_negative(0, &[DATA, 9, DATA + 9, 11]);
    body.extend(call_and_bail_if_negative(1, &[DATA, 9, OUT, OUT_CAP]));
    // get returned 0 (missing) would be a bug here.
    body.extend([
        I::LocalGet(2),
        I::I32Eqz,
        I::If(wasm_encoder::BlockType::Empty),
        I::I32Const(-97),
        I::Return,
        I::End,
        I::I32Const(OUT),
    ]);
    let wasm = build_gene(&imports, &data, body);

    let (data, metadata) = expect_success(run(&sandbox(), &wasm, HybridConfig::disabled()));
    assert_eq!(data, serde_json::json!({"ok": true}));
    assert_eq!(metadata.host.expect("kv calls are metered").host_calls, 2);
}

#[test]
fn wasm_kv_del_removes_key() {
    use wasm_encoder::Instruction as I;
    let mut data = Vec::new();
    data.extend_from_slice(b"k");
    data.extend_from_slice(b"v");

    let imports = [
        HostImport { module: "rotifer.kv", name: "put", n_params: 4 },
        HostImport { module: "rotifer.kv", name: "del", n_params: 2 },
        HostImport { module: "rotifer.kv", name: "get", n_params: 4 },
    ];
    let mut body = call_and_bail_if_negative(0, &[DATA, 1, DATA + 1, 1]);
    body.extend(call_and_bail_if_negative(1, &[DATA, 1]));
    body.extend(call_and_bail_if_negative(2, &[DATA, 1, OUT, OUT_CAP]));
    body.extend([
        I::LocalGet(2),
        I::I32Eqz,
        I::If(wasm_encoder::BlockType::Empty),
        I::I32Const(-77), // expected: key is gone after del
        I::Return,
        I::End,
        I::I32Const(-96), // bug: value survived del
    ]);
    let wasm = build_gene(&imports, &data, body);
    expect_error_code(run(&sandbox(), &wasm, HybridConfig::disabled()), -77);
}

// ── rotifer.env ─────────────────────────────────────────────────────────

#[test]
fn wasm_env_plain_read() {
    use wasm_encoder::Instruction as I;
    let imports = [HostImport { module: "rotifer.env", name: "read", n_params: 4 }];
    let mut body = call_and_bail_if_negative(0, &[DATA, 3, OUT, OUT_CAP]);
    body.extend([
        I::LocalGet(2),
        I::I32Eqz,
        I::If(wasm_encoder::BlockType::Empty),
        I::I32Const(-95), // variable should have been granted
        I::Return,
        I::End,
        I::I32Const(OUT),
    ]);
    let wasm = build_gene(&imports, b"CFG", body);

    let mut config = HybridConfig::disabled();
    config.env_plain.insert("CFG".into(), r#"{"region":"eu"}"#.into());
    let (data, _) = expect_success(run(&sandbox(), &wasm, config));
    assert_eq!(data, serde_json::json!({"region": "eu"}));
}

#[test]
fn wasm_env_secret_is_unreadable_from_guest() {
    // ADR-327 D3: secret-tier values never enter guest memory — env.read on
    // a secret name is a permission error, full stop.
    let imports = [HostImport { module: "rotifer.env", name: "read", n_params: 4 }];
    let body = call_and_bail_if_negative(0, &[DATA, 3, OUT, OUT_CAP]);
    // Falls through only if read succeeded (>=0) — that itself is the bug;
    // returning OUT would surface garbage instead of the expected error.
    let mut body = body;
    body.push(wasm_encoder::Instruction::I32Const(-94));
    let wasm = build_gene(&imports, b"KEY", body);

    let mut config = HybridConfig::disabled();
    config.env_secret.insert("KEY".into(), "s3cr3t-value".into());
    expect_error_code(run(&sandbox(), &wasm, config), errors::ERR_PERMISSION_DENIED);
}

#[test]
fn wasm_env_absent_reads_zero() {
    use wasm_encoder::Instruction as I;
    let imports = [HostImport { module: "rotifer.env", name: "read", n_params: 4 }];
    let mut body = call_and_bail_if_negative(0, &[DATA, 3, OUT, OUT_CAP]);
    body.extend([
        I::LocalGet(2),
        I::I32Eqz,
        I::If(wasm_encoder::BlockType::Empty),
        I::I32Const(-93), // expected: absent variable reads as 0
        I::Return,
        I::End,
        I::I32Const(-92), // bug: something was returned for an ungranted name
    ]);
    let wasm = build_gene(&imports, b"CFG", body);
    expect_error_code(run(&sandbox(), &wasm, HybridConfig::disabled()), -93);
}

// ── secret substitution end-to-end ──────────────────────────────────────

#[test]
fn wasm_secret_substitution_reaches_wire_but_not_guest() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let envelope = format!(
        r#"{{"method":"GET","url":"{}","headers":{{"Authorization":"Bearer ${{env:KEY}}"}}}}"#,
        server.url("/auth")
    );
    let wasm = build_fetch_gene(&envelope);

    let mut config = loopback_config();
    config.env_secret.insert("KEY".into(), "s3cr3t-value".into());
    let (data, _) = expect_success(run(&sandbox(), &wasm, config));
    assert_eq!(data["status"], 200);

    let seen = server.requests_seen.lock().unwrap().join("\n");
    assert!(
        seen.contains("Bearer s3cr3t-value"),
        "substituted secret must reach the wire; request was:\n{seen}"
    );
}

// ── fidelity honesty + gated entry ──────────────────────────────────────

fn hybrid_phenotype(fidelity: Fidelity) -> Phenotype {
    Phenotype {
        domain: "test.hybrid".into(),
        input_schema: serde_json::json!({"type": "object"}),
        output_schema: serde_json::json!({"type": "object"}),
        dependencies: vec![],
        version: "0.1.0".into(),
        author: "test".into(),
        created_at: 1000,
        ir_hash: None,
        fidelity,
        source_framework: None,
        regulatory_tags: None,
        transparency: GeneTransparency::Open,
        streaming_capability: None,
        pricing_hint: None,
        semantic_requirements: None,
        network: Some(NetworkConfig {
            allowed_domains: vec!["127.0.0.1".into()],
            max_timeout_ms: 5_000,
            max_response_bytes: 1_048_576,
            max_requests_per_min: 10,
        }),
        external_dependencies: Some(vec![ExternalDependency {
            api_type: "rest".into(),
            semantic_tag: "loopback-test".into(),
            domains: Some(vec!["127.0.0.1".into()]),
            credentials: None,
            degradation_behavior: Some("FAIL".into()),
            sla: None,
        }]),
        llm_requirements: None,
        guard_config: None,
    }
}

#[test]
fn native_fidelity_with_capability_imports_is_rejected() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/")));
    let err = sandbox()
        .execute_with_phenotype(
            &wasm,
            &ctx(true),
            serde_json::json!({}),
            &hybrid_phenotype(Fidelity::Native),
        )
        .expect_err("native fidelity must not import capability modules");
    assert!(
        err.to_string().to_lowercase().contains("fidelity"),
        "error should name the fidelity violation, got: {err}"
    );
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[test]
fn e2e_execute_gated_hybrid_fetch() {
    // Full path: L0 gate → fidelity check → phenotype-derived policy →
    // host functions → real HTTP server (v0.9.3 §3.5 acceptance E2E).
    let server = TestServer::spawn(200, br#"{"price":42}"#.to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/api")));

    let mut sb = sandbox();
    sb.set_insecure_loopback(true);
    let result = sb.execute_gated(
        &wasm,
        &ctx(true),
        serde_json::json!({}),
        &hybrid_phenotype(Fidelity::Hybrid),
    );
    let (data, metadata) = expect_success(result);
    assert_eq!(data["status"], 200);
    assert_eq!(body_of(&data), br#"{"price":42}"#);
    assert!(metadata.host.is_some());
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
}

#[test]
fn e2e_execute_gated_denies_without_network_permission() {
    // The other half of the acceptance: same gene, deployer did NOT grant
    // network_access → the guest observes -2 and the wire stays silent.
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 0);
    let wasm = build_fetch_gene(&envelope_for(&server.url("/api")));

    let mut sb = sandbox();
    sb.set_insecure_loopback(true);
    let result = sb.execute_gated(
        &wasm,
        &ctx(false),
        serde_json::json!({}),
        &hybrid_phenotype(Fidelity::Hybrid),
    );
    expect_error_code(result, errors::ERR_PERMISSION_DENIED);
    assert_eq!(server.hits.load(Ordering::SeqCst), 0);
}

#[test]
fn native_gene_without_capability_imports_is_unaffected() {
    // Regression: the hybrid wiring must not disturb plain native genes.
    let wasm = crate::compiler::genesis::build_echo_gene_wasm();
    let mut ph = hybrid_phenotype(Fidelity::Native);
    ph.network = None;
    ph.external_dependencies = None;
    let result = sandbox().execute_with_phenotype(
        &wasm,
        &ctx(false),
        serde_json::json!({"echo": 1}),
        &ph,
    );
    let (data, metadata) = expect_success(result);
    assert_eq!(data, serde_json::json!({"echo": 1}));
    assert!(metadata.host.is_none(), "no host metering for pure native runs");
}

// ── perform_fetch behaviour pinned across the HTTP client (ureq 2 → 3) ──
//
// These call perform_fetch directly against loopback servers, so a change of
// HTTP client cannot quietly change what a gene sees: non-2xx statuses arrive
// in the envelope (not as errors), transport failures and timeouts map to
// their own codes, redirects are followed only by the whitelist-checked loop,
// response header names are lower-cased with the first value kept, and proxy
// environment variables are ignored.

use super::hybrid::{perform_fetch, NetRequest};

fn get(url: String, timeout_ms: Option<u32>) -> NetRequest {
    NetRequest { method: "GET".into(), url, headers: Vec::new(), body: None, timeout_ms }
}

fn envelope(bytes: Vec<u8>) -> serde_json::Value {
    serde_json::from_slice(&bytes).expect("envelope is JSON")
}

/// Serve exactly `response` (raw HTTP bytes) to every connection.
fn spawn_raw(response: &'static [u8]) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = [0u8; 8192];
            let mut req = Vec::new();
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                if req.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = stream.write_all(response);
        }
    });
    port
}

#[test]
fn fetch_non_2xx_status_is_returned_in_the_envelope() {
    for status in [404u16, 503] {
        let server = TestServer::spawn(status, br#"{"err":true}"#.to_vec(), None, 0);
        let env = envelope(
            perform_fetch(&loopback_policy(), true, &get(server.url("/x"), None), &[])
                .unwrap_or_else(|code| panic!("{status} must not be an error, got {code}")),
        );
        assert_eq!(env["status"], status);
        assert_eq!(body_of(&env), br#"{"err":true}"#);
    }
}

#[test]
fn fetch_transport_failure_is_a_network_error() {
    // A port nothing listens on: connection refused.
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let req = get(format!("http://127.0.0.1:{port}/x"), None);
    assert_eq!(perform_fetch(&loopback_policy(), true, &req, &[]), Err(errors::ERR_NETWORK));
}

#[test]
fn fetch_timeout_is_a_timeout_error() {
    let server = TestServer::spawn(200, b"{}".to_vec(), None, 2_000);
    let req = get(server.url("/slow"), Some(300));
    let started = std::time::Instant::now();
    assert_eq!(perform_fetch(&loopback_policy(), true, &req, &[]), Err(errors::ERR_TIMEOUT));
    assert!(started.elapsed() < std::time::Duration::from_millis(1_800), "the 300ms budget applies");
}

#[test]
fn fetch_follows_a_whitelisted_redirect_and_returns_a_bare_3xx() {
    let target = TestServer::spawn(200, br#"{"ok":1}"#.to_vec(), None, 0);
    let hop = TestServer::spawn(302, Vec::new(), Some(target.url("/final")), 0);
    let env = envelope(perform_fetch(&loopback_policy(), true, &get(hop.url("/start"), None), &[]).unwrap());
    assert_eq!(env["status"], 200);
    assert_eq!(body_of(&env), br#"{"ok":1}"#);
    assert_eq!(hop.hits.load(Ordering::SeqCst), 1);
    assert_eq!(target.hits.load(Ordering::SeqCst), 1);

    // A 3xx without Location is an ordinary response.
    let bare = TestServer::spawn(304, Vec::new(), None, 0);
    let env = envelope(perform_fetch(&loopback_policy(), true, &get(bare.url("/x"), None), &[]).unwrap());
    assert_eq!(env["status"], 304);
}

#[test]
fn fetch_lowercases_header_names_and_keeps_the_first_value() {
    let port = spawn_raw(
        b"HTTP/1.1 200 OK\r\nX-Dup: first\r\nX-Dup: second\r\nX-Mixed-Case: v\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    let env = envelope(
        perform_fetch(&loopback_policy(), true, &get(format!("http://127.0.0.1:{port}/h"), None), &[]).unwrap(),
    );
    assert_eq!(env["headers"]["x-dup"], "first");
    assert_eq!(env["headers"]["x-mixed-case"], "v");
    assert!(env["headers"].get("X-Mixed-Case").is_none());
}

/// Read one full request (headers, then Content-Length bytes of body), record
/// it, answer 200. Unlike TestServer it drains the body before replying, so
/// closing the socket never resets a client still writing.
fn spawn_capturing() -> (u16, Arc<Mutex<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_t = seen.clone();
    std::thread::spawn(move || {
        let Some(Ok(mut stream)) = listener.incoming().next() else { return };
        let mut req = Vec::new();
        let mut buf = [0u8; 8192];
        let header_end = loop {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                return;
            }
            req.extend_from_slice(&buf[..n]);
            if let Some(i) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                break i + 4;
            }
        };
        let head = String::from_utf8_lossy(&req[..header_end]).to_ascii_lowercase();
        let len: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        while req.len() < header_end + len {
            let n = stream.read(&mut buf).unwrap_or(0);
            if n == 0 {
                break;
            }
            req.extend_from_slice(&buf[..n]);
        }
        *seen_t.lock().unwrap() = req;
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    });
    (port, seen)
}

#[test]
fn fetch_sends_resolved_headers_and_body() {
    let (port, seen) = spawn_capturing();
    let req = NetRequest {
        method: "POST".into(),
        url: format!("http://127.0.0.1:{port}/p"),
        headers: Vec::new(),
        body: Some(b"payload".to_vec()),
        timeout_ms: None,
    };
    let headers = vec![("x-api-key".to_string(), "resolved-secret".to_string())];
    let env = envelope(perform_fetch(&loopback_policy(), true, &req, &headers).unwrap());
    assert_eq!(env["status"], 200);
    let seen = String::from_utf8_lossy(&seen.lock().unwrap()).to_string();
    let lower = seen.to_ascii_lowercase();
    assert!(lower.starts_with("post /p "), "method and path: {seen}");
    assert!(lower.contains("x-api-key: resolved-secret"), "header reached the wire: {seen}");
    assert!(seen.ends_with("\r\n\r\npayload"), "body reached the wire: {seen}");
}

/// Proxy variables must not route gene traffic around the whitelist. Runs the
/// probe below in a child process so the environment change cannot leak into
/// other tests running in parallel.
#[test]
fn fetch_ignores_proxy_environment_variables() {
    let exe = std::env::current_exe().unwrap();
    let proxy = "http://127.0.0.1:9";
    let out = std::process::Command::new(exe)
        .args(["--ignored", "--exact", "sandbox::hybrid_wasm_tests::proxy_env_probe", "--nocapture"])
        .env("HTTP_PROXY", proxy)
        .env("http_proxy", proxy)
        .env("HTTPS_PROXY", proxy)
        .env("ALL_PROXY", proxy)
        .env_remove("NO_PROXY")
        .env_remove("no_proxy")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && stdout.contains("1 passed"),
        "probe failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
#[ignore = "run by fetch_ignores_proxy_environment_variables with proxy variables set"]
fn proxy_env_probe() {
    assert!(std::env::var_os("HTTP_PROXY").is_some(), "only meaningful with proxy variables set");
    let server = TestServer::spawn(200, br#"{"direct":true}"#.to_vec(), None, 0);
    let env = envelope(perform_fetch(&loopback_policy(), true, &get(server.url("/d"), None), &[]).unwrap());
    assert_eq!(env["status"], 200);
    assert_eq!(server.hits.load(Ordering::SeqCst), 1, "request went to the server, not a proxy");
}
