//! Proof of registration (PoR), node side: checking the attestation a node
//! carries in its heartbeat (ADR-300 locked contract v2; P2P RFC §8.4).
//!
//! An issuer the receiver trusts signs a short JWT binding a PeerId to an
//! opaque account pseudonym (`sub`). It proves only that the node is held by a
//! registered account. It never upgrades an announcement to "verified gene"
//! (R22): nothing here touches announcements.
//!
//! What the checks decide (contract v2, "打分与罚分"):
//! - a valid, unexpired, unrevoked token bound to the authenticated source
//!   marks the source as attested;
//! - expired or revoked tokens are accepted with no standing;
//! - anything this node cannot decide by itself (an issuer it does not trust,
//!   keys it has not fetched, a token from its future) is ignored: the
//!   heartbeat is not forwarded and nobody is penalised, because another
//!   node's key cache may simply be newer (R17);
//! - only a cryptographically certain forgery is rejected and held against the
//!   authenticated source: a bad signature under a known key, or a valid token
//!   for another PeerId.
//!
//! Keys come only from the trust anchor list, never from the token (R16). Each
//! anchor's JWKS is fetched in the background, cached for at most 24 hours, on
//! disk too, and kept when a refetch fails (R3). The event loop never waits
//! for the network (R18).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use libp2p::identity::ed25519;
use serde::{Deserialize, Serialize};

use super::heartbeat::{MAX_ATTESTATION_BYTES, WireNodeHeartbeat};

/// The default (and, out of the box, only) trusted issuer (ADR-300 D3).
pub const DEFAULT_ISSUER: &str = "https://rotifer.dev";
/// Where the default issuer publishes its keys (ADR-300 D3).
pub const DEFAULT_JWKS_URL: &str = "https://rotifer.dev/.well-known/jwks.json";
/// The only `typ` a PoR token may carry: a login token from the same account
/// system cannot pass as an attestation (R16).
pub const TOKEN_TYPE: &str = "rotifer-por+jwt";
/// Longest allowed token lifetime, `exp - iat`.
pub const MAX_LIFETIME_SECS: u64 = 7 * 24 * 3600;
/// Clock tolerance on `iat` (future) and `exp`.
pub const CLOCK_SKEW_SECS: u64 = 60;
/// Contract v2 resource limits.
pub const MAX_TOKEN_BYTES: usize = MAX_ATTESTATION_BYTES;
pub const MAX_HEADER_BYTES: usize = 512;
/// A cached JWKS is refreshed after at most this long (or sooner, if the
/// issuer's `Cache-Control: max-age` says so).
pub const MAX_JWKS_CACHE_SECS: u64 = 24 * 3600;
/// Verification results kept, keyed by digest (contract: at most 4096).
pub const VERIFIED_CACHE_CAP: usize = 4096;
/// Heartbeats accepted per authenticated source per minute (R5, P2P RFC
/// §8.6). Counted per source, not per forwarding neighbour: an honest relay
/// carries many nodes' heartbeats.
pub const HEARTBEATS_PER_SOURCE_PER_MIN: usize = 2;
/// Sources whose heartbeat state is kept. Identities are free to mint, so the
/// bookkeeping must not grow with them.
pub const MAX_TRACKED_SOURCES: usize = super::security::MAX_TRACKED_PEERS;

// Implementation choices, not contract numbers (CEO 〔T-140〕 E5):
/// One fetch per issuer per minute, whatever triggered it (an unknown `kid`,
/// an expired cache, the first use of an issuer).
pub const JWKS_REFETCH_INTERVAL_SECS: u64 = 60;
/// Largest JWKS document read.
pub const MAX_JWKS_BYTES: u64 = 64 * 1024;
/// Whole-request timeout for a JWKS fetch.
pub const JWKS_FETCH_TIMEOUT: Duration = Duration::from_secs(5);

// GossipSub peer scoring (ADR-300 contract v2; parameters CEO 〔T-140〕 E7).
// Only the application-specific score (P5) is set; P1–P4 stay off.
/// Weight of the application-specific score.
pub const APP_SPECIFIC_WEIGHT: f64 = 1.0;
/// Score of a peer holding a valid registration, within its pseudonym's quota.
pub const REGISTERED_BONUS: f64 = 20.0;
/// Registered peers per pseudonym that get the bonus: the earliest verified
/// valid among connected peers. Stricter than the contract's "per topic
/// mesh", because GossipSub's application score is per peer, not per topic.
pub const BONUS_PEERS_PER_PSEUDONYM: usize = 2;
/// Score of one certain forgery (bad signature, or a token for another
/// PeerId). Never for a token this node cannot decide (R17).
pub const FORGERY_PENALTY: f64 = -100.0;
/// How long a forgery counts against its source.
pub const FORGERY_WINDOW_MS: u64 = 24 * 3600 * 1000;
/// Lowest score forgeries can bring a peer to.
pub const FORGERY_FLOOR: f64 = -300.0;
/// Forgeries remembered per source: enough to reach the floor.
const COUNTED_FORGERIES: usize = 3;
/// Scores are recomputed after every heartbeat decision and this often.
pub const SCORE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

// ---------------------------------------------------------------------------
// Trust anchors

/// A trusted issuer: tokens whose `iss` is exactly `iss` are checked against
/// the keys published at `jwks_url` (contract v2, "信任锚"; R14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustAnchor {
    pub iss: String,
    pub jwks_url: String,
}

/// The default list: just `https://rotifer.dev`.
pub fn default_trust_anchors() -> Vec<TrustAnchor> {
    vec![TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: DEFAULT_JWKS_URL.into() }]
}

/// A JWKS address must be https, except plain http to this machine for local
/// test setups (an implementation choice, CEO 〔T-140〕 E5).
pub fn check_jwks_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|e| format!("JWKS address {raw}: {e}"))?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    match url.scheme() {
        "https" if url.host().is_some() => Ok(()),
        "http" if loopback => Ok(()),
        _ => Err(format!("JWKS address {raw} must be https (plain http only to a loopback address)")),
    }
}

/// Check a configured anchor list: valid addresses, no issuer twice.
pub fn check_trust_anchors(anchors: &[TrustAnchor]) -> Result<(), String> {
    for (i, a) in anchors.iter().enumerate() {
        if a.iss.is_empty() {
            return Err("a trust anchor needs an iss".into());
        }
        check_jwks_url(&a.jwks_url)?;
        if anchors[..i].iter().any(|b| b.iss == a.iss) {
            return Err(format!("trust anchor {} is listed twice", a.iss));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// JWKS

/// An issuer's published keys and revocations (contract v2, "JWKS 文件"): a
/// JWK Set plus `rotifer_revoked`, `[{ peer_id, not_after }]`, meaning "every
/// token for this PeerId with `iat <= not_after` is void".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Jwks {
    keys: HashMap<String, [u8; 32]>,
    revoked: Vec<(String, u64)>,
}

impl Jwks {
    /// Parse a JWKS document. Keys of other types are skipped (RFC 7517);
    /// a revocation list this node cannot read fails the whole document, so
    /// a revocation is never silently missed and the previous copy stays.
    pub fn parse(body: &[u8]) -> Result<Self, String> {
        let doc: serde_json::Value = serde_json::from_slice(body).map_err(|e| format!("JWKS is not JSON: {e}"))?;
        let obj = doc.as_object().ok_or("JWKS is not a JSON object")?;
        let keys = obj.get("keys").and_then(|k| k.as_array()).ok_or("JWKS has no keys array")?;
        let mut parsed = HashMap::new();
        for key in keys {
            let s = |name: &str| key.get(name).and_then(|v| v.as_str());
            let usable = s("kty") == Some("OKP")
                && s("crv") == Some("Ed25519")
                && key.get("alg").is_none_or(|a| a.as_str() == Some("EdDSA"))
                && key.get("use").is_none_or(|u| u.as_str() == Some("sig"));
            let (true, Some(kid), Some(x)) = (usable, s("kid"), s("x")) else { continue };
            let Ok(raw) = B64.decode(x) else { continue };
            let Ok(raw) = <[u8; 32]>::try_from(raw.as_slice()) else { continue };
            if kid.is_empty() {
                continue;
            }
            if parsed.insert(kid.to_string(), raw).is_some() {
                return Err(format!("JWKS lists kid {kid} twice"));
            }
        }
        let mut revoked = Vec::new();
        if let Some(list) = obj.get("rotifer_revoked") {
            for r in list.as_array().ok_or("rotifer_revoked is not an array")? {
                let peer = r.get("peer_id").and_then(|p| p.as_str());
                let not_after = r.get("not_after").and_then(|n| n.as_u64());
                let (Some(peer), Some(not_after)) = (peer, not_after) else {
                    return Err(format!("unreadable revocation: {r}"));
                };
                revoked.push((peer.to_string(), not_after));
            }
        }
        Ok(Self { keys: parsed, revoked })
    }

    fn key(&self, kid: &str) -> Option<&[u8; 32]> {
        self.keys.get(kid)
    }

    fn revokes(&self, peer_id: &str, iat: u64) -> bool {
        self.revoked.iter().any(|(p, not_after)| p == peer_id && iat <= *not_after)
    }
}

// ---------------------------------------------------------------------------
// Token checks

/// The five claims of a PoR token.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub peer_id: String,
    pub iat: u64,
    pub exp: u64,
}

/// Why a heartbeat's token could not be decided locally: ignored, nobody
/// penalised (R17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unverifiable {
    /// `iss` is not exactly one of this node's trust anchors.
    UntrustedIssuer,
    /// No usable copy of the issuer's keys yet, or no key with this `kid`.
    UnknownKey,
    /// `iat` is more than 60 s ahead of this node's clock: one of the clocks
    /// is wrong, and this node cannot tell which.
    IssuedInFuture,
}

/// A certain forgery: rejected and held against the authenticated source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Forgery {
    /// The signature does not verify under the issuer's key with that `kid`.
    BadSignature,
    /// A genuine token for another PeerId, put in this source's heartbeat.
    WrongPeer,
}

