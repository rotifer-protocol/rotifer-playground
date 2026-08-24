//! Hybrid Binding API host functions — `rotifer.net` / `rotifer.kv` / `rotifer.env`.
//!
//! **`nonstandard` (spec §25.4):** these are the standard-optional capability
//! modules proposed by ADR-327 (Spec Change Backlog Tier 1, targeting IR spec
//! §6.2). Until that patch is formally merged through protocol governance,
//! this implementation is a binding-internal preview and MUST be labeled
//! nonstandard wherever it is documented. Import names are already the
//! protocol-proposed ones on purpose — never `rotifer.ext.*` (ADR-327 D6).

use std::collections::HashMap;
use std::time::Instant;

use crate::types::gene::{Phenotype, NetworkConfig};
use crate::types::PermissionSet;

/// Unified error codes shared by all three modules (ADR-327 D2).
/// Part of the ABI: guests may branch on them (e.g. run their declared
/// `degradationBehavior` on -3/-4/-5). Kept clear of `rotifer.gene.call`'s
/// -100 range.
pub mod errors {
    pub const ERR_BUFFER_TOO_SMALL: i32 = -1;
    pub const ERR_PERMISSION_DENIED: i32 = -2;
    pub const ERR_NOT_WHITELISTED: i32 = -3;
    pub const ERR_TIMEOUT: i32 = -4;
    pub const ERR_NETWORK: i32 = -5;
    pub const ERR_RESPONSE_TOO_LARGE: i32 = -6;
    pub const ERR_RATE_LIMITED: i32 = -7;
    pub const ERR_QUOTA_EXCEEDED: i32 = -8;
    pub const ERR_VALUE_TOO_LARGE: i32 = -9;
    pub const ERR_INVALID_REQUEST: i32 = -10;
    pub const ERR_UNDECLARED_DEPENDENCY: i32 = -11;
}

/// Metering constants (ADR-327 D4). All are `[N]`-channel initial values —
/// calibratable via governance without a spec break. The calibration
/// acceptance test is the anti-freeride invariant: moving work from guest to
/// host must never lower `resource_cost`. Seed calibration: measured guest
/// compute burns ≈9.5e9 fuel per wall-second (v0.9 fuel-ladder measurements).
pub mod constants {
    /// A network round-trip is never cheaper than ~0.1 s of guest compute.
    pub const BASE_CALL_FUEL_NET_FETCH: u64 = 1_000_000_000;
    /// A storage op ≈ 1 ms of guest compute.
    pub const BASE_CALL_FUEL_KV: u64 = 10_000_000;
    /// Near-free; still discourages hot-loop reads.
    pub const BASE_CALL_FUEL_ENV_READ: u64 = 100_000;
    /// 1 MiB transferred ≈ 1 s of guest compute.
    pub const PER_BYTE_FUEL: u64 = 10_000;
    pub const MAX_FETCH_TIMEOUT_MS: u32 = 10_000;
    pub const MAX_TOTAL_HOST_MILLIS: u64 = 30_000;
    pub const MAX_KV_KEYS: usize = 256;
    pub const MAX_KV_VALUE_BYTES: usize = 65_536;
    pub const MAX_KV_TOTAL_BYTES: usize = 4_194_304;
    /// Redirect hops followed inside the whitelist before giving up.
    pub const MAX_REDIRECT_HOPS: usize = 5;
}

/// Per-execution capability configuration, derived at the gated entry point
/// from the phenotype + deployer permissions. `Default` = everything denied,
/// which is what the ungated `execute()` path gets.
#[derive(Debug, Clone, Default)]
pub struct HybridConfig {
    /// `None` = network denied (permission layer 2 fails with -2).
    pub net: Option<NetPolicy>,
    /// Non-secret configuration readable via `rotifer.env.read`.
    pub env_plain: HashMap<String, String>,
    /// Secret values usable ONLY through `${env:NAME}` host-side header
    /// substitution — never readable from guest memory (ADR-327 D3).
    pub env_secret: HashMap<String, String>,
    /// Binding-internal test hook: permit plain-http requests to loopback
    /// addresses (and skip the IP-literal rejection for them). Never derived
    /// from a phenotype and never reachable from the CLI.
    pub allow_insecure_loopback: bool,
}

