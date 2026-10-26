//! tavily-web-search — a Hybrid gene that searches the web through the
//! Tavily API (`POST https://api.tavily.com/search`).
//!
//! Input and output have the same shape as `genesis-web-search`:
//! `{query, maxResults?}` → `{results: [{title, url, snippet}], totalResults,
//! searchTime?}`. Unlike that demo, the results are real.
//!
//! The API key never enters this module. The request carries the literal
//! header `Authorization: Bearer ${env:TAVILY_API_KEY}`; the host substitutes
//! the value after the request leaves guest memory (ADR-327 D3), and only
//! because the phenotype declares `TAVILY_API_KEY` in
//! `externalDependencies[].credentials`. The CLI reads it from the
//! environment variable of the same name.
//!
//! **`nonstandard` (spec §25.4):** `rotifer.net` and `rotifer.env` are the
//! ADR-327 capability modules, a binding-internal preview until the IR spec
//! §6.2 patch is merged.
//!
//! Errors are returned as negative codes: the host's own codes pass through
//! unchanged (-2 permission, -3 not whitelisted, -4 timeout, -5 network,
//! -6 response too large, -7 rate limited, -10 invalid request, -11
//! undeclared dependency), and Tavily's answers map to the codes below —
//! in the -200 range, clear of the host's codes and of `rotifer.gene.call`'s
//! -100 range (IR spec §5):

use serde_json::{Value, json};

/// Tavily rejected the key (HTTP 401 / 403).
pub const ERR_KEY_REJECTED: i32 = -201;
/// Tavily's rate limit or the account's usage limit (HTTP 429 / 432 / 433).
pub const ERR_USAGE_LIMIT: i32 = -202;
/// Any other non-2xx answer from Tavily.
pub const ERR_API_STATUS: i32 = -203;
/// A 2xx answer this gene could not read.
pub const ERR_BAD_RESPONSE: i32 = -204;

pub const DEFAULT_BASE_URL: &str = "https://api.tavily.com";
pub const DEFAULT_MAX_RESULTS: u64 = 5;
pub const MAX_RESULTS: u64 = 20;

/// Why a run produced no results.
#[derive(Debug, PartialEq)]
pub enum Failure {
    /// The input does not conform to `inputSchema`: answered with the
    /// ADR-334 refusal envelope, never with a search.
    Refuse(String),
    /// A negative code, from the host or from the table above.
    Code(i32),
}

/// The validated input.
#[derive(Debug, PartialEq)]
pub struct Query {
    pub query: String,
    pub max_results: u64,
}

pub fn parse_input(bytes: &[u8]) -> Result<Query, Failure> {
    let v: Value = serde_json::from_slice(bytes)
        .map_err(|_| Failure::Refuse("input is not valid JSON".into()))?;
    let query = v
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .ok_or_else(|| Failure::Refuse("query is required: a non-empty string".into()))?
        .to_string();
    let max_results = match v.get("maxResults") {
        None | Some(Value::Null) => DEFAULT_MAX_RESULTS,
        Some(m) => m
            .as_u64()
            .filter(|n| (1..=MAX_RESULTS).contains(n))
            .ok_or_else(|| {
                Failure::Refuse(format!("maxResults must be an integer from 1 to {MAX_RESULTS}"))
            })?,
    };
    Ok(Query { query, max_results })
}

/// The `rotifer.net.fetch` request envelope. `base_url` is
/// [`DEFAULT_BASE_URL`] unless the binding grants the plain config value
/// `TAVILY_BASE_URL` (tests point it at a local fake; the CLI never sets it).
pub fn request_envelope(q: &Query, base_url: &str) -> Vec<u8> {
    use base64::Engine as _;
    let body = json!({
        "query": q.query,
        "max_results": q.max_results,
        "search_depth": "basic",
        "include_answer": false,
        "include_raw_content": false,
        "include_images": false,
    });
    let envelope = json!({
        "method": "POST",
        "url": format!("{}/search", base_url.trim_end_matches('/')),
        "headers": {
            "Authorization": "Bearer ${env:TAVILY_API_KEY}",
            "Content-Type": "application/json",
        },
        "bodyBase64": base64::engine::general_purpose::STANDARD.encode(body.to_string()),
    });
    envelope.to_string().into_bytes()
}