/// Outcome of checking one token against one authenticated source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenCheck {
    Valid(Claims),
    Expired(Claims),
    Revoked(Claims),
    Unverifiable(Unverifiable),
    /// Not a PoR token by this contract's rules. Every node decides this the
    /// same way, so it is rejected like any malformed message.
    Malformed(&'static str),
    Forged(Forgery),
}

/// A token split and decoded, before any key is involved (the cheap checks:
/// size, structure, `typ`, `alg`, `crit`, claim presence and types).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedToken {
    pub claims: Claims,
    pub kid: String,
    signing_input: Vec<u8>,
    signature: [u8; 64],
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    typ: String,
    kid: String,
    #[serde(default)]
    crit: Present,
    // `jku`, `x5u`, `x5c`, `jwk` and every other member are ignored: keys come
    // only from the trust anchors (R16).
}

/// Set when the member exists at all, whatever its value (even `null`).
#[derive(Default)]
struct Present(bool);

impl<'de> Deserialize<'de> for Present {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(d)?;
        Ok(Present(true))
    }
}

/// A JSON object (not an array, which serde would also map onto a struct),
/// with each named field exactly once: serde refuses duplicates.
fn json_object<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Option<T> {
    let text = std::str::from_utf8(bytes).ok()?;
    if !text.trim_start().starts_with('{') {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// The cheap, key-free half of the checks (contract v2 "JWT 校验" 1–4, 5's
/// first part).
pub fn parse_token(token: &[u8]) -> Result<ParsedToken, &'static str> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err("token too long");
    }
    let text = std::str::from_utf8(token).map_err(|_| "token is not text")?;
    let mut parts = text.split('.');
    let (Some(h), Some(p), Some(s), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("token is not three dot-separated parts");
    };
    let header = B64.decode(h).map_err(|_| "header is not base64url")?;
    if header.len() > MAX_HEADER_BYTES {
        return Err("header too long");
    }
    let header: Header = json_object(&header).ok_or("header is not a JSON object with alg, typ and kid")?;
    if header.alg != "EdDSA" {
        return Err("alg is not EdDSA");
    }
    if header.typ != TOKEN_TYPE {
        return Err("typ is not rotifer-por+jwt");
    }
    if header.crit.0 {
        return Err("crit header present");
    }
    if header.kid.is_empty() {
        return Err("empty kid");
    }
    let payload = B64.decode(p).map_err(|_| "payload is not base64url")?;
    let claims: Claims = json_object(&payload).ok_or("payload lacks a claim, repeats one, or has a wrong type")?;
    if claims.sub.is_empty() || claims.peer_id.is_empty() {
        return Err("empty sub or peer_id");
    }
    let signature = B64.decode(s).map_err(|_| "signature is not base64url")?;
    let signature = <[u8; 64]>::try_from(signature.as_slice()).map_err(|_| "signature is not 64 bytes")?;
    Ok(ParsedToken {
        claims,
        kid: header.kid,
        signing_input: text.as_bytes()[..h.len() + 1 + p.len()].to_vec(),
        signature,
    })
}

/// Checks an Ed25519 signature: `(public key, message, signature)`.
pub type Verifier<'a> = &'a mut dyn FnMut(&[u8; 32], &[u8], &[u8; 64]) -> bool;

/// The rest of the checks, given the issuer's keys (`None` if this node has
/// none for that issuer yet). `verify` checks an Ed25519 signature; the desk
/// passes a cached version. Order (contract v2 rule 5): key known, signature,
/// then the PeerId binding, lifetime, revocation and expiry. An expired token
/// goes through every one of these (rule 6), so a stolen expired token still
/// counts as a forgery.
pub fn check_parsed(
    token: &ParsedToken,
    source: &str,
    now_s: u64,
    anchors: &[TrustAnchor],
    jwks: Option<&Jwks>,
    verify: Verifier<'_>,
) -> TokenCheck {
    let c = &token.claims;
    if !anchors.iter().any(|a| a.iss == c.iss) {
        return TokenCheck::Unverifiable(Unverifiable::UntrustedIssuer);
    }
    let Some(key) = jwks.and_then(|j| j.key(&token.kid)) else {
        return TokenCheck::Unverifiable(Unverifiable::UnknownKey);
    };
    if !verify(key, &token.signing_input, &token.signature) {
        return TokenCheck::Forged(Forgery::BadSignature);
    }
    if c.peer_id != source {
        return TokenCheck::Forged(Forgery::WrongPeer);
    }
    if c.exp < c.iat || c.exp - c.iat > MAX_LIFETIME_SECS {
        return TokenCheck::Malformed("lifetime longer than 7 days");
    }
    if c.iat > now_s.saturating_add(CLOCK_SKEW_SECS) {
        return TokenCheck::Unverifiable(Unverifiable::IssuedInFuture);
    }
    if jwks.is_some_and(|j| j.revokes(&c.peer_id, c.iat)) {
        return TokenCheck::Revoked(c.clone());
    }
    if now_s > c.exp.saturating_add(CLOCK_SKEW_SECS) {
        return TokenCheck::Expired(c.clone());
    }
    TokenCheck::Valid(c.clone())
}

/// Plain Ed25519 verification.
pub fn verify_ed25519(key: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    ed25519::PublicKey::try_from_bytes(key).is_ok_and(|k| k.verify(msg, sig))
}

/// Parse and check in one go.
pub fn check_token(
    token: &[u8],
    source: &str,
    now_s: u64,
    anchors: &[TrustAnchor],
    jwks: impl Fn(&str) -> Option<Jwks>,
) -> TokenCheck {
    match parse_token(token) {
        Err(why) => TokenCheck::Malformed(why),
        Ok(parsed) => {
            let keys = jwks(&parsed.claims.iss);
            check_parsed(&parsed, source, now_s, anchors, keys.as_ref(), &mut verify_ed25519)
        }
    }
}

// ---------------------------------------------------------------------------
// Key store: cached JWKS per issuer, background refresh

/// A JWKS fetch the event loop should run in the background.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchJob {
    pub iss: String,
    pub url: String,
}

/// A fetched JWKS document and how long the issuer says it may be cached.
#[derive(Debug, Clone)]
pub struct Fetched {
    pub body: Vec<u8>,
    pub max_age_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    url: String,
    fetched_at: u64,
    max_age_secs: u64,
    body: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    entries: HashMap<String, CacheEntry>,
}

/// Each anchor's keys, their age, and the fetch bookkeeping: one fetch at a
/// time, at most one queued (contract v2), one attempt per issuer per
/// [`JWKS_REFETCH_INTERVAL_SECS`].
#[derive(Debug, Default)]
pub struct KeyStore {
    keys: HashMap<String, (Jwks, CacheEntry)>,
    last_attempt: HashMap<String, u64>,
    in_flight: Option<String>,
    queued: Option<FetchJob>,
    cache_path: Option<PathBuf>,
}

impl KeyStore {
    /// A store that persists to `cache_path`, loaded with whatever usable
    /// entries it already holds for these anchors (offline use, R3).
    pub fn load(cache_path: Option<PathBuf>, anchors: &[TrustAnchor]) -> Self {
        let mut store = Self { cache_path, ..Self::default() };
        let Some(path) = &store.cache_path else { return store };
        let Ok(raw) = std::fs::read(path) else { return store };
        let Ok(file) = serde_json::from_slice::<CacheFile>(&raw) else { return store };
        for (iss, entry) in file.entries {
            let anchored = anchors.iter().any(|a| a.iss == iss && a.jwks_url == entry.url);
            if let (true, Ok(jwks)) = (anchored, Jwks::parse(entry.body.as_bytes())) {
                store.keys.insert(iss, (jwks, entry));
            }
        }
        store
    }

    pub fn jwks(&self, iss: &str) -> Option<&Jwks> {
        self.keys.get(iss).map(|(j, _)| j)
    }

    fn is_stale(&self, iss: &str, now_s: u64) -> bool {
        self.keys.get(iss).is_none_or(|(_, e)| now_s >= e.fetched_at.saturating_add(e.max_age_secs))
    }

    /// Ask for a fetch of `anchor`'s keys. Returns the job to start now, if
    /// any; otherwise it is queued, or dropped because one was tried within
    /// the last minute.
    pub fn request(&mut self, anchor: &TrustAnchor, mono_s: u64) -> Option<FetchJob> {
        let job = FetchJob { iss: anchor.iss.clone(), url: anchor.jwks_url.clone() };
        let recent = self
            .last_attempt
            .get(&job.iss)
            .is_some_and(|t| mono_s < t.saturating_add(JWKS_REFETCH_INTERVAL_SECS));
        if recent || self.in_flight.as_deref() == Some(job.iss.as_str()) {
            return None;
        }
        if self.in_flight.is_some() {
            if self.queued.is_none() {
                self.queued = Some(job);
            }
            return None;
        }
        self.start(job, mono_s)
    }

    fn start(&mut self, job: FetchJob, mono_s: u64) -> Option<FetchJob> {
        self.last_attempt.insert(job.iss.clone(), mono_s);
        self.in_flight = Some(job.iss.clone());
        Some(job)
    }

    /// Record a finished fetch; returns the queued job to start next. A
    /// failed fetch, or a document that does not parse, keeps the old copy.
    pub fn finish(&mut self, job: &FetchJob, result: Result<Fetched, String>, now_s: u64, mono_s: u64) -> Option<FetchJob> {
        self.in_flight = None;
        match result.and_then(|f| Jwks::parse(&f.body).map(|j| (j, f))) {
            Ok((jwks, fetched)) => {
                let entry = CacheEntry {
                    url: job.url.clone(),
                    fetched_at: now_s,
                    max_age_secs: fetched.max_age_secs.unwrap_or(MAX_JWKS_CACHE_SECS).min(MAX_JWKS_CACHE_SECS),
                    body: String::from_utf8_lossy(&fetched.body).into_owned(),
                };
                self.keys.insert(job.iss.clone(), (jwks, entry));
                self.persist();
            }
            Err(e) => tracing::debug!(iss = %job.iss, "JWKS fetch failed, keeping the cached copy: {e}"),
        }
        let next = self.queued.take()?;
        let recent = self
            .last_attempt
            .get(&next.iss)
            .is_some_and(|t| mono_s < t.saturating_add(JWKS_REFETCH_INTERVAL_SECS));
        if recent { None } else { self.start(next, mono_s) }
    }