/// Effective network policy for one execution.
#[derive(Debug, Clone)]
pub struct NetPolicy {
    /// Protocol-layer whitelist (`phenotype.network.allowedDomains`).
    pub allowed_domains: Vec<String>,
    /// Union of `externalDependencies[].domains` — every request host must be
    /// attributable to a declared dependency (B-2; error -11).
    pub dependency_domains: Vec<String>,
    pub max_timeout_ms: u32,
    pub max_response_bytes: u64,
    /// Requests permitted within this execution. Approximates the phenotype's
    /// per-minute cap: executions are bounded well under a minute, so the cap
    /// is applied per run.
    pub max_requests: u32,
}

impl HybridConfig {
    /// Everything denied — the ungated / non-hybrid path.
    pub fn disabled() -> Self {
        Self::default()
    }

    /// Derive the per-execution config from a phenotype and the deployer's
    /// permission set. Network is enabled only when the deployer granted
    /// `network_access` AND the phenotype declares a `network` block.
    /// Env maps stay empty here — populating them is the binding's deployment
    /// wiring (`WasmtimeSandbox::set_hybrid_env`), never the phenotype's.
    pub fn from_phenotype(phenotype: &Phenotype, permissions: &PermissionSet) -> Self {
        let net = if permissions.network_access {
            phenotype.network.as_ref().map(|nc| {
                NetPolicy::from_network_config(nc, phenotype)
            })
        } else {
            None
        };
        Self {
            net,
            env_plain: HashMap::new(),
            env_secret: HashMap::new(),
            allow_insecure_loopback: false,
        }
    }
}

impl NetPolicy {
    fn from_network_config(nc: &NetworkConfig, phenotype: &Phenotype) -> Self {
        let dependency_domains = phenotype
            .external_dependencies
            .iter()
            .flatten()
            .filter_map(|d| d.domains.as_ref())
            .flatten()
            .map(|d| d.to_ascii_lowercase())
            .collect();
        Self {
            allowed_domains: nc.allowed_domains.iter().map(|d| d.to_ascii_lowercase()).collect(),
            dependency_domains,
            max_timeout_ms: nc.max_timeout_ms.min(constants::MAX_FETCH_TIMEOUT_MS),
            max_response_bytes: nc.max_response_bytes,
            max_requests: nc.max_requests_per_min,
        }
    }
}

/// Mutable per-execution state for the capability modules. Lives in
/// `HostState`; host function closures reach it via the store data.
#[derive(Debug, Default)]
pub struct HybridRuntime {
    pub config: HybridConfig,
    pub kv: KvStore,
    pub requests_made: u32,
    /// Retained response for the -1 buffer-too-small retry protocol:
    /// (request-envelope digest, serialized response envelope). An immediately
    /// repeated byte-identical request returns this without new network I/O.
    pub retained: Option<([u8; 32], Vec<u8>)>,
    pub host_call_millis: u64,
    pub host_calls: u64,
    pub host_bytes_in: u64,
    pub host_bytes_out: u64,
}

impl HybridRuntime {
    pub fn new(config: HybridConfig) -> Self {
        Self { config, ..Default::default() }
    }

    /// True once cumulative host time has exceeded the run's host budget.
    pub fn host_budget_exhausted(&self) -> bool {
        self.host_call_millis >= constants::MAX_TOTAL_HOST_MILLIS
    }
}

/// Gene-scoped key-value store — the substrate for `degradationBehavior:
/// "CACHE"`. Ephemeral per execution in this binding (persistence tiers are a
/// binding capability, negotiated, never assumed by genes).
#[derive(Debug, Default)]
pub struct KvStore {
    map: HashMap<String, Vec<u8>>,
    total_bytes: usize,
}

impl KvStore {
    /// Returns the value if present.
    pub fn get(&self, key: &str) -> Option<&[u8]> {
        self.map.get(key).map(|v| v.as_slice())
    }

    /// Returns 0 on success, or a negative error code:
    /// -9 value too large, -8 key-count or total-byte quota exceeded.
    pub fn put(&mut self, key: &str, value: &[u8]) -> i32 {
        if value.len() > constants::MAX_KV_VALUE_BYTES {
            return errors::ERR_VALUE_TOO_LARGE;
        }
        let existing = self.map.get(key).map(|v| v.len());
        if existing.is_none() && self.map.len() >= constants::MAX_KV_KEYS {
            return errors::ERR_QUOTA_EXCEEDED;
        }
        let new_total = self.total_bytes - existing.unwrap_or(0) + value.len();
        if new_total > constants::MAX_KV_TOTAL_BYTES {
            return errors::ERR_QUOTA_EXCEEDED;
        }
        self.map.insert(key.to_string(), value.to_vec());
        self.total_bytes = new_total;
        0
    }