/// Map the host's response envelope to the gene's output.
pub fn read_response(envelope: &[u8]) -> Result<Value, Failure> {
    use base64::Engine as _;
    let env: Value = serde_json::from_slice(envelope).map_err(|_| Failure::Code(ERR_BAD_RESPONSE))?;
    let status = env.get("status").and_then(Value::as_u64).ok_or(Failure::Code(ERR_BAD_RESPONSE))?;
    match status {
        200..=299 => {}
        401 | 403 => return Err(Failure::Code(ERR_KEY_REJECTED)),
        429 | 432 | 433 => return Err(Failure::Code(ERR_USAGE_LIMIT)),
        _ => return Err(Failure::Code(ERR_API_STATUS)),
    }
    let body = env
        .get("bodyBase64")
        .and_then(Value::as_str)
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .ok_or(Failure::Code(ERR_BAD_RESPONSE))?;
    let body: Value = serde_json::from_slice(&body).map_err(|_| Failure::Code(ERR_BAD_RESPONSE))?;
    let items = body.get("results").and_then(Value::as_array).ok_or(Failure::Code(ERR_BAD_RESPONSE))?;

    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let results: Vec<Value> = items
        .iter()
        .filter(|item| !text(item, "url").is_empty())
        .map(|item| {
            json!({
                "title": text(item, "title"),
                "url": text(item, "url"),
                "snippet": text(item, "content"),
            })
        })
        .collect();

    let mut out = json!({ "totalResults": results.len(), "results": results });
    // Tavily reports seconds, as a number or a numeric string; the output
    // reports milliseconds, like genesis-web-search. Left out when absent.
    let seconds = match body.get("response_time") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.parse::<f64>().ok(),
        _ => None,
    };
    if let Some(s) = seconds.filter(|s| s.is_finite() && *s >= 0.0) {
        out["searchTime"] = json!((s * 1000.0).round());
    }
    Ok(out)
}

#[cfg(target_arch = "wasm32")]
mod guest {
    use super::*;

    #[link(wasm_import_module = "rotifer.net")]
    unsafe extern "C" {
        #[link_name = "fetch"]
        fn net_fetch(req_ptr: i32, req_len: i32, out_ptr: i32, out_cap: i32) -> i32;
    }

    #[link(wasm_import_module = "rotifer.env")]
    unsafe extern "C" {
        #[link_name = "read"]
        fn env_read(key_ptr: i32, key_len: i32, out_ptr: i32, out_cap: i32) -> i32;
    }

    /// Room for a full `maxResponseBytes` (1 MiB) body once base64 adds a third.
    const RESPONSE_CAP: usize = 2 * 1024 * 1024;

    /// `TAVILY_BASE_URL` if the binding granted it, else the real API. An
    /// unset plain name reads as length 0.
    fn base_url() -> String {
        let key = b"TAVILY_BASE_URL";
        let mut buf = vec![0u8; 512];
        let n = unsafe {
            env_read(key.as_ptr() as i32, key.len() as i32, buf.as_mut_ptr() as i32, buf.len() as i32)
        };
        if n > 0 {
            buf.truncate(n as usize);
            if let Ok(url) = String::from_utf8(buf) {
                return url;
            }
        }
        DEFAULT_BASE_URL.to_string()
    }

    fn run(input: &[u8]) -> Result<Value, Failure> {
        let q = parse_input(input)?;
        let req = request_envelope(&q, &base_url());
        let mut out = vec![0u8; RESPONSE_CAP];
        let n = unsafe {
            net_fetch(req.as_ptr() as i32, req.len() as i32, out.as_mut_ptr() as i32, out.len() as i32)
        };
        if n < 0 {
            return Err(Failure::Code(n));
        }
        out.truncate(n as usize);
        read_response(&out)
    }