    fn persist(&self) {
        let Some(path) = &self.cache_path else { return };
        let file = CacheFile { entries: self.keys.iter().map(|(iss, (_, e))| (iss.clone(), e.clone())).collect() };
        let Ok(bytes) = serde_json::to_vec_pretty(&file) else { return };
        if let Err(e) = write_atomic(path, &bytes) {
            tracing::debug!("cannot write the JWKS cache: {e}");
        }
    }
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

/// `max-age` from a Cache-Control header value.
pub fn max_age(cache_control: &str) -> Option<u64> {
    cache_control.split(',').find_map(|d| {
        let (name, value) = d.trim().split_once('=')?;
        name.trim().eq_ignore_ascii_case("max-age").then(|| value.trim().parse().ok())?
    })
}

/// Fetch a JWKS document (blocking; the node runs it off the event loop). No
/// redirects, no proxies from the environment: keys come from the configured
/// address and nowhere else.
pub fn fetch_jwks(url: &str) -> Result<Fetched, String> {
    check_jwks_url(url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(JWKS_FETCH_TIMEOUT))
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("{url}: HTTP {status}"));
    }
    let max_age_secs = response
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .and_then(max_age);
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_JWKS_BYTES)
        .read_to_vec()
        .map_err(|e| format!("{url}: {e}"))?;
    Ok(Fetched { body, max_age_secs })
}

// ---------------------------------------------------------------------------
// The heartbeat desk: per-source state, rate, attestation

/// What a source's newest heartbeat says about its registration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AttestationStatus {
    /// No token (an anonymous node: a full participant, score 0).
    #[default]
    None,
    Valid,
    Expired,
    Revoked,
}

/// One source's standing, from its newest applied heartbeat.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PeerAttestation {
    pub status: AttestationStatus,
    /// Issuer and account pseudonym of the token, when it had a valid
    /// signature (valid, expired or revoked). The pseudonym is public in the
    /// heartbeat, but it is never logged.
    pub iss: Option<String>,
    pub sub: Option<String>,
    pub exp: Option<u64>,
    /// `timestamp_ms` of the newest heartbeat applied; older ones are
    /// forwarded but change nothing (R19).
    pub heartbeat_ms: u64,
    /// Forged tokens this source has sent (held against it, never against
    /// the PeerId written in the token).
    pub forged: u64,
    /// Monotonic ms of this source's newest forgeries (at most
    /// [`COUNTED_FORGERIES`]), for the 24-hour penalty window.
    pub(crate) forged_at: VecDeque<u64>,
    /// Monotonic ms since which this source has held a valid token for its
    /// current pseudonym; orders the pseudonym's bonus quota.
    pub(crate) valid_since_ms: Option<u64>,
}

impl PeerAttestation {
    /// Forgeries still counting against this source at `mono_ms`.
    fn recent_forgeries(&self, mono_ms: u64) -> usize {
        self.forged_at.iter().filter(|t| mono_ms < t.saturating_add(FORGERY_WINDOW_MS)).count()
    }
}

/// Counters, for logs and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HeartbeatStats {
    /// Heartbeats that updated a source's state.
    pub applied: u64,
    /// Accepted but older than the source's newest: forwarded, not applied.
    pub not_newer: u64,
    /// Over the per-source rate: ignored.
    pub rate_limited: u64,
    /// Token not decidable here: ignored.
    pub unverifiable: u64,
    /// Token malformed: rejected.
    pub malformed: u64,
    /// Token forged: rejected, held against the source.
    pub forged: u64,
}

/// What to tell GossipSub about a heartbeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Ignore,
    Reject,
}

/// The node's heartbeat state: trust anchors, keys, per-source rate and
/// history, and each source's attestation.
#[derive(Debug)]
pub struct HeartbeatDesk {
    anchors: Vec<TrustAnchor>,
    pub(crate) store: KeyStore,
    verified: HashMap<[u8; 32], bool>,
    arrivals: HashMap<String, VecDeque<u64>>,
    peers: HashMap<String, PeerAttestation>,
    stats: HeartbeatStats,
}

impl HeartbeatDesk {
    pub fn new(anchors: Vec<TrustAnchor>, store: KeyStore) -> Self {
        Self {
            anchors,
            store,
            verified: HashMap::new(),
            arrivals: HashMap::new(),
            peers: HashMap::new(),
            stats: HeartbeatStats::default(),
        }
    }

    pub fn peer(&self, source: &str) -> Option<PeerAttestation> {
        self.peers.get(source).cloned()
    }

    pub fn peers(&self) -> Vec<(String, PeerAttestation)> {
        self.peers.iter().map(|(p, a)| (p.clone(), a.clone())).collect()
    }

    pub fn stats(&self) -> HeartbeatStats {
        self.stats
    }

    /// Decide a structurally valid heartbeat from the authenticated `source`.
    /// `now_ms` is wall-clock Unix ms; `mono_ms` a monotonic clock. Returns
    /// the decision and, possibly, a JWKS fetch to start in the background.
    pub fn on_heartbeat(&mut self, source: &str, hb: &WireNodeHeartbeat, now_ms: u64, mono_ms: u64) -> (Decision, Option<FetchJob>) {
        if !self.admit(source, mono_ms) {
            self.stats.rate_limited += 1;
            return (Decision::Ignore, None);
        }
        let now_s = now_ms / 1000;
        let mut fetch = None;
        let (status, claims) = match hb.attestation() {
            None => (AttestationStatus::None, None),
            Some(token) => match self.check(token, source, now_s, mono_ms / 1000, &mut fetch) {
                TokenCheck::Valid(c) => (AttestationStatus::Valid, Some(c)),
                TokenCheck::Expired(c) => (AttestationStatus::Expired, Some(c)),
                TokenCheck::Revoked(c) => (AttestationStatus::Revoked, Some(c)),
                TokenCheck::Unverifiable(why) => {
                    tracing::debug!(%source, ?why, "heartbeat attestation not decidable here; ignored");
                    self.stats.unverifiable += 1;
                    return (Decision::Ignore, fetch);
                }
                TokenCheck::Malformed(why) => {
                    tracing::debug!(%source, why, "malformed heartbeat attestation; rejected");
                    self.stats.malformed += 1;
                    return (Decision::Reject, fetch);
                }
                TokenCheck::Forged(how) => {
                    tracing::debug!(%source, ?how, "forged heartbeat attestation; rejected");
                    self.stats.forged += 1;
                    self.record_forgery(source, mono_ms);
                    return (Decision::Reject, fetch);
                }
            },
        };
        let current = self.peers.get(source).map_or(0, |p| p.heartbeat_ms);
        if hb.timestamp_ms <= current {
            self.stats.not_newer += 1;
            return (Decision::Accept, fetch);
        }
        let entry = self.entry(source, mono_ms);
        let iss = claims.as_ref().map(|c| c.iss.clone());
        let sub = claims.as_ref().map(|c| c.sub.clone());
        // The quota goes by how long a peer has been registered, so a
        // routine token renewal does not cost a node its place.
        let still_valid = entry.status == AttestationStatus::Valid && entry.iss == iss && entry.sub == sub;
        entry.valid_since_ms = match status {
            AttestationStatus::Valid if still_valid => entry.valid_since_ms.or(Some(mono_ms)),
            AttestationStatus::Valid => Some(mono_ms),
            _ => None,
        };
        entry.status = status;
        entry.heartbeat_ms = hb.timestamp_ms;
        entry.iss = iss;
        entry.sub = sub;
        entry.exp = claims.as_ref().map(|c| c.exp);
        self.stats.applied += 1;
        (Decision::Accept, fetch)
    }

    /// Hold one certain forgery against the authenticated `source`: a forged
    /// heartbeat token, or a DHT record failing its publisher binding or
    /// signature (A2). It counts for [`FORGERY_WINDOW_MS`].
    pub fn record_forgery(&mut self, source: &str, mono_ms: u64) {
        let entry = self.entry(source, mono_ms);
        entry.forged += 1;
        if entry.forged_at.len() >= COUNTED_FORGERIES {
            entry.forged_at.pop_front();
        }
        entry.forged_at.push_back(mono_ms);
    }

    /// The issuer and pseudonym `peer` is validly registered under at
    /// `now_s`, if any.
    pub fn registration(&self, peer: &str, now_s: u64) -> Option<(String, String)> {
        let a = self.peers.get(peer)?;
        if a.status != AttestationStatus::Valid || now_s > a.exp?.saturating_add(CLOCK_SKEW_SECS) {
            return None;
        }
        Some((a.iss.clone()?, a.sub.clone()?))
    }

    /// Record a finished JWKS fetch; returns the next fetch to start.
    pub fn on_fetched(&mut self, job: &FetchJob, result: Result<Fetched, String>, now_s: u64, mono_s: u64) -> Option<FetchJob> {
        self.store.finish(job, result, now_s, mono_s)
    }

    fn check(&mut self, token: &[u8], source: &str, now_s: u64, mono_s: u64, fetch: &mut Option<FetchJob>) -> TokenCheck {
        let parsed = match parse_token(token) {
            Ok(p) => p,
            Err(why) => return TokenCheck::Malformed(why),
        };
        if let Some(anchor) = self.anchors.iter().find(|a| a.iss == parsed.claims.iss).cloned() {
            // First use, an expired cache, or a kid this node has not seen:
            // fetch in the background, and keep using what is cached.
            let unknown_kid = self.store.jwks(&anchor.iss).is_none_or(|j| j.key(&parsed.kid).is_none());
            if unknown_kid || self.store.is_stale(&anchor.iss, now_s) {
                *fetch = self.store.request(&anchor, mono_s);
            }
        }
        let verified = &mut self.verified;
        let mut cached_verify = |key: &[u8; 32], msg: &[u8], sig: &[u8; 64]| -> bool {
            use sha2::{Digest, Sha256};
            let digest: [u8; 32] = Sha256::new().chain_update(key).chain_update(sig).chain_update(msg).finalize().into();
            if let Some(ok) = verified.get(&digest) {
                return *ok;
            }
            let ok = verify_ed25519(key, msg, sig);
            if verified.len() >= VERIFIED_CACHE_CAP {
                verified.clear();
            }
            verified.insert(digest, ok);
            ok
        };
        check_parsed(&parsed, source, now_s, &self.anchors, self.store.jwks(&parsed.claims.iss), &mut cached_verify)
    }