    /// Idempotent delete; always 0.
    pub fn del(&mut self, key: &str) -> i32 {
        if let Some(old) = self.map.remove(key) {
            self.total_bytes -= old.len();
        }
        0
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// One parsed `rotifer.net.fetch` request envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct NetRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout_ms: Option<u32>,
}

/// Parse and structurally validate the JSON request envelope.
/// Errors with -10 (invalid request) on malformed JSON, missing/empty
/// method or url, unsupported method, or undecodable bodyBase64.
pub fn parse_request_envelope(bytes: &[u8]) -> Result<NetRequest, i32> {
    use base64::Engine as _;

    const METHODS: [&str; 6] = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];

    let v: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| errors::ERR_INVALID_REQUEST)?;

    let method = v
        .get("method")
        .and_then(|m| m.as_str())
        .filter(|m| METHODS.contains(m))
        .ok_or(errors::ERR_INVALID_REQUEST)?
        .to_string();

    let url = v
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|u| !u.is_empty())
        .ok_or(errors::ERR_INVALID_REQUEST)?
        .to_string();

    let mut headers = Vec::new();
    if let Some(h) = v.get("headers") {
        let obj = h.as_object().ok_or(errors::ERR_INVALID_REQUEST)?;
        for (name, value) in obj {
            let value = value.as_str().ok_or(errors::ERR_INVALID_REQUEST)?;
            headers.push((name.clone(), value.to_string()));
        }
    }

    let body = match v.get("bodyBase64") {
        None | Some(serde_json::Value::Null) => None,
        Some(b) => {
            let s = b.as_str().ok_or(errors::ERR_INVALID_REQUEST)?;
            Some(
                base64::engine::general_purpose::STANDARD
                    .decode(s)
                    .map_err(|_| errors::ERR_INVALID_REQUEST)?,
            )
        }
    };

    let timeout_ms = match v.get("timeoutMs") {
        None | Some(serde_json::Value::Null) => None,
        Some(t) => Some(
            t.as_u64()
                .filter(|&t| t > 0 && t <= u32::MAX as u64)
                .ok_or(errors::ERR_INVALID_REQUEST)? as u32,
        ),
    };

    Ok(NetRequest { method, url, headers, body, timeout_ms })
}

/// Validate a request URL against policy. Enforcement order defines which
/// error code wins (ADR-327 D5 layers 3–4):
/// scheme/host shape (-10) → whitelist (-3) → dependency attribution (-11).
/// `allow_insecure_loopback` permits `http://127.0.0.1` / `[::1]` /
/// `localhost` and skips the IP-literal rejection for loopback only.
pub fn check_url(
    policy: &NetPolicy,
    url_str: &str,
    allow_insecure_loopback: bool,
) -> Result<url::Url, i32> {
    let parsed = url::Url::parse(url_str).map_err(|_| errors::ERR_INVALID_REQUEST)?;

    let is_loopback = match parsed.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    let loopback_admitted = allow_insecure_loopback && is_loopback;

    // Layer: scheme/host shape (-10). https-only; IP literals rejected —
    // SSRF hardening — except loopback under the test hook.
    match parsed.scheme() {
        "https" => {}
        "http" if loopback_admitted => {}
        _ => return Err(errors::ERR_INVALID_REQUEST),
    }
    if !loopback_admitted
        && matches!(parsed.host(), Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_)))
    {
        return Err(errors::ERR_INVALID_REQUEST);
    }

    let host = parsed
        .host_str()
        .ok_or(errors::ERR_INVALID_REQUEST)?
        .to_ascii_lowercase();

    // Layer: protocol whitelist (-3). Exact host equality — no implicit
    // subdomains (evil.api.example.com must not ride on api.example.com).
    if !policy.allowed_domains.iter().any(|d| d == &host) {
        return Err(errors::ERR_NOT_WHITELISTED);
    }

    // Layer: dependency attribution (-11, B-2). The host must belong to a
    // declared externalDependencies entry; no declaration ⇒ no fetch.
    if !policy.dependency_domains.iter().any(|d| d == &host) {
        return Err(errors::ERR_UNDECLARED_DEPENDENCY);
    }

    Ok(parsed)
}