    /// NUL-terminated JSON, leaked: the host reads it after `express` returns.
    fn emit(v: &Value) -> i32 {
        let mut bytes = v.to_string().into_bytes();
        bytes.push(0);
        let ptr = bytes.as_ptr() as i32;
        std::mem::forget(bytes);
        ptr
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn alloc(len: i32) -> i32 {
        let mut buf = Vec::<u8>::with_capacity(len.max(0) as usize);
        let ptr = buf.as_mut_ptr() as i32;
        std::mem::forget(buf);
        ptr
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn express(ptr: i32, len: i32) -> i32 {
        let input = unsafe { std::slice::from_raw_parts(ptr as *const u8, len.max(0) as usize) };
        match run(input) {
            Ok(out) => emit(&out),
            Err(Failure::Refuse(message)) => emit(&json!({ "__rotifer_error": { "message": message } })),
            Err(Failure::Code(code)) => code,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn response(status: u16, body: &str) -> Vec<u8> {
        json!({
            "status": status,
            "headers": {},
            "bodyBase64": base64::engine::general_purpose::STANDARD.encode(body),
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn input_needs_a_query_and_a_maxresults_in_range() {
        assert_eq!(
            parse_input(br#"{"query":"  rotifer  "}"#),
            Ok(Query { query: "rotifer".into(), max_results: 5 })
        );
        assert_eq!(parse_input(br#"{"query":"x","maxResults":20}"#).unwrap().max_results, 20);
        for bad in [&br#"{}"#[..], br#"{"query":"  "}"#, br#"{"query":3}"#, b"not json"] {
            assert!(matches!(parse_input(bad), Err(Failure::Refuse(_))), "{}", String::from_utf8_lossy(bad));
        }
        for bad in [&br#"{"query":"x","maxResults":0}"#[..], br#"{"query":"x","maxResults":21}"#, br#"{"query":"x","maxResults":2.5}"#] {
            assert!(matches!(parse_input(bad), Err(Failure::Refuse(_))), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn the_request_carries_a_placeholder_never_a_key() {
        let env: Value = serde_json::from_slice(&request_envelope(
            &Query { query: "q".into(), max_results: 3 },
            "https://api.tavily.com/",
        ))
        .unwrap();
        assert_eq!(env["method"], "POST");
        assert_eq!(env["url"], "https://api.tavily.com/search");
        assert_eq!(env["headers"]["Authorization"], "Bearer ${env:TAVILY_API_KEY}");
        let body = base64::engine::general_purpose::STANDARD.decode(env["bodyBase64"].as_str().unwrap()).unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["query"], "q");
        assert_eq!(body["max_results"], 3);
        assert_eq!(body["include_answer"], false);
        assert_eq!(body["include_raw_content"], false);
        assert!(body.get("api_key").is_none());
    }

    #[test]
    fn results_keep_title_url_and_snippet_only() {
        let out = read_response(&response(
            200,
            r#"{"query":"q","answer":"ignored","response_time":1.25,"results":[
                {"title":"A","url":"https://a.example/","content":"alpha","score":0.9,"raw_content":"long"},
                {"title":"no url","url":"","content":"dropped"}
            ]}"#,
        ))
        .unwrap();
        assert_eq!(
            out,
            json!({
                "results": [{"title": "A", "url": "https://a.example/", "snippet": "alpha"}],
                "totalResults": 1,
                "searchTime": 1250.0,
            })
        );
    }

    #[test]
    fn response_time_may_be_a_string_or_missing() {
        let out = read_response(&response(200, r#"{"results":[],"response_time":"0.5"}"#)).unwrap();
        assert_eq!(out["searchTime"], json!(500.0));
        let out = read_response(&response(200, r#"{"results":[]}"#)).unwrap();
        assert!(out.get("searchTime").is_none());
    }

    #[test]
    fn tavily_errors_map_to_documented_codes() {
        for (status, code) in [
            (401, ERR_KEY_REJECTED),
            (403, ERR_KEY_REJECTED),
            (429, ERR_USAGE_LIMIT),
            (432, ERR_USAGE_LIMIT),
            (433, ERR_USAGE_LIMIT),
            (400, ERR_API_STATUS),
            (500, ERR_API_STATUS),
        ] {
            assert_eq!(read_response(&response(status, "{}")), Err(Failure::Code(code)), "HTTP {status}");
        }
        assert_eq!(read_response(&response(200, "not json")), Err(Failure::Code(ERR_BAD_RESPONSE)));
        assert_eq!(read_response(&response(200, r#"{"answer":"x"}"#)), Err(Failure::Code(ERR_BAD_RESPONSE)));
    }
}