    /// Per-source rate: at most [`HEARTBEATS_PER_SOURCE_PER_MIN`] in any 60 s.
    fn admit(&mut self, source: &str, mono_ms: u64) -> bool {
        if !self.arrivals.contains_key(source) && self.arrivals.len() >= MAX_TRACKED_SOURCES {
            self.arrivals.retain(|_, q| q.back().is_some_and(|t| mono_ms < t.saturating_add(60_000)));
            // Still full (many identities, all active): forget the quietest
            // rather than turn newcomers away, so a swarm of throwaway
            // identities cannot keep honest nodes' heartbeats from being heard.
            if self.arrivals.len() >= MAX_TRACKED_SOURCES
                && let Some(quietest) = self.arrivals.iter().min_by_key(|(_, q)| q.back().copied()).map(|(p, _)| p.clone())
            {
                self.arrivals.remove(&quietest);
            }
        }
        let q = self.arrivals.entry(source.to_string()).or_default();
        while q.front().is_some_and(|t| mono_ms >= t.saturating_add(60_000)) {
            q.pop_front();
        }
        if q.len() >= HEARTBEATS_PER_SOURCE_PER_MIN {
            return false;
        }
        q.push_back(mono_ms);
        true
    }

    /// GossipSub application score for each `connected` peer (ADR-300
    /// contract v2): [`REGISTERED_BONUS`] for a valid, unexpired registration
    /// within its pseudonym's quota, [`FORGERY_PENALTY`] per forgery in the
    /// last 24 hours down to [`FORGERY_FLOOR`], and 0 otherwise — anonymous,
    /// expired, revoked, or undecidable here. A peer with a forgery in the
    /// window gets no bonus, so one forgery is enough to graylist it.
    pub fn scores<'a>(&self, connected: impl IntoIterator<Item = &'a str>, now_ms: u64, mono_ms: u64) -> Vec<(&'a str, f64)> {
        let now_s = now_ms / 1000;
        let mut scores: Vec<(&'a str, f64)> = Vec::new();
        let mut registered: HashMap<(&str, &str), Vec<(u64, usize)>> = HashMap::new();
        for peer in connected {
            let i = scores.len();
            let Some(a) = self.peers.get(peer) else {
                scores.push((peer, 0.0));
                continue;
            };
            let forgeries = a.recent_forgeries(mono_ms);
            scores.push((peer, (forgeries as f64 * FORGERY_PENALTY).max(FORGERY_FLOOR)));
            if forgeries > 0 || a.status != AttestationStatus::Valid {
                continue;
            }
            if let (Some(iss), Some(sub), Some(exp), Some(since)) = (&a.iss, &a.sub, a.exp, a.valid_since_ms)
                && now_s <= exp.saturating_add(CLOCK_SKEW_SECS)
            {
                registered.entry((iss.as_str(), sub.as_str())).or_default().push((since, i));
            }
        }
        for mut holders in registered.into_values() {
            holders.sort_by(|x, y| x.0.cmp(&y.0).then_with(|| scores[x.1].0.cmp(scores[y.1].0)));
            for &(_, i) in holders.iter().take(BONUS_PEERS_PER_PSEUDONYM) {
                scores[i].1 += REGISTERED_BONUS;
            }
        }
        scores
    }

    fn entry(&mut self, source: &str, mono_ms: u64) -> &mut PeerAttestation {
        if !self.peers.contains_key(source) && self.peers.len() >= MAX_TRACKED_SOURCES {
            // Forget the source heard from longest ago, but never one whose
            // forgery still counts: forgetting it would lift its penalty.
            if let Some(oldest) = self
                .peers
                .iter()
                .min_by_key(|(_, a)| (a.recent_forgeries(mono_ms) > 0, a.heartbeat_ms))
                .map(|(p, _)| p.clone())
            {
                self.peers.remove(&oldest);
            }
        }
        self.peers.entry(source.to_string()).or_default()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const NOW_S: u64 = 1_800_000_000;
    const ME: &str = "12D3KooWSourceNodeOfTheHeartbeat";
    const OTHER: &str = "12D3KooWSomeoneElseEntirely";

    pub(crate) fn header(kid: &str) -> String {
        format!(r#"{{"alg":"EdDSA","typ":"{TOKEN_TYPE}","kid":"{kid}"}}"#)
    }

    pub(crate) fn claims(peer: &str, iat: u64) -> String {
        format!(r#"{{"iss":"{DEFAULT_ISSUER}","sub":"acct-pseudonym-1","peer_id":"{peer}","iat":{iat},"exp":{}}}"#, iat + MAX_LIFETIME_SECS)
    }

    pub(crate) fn sign(kp: &ed25519::Keypair, header: &str, payload: &str) -> String {
        let input = format!("{}.{}", B64.encode(header), B64.encode(payload));
        let sig = kp.sign(input.as_bytes());
        format!("{input}.{}", B64.encode(sig))
    }

    pub(crate) fn jwks_json(kp: &ed25519::Keypair, kid: &str, revoked: &str) -> String {
        let x = B64.encode(kp.public().to_bytes());
        format!(
            r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","x":"{x}","kid":"{kid}","alg":"EdDSA","use":"sig"}}],"rotifer_revoked":[{revoked}]}}"#
        )
    }

    fn check(token: &str, source: &str, jwks: &Jwks) -> TokenCheck {
        let j = jwks.clone();
        check_token(token.as_bytes(), source, NOW_S, &default_trust_anchors(), move |iss| (iss == DEFAULT_ISSUER).then(|| j.clone()))
    }

    struct Issuer {
        kp: ed25519::Keypair,
        jwks: Jwks,
    }

    fn issuer(revoked: &str) -> Issuer {
        let kp = ed25519::Keypair::generate();
        let jwks = Jwks::parse(jwks_json(&kp, "k1", revoked).as_bytes()).unwrap();
        Issuer { kp, jwks }
    }

    impl Issuer {
        fn token(&self, peer: &str, iat: u64) -> String {
            sign(&self.kp, &header("k1"), &claims(peer, iat))
        }
    }

    #[test]
    fn a_genuine_token_for_the_source_is_valid() {
        let i = issuer("");
        let t = i.token(ME, NOW_S - 3600);
        let TokenCheck::Valid(c) = check(&t, ME, &i.jwks) else { panic!("{:?}", check(&t, ME, &i.jwks)) };
        assert_eq!((c.iss.as_str(), c.sub.as_str(), c.peer_id.as_str()), (DEFAULT_ISSUER, "acct-pseudonym-1", ME));
    }

    #[test]
    fn attack_forged_signature_is_a_forgery() {
        let i = issuer("");
        // Signed by a key the issuer never published, under the issuer's kid.
        let forger = ed25519::Keypair::generate();
        let forged = sign(&forger, &header("k1"), &claims(ME, NOW_S - 60));
        assert_eq!(check(&forged, ME, &i.jwks), TokenCheck::Forged(Forgery::BadSignature));
        // A genuine token with its payload swapped for another (here: a new
        // pseudonym) keeps a signature that no longer matches.
        let genuine = i.token(ME, NOW_S - 60);
        let parts: Vec<&str> = genuine.split('.').collect();
        let other = B64.encode(claims(ME, NOW_S - 60).replace("acct-pseudonym-1", "acct-pseudonym-2"));
        let tampered = format!("{}.{other}.{}", parts[0], parts[2]);
        assert_eq!(check(&tampered, ME, &i.jwks), TokenCheck::Forged(Forgery::BadSignature));
    }

    #[test]
    fn attack_someone_elses_token_is_a_forgery() {
        let i = issuer("");
        let theirs = i.token(OTHER, NOW_S - 60);
        assert_eq!(check(&theirs, ME, &i.jwks), TokenCheck::Forged(Forgery::WrongPeer));
        // Expired does not launder it: a stolen expired token is still a forgery.
        let old = i.token(OTHER, NOW_S - 30 * 24 * 3600);
        assert_eq!(check(&old, ME, &i.jwks), TokenCheck::Forged(Forgery::WrongPeer));
    }

    #[test]
    fn attack_expired_token_has_no_standing() {
        let i = issuer("");
        let iat = NOW_S - MAX_LIFETIME_SECS - CLOCK_SKEW_SECS - 1;
        assert!(matches!(check(&i.token(ME, iat), ME, &i.jwks), TokenCheck::Expired(_)));
        // Within the 60 s tolerance it still counts.
        let iat = NOW_S - MAX_LIFETIME_SECS - CLOCK_SKEW_SECS;
        assert!(matches!(check(&i.token(ME, iat), ME, &i.jwks), TokenCheck::Valid(_)));
    }

    #[test]
    fn attack_revoked_token_has_no_standing() {
        let not_after = NOW_S - 100;
        let i = issuer(&format!(r#"{{"peer_id":"{ME}","not_after":{not_after}}}"#));
        assert!(matches!(check(&i.token(ME, not_after), ME, &i.jwks), TokenCheck::Revoked(_)));
        assert!(matches!(check(&i.token(ME, not_after - 5000), ME, &i.jwks), TokenCheck::Revoked(_)));
        // Issued after the revocation: a fresh registration is valid again.
        assert!(matches!(check(&i.token(ME, not_after + 1), ME, &i.jwks), TokenCheck::Valid(_)));
        // The revocation names one PeerId only.
        let j = issuer(&format!(r#"{{"peer_id":"{OTHER}","not_after":{not_after}}}"#));
        assert!(matches!(check(&j.token(ME, not_after), ME, &j.jwks), TokenCheck::Valid(_)));
    }

    #[test]
    fn what_this_node_cannot_decide_is_unverifiable() {
        let i = issuer("");
        // An issuer not in the anchor list, even one serving real keys.
        let foreign = sign(&i.kp, &header("k1"), &claims(ME, NOW_S).replace(DEFAULT_ISSUER, "https://evil.example"));
        assert_eq!(check(&foreign, ME, &i.jwks), TokenCheck::Unverifiable(Unverifiable::UntrustedIssuer));
        // A kid this node has not fetched (the issuer may have rotated keys).
        let rotated = sign(&i.kp, &header("k2"), &claims(ME, NOW_S));
        assert_eq!(check(&rotated, ME, &i.jwks), TokenCheck::Unverifiable(Unverifiable::UnknownKey));
        // No keys at all yet.
        let none = check_token(i.token(ME, NOW_S).as_bytes(), ME, NOW_S, &default_trust_anchors(), |_| None);
        assert_eq!(none, TokenCheck::Unverifiable(Unverifiable::UnknownKey));
        // Issued more than 60 s in this node's future.
        assert!(matches!(check(&i.token(ME, NOW_S + CLOCK_SKEW_SECS), ME, &i.jwks), TokenCheck::Valid(_)));
        assert_eq!(
            check(&i.token(ME, NOW_S + CLOCK_SKEW_SECS + 1), ME, &i.jwks),
            TokenCheck::Unverifiable(Unverifiable::IssuedInFuture)
        );
    }

    #[test]
    fn header_rules_are_strict() {
        let i = issuer("");
        let c = claims(ME, NOW_S);
        let with = |h: &str| check(&sign(&i.kp, h, &c), ME, &i.jwks);
        assert!(matches!(with(r#"{"alg":"none","typ":"rotifer-por+jwt","kid":"k1"}"#), TokenCheck::Malformed(_)));
        assert!(matches!(with(r#"{"alg":"ES256","typ":"rotifer-por+jwt","kid":"k1"}"#), TokenCheck::Malformed(_)));
        // A login JWT from the same account system: right alg, wrong typ.
        assert!(matches!(with(r#"{"alg":"EdDSA","typ":"JWT","kid":"k1"}"#), TokenCheck::Malformed(_)));
        assert!(matches!(with(r#"{"alg":"EdDSA","kid":"k1"}"#), TokenCheck::Malformed(_)));
        assert!(matches!(with(r#"{"alg":"EdDSA","typ":"rotifer-por+jwt"}"#), TokenCheck::Malformed(_)));
        for crit in ["[]", "null", r#"["exp"]"#] {
            let h = format!(r#"{{"alg":"EdDSA","typ":"rotifer-por+jwt","kid":"k1","crit":{crit}}}"#);
            assert!(matches!(with(&h), TokenCheck::Malformed(_)), "crit {crit}");
        }
        assert!(matches!(with(r#"{"alg":"EdDSA","alg":"EdDSA","typ":"rotifer-por+jwt","kid":"k1"}"#), TokenCheck::Malformed(_)));
        assert!(matches!(with(r#"["EdDSA","rotifer-por+jwt","k1"]"#), TokenCheck::Malformed(_)));
        // jku / x5u / jwk pointing elsewhere change nothing: keys come only
        // from the trust anchor, and here they match.
        let h = r#"{"alg":"EdDSA","typ":"rotifer-por+jwt","kid":"k1","jku":"https://evil.example/jwks","x5u":"https://evil.example/c","jwk":{}}"#;
        assert!(matches!(with(h), TokenCheck::Valid(_)));
        // ... and cannot bring their own key either.
        let forger = ed25519::Keypair::generate();
        let x = B64.encode(forger.public().to_bytes());
        let h = format!(r#"{{"alg":"EdDSA","typ":"rotifer-por+jwt","kid":"k1","jwk":{{"kty":"OKP","crv":"Ed25519","x":"{x}"}}}}"#);
        assert_eq!(check(&sign(&forger, &h, &c), ME, &i.jwks), TokenCheck::Forged(Forgery::BadSignature));
    }

    #[test]
    fn claim_and_shape_rules_are_strict() {
        let i = issuer("");
        let h = header("k1");
        let with = |p: &str| check(&sign(&i.kp, &h, p), ME, &i.jwks);
        let iat = NOW_S;
        let ok = claims(ME, iat);
        assert!(matches!(with(&ok), TokenCheck::Valid(_)));
        for missing in ["iss", "sub", "peer_id", "iat", "exp"] {
            let v: serde_json::Value = serde_json::from_str(&ok).unwrap();
            let mut m = v.as_object().unwrap().clone();
            m.remove(missing);
            assert!(matches!(with(&serde_json::Value::Object(m).to_string()), TokenCheck::Malformed(_)), "no {missing}");
        }
        assert!(matches!(with(&ok.replace(&format!("\"iat\":{iat}"), &format!("\"iat\":\"{iat}\""))), TokenCheck::Malformed(_)));
        assert!(matches!(with(&ok.replace("acct-pseudonym-1", "")), TokenCheck::Malformed(_)));
        let dup = ok.replacen('{', r#"{"sub":"acct-pseudonym-9","#, 1);
        assert!(matches!(with(&dup), TokenCheck::Malformed(_)), "a repeated claim is refused, not resolved");
        let long = format!(r#"{{"iss":"{DEFAULT_ISSUER}","sub":"s","peer_id":"{ME}","iat":{iat},"exp":{}}}"#, iat + MAX_LIFETIME_SECS + 1);
        assert_eq!(with(&long), TokenCheck::Malformed("lifetime longer than 7 days"));
        let backwards = format!(r#"{{"iss":"{DEFAULT_ISSUER}","sub":"s","peer_id":"{ME}","iat":{iat},"exp":{}}}"#, iat - 1);
        assert!(matches!(with(&backwards), TokenCheck::Malformed(_)));
        // Extra claims are fine.
        assert!(matches!(with(&ok.replacen('{', r#"{"nbf":1,"#, 1)), TokenCheck::Valid(_)));

        let t = i.token(ME, iat);
        let check_raw = |raw: &[u8]| check_token(raw, ME, NOW_S, &default_trust_anchors(), |_| Some(i.jwks.clone()));
        assert!(matches!(check_raw(format!("{t}.x").as_bytes()), TokenCheck::Malformed(_)));
        assert!(matches!(check_raw(t.rsplit_once('.').unwrap().0.as_bytes()), TokenCheck::Malformed(_)));
        assert!(matches!(check_raw(format!("{t}=").as_bytes()), TokenCheck::Malformed(_)), "padding is not base64url");
        assert!(matches!(check_raw(&vec![b'a'; MAX_TOKEN_BYTES + 1]), TokenCheck::Malformed("token too long")));
        let big = format!(r#"{{"alg":"EdDSA","typ":"rotifer-por+jwt","kid":"k1","pad":"{}"}}"#, "x".repeat(MAX_HEADER_BYTES));
        assert!(matches!(check_raw(sign(&i.kp, &big, &ok).as_bytes()), TokenCheck::Malformed("header too long")));
    }

    #[test]
    fn jwks_parsing() {
        let kp = ed25519::Keypair::generate();
        let x = B64.encode(kp.public().to_bytes());
        let doc = format!(
            r#"{{"keys":[
                {{"kty":"RSA","kid":"r","n":"AQAB","e":"AQAB"}},
                {{"kty":"OKP","crv":"X25519","kid":"x","x":"{x}"}},
                {{"kty":"OKP","crv":"Ed25519","kid":"enc","x":"{x}","use":"enc"}},
                {{"kty":"OKP","crv":"Ed25519","kid":"short","x":"AAAA"}},
                {{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"{x}"}}
            ]}}"#
        );
        let j = Jwks::parse(doc.as_bytes()).unwrap();
        assert_eq!(j.keys.keys().collect::<Vec<_>>(), vec!["k1"]);
        assert!(j.revoked.is_empty());
        let twice = format!(r#"{{"keys":[{{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"{x}"}},{{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"{x}"}}]}}"#);
        assert!(Jwks::parse(twice.as_bytes()).is_err());
        assert!(Jwks::parse(b"[]").is_err());
        assert!(Jwks::parse(br#"{"rotifer_revoked":[]}"#).is_err());
        for bad in [r#""all""#, r#"[{"peer_id":"p"}]"#, r#"[{"peer_id":"p","not_after":"1"}]"#, r#"[{"not_after":1}]"#] {
            let doc = format!(r#"{{"keys":[],"rotifer_revoked":{bad}}}"#);
            assert!(Jwks::parse(doc.as_bytes()).is_err(), "unreadable revocations must not be skipped: {bad}");
        }
    }

    #[test]
    fn jwks_addresses_and_anchors() {
        assert!(check_jwks_url(DEFAULT_JWKS_URL).is_ok());
        assert!(check_jwks_url("http://127.0.0.1:8123/jwks.json").is_ok());
        assert!(check_jwks_url("http://[::1]:8123/jwks.json").is_ok());
        assert!(check_jwks_url("http://localhost/jwks.json").is_ok());
        assert!(check_jwks_url("http://rotifer.dev/.well-known/jwks.json").is_err());
        assert!(check_jwks_url("http://10.0.0.1/jwks.json").is_err());
        assert!(check_jwks_url("file:///etc/jwks.json").is_err());
        assert!(check_jwks_url("not a url").is_err());
        assert!(check_trust_anchors(&default_trust_anchors()).is_ok());
        let mut twice = default_trust_anchors();
        twice.push(TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: "https://mirror.example/jwks.json".into() });
        assert!(check_trust_anchors(&twice).is_err());
        assert!(check_trust_anchors(&[TrustAnchor { iss: String::new(), jwks_url: DEFAULT_JWKS_URL.into() }]).is_err());
        assert!(check_trust_anchors(&[]).is_ok(), "trusting nobody is allowed: every token is then unverifiable");
        assert_eq!(max_age("public, max-age=600"), Some(600));
        assert_eq!(max_age("Max-Age = 30 , no-transform"), Some(30));
        assert_eq!(max_age("no-store"), None);
        assert_eq!(max_age("max-age=soon"), None);
    }

    fn anchor(iss: &str) -> TrustAnchor {
        TrustAnchor { iss: iss.into(), jwks_url: format!("https://{}/jwks.json", iss.trim_start_matches("https://")) }
    }

    fn fetched(body: &str, max_age_secs: Option<u64>) -> Result<Fetched, String> {
        Ok(Fetched { body: body.as_bytes().to_vec(), max_age_secs })
    }

    #[test]
    fn key_store_fetches_one_at_a_time_and_at_most_once_a_minute() {
        let (a, b, c) = (anchor("https://a.example"), anchor("https://b.example"), anchor("https://c.example"));
        let mut s = KeyStore::default();
        let job_a = s.request(&a, 0).expect("first fetch starts");
        assert_eq!(s.request(&a, 1), None, "already in flight");
        assert_eq!(s.request(&b, 1), None, "queued behind a");
        assert_eq!(s.request(&c, 1), None, "the queue holds one; c is dropped");
        let job_b = s.finish(&job_a, Err("down".into()), NOW_S, 2).expect("the queued fetch starts");
        assert_eq!(job_b.iss, b.iss);
        assert_eq!(s.finish(&job_b, Err("down".into()), NOW_S, 3), None);
        assert_eq!(s.request(&a, 59), None, "a was tried less than a minute ago");
        assert!(s.request(&a, JWKS_REFETCH_INTERVAL_SECS).is_some());
        assert!(s.request(&c, 61).is_none(), "one in flight");
    }

    #[test]
    fn key_store_keeps_the_old_copy_and_honours_max_age() {
        let kp = ed25519::Keypair::generate();
        let a = anchor(DEFAULT_ISSUER);
        let mut s = KeyStore::default();
        assert!(s.is_stale(&a.iss, NOW_S));
        let job = s.request(&a, 0).unwrap();
        s.finish(&job, fetched(&jwks_json(&kp, "k1", ""), Some(10 * 24 * 3600)), NOW_S, 0);
        assert!(s.jwks(&a.iss).unwrap().key("k1").is_some());
        assert!(!s.is_stale(&a.iss, NOW_S + MAX_JWKS_CACHE_SECS - 1));
        assert!(s.is_stale(&a.iss, NOW_S + MAX_JWKS_CACHE_SECS), "max-age is capped at 24 h");
        // A failed refetch, or a garbled one, keeps the keys.
        let job = s.request(&a, 100).unwrap();
        s.finish(&job, Err("timeout".into()), NOW_S + 100, 100);
        let job = s.request(&a, 200).unwrap();
        s.finish(&job, fetched("<html>", None), NOW_S + 200, 200);
        assert!(s.jwks(&a.iss).unwrap().key("k1").is_some());
        let job = s.request(&a, 300).unwrap();
        s.finish(&job, fetched(&jwks_json(&kp, "k1", ""), Some(60)), NOW_S + 300, 300);
        assert!(s.is_stale(&a.iss, NOW_S + 360), "a shorter max-age is honoured");
    }

    #[test]
    fn key_store_cache_survives_a_restart_for_the_same_anchor_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("jwks-cache.json");
        let kp = ed25519::Keypair::generate();
        let a = anchor(DEFAULT_ISSUER);
        let mut s = KeyStore::load(Some(path.clone()), std::slice::from_ref(&a));
        let job = s.request(&a, 0).unwrap();
        s.finish(&job, fetched(&jwks_json(&kp, "k1", ""), None), NOW_S, 0);
        let again = KeyStore::load(Some(path.clone()), std::slice::from_ref(&a));
        assert!(again.jwks(&a.iss).unwrap().key("k1").is_some(), "offline restart keeps the keys");
        let moved = TrustAnchor { iss: a.iss.clone(), jwks_url: "https://elsewhere.example/jwks.json".into() };
        assert!(KeyStore::load(Some(path.clone()), &[moved]).jwks(&a.iss).is_none(), "a cache for another address is not used");
        assert!(KeyStore::load(Some(path), &[]).jwks(&a.iss).is_none(), "an issuer no longer trusted is not used");
    }

    /// An issuer's JWKS served over plain HTTP on loopback, counting fetches.
    pub(crate) struct JwksServer {
        pub url: String,
        pub hits: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        addr: std::net::SocketAddr,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl JwksServer {
        pub(crate) fn serve(body: String) -> Self {
            use std::io::{Read, Write};
            use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            let addr = listener.local_addr().unwrap();
            let hits = std::sync::Arc::new(AtomicUsize::new(0));
            let stop = std::sync::Arc::new(AtomicBool::new(false));
            let (hits_t, stop_t) = (hits.clone(), stop.clone());
            let thread = std::thread::spawn(move || {
                for conn in listener.incoming() {
                    if stop_t.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(mut conn) = conn else { continue };
                    let mut buf = [0u8; 4096];
                    let mut req = Vec::new();
                    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                        match conn.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => req.extend_from_slice(&buf[..n]),
                        }
                    }
                    hits_t.fetch_add(1, Ordering::Relaxed);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: public, max-age=600\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = conn.write_all(head.as_bytes());
                    let _ = conn.write_all(body.as_bytes());
                }
            });
            Self { url: format!("http://{addr}/.well-known/jwks.json"), hits, stop, addr, thread: Some(thread) }
        }
    }

    impl Drop for JwksServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = std::net::TcpStream::connect(self.addr);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    #[test]
    fn fetch_reads_a_jwks_over_http_and_refuses_other_addresses() {
        let kp = ed25519::Keypair::generate();
        let server = JwksServer::serve(jwks_json(&kp, "k1", ""));
        let got = fetch_jwks(&server.url).expect("fetch");
        assert_eq!(got.max_age_secs, Some(600));
        assert!(Jwks::parse(&got.body).unwrap().key("k1").is_some());
        assert_eq!(server.hits.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(fetch_jwks("http://example.com/jwks.json").is_err(), "plain http off loopback is never fetched");
    }

    /// The Cloud issuer's own signing code (#536), run under Deno by
    /// `tests/por-issuer/issue.ts` and serving its JWKS on loopback: the
    /// cross-layer check that this verifier accepts and refuses exactly what
    /// the real issuer produces (CEO 〔T-140〕 E1). `None` when deno is not
    /// installed, unless `REQUIRE_POR_CROSS=1` (set in CI), where a missing
    /// deno fails the test instead of skipping it.
    pub(crate) struct DenoIssuer {
        pub url: String,
        pub sub: String,
        pub tokens: serde_json::Map<String, serde_json::Value>,
        child: std::process::Child,
    }

    impl DenoIssuer {
        pub(crate) fn start(me: &str, other: &str) -> Option<Self> {
            use std::io::BufRead;
            use std::process::{Command, Stdio};
            let required = std::env::var("REQUIRE_POR_CROSS").is_ok_and(|v| v == "1");
            if Command::new("deno").arg("--version").stdout(Stdio::null()).status().is_err() {
                assert!(!required, "REQUIRE_POR_CROSS=1 but deno is not installed: the cross-layer PoR test must run here");
                eprintln!("SKIPPED: deno is not installed; the cross-layer PoR test did not run (CI sets REQUIRE_POR_CROSS=1)");
                return None;
            }
            let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/por-issuer/issue.ts");
            let mut child = Command::new("deno")
                .args(["run", "--quiet", "--no-prompt", "--allow-net=127.0.0.1", script, me, other])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("run deno");
            let mut line = String::new();
            std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).expect("issuer output");
            let out: serde_json::Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("issuer printed no JSON ({e}): {line:?}"));
            let field = |k: &str| out.get(k).and_then(|v| v.as_str()).map(String::from).expect("issuer field");
            assert_eq!(field("iss"), DEFAULT_ISSUER, "the issuer's iss is this node's default anchor");
            let tokens = out.get("tokens").and_then(|t| t.as_object()).cloned().expect("tokens");
            Some(Self { url: field("url"), sub: field("sub"), tokens, child })
        }

        pub(crate) fn token(&self, name: &str) -> String {
            self.tokens.get(name).and_then(|t| t.as_str()).map(String::from).expect("token")
        }
    }

    impl Drop for DenoIssuer {
        fn drop(&mut self) {
            drop(self.child.stdin.take());
            if !matches!(self.child.wait_timeout(), Some(true)) {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }

    trait WaitTimeout {
        fn wait_timeout(&mut self) -> Option<bool>;
    }

    impl WaitTimeout for std::process::Child {
        /// Closing stdin ends the issuer; give it two seconds.
        fn wait_timeout(&mut self) -> Option<bool> {
            for _ in 0..20 {
                if let Ok(Some(_)) = self.try_wait() {
                    return Some(true);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Some(false)
        }
    }

    fn peer_ids() -> (String, String) {
        let id = || libp2p::identity::Keypair::generate_ed25519().public().to_peer_id().to_string();
        (id(), id())
    }

    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "cross-layer: the Cloud issuer's code under Deno — enable the p2p-integration feature or run with --ignored"
    )]
    fn cross_layer_tokens_from_the_real_issuer() {
        let (me, other) = peer_ids();
        let Some(issuer) = DenoIssuer::start(&me, &other) else { return };
        // The node's own fetch path, over real HTTP.
        let fetched = fetch_jwks(&issuer.url).expect("fetch the issuer's JWKS");
        assert_eq!(fetched.max_age_secs, Some(300));
        let jwks = Jwks::parse(&fetched.body).expect("the issuer's JWKS parses");
        let now_s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let check_as = |name: &str, source: &str| {
            let j = jwks.clone();
            check_token(issuer.token(name).as_bytes(), source, now_s, &default_trust_anchors(), move |_| Some(j.clone()))
        };
        let check = |name: &str| check_as(name, &me);
        let TokenCheck::Valid(c) = check("valid") else { panic!("valid: {:?}", check("valid")) };
        assert_eq!((c.iss.as_str(), c.sub.as_str(), c.peer_id.as_str()), (DEFAULT_ISSUER, issuer.sub.as_str(), me.as_str()));
        assert!(matches!(check_as("expired", &other), TokenCheck::Expired(_)), "{:?}", check_as("expired", &other));
        assert!(matches!(check("revoked"), TokenCheck::Revoked(_)), "{:?}", check("revoked"));
        assert_eq!(check("stolen"), TokenCheck::Forged(Forgery::WrongPeer));
        assert_eq!(check("tampered"), TokenCheck::Forged(Forgery::BadSignature));
        // And the same token, presented by the PeerId it names, is valid.
        assert!(matches!(check_as("stolen", &other), TokenCheck::Valid(_)));
    }

    pub(crate) fn hb(token: &str, timestamp_ms: u64) -> WireNodeHeartbeat {
        WireNodeHeartbeat {
            genes_hosted: 0,
            uptime_seconds: 1,
            rotifer_version: "0.33.1".into(),
            bindings: vec![],
            cloud_attestation: token.as_bytes().to_vec(),
            timestamp_ms,
        }
    }

    /// A desk that already holds `i`'s keys.
    fn desk_with(i: &Issuer) -> HeartbeatDesk {
        let a = default_trust_anchors();
        let mut store = KeyStore::default();
        let job = store.request(&a[0], 0).unwrap();
        let body = jwks_json(&i.kp, "k1", &revocations(&i.jwks));
        store.finish(&job, fetched(&body, None), NOW_S, 0);
        HeartbeatDesk::new(a, store)
    }

    fn revocations(j: &Jwks) -> String {
        j.revoked.iter().map(|(p, n)| format!(r#"{{"peer_id":"{p}","not_after":{n}}}"#)).collect::<Vec<_>>().join(",")
    }

    const NOW_MS: u64 = NOW_S * 1000;

    #[test]
    fn desk_marks_a_valid_attestation() {
        let i = issuer("");
        let mut d = desk_with(&i);
        let (decision, fetch) = d.on_heartbeat(ME, &hb(&i.token(ME, NOW_S - 10), NOW_MS), NOW_MS, 1000);
        assert_eq!((decision, fetch), (Decision::Accept, None));
        let p = d.peer(ME).unwrap();
        assert_eq!(p.status, AttestationStatus::Valid);
        assert_eq!((p.iss.as_deref(), p.sub.as_deref()), (Some(DEFAULT_ISSUER), Some("acct-pseudonym-1")));
        assert_eq!(p.heartbeat_ms, NOW_MS);
        // Anonymous heartbeats are accepted with no attestation.
        assert_eq!(d.on_heartbeat(OTHER, &hb("", NOW_MS), NOW_MS, 1000).0, Decision::Accept);
        assert_eq!(d.peer(OTHER).unwrap().status, AttestationStatus::None);
    }

    #[test]
    fn attack_forgeries_are_rejected_and_held_against_the_source() {
        let i = issuer("");
        let mut d = desk_with(&i);
        let forger = ed25519::Keypair::generate();
        let forged = sign(&forger, &header("k1"), &claims(ME, NOW_S));
        assert_eq!(d.on_heartbeat(ME, &hb(&forged, NOW_MS), NOW_MS, 0).0, Decision::Reject);
        let stolen = i.token(OTHER, NOW_S);
        assert_eq!(d.on_heartbeat(ME, &hb(&stolen, NOW_MS + 1), NOW_MS, 30_000).0, Decision::Reject);
        let me = d.peer(ME).unwrap();
        assert_eq!((me.forged, me.status), (2, AttestationStatus::None));
        assert!(d.peer(OTHER).is_none(), "the PeerId written in a stolen token is not blamed");
        assert_eq!(d.stats().forged, 2);
    }

    #[test]
    fn attack_expired_and_revoked_are_accepted_without_standing() {
        let i = issuer(&format!(r#"{{"peer_id":"{OTHER}","not_after":{NOW_S}}}"#));
        let mut d = desk_with(&i);
        let old = i.token(ME, NOW_S - 30 * 24 * 3600);
        assert_eq!(d.on_heartbeat(ME, &hb(&old, NOW_MS), NOW_MS, 0).0, Decision::Accept);
        assert_eq!(d.peer(ME).unwrap().status, AttestationStatus::Expired);
        let revoked = i.token(OTHER, NOW_S - 10);
        assert_eq!(d.on_heartbeat(OTHER, &hb(&revoked, NOW_MS), NOW_MS, 0).0, Decision::Accept);
        assert_eq!(d.peer(OTHER).unwrap().status, AttestationStatus::Revoked);
    }

    #[test]
    fn attack_an_older_heartbeat_does_not_roll_state_back() {
        let i = issuer("");
        let mut d = desk_with(&i);
        let valid = i.token(ME, NOW_S - 10);
        let expired = i.token(ME, NOW_S - 30 * 24 * 3600);
        assert_eq!(d.on_heartbeat(ME, &hb(&valid, NOW_MS), NOW_MS, 0).0, Decision::Accept);
        // A replayed earlier heartbeat (still inside the time window) carrying
        // the old, expired token: forwarded, but the state stays.
        assert_eq!(d.on_heartbeat(ME, &hb(&expired, NOW_MS - 120_000), NOW_MS, 31_000).0, Decision::Accept);
        assert_eq!(d.peer(ME).unwrap().status, AttestationStatus::Valid);
        assert_eq!(d.peer(ME).unwrap().heartbeat_ms, NOW_MS);
        assert_eq!(d.stats().not_newer, 1);
    }

    #[test]
    fn attack_heartbeat_flood_is_rate_limited_per_source() {
        let mut d = desk_with(&issuer(""));
        for k in 0..HEARTBEATS_PER_SOURCE_PER_MIN as u64 {
            assert_eq!(d.on_heartbeat(ME, &hb("", NOW_MS + k), NOW_MS, k * 1000).0, Decision::Accept);
        }
        assert_eq!(d.on_heartbeat(ME, &hb("", NOW_MS + 9), NOW_MS, 59_999).0, Decision::Ignore);
        assert_eq!(d.on_heartbeat(OTHER, &hb("", NOW_MS), NOW_MS, 59_999).0, Decision::Accept, "per source");
        assert_eq!(d.on_heartbeat(ME, &hb("", NOW_MS + 10), NOW_MS, 60_000).0, Decision::Accept, "the minute moved on");
        assert_eq!(d.stats().rate_limited, 1);
        assert_eq!(d.peer(ME).unwrap().heartbeat_ms, NOW_MS + 10);
    }

    #[test]
    fn desk_ignores_what_it_cannot_decide_and_fetches_keys() {
        let i = issuer("");
        let mut d = HeartbeatDesk::new(default_trust_anchors(), KeyStore::default());
        let t = i.token(ME, NOW_S - 10);
        let (decision, fetch) = d.on_heartbeat(ME, &hb(&t, NOW_MS), NOW_MS, 0);
        assert_eq!(decision, Decision::Ignore);
        let job = fetch.expect("first sight of the issuer starts a fetch");
        assert_eq!((job.iss.as_str(), job.url.as_str()), (DEFAULT_ISSUER, DEFAULT_JWKS_URL));
        assert!(d.peer(ME).is_none(), "nothing is recorded and nobody penalised");
        assert_eq!(d.on_fetched(&job, fetched(&jwks_json(&i.kp, "k1", ""), None), NOW_S, 1), None);
        assert_eq!(d.on_heartbeat(ME, &hb(&t, NOW_MS + 1), NOW_MS, 40_000), (Decision::Accept, None));
        assert_eq!(d.peer(ME).unwrap().status, AttestationStatus::Valid);
        // A new kid triggers at most one refetch a minute.
        let rotated = sign(&i.kp, &header("k2"), &claims(OTHER, NOW_S));
        let (decision, fetch) = d.on_heartbeat(OTHER, &hb(&rotated, NOW_MS), NOW_MS, 40_000);
        assert_eq!((decision, fetch), (Decision::Ignore, None), "the last attempt was under a minute ago");
        let (_, fetch) = d.on_heartbeat(OTHER, &hb(&rotated, NOW_MS + 1), NOW_MS, 61_000);
        assert!(fetch.is_some());
        // Malformed tokens are rejected without a fetch.
        let (decision, fetch) = d.on_heartbeat("p3", &hb("not.a.token", NOW_MS), NOW_MS, 61_000);
        assert_eq!((decision, fetch), (Decision::Reject, None));
        assert_eq!(d.stats().unverifiable, 3);
        assert_eq!(d.stats().malformed, 1);
    }

    #[test]
    fn desk_bookkeeping_is_bounded() {
        let mut d = HeartbeatDesk::new(default_trust_anchors(), KeyStore::default());
        for k in 0..(MAX_TRACKED_SOURCES as u64 + 10) {
            let source = format!("peer-{k}");
            assert_eq!(d.on_heartbeat(&source, &hb("", NOW_MS + k), NOW_MS, 0).0, Decision::Accept);
        }
        assert_eq!(d.peers.len(), MAX_TRACKED_SOURCES);
        assert!(d.peer("peer-0").is_none(), "the source heard from longest ago is forgotten first");
        assert!(d.arrivals.len() <= MAX_TRACKED_SOURCES);
    }

    // -----------------------------------------------------------------------
    // Scores (ADR-300 contract v2, CEO 〔T-140〕 E7)

    /// libp2p's graylist threshold: below it a peer's messages are dropped.
    const GRAYLIST: f64 = -80.0;

    impl Issuer {
        fn token_for(&self, peer: &str, sub: &str, iat: u64) -> String {
            let payload = format!(
                r#"{{"iss":"{DEFAULT_ISSUER}","sub":"{sub}","peer_id":"{peer}","iat":{iat},"exp":{}}}"#,
                iat + MAX_LIFETIME_SECS
            );
            sign(&self.kp, &header("k1"), &payload)
        }
    }

    fn score_of(d: &HeartbeatDesk, peer: &str, connected: &[&str], now_ms: u64, mono_ms: u64) -> f64 {
        let scores = d.scores(connected.iter().copied(), now_ms, mono_ms);
        scores.into_iter().find(|(p, _)| *p == peer).map(|(_, s)| s).expect("connected peer scored")
    }

    #[test]
    fn score_numbers_are_the_ruled_ones() {
        // CEO 〔T-140〕 E7, by value: the other tests use the names.
        assert_eq!(APP_SPECIFIC_WEIGHT, 1.0);
        assert_eq!(REGISTERED_BONUS, 20.0);
        assert_eq!(BONUS_PEERS_PER_PSEUDONYM, 2);
        assert_eq!(FORGERY_PENALTY, -100.0);
        assert_eq!(FORGERY_WINDOW_MS, 86_400_000);
        assert_eq!(FORGERY_FLOOR, -300.0);
        assert_eq!(SCORE_REFRESH_INTERVAL, Duration::from_secs(60));
    }

    #[test]
    fn score_follows_registration_status() {
        assert_eq!(GRAYLIST, libp2p::gossipsub::PeerScoreThresholds::default().graylist_threshold);
        let i = issuer(&format!(r#"{{"peer_id":"p-revoked","not_after":{NOW_S}}}"#));
        let mut d = desk_with(&i);
        d.on_heartbeat("p-valid", &hb(&i.token("p-valid", NOW_S - 10), NOW_MS), NOW_MS, 0);
        d.on_heartbeat("p-anon", &hb("", NOW_MS), NOW_MS, 0);
        d.on_heartbeat("p-expired", &hb(&i.token("p-expired", NOW_S - 30 * 24 * 3600), NOW_MS), NOW_MS, 0);
        d.on_heartbeat("p-revoked", &hb(&i.token("p-revoked", NOW_S - 10), NOW_MS), NOW_MS, 0);
        let all = ["p-valid", "p-anon", "p-expired", "p-revoked", "p-unheard"];
        let scores = d.scores(all, NOW_MS, 1000);
        assert_eq!(
            scores,
            vec![("p-valid", REGISTERED_BONUS), ("p-anon", 0.0), ("p-expired", 0.0), ("p-revoked", 0.0), ("p-unheard", 0.0)]
        );
        assert_eq!(REGISTERED_BONUS, 20.0);
        // The token runs out while the peer stays connected: the bonus goes.
        let exp_ms = (NOW_S - 10 + MAX_LIFETIME_SECS + CLOCK_SKEW_SECS + 1) * 1000;
        assert_eq!(score_of(&d, "p-valid", &all, exp_ms, 2000), 0.0);
    }

    #[test]
    fn attack_a_third_node_under_one_pseudonym_gets_no_bonus() {
        let i = issuer("");
        let mut d = desk_with(&i);
        for (k, p) in ["n1", "n2", "n3"].into_iter().enumerate() {
            let t = i.token_for(p, "acct-a", NOW_S - 10);
            assert_eq!(d.on_heartbeat(p, &hb(&t, NOW_MS), NOW_MS, k as u64 * 1000).0, Decision::Accept);
        }
        d.on_heartbeat("m1", &hb(&i.token_for("m1", "acct-b", NOW_S - 10), NOW_MS), NOW_MS, 5000);
        // Whatever order the connections are listed in, the two registered
        // longest keep the bonus; another account is counted on its own.
        let scores = d.scores(["n3", "m1", "n2", "n1"], NOW_MS, 6000);
        assert_eq!(scores, vec![("n3", 0.0), ("m1", 20.0), ("n2", 20.0), ("n1", 20.0)]);
        // Counted over connected peers: one of the two leaves, the third moves up.
        assert_eq!(d.scores(["n3", "n2"], NOW_MS, 6000), vec![("n3", 20.0), ("n2", 20.0)]);
        // A routine renewal keeps a node's place in the queue...
        let renewed = i.token_for("n1", "acct-a", NOW_S - 1);
        assert_eq!(d.on_heartbeat("n1", &hb(&renewed, NOW_MS + 1), NOW_MS, 70_000).0, Decision::Accept);
        assert_eq!(d.scores(["n1", "n2", "n3"], NOW_MS, 70_000), vec![("n1", 20.0), ("n2", 20.0), ("n3", 0.0)]);
        // ...and losing its registration sends it to the back.
        assert_eq!(d.on_heartbeat("n1", &hb("", NOW_MS + 2), NOW_MS, 71_000).0, Decision::Accept);
        assert_eq!(d.on_heartbeat("n1", &hb(&renewed, NOW_MS + 3), NOW_MS, 140_000).0, Decision::Accept);
        assert_eq!(d.scores(["n1", "n2", "n3"], NOW_MS, 140_000), vec![("n1", 0.0), ("n2", 20.0), ("n3", 20.0)]);
    }

    #[test]
    fn attack_one_forgery_graylists_for_a_day() {
        let i = issuer("");
        let mut d = desk_with(&i);
        // Even a source that was registered.
        d.on_heartbeat(ME, &hb(&i.token(ME, NOW_S - 10), NOW_MS), NOW_MS, 0);
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, 0), 20.0);
        let forged = sign(&ed25519::Keypair::generate(), &header("k1"), &claims(ME, NOW_S));
        let t0 = 70_000;
        assert_eq!(d.on_heartbeat(ME, &hb(&forged, NOW_MS + 1), NOW_MS, t0).0, Decision::Reject);
        let score = score_of(&d, ME, &[ME], NOW_MS, t0);
        assert_eq!(score, FORGERY_PENALTY);
        assert!(score < GRAYLIST, "one certain forgery is enough to graylist");
        assert!(score_of(&d, ME, &[ME], NOW_MS, t0 + FORGERY_WINDOW_MS - 1) < GRAYLIST);
        // A day later it no longer counts, and the registration it kept counts again.
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, t0 + FORGERY_WINDOW_MS), 20.0);
    }

    #[test]
    fn attack_forgeries_add_up_to_a_floor_within_a_sliding_day() {
        let mut d = desk_with(&issuer(""));
        let forged = sign(&ed25519::Keypair::generate(), &header("k1"), &claims(ME, NOW_S));
        for k in 0..5u64 {
            // One a minute, under the rate limit.
            assert_eq!(d.on_heartbeat(ME, &hb(&forged, NOW_MS + k), NOW_MS, k * 60_000).0, Decision::Reject);
            let expected = (-100.0 * (k + 1) as f64).max(FORGERY_FLOOR);
            assert_eq!(score_of(&d, ME, &[ME], NOW_MS, k * 60_000), expected, "after {} forgeries", k + 1);
        }
        assert_eq!(FORGERY_FLOOR, -300.0);
        assert_eq!(d.peer(ME).unwrap().forged, 5);
        // The window slides: the last three were at minutes 2, 3 and 4.
        let day = FORGERY_WINDOW_MS;
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, 2 * 60_000 + day - 1), -300.0);
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, 2 * 60_000 + day), -200.0);
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, 3 * 60_000 + day), -100.0);
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, 4 * 60_000 + day), 0.0);
    }

    #[test]
    fn attack_what_cannot_be_decided_here_is_never_penalised() {
        // R17: only a cryptographically certain forgery costs score. A key this
        // node has not seen, keys it cannot fetch, an issuer it does not
        // trust, a token from the future, or a malformed one: score 0, never
        // graylisted, however often they come.
        let i = issuer("");
        let mut d = desk_with(&i);
        let unknown_kid = sign(&i.kp, &header("k-rotated"), &claims("p-kid", NOW_S - 10));
        let other_key_unknown_kid = sign(&ed25519::Keypair::generate(), &header("k-other"), &claims("p-kid2", NOW_S - 10));
        let untrusted = sign(
            &i.kp,
            &header("k1"),
            &format!(r#"{{"iss":"https://elsewhere.example","sub":"s","peer_id":"p-iss","iat":{},"exp":{}}}"#, NOW_S - 10, NOW_S + 3600),
        );
        let future = i.token("p-future", NOW_S + 3600);
        let cases = [
            ("p-kid", unknown_kid.as_str(), Decision::Ignore),
            ("p-kid2", other_key_unknown_kid.as_str(), Decision::Ignore),
            ("p-iss", untrusted.as_str(), Decision::Ignore),
            ("p-future", future.as_str(), Decision::Ignore),
            ("p-junk", "not.a.token", Decision::Reject),
        ];
        // No keys at all: the issuer's JWKS could not be fetched.
        let mut keyless = HeartbeatDesk::new(default_trust_anchors(), KeyStore::default());
        let (decision, fetch) = keyless.on_heartbeat("p-nokeys", &hb(&i.token("p-nokeys", NOW_S - 10), NOW_MS), NOW_MS, 0);
        assert_eq!(decision, Decision::Ignore);
        let job = fetch.expect("a fetch was asked for");
        assert_eq!(keyless.on_fetched(&job, Err("connection refused".into()), NOW_S, 0), None);
        for round in 0..2u64 {
            let mono = round * 60_000;
            for (peer, token, expected) in cases {
                assert_eq!(d.on_heartbeat(peer, &hb(token, NOW_MS + round), NOW_MS, mono).0, expected, "{peer}");
            }
            let (decision, _) = keyless.on_heartbeat("p-nokeys", &hb(&i.token("p-nokeys", NOW_S - 10), NOW_MS + round), NOW_MS, 61_000 + mono);
            assert_eq!(decision, Decision::Ignore, "still no keys");
        }
        let peers: Vec<&str> = cases.iter().map(|c| c.0).collect();
        for (peer, score) in d.scores(peers.iter().copied(), NOW_MS, 120_000) {
            assert_eq!(score, 0.0, "{peer}");
        }
        assert_eq!(score_of(&keyless, "p-nokeys", &["p-nokeys"], NOW_MS, 122_000), 0.0);
        assert_eq!(d.stats().forged + keyless.stats().forged, 0);
    }

    #[test]
    fn attack_forgers_are_not_forgotten_to_lift_their_penalty() {
        // A flood of new identities fills the bookkeeping; the source that
        // forged, heard from longest ago, must still be remembered.
        let mut d = desk_with(&issuer(""));
        let forged = sign(&ed25519::Keypair::generate(), &header("k1"), &claims(ME, NOW_S));
        assert_eq!(d.on_heartbeat(ME, &hb(&forged, NOW_MS), NOW_MS, 0).0, Decision::Reject);
        for k in 0..(MAX_TRACKED_SOURCES as u64 + 10) {
            d.on_heartbeat(&format!("flood-{k}"), &hb("", NOW_MS + k), NOW_MS, 1000);
        }
        assert_eq!(d.peers.len(), MAX_TRACKED_SOURCES);
        assert_eq!(score_of(&d, ME, &[ME], NOW_MS, 2000), FORGERY_PENALTY);
    }
}