/// Host-side `${env:NAME}` substitution in header values (ADR-327 D3).
/// Secrets resolve here so their bytes never enter guest memory. An
/// unresolvable name is a permission error (-2) — never a silent passthrough.
pub fn substitute_headers(
    headers: &[(String, String)],
    plain: &HashMap<String, String>,
    secret: &HashMap<String, String>,
) -> Result<Vec<(String, String)>, i32> {
    let mut out = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let mut resolved = String::with_capacity(value.len());
        let mut rest = value.as_str();
        while let Some(start) = rest.find("${env:") {
            resolved.push_str(&rest[..start]);
            let after = &rest[start + 6..];
            let end = after.find('}').ok_or(errors::ERR_INVALID_REQUEST)?;
            let var = &after[..end];
            let val = secret
                .get(var)
                .or_else(|| plain.get(var))
                .ok_or(errors::ERR_PERMISSION_DENIED)?;
            resolved.push_str(val);
            rest = &after[end + 1..];
        }
        resolved.push_str(rest);
        out.push((name.clone(), resolved));
    }
    Ok(out)
}

/// Fuel surcharge for one host call (ADR-327 D4).
pub fn fuel_surcharge(base: u64, bytes_in: u64, bytes_out: u64) -> u64 {
    base.saturating_add(
        constants::PER_BYTE_FUEL.saturating_mul(bytes_in.saturating_add(bytes_out)),
    )
}

/// Perform the actual HTTP round-trip with manual, whitelist-checked
/// redirects. Returns the serialized response envelope JSON, or a negative
/// error code. Never called unless every policy layer already passed for the
/// initial URL.
pub fn perform_fetch(
    policy: &NetPolicy,
    allow_insecure_loopback: bool,
    req: &NetRequest,
    resolved_headers: &[(String, String)],
) -> Result<Vec<u8>, i32> {
    use base64::Engine as _;
    use std::io::Read as _;

    let timeout_ms = req
        .timeout_ms
        .unwrap_or(policy.max_timeout_ms)
        .min(policy.max_timeout_ms)
        .min(constants::MAX_FETCH_TIMEOUT_MS);

    let agent = ureq::AgentBuilder::new()
        .redirects(0) // manual redirect loop: every hop re-checked below
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build();

    let mut current_url = req.url.clone();
    for _hop in 0..=constants::MAX_REDIRECT_HOPS {
        let checked = check_url(policy, &current_url, allow_insecure_loopback)?;

        let mut request = agent.request(&req.method, checked.as_str());
        for (name, value) in resolved_headers {
            request = request.set(name, value);
        }

        let result = match &req.body {
            Some(body) => request.send_bytes(body),
            None => request.call(),
        };

        let response = match result {
            Ok(r) => r,
            // 4xx/5xx are valid protocol outcomes: the envelope carries them.
            Err(ureq::Error::Status(_, r)) => r,
            Err(ureq::Error::Transport(t)) => {
                let msg = t.to_string().to_ascii_lowercase();
                return Err(if msg.contains("timed out") || msg.contains("timeout") {
                    errors::ERR_TIMEOUT
                } else {
                    errors::ERR_NETWORK
                });
            }
        };

        // Whitelist-checked manual redirect.
        if (300..400).contains(&response.status())
            && let Some(location) = response.header("location")
        {
            let next = checked
                .join(location)
                .map_err(|_| errors::ERR_INVALID_REQUEST)?;
            current_url = next.to_string();
            continue;
        }

        let status = response.status();
        let mut resp_headers = serde_json::Map::new();
        for name in response.headers_names() {
            if let Some(v) = response.header(&name) {
                resp_headers.insert(name.to_ascii_lowercase(), serde_json::Value::String(v.to_string()));
            }
        }

        let mut body = Vec::new();
        let limit = policy.max_response_bytes;
        response
            .into_reader()
            .take(limit + 1)
            .read_to_end(&mut body)
            .map_err(|_| errors::ERR_NETWORK)?;
        if body.len() as u64 > limit {
            return Err(errors::ERR_RESPONSE_TOO_LARGE);
        }

        let envelope = serde_json::json!({
            "status": status,
            "headers": serde_json::Value::Object(resp_headers),
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode(&body),
        });
        return Ok(serde_json::to_vec(&envelope).expect("envelope serialization cannot fail"));
    }

    // Redirect chain longer than MAX_REDIRECT_HOPS.
    Err(errors::ERR_NETWORK)
}

/// The three capability module names (ADR-327 D2).
pub const CAPABILITY_MODULES: [&str; 3] = ["rotifer.net", "rotifer.kv", "rotifer.env"];

/// Cheap wasmparser scan: does this module import any capability module?
/// Malformed bytes report `false` — `Module::new` rejects them later with a
/// proper compilation error.
pub fn imports_capability_modules(wasm: &[u8]) -> bool {
    use wasmparser::{Parser, Payload};
    for payload in Parser::new(0).parse_all(wasm) {
        let Ok(Payload::ImportSection(reader)) = payload else { continue };
        for imports in reader.into_iter().flatten() {
            for entry in imports {
                let Ok((_, import)) = entry else { continue };
                if CAPABILITY_MODULES.contains(&import.module) {
                    return true;
                }
            }
        }
    }
    false
}

/// Wall-clock guard for one host call: measures elapsed time into the
/// runtime's cumulative counter and reports whether the budget was already
/// gone before the call.
pub struct HostCallTimer(Instant);

impl HostCallTimer {
    pub fn start() -> Self {
        Self(Instant::now())
    }
    pub fn stop_into(self, runtime: &mut HybridRuntime) {
        runtime.host_call_millis = runtime
            .host_call_millis
            .saturating_add(self.0.elapsed().as_millis() as u64);
        runtime.host_calls += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::gene::{ExternalDependency, Fidelity, GeneTransparency};

    // ── shared fixtures ─────────────────────────────────────────────────
    // Suite-wide constants (Strict-Test no-overfit per ADR-264 §5: one set of
    // parameters for every case; no per-case tuning).

    fn policy() -> NetPolicy {
        NetPolicy {
            allowed_domains: vec!["api.example.com".into(), "127.0.0.1".into()],
            dependency_domains: vec!["api.example.com".into(), "127.0.0.1".into()],
            max_timeout_ms: 5_000,
            max_response_bytes: 1_048_576,
            max_requests: 10,
        }
    }

    fn phenotype_hybrid() -> Phenotype {
        Phenotype {
            domain: "test.hybrid".into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "test".into(),
            created_at: 1000,
            ir_hash: None,
            fidelity: Fidelity::Hybrid,
            source_framework: None,
            regulatory_tags: None,
            transparency: GeneTransparency::Open,
            streaming_capability: None,
            pricing_hint: None,
            semantic_requirements: None,
            network: Some(NetworkConfig {
                allowed_domains: vec!["api.example.com".into()],
                max_timeout_ms: 5_000,
                max_response_bytes: 1_048_576,
                max_requests_per_min: 10,
            }),
            external_dependencies: Some(vec![ExternalDependency {
                api_type: "rest".into(),
                semantic_tag: "example-api".into(),
                domains: Some(vec!["api.example.com".into()]),
                credentials: Some(vec!["EXAMPLE_KEY".into()]),
                degradation_behavior: Some("FAIL".into()),
                sla: None,
            }]),
            llm_requirements: None,
            guard_config: None,
        }
    }

    // ── KvStore ─────────────────────────────────────────────────────────

    #[test]
    fn kv_put_get_del_roundtrip() {
        let mut kv = KvStore::default();
        assert_eq!(kv.put("k", b"v1"), 0);
        assert_eq!(kv.get("k"), Some(b"v1".as_ref()));
        assert_eq!(kv.put("k", b"v2"), 0, "overwrite is allowed");
        assert_eq!(kv.get("k"), Some(b"v2".as_ref()));
        assert_eq!(kv.del("k"), 0);
        assert_eq!(kv.get("k"), None);
        assert_eq!(kv.del("k"), 0, "delete is idempotent");
    }

    #[test]
    fn kv_value_too_large_rejected() {
        let mut kv = KvStore::default();
        let big = vec![0u8; constants::MAX_KV_VALUE_BYTES + 1];
        assert_eq!(kv.put("k", &big), errors::ERR_VALUE_TOO_LARGE);
        assert_eq!(kv.get("k"), None, "rejected put must not store");
        let exact = vec![0u8; constants::MAX_KV_VALUE_BYTES];
        assert_eq!(kv.put("k", &exact), 0, "exactly at the cap is fine");
    }

    #[test]
    fn kv_key_count_quota() {
        let mut kv = KvStore::default();
        for i in 0..constants::MAX_KV_KEYS {
            assert_eq!(kv.put(&format!("k{i}"), b"v"), 0);
        }
        assert_eq!(kv.put("one-too-many", b"v"), errors::ERR_QUOTA_EXCEEDED);
        // Overwriting an existing key is not a new key: still allowed.
        assert_eq!(kv.put("k0", b"v2"), 0);
        // Freeing a slot re-admits.
        assert_eq!(kv.del("k1"), 0);
        assert_eq!(kv.put("one-too-many", b"v"), 0);
    }

    #[test]
    fn kv_total_bytes_quota() {
        let mut kv = KvStore::default();
        let chunk = vec![0u8; constants::MAX_KV_VALUE_BYTES]; // 64 KiB
        let fits = constants::MAX_KV_TOTAL_BYTES / constants::MAX_KV_VALUE_BYTES; // 64
        for i in 0..fits {
            assert_eq!(kv.put(&format!("k{i}"), &chunk), 0, "chunk {i} should fit");
        }
        assert_eq!(kv.put("overflow", &chunk), errors::ERR_QUOTA_EXCEEDED);
        // Shrinking an existing value must release its accounting: after k0
        // shrinks to 4 bytes, a full chunk still misses by exactly those 4…
        assert_eq!(kv.put("k0", b"tiny"), 0);
        assert_eq!(kv.put("overflow", &chunk), errors::ERR_QUOTA_EXCEEDED);
        // …and deleting k0 outright frees enough.
        assert_eq!(kv.del("k0"), 0);
        assert_eq!(kv.put("overflow", &chunk), 0);
    }

    // ── request envelope ────────────────────────────────────────────────

    #[test]
    fn envelope_parses_minimal_get() {
        let req = parse_request_envelope(
            br#"{"method":"GET","url":"https://api.example.com/x"}"#,
        )
        .unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.url, "https://api.example.com/x");
        assert!(req.headers.is_empty());
        assert!(req.body.is_none());
    }

    #[test]
    fn envelope_parses_full_post() {
        let req = parse_request_envelope(
            br#"{"method":"POST","url":"https://api.example.com/x","headers":{"Accept":"application/json"},"bodyBase64":"aGk=","timeoutMs":1234}"#,
        )
        .unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.headers, vec![("Accept".to_string(), "application/json".to_string())]);
        assert_eq!(req.body.as_deref(), Some(b"hi".as_ref()));
        assert_eq!(req.timeout_ms, Some(1234));
    }

    #[test]
    fn envelope_rejects_malformed() {
        for bad in [
            &b"not json"[..],
            br#"{"url":"https://api.example.com"}"#,          // missing method
            br#"{"method":"GET"}"#,                            // missing url
            br#"{"method":"YEET","url":"https://a.com"}"#,     // unknown method
            br#"{"method":"GET","url":"https://a.com","bodyBase64":"@@@"}"#, // bad base64
        ] {
            assert_eq!(
                parse_request_envelope(bad).unwrap_err(),
                errors::ERR_INVALID_REQUEST,
                "should reject: {}",
                String::from_utf8_lossy(bad),
            );
        }
    }

    // ── URL policy checks ───────────────────────────────────────────────

    #[test]
    fn url_https_whitelisted_passes() {
        let u = check_url(&policy(), "https://api.example.com/v1/things?q=1", false).unwrap();
        assert_eq!(u.host_str(), Some("api.example.com"));
    }

    #[test]
    fn url_domain_matching_is_case_insensitive_and_exact() {
        assert!(check_url(&policy(), "https://API.Example.COM/x", false).is_ok());
        // Subdomains are NOT implicitly whitelisted.
        assert_eq!(
            check_url(&policy(), "https://evil.api.example.com/x", false).unwrap_err(),
            errors::ERR_NOT_WHITELISTED
        );
        // Suffix tricks neither.
        assert_eq!(
            check_url(&policy(), "https://notapi.example.com.evil.io/x", false).unwrap_err(),
            errors::ERR_NOT_WHITELISTED
        );
    }

    #[test]
    fn url_plain_http_rejected() {
        assert_eq!(
            check_url(&policy(), "http://api.example.com/x", false).unwrap_err(),
            errors::ERR_INVALID_REQUEST
        );
    }

    #[test]
    fn url_ip_literal_rejected() {
        // Even a whitelisted IP is rejected without the loopback test hook.
        assert_eq!(
            check_url(&policy(), "https://127.0.0.1/x", false).unwrap_err(),
            errors::ERR_INVALID_REQUEST
        );
        assert_eq!(
            check_url(&policy(), "https://192.168.1.1/x", false).unwrap_err(),
            errors::ERR_INVALID_REQUEST
        );
    }

    #[test]
    fn url_loopback_hook_permits_only_loopback() {
        // The hook admits plain-http loopback (any port)…
        assert!(check_url(&policy(), "http://127.0.0.1:8080/x", true).is_ok());
        // …but not plain http to real domains…
        assert_eq!(
            check_url(&policy(), "http://api.example.com/x", true).unwrap_err(),
            errors::ERR_INVALID_REQUEST
        );
        // …and not non-loopback IPs.
        assert_eq!(
            check_url(&policy(), "http://192.168.1.1/x", true).unwrap_err(),
            errors::ERR_INVALID_REQUEST
        );
    }

    #[test]
    fn url_not_whitelisted_vs_undeclared_dependency() {
        let mut p = policy();
        p.allowed_domains = vec!["api.example.com".into(), "cdn.example.com".into()];
        p.dependency_domains = vec!["api.example.com".into()];
        // Whitelisted but not attributable to any declared dependency → -11.
        assert_eq!(
            check_url(&p, "https://cdn.example.com/x", false).unwrap_err(),
            errors::ERR_UNDECLARED_DEPENDENCY
        );
        // Not whitelisted at all → -3 (whitelist wins over attribution).
        assert_eq!(
            check_url(&p, "https://other.example.com/x", false).unwrap_err(),
            errors::ERR_NOT_WHITELISTED
        );
    }

    // ── env substitution ────────────────────────────────────────────────

    #[test]
    fn substitution_resolves_secret_and_plain() {
        let plain = HashMap::from([("REGION".to_string(), "eu".to_string())]);
        let secret = HashMap::from([("KEY".to_string(), "s3cr3t".to_string())]);
        let out = substitute_headers(
            &[
                ("Authorization".into(), "Bearer ${env:KEY}".into()),
                ("X-Region".into(), "${env:REGION}".into()),
                ("Accept".into(), "application/json".into()),
            ],
            &plain,
            &secret,
        )
        .unwrap();
        assert_eq!(out[0].1, "Bearer s3cr3t");
        assert_eq!(out[1].1, "eu");
        assert_eq!(out[2].1, "application/json");
    }

    #[test]
    fn substitution_unknown_name_is_permission_denied() {
        assert_eq!(
            substitute_headers(
                &[("Authorization".into(), "Bearer ${env:NOPE}".into())],
                &HashMap::new(),
                &HashMap::new(),
            )
            .unwrap_err(),
            errors::ERR_PERMISSION_DENIED
        );
    }

    // ── config derivation ───────────────────────────────────────────────

    #[test]
    fn config_denies_network_without_permission() {
        let ph = phenotype_hybrid();
        let perms = PermissionSet::default(); // network_access: false
        let cfg = HybridConfig::from_phenotype(&ph, &perms);
        assert!(cfg.net.is_none());
    }

    #[test]
    fn config_derives_policy_from_phenotype() {
        let ph = phenotype_hybrid();
        let perms = PermissionSet { network_access: true, ..Default::default() };
        let cfg = HybridConfig::from_phenotype(&ph, &perms);
        let net = cfg.net.expect("network should be enabled");
        assert_eq!(net.allowed_domains, vec!["api.example.com"]);
        assert_eq!(net.dependency_domains, vec!["api.example.com"]);
        assert_eq!(net.max_requests, 10);
        assert!(!cfg.allow_insecure_loopback, "hook must never come from a phenotype");
    }

    #[test]
    fn config_without_network_block_denies_even_with_permission() {
        let mut ph = phenotype_hybrid();
        ph.network = None;
        let perms = PermissionSet { network_access: true, ..Default::default() };
        assert!(HybridConfig::from_phenotype(&ph, &perms).net.is_none());
    }

    // ── metering ────────────────────────────────────────────────────────

    #[test]
    fn surcharge_is_base_plus_bytes() {
        assert_eq!(fuel_surcharge(100, 0, 0), 100);
        assert_eq!(
            fuel_surcharge(constants::BASE_CALL_FUEL_KV, 10, 20),
            constants::BASE_CALL_FUEL_KV + 30 * constants::PER_BYTE_FUEL
        );
        assert_eq!(fuel_surcharge(u64::MAX, u64::MAX, 1), u64::MAX, "saturates");
    }
}
