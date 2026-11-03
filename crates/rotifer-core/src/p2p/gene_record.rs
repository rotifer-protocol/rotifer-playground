//! DHT gene record v1 — frozen (`proto/p2p-dht-v1.proto`, ADR-340 revision).
//!
//! A record is one publisher's signed claim that it has a gene. It lives at
//! `/rotifer/gene/<gene_id>/<publisher>` so publishers never overwrite each
//! other. Provider records listing them live at the gene ID's own SHA-256
//! digest as a sha2-256 multihash ([`provider_key`]).
//!
//! [`validate_record`] is the whole receiving-side contract, applied in a fixed
//! order; the first failing check is the verdict, and only a failed publisher
//! binding or signature counts as a forgery ([`RecordRejection::is_forgery`]).
//! Tests pin the `.proto` sha256 and check vectors made by an independent
//! implementation (`scripts/p2p-dht-v1-reference.py`, standard library only,
//! its own Ed25519).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use libp2p::PeerId;
use libp2p::identity::Keypair;
use prost::Message as _;

use super::GeneAnnouncement;
use super::messages::WireGeneAnnouncement;

/// sha256 of `proto/p2p-dht-v1.proto` — the frozen schema.
pub const FROZEN_DHT_PROTO_SHA256: &str =
    "1454f769c246a253c777e2ac513bc3353b5a25ce1f9b8f677940d68640c86dda";

/// Kad protocol the gene records are stored on.
pub const KAD_PROTOCOL: &str = super::GENE_DISCOVERY_PROTOCOL;

/// Prefix of every key a v1 node stores.
pub const KEY_PREFIX: &str = "/rotifer/gene/";

/// Largest record value accepted, as received.
pub const MAX_RECORD_BYTES: usize = 8192;

/// Signature domain: the signed message is this, a zero byte, the
/// announcement's length (u32 big-endian) and the announcement bytes.
pub const SIGNATURE_DOMAIN: &[u8] = b"rotifer-gene-record-v1";

/// A record older than this is stale.
pub const MAX_AGE_MS: u64 = 48 * 3600 * 1000;

/// A record further ahead of the receiver's clock than this is rejected.
pub const MAX_FUTURE_MS: u64 = 300 * 1000;

/// A stored record is kept at most this long after it arrived, so it never
/// outlives the provider records that make it findable.
pub const STORE_TTL_MS: u64 = 24 * 3600 * 1000;

/// The 38-byte publisher is this prefix — identity multihash (0x00, length
/// 36) of a protobuf-encoded libp2p Ed25519 public key (type 1, 32 bytes) —
/// followed by the 32-byte key. No other form names a publisher.
const PUBLISHER_PREFIX: [u8; 6] = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20];
const PUBLISHER_LEN: usize = 38;
const SIGNATURE_LEN: usize = 64;

/// The ten encodings (y < p) of Ed25519 points of small order. A key spelled
/// as one of them is refused: the identity, for one, "signs" anything under
/// cofactorless verification, and the library's default verify does not
/// object. Equivalent to "decodes per RFC 8032 §5.1.3 and [8]A is not the
/// identity" (the reference script checks the equivalence).
const SMALL_ORDER_KEYS: [[u8; 32]; 10] = [
    hex32("0000000000000000000000000000000000000000000000000000000000000000"),
    hex32("0000000000000000000000000000000000000000000000000000000000000080"),
    hex32("0100000000000000000000000000000000000000000000000000000000000000"),
    hex32("0100000000000000000000000000000000000000000000000000000000000080"),
    hex32("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
    hex32("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"),
    hex32("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"),
    hex32("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"),
    hex32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
    hex32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
];

const fn hex32(s: &str) -> [u8; 32] {
    const fn nibble(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("lowercase hex"),
        }
    }
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = nibble(b[2 * i]) << 4 | nibble(b[2 * i + 1]);
        i += 1;
    }
    out
}

/// Field rules of the announcement a record carries, frozen with v1 — not the
/// gossip format's `check_fields`, which may change without changing these.
const MAX_NAME_BYTES: usize = 128;
const MAX_DOMAIN_BYTES: usize = 128;
const MAX_IR_SPEC_BYTES: usize = 32;
const MAX_VERSION_BYTES: usize = 64;

/// Field numbers run 1 ..= 2^29 − 1; anything else is refused.
const MAX_FIELD_NUMBER: u64 = (1 << 29) - 1;

/// `GeneRecord` (wire tag numbers as in the .proto). Used to encode; decoding
/// goes through [`parse_fields`], which enforces the frozen grammar.
#[derive(Clone, PartialEq, prost::Message)]
pub struct WireGeneRecord {
    #[prost(bytes = "vec", tag = "1")]
    pub announcement: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub publisher: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub signature: Vec<u8>,
}

/// Why a record was refused. Each variant belongs to one step of the fixed
/// validation order ([`RecordRejection::step`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordRejection {
    /// Step 2: the key is not `/rotifer/gene/<v2 id>/<P>` with `P` the
    /// base58btc of 38 bytes starting with the Ed25519 PeerId prefix.
    BadKey,
    /// Step 3: the value is over [`MAX_RECORD_BYTES`].
    Oversized,
    /// Step 4: the outer record breaks the grammar or lacks a field.
    MalformedRecord,
    /// Step 5: the publisher is not the one the key names, or its key is not
    /// a canonical encoding of a point outside the small-order subgroup.
    BadPublisher,
    /// Step 6: the announcement breaks the grammar or the frozen field rules.
    BadAnnouncement,
    /// Step 6: the announcement's gene ID is not the one the key names.
    GeneIdMismatch,
    /// Step 7: older than [`MAX_AGE_MS`].
    Stale,
    /// Step 7: more than [`MAX_FUTURE_MS`] ahead.
    FromTheFuture,
    /// Step 8: the signature is not 64 bytes or does not verify.
    BadSignature,
}

impl RecordRejection {
    /// The validation step that refused the record.
    pub fn step(self) -> u8 {
        match self {
            Self::BadKey => 2,
            Self::Oversized => 3,
            Self::MalformedRecord => 4,
            Self::BadPublisher => 5,
            Self::BadAnnouncement | Self::GeneIdMismatch => 6,
            Self::Stale | Self::FromTheFuture => 7,
            Self::BadSignature => 8,
        }
    }

    /// Stable name, as the vectors spell it.
    pub fn reason(self) -> &'static str {
        match self {
            Self::BadKey => "bad_key",
            Self::Oversized => "oversized",
            Self::MalformedRecord => "malformed_record",
            Self::BadPublisher => "bad_publisher",
            Self::BadAnnouncement => "bad_announcement",
            Self::GeneIdMismatch => "gene_id_mismatch",
            Self::Stale => "stale",
            Self::FromTheFuture => "from_the_future",
            Self::BadSignature => "bad_signature",
        }
    }

    /// Whether the sender of a PUT carrying this record forged it. Only the
    /// publisher binding and the signature qualify: only the publisher's key
    /// makes a record that passes them, so failing them is not an error an
    /// honest author could make. A bad key shape or field may be other
    /// software, a bad time clock skew.
    pub fn is_forgery(self) -> bool {
        matches!(self, Self::BadPublisher | Self::BadSignature)
    }
}

/// A record that passed [`validate_record`].
#[derive(Debug, Clone, PartialEq)]
pub struct ValidRecord {
    pub announcement: GeneAnnouncement,
    /// The announcement exactly as signed.
    pub announcement_bytes: Vec<u8>,
    pub publisher: PeerId,
    pub signature: [u8; SIGNATURE_LEN],
    /// What a node stores and serves: the three fields, canonically encoded,
    /// anything else dropped.
    pub canonical: Vec<u8>,
}

impl ValidRecord {
    /// Whether this record replaces `stored` under the same key: a later
    /// timestamp wins; on a tie, the lexicographically smaller signature.
    pub fn supersedes(&self, stored: &ValidRecord) -> bool {
        let (new, old) = (self.announcement.timestamp_ms, stored.announcement.timestamp_ms);
        new > old || (new == old && self.signature < stored.signature)
    }

    /// When a copy that arrived at `arrival_ms` expires.
    pub fn expires_at_ms(&self, arrival_ms: u64) -> u64 {
        self.announcement
            .timestamp_ms
            .saturating_add(MAX_AGE_MS)
            .min(arrival_ms.saturating_add(STORE_TTL_MS))
    }
}

/// Multihash header of a sha2-256 digest: code 0x12, length 32.
pub const SHA2_256_MULTIHASH: [u8; 2] = [0x12, 0x20];

/// Key of the provider records for `gene_id`: the 32 bytes its 64 hex digits
/// spell, as a sha2-256 multihash (34 bytes). A v2 ID already is a SHA-256
/// digest, so it is not hashed again. A multihash key fits go-libp2p-kad-dht's
/// 80-byte key limit and decodes as a CID in js-libp2p. `None` unless
/// `gene_id` is a v2 ID.
pub fn provider_key(gene_id: &str) -> Option<Vec<u8>> {
    if !is_gene_id(gene_id) {
        return None;
    }
    let digest = hex::decode(&gene_id[3..]).ok()?;
    Some([&SHA2_256_MULTIHASH[..], &digest].concat())
}

/// Key of `publisher`'s record for `gene_id`.
pub fn record_key(gene_id: &str, publisher: &PeerId) -> Vec<u8> {
    format!("{KEY_PREFIX}{gene_id}/{}", publisher.to_base58()).into_bytes()
}

/// The bytes a publisher signs.
pub fn signed_message(announcement: &[u8]) -> Vec<u8> {
    let len = u32::try_from(announcement.len()).expect("announcement under 4 GiB");
    let mut msg = Vec::with_capacity(SIGNATURE_DOMAIN.len() + 5 + announcement.len());
    msg.extend_from_slice(SIGNATURE_DOMAIN);
    msg.push(0);
    msg.extend_from_slice(&len.to_be_bytes());
    msg.extend_from_slice(announcement);
    msg
}

/// Encode an announcement as the bare wire-v1 `GeneAnnouncement` a record
/// carries (no `GossipMessage` wrapper).
pub fn encode_announcement_message(ann: &GeneAnnouncement) -> Vec<u8> {
    WireGeneAnnouncement::from(ann).encode_to_vec()
}

/// Sign `announcement` (already encoded) as `keypair`'s record. Fails for a
/// key that is not Ed25519.
pub fn sign_record(keypair: &Keypair, announcement: &[u8]) -> Option<Vec<u8>> {
    keypair.clone().try_into_ed25519().ok()?;
    let signature = keypair.sign(&signed_message(announcement)).ok()?;
    let record = WireGeneRecord {
        announcement: announcement.to_vec(),
        publisher: keypair.public().to_peer_id().to_bytes(),
        signature,
    };
    Some(record.encode_to_vec())
}

/// Validate the record `value` stored under `key`, at `now_ms`. The checks run
/// in the frozen order; the first one that fails is the verdict.
pub fn validate_record(key: &[u8], value: &[u8], now_ms: u64) -> Result<ValidRecord, RecordRejection> {
    // 2. Key shape.
    let (key_gene, named) = parse_key(key).ok_or(RecordRejection::BadKey)?;
    // 3. Size.
    if value.len() > MAX_RECORD_BYTES {
        return Err(RecordRejection::Oversized);
    }
    // 4. Outer grammar; all three fields present.
    let outer = parse_fields(value, &RECORD_SCHEMA).map_err(|_| RecordRejection::MalformedRecord)?;
    let [Some(Field::Bytes(ann_bytes)), Some(Field::Bytes(publisher)), Some(Field::Bytes(signature))] = outer else {
        return Err(RecordRejection::MalformedRecord);
    };
    // 5. Publisher binding.
    let key = publisher_key(publisher, &named).ok_or(RecordRejection::BadPublisher)?;
    // 6. Announcement grammar, field rules, gene ID.
    let announcement = parse_announcement(ann_bytes).ok_or(RecordRejection::BadAnnouncement)?;
    if !fields_are_valid(&announcement) {
        return Err(RecordRejection::BadAnnouncement);
    }
    if announcement.gene_id != key_gene {
        return Err(RecordRejection::GeneIdMismatch);
    }
    // 7. Time window.
    if announcement.timestamp_ms < now_ms.saturating_sub(MAX_AGE_MS) {
        return Err(RecordRejection::Stale);
    }
    if announcement.timestamp_ms > now_ms.saturating_add(MAX_FUTURE_MS) {
        return Err(RecordRejection::FromTheFuture);
    }
    // 8. Signature over the raw announcement bytes. Cofactorless, with R
    // compared byte for byte (so a non-canonical R never matches) and not
    // checked for small order: never the cofactored equation, which accepts
    // what this refuses, and never `verify_strict`, which refuses a
    // small-order R the rules accept.
    let signature: [u8; SIGNATURE_LEN] = signature.try_into().map_err(|_| RecordRejection::BadSignature)?;
    key.verify(&signed_message(ann_bytes), &Signature::from_bytes(&signature))
        .map_err(|_| RecordRejection::BadSignature)?;

    let publisher = PeerId::from_bytes(publisher).map_err(|_| RecordRejection::BadPublisher)?;
    let canonical = WireGeneRecord {
        announcement: ann_bytes.to_vec(),
        publisher: publisher.to_bytes(),
        signature: signature.to_vec(),
    }
    .encode_to_vec();
    Ok(ValidRecord {
        announcement,
        announcement_bytes: ann_bytes.to_vec(),
        publisher,
        signature,
        canonical,
    })
}

/// Split a key into its gene ID and the publisher bytes it names. Step 2
/// checks the shape only: `P` must spell 38 bytes with the Ed25519 PeerId
/// prefix. Whether they are the record's publisher is step 5.
fn parse_key(key: &[u8]) -> Option<(&str, [u8; PUBLISHER_LEN])> {
    let rest = std::str::from_utf8(key).ok()?.strip_prefix(KEY_PREFIX)?;
    let (gene, publisher) = rest.split_once('/')?;
    if !is_gene_id(gene) || publisher.len() > 64 {
        return None;
    }
    let named: [u8; PUBLISHER_LEN] = base58_decode(publisher)?.try_into().ok()?;
    (named[..PUBLISHER_PREFIX.len()] == PUBLISHER_PREFIX).then_some((gene, named))
}

/// `v2:` followed by 64 lowercase hex digits.
fn is_gene_id(s: &str) -> bool {
    s.strip_prefix("v2:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Base58btc (Bitcoin alphabet, no multibase prefix); `None` on any other
/// character.
fn base58_decode(text: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut magnitude: Vec<u8> = Vec::new(); // big-endian
    for c in text.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c)? as u32;
        for b in magnitude.iter_mut().rev() {
            carry += u32::from(*b) * 58;
            *b = carry as u8;
            carry >>= 8;
        }
        while carry > 0 {
            magnitude.insert(0, carry as u8);
            carry >>= 8;
        }
    }
    let zeros = text.bytes().take_while(|&c| c == b'1').count();
    let mut out = vec![0; zeros];
    out.extend(magnitude);
    Some(out)
}

/// Step 5: the publisher's verifying key, if `publisher` is exactly the bytes
/// the key names and its key is a canonical encoding of a point not of small
/// order.
fn publisher_key(publisher: &[u8], named: &[u8; PUBLISHER_LEN]) -> Option<VerifyingKey> {
    if publisher != named {
        return None;
    }
    let a: [u8; 32] = publisher[PUBLISHER_PREFIX.len()..].try_into().ok()?;
    if !is_canonical_y(&a) || SMALL_ORDER_KEYS.contains(&a) {
        return None;
    }
    VerifyingKey::from_bytes(&a).ok()
}

/// Whether a compressed Edwards point encodes y < p = 2^255 − 19. A y in
/// [p, 2^255) is a second spelling of y − p, which would give one key two
/// PeerIds.
fn is_canonical_y(a: &[u8; 32]) -> bool {
    let all_ones = a[1..31].iter().all(|&b| b == 0xff) && a[31] & 0x7f == 0x7f;
    !(all_ones && a[0] >= 0xed)
}

/// Step 6: the frozen field rules.
fn fields_are_valid(a: &GeneAnnouncement) -> bool {
    let compiled = match a.fidelity.as_str() {
        "Native" | "Hybrid" => true,
        "Wrapped" => false,
        _ => return false,
    };
    is_gene_id(&a.gene_id)
        && a.name.len() <= MAX_NAME_BYTES
        && !a.domain.is_empty()
        && a.domain.len() <= MAX_DOMAIN_BYTES
        && a.ir_spec.len() <= MAX_IR_SPEC_BYTES
        && (compiled || a.ir_spec.is_empty())
        && a.version.len() <= MAX_VERSION_BYTES
}

/// Step 6: the announcement's fields under the frozen grammar.
fn parse_announcement(bytes: &[u8]) -> Option<GeneAnnouncement> {
    let fields = parse_fields(bytes, &ANNOUNCEMENT_SCHEMA).ok()?;
    let text = |i: usize| match fields[i] {
        Some(Field::Bytes(b)) => std::str::from_utf8(b).map(str::to_owned).unwrap_or_default(),
        _ => String::new(),
    };
    let timestamp_ms = match fields[6] {
        Some(Field::Uint(n)) => n,
        _ => 0,
    };
    Some(GeneAnnouncement {
        gene_id: text(0),
        name: text(1),
        domain: text(2),
        fidelity: text(3),
        ir_spec: text(4),
        version: text(5),
        timestamp_ms,
    })
}

// ---- The frozen parsing grammar ---------------------------------------------

#[derive(Clone, Copy)]
enum Kind {
    /// Length-delimited, any bytes.
    Bytes,
    /// Length-delimited, strict UTF-8.
    Utf8,
    /// Varint.
    Uint,
}

/// `(field number, kind)` of each defined field, in declaration order.
const RECORD_SCHEMA: [(u64, Kind); 3] = [(1, Kind::Bytes), (2, Kind::Bytes), (3, Kind::Bytes)];
const ANNOUNCEMENT_SCHEMA: [(u64, Kind); 7] = [
    (1, Kind::Utf8),
    (2, Kind::Utf8),
    (3, Kind::Utf8),
    (4, Kind::Utf8),
    (5, Kind::Utf8),
    (6, Kind::Utf8),
    (7, Kind::Uint),
];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Field<'a> {
    Bytes(&'a [u8]),
    Uint(u64),
}

#[derive(Debug)]
struct Malformed;

/// Walk `buf` as protobuf fields under the frozen grammar and return the
/// defined fields by schema position:
/// - wire types 0, 1, 2 and 5 only (groups and 6, 7 are refused);
/// - a varint (tag, length or value) is at most 10 bytes and fits in 64
///   bits; overlong in-range spellings are accepted;
/// - a field number is 1 ..= 2^29 − 1;
/// - every field, tag included, ends before the input does;
/// - fields come in any order, unknown numbers are skipped;
/// - a defined field appearing twice, or with another wire type, is refused;
/// - a defined string is strict UTF-8.
fn parse_fields<'a, const N: usize>(mut buf: &'a [u8], schema: &[(u64, Kind); N]) -> Result<[Option<Field<'a>>; N], Malformed> {
    let mut out = [None; N];
    while !buf.is_empty() {
        let key = read_varint(&mut buf)?;
        let (number, wire) = (key >> 3, key & 7);
        if !(1..=MAX_FIELD_NUMBER).contains(&number) {
            return Err(Malformed);
        }
        let value = match wire {
            0 => Field::Uint(read_varint(&mut buf)?),
            1 => Field::Bytes(take(&mut buf, 8)?),
            2 => {
                let len = usize::try_from(read_varint(&mut buf)?).map_err(|_| Malformed)?;
                Field::Bytes(take(&mut buf, len)?)
            }
            5 => Field::Bytes(take(&mut buf, 4)?),
            _ => return Err(Malformed),
        };
        let Some(i) = schema.iter().position(|(n, _)| *n == number) else {
            continue;
        };
        let ok = match (schema[i].1, value, wire) {
            (Kind::Uint, Field::Uint(_), 0) => true,
            (Kind::Bytes, Field::Bytes(_), 2) => true,
            (Kind::Utf8, Field::Bytes(b), 2) => std::str::from_utf8(b).is_ok(),
            _ => false,
        };
        if !ok || out[i].is_some() {
            return Err(Malformed);
        }
        out[i] = Some(value);
    }
    Ok(out)
}

fn read_varint(buf: &mut &[u8]) -> Result<u64, Malformed> {
    let mut value = 0u64;
    for i in 0..10 {
        let (&b, rest) = buf.split_first().ok_or(Malformed)?;
        *buf = rest;
        if i == 9 && b > 0x01 {
            return Err(Malformed);
        }
        value |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(value);
        }
    }
    unreachable!("the 10th byte either ends the varint or is refused")
}

fn take<'a>(buf: &mut &'a [u8], len: usize) -> Result<&'a [u8], Malformed> {
    if len > buf.len() {
        return Err(Malformed);
    }
    let (head, rest) = buf.split_at(len);
    *buf = rest;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 8032 §7.1 TEST 1 secret key — a published test vector, not a
    /// credential. The reference script signs with the same key, so Rust's
    /// signatures must match its bytes exactly (Ed25519 is deterministic).
    const RFC8032_TEST1_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"; // gitleaks:allow

    fn vectors() -> serde_json::Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/p2p-dht-v1/vectors.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("read the vectors")).expect("vectors are JSON")
    }

    fn unhex(v: &serde_json::Value) -> Vec<u8> {
        hex::decode(v.as_str().expect("hex string")).expect("valid hex")
    }

    #[test]
    fn dht_proto_schema_frozen_sha256() {
        use sha2::{Digest, Sha256};
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/proto/p2p-dht-v1.proto");
        let bytes = std::fs::read(path).expect("read the frozen .proto");
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            FROZEN_DHT_PROTO_SHA256,
            "proto/p2p-dht-v1.proto changed — GeneRecord v1 is frozen; an incompatible \
             change gets a new key namespace and Kad protocol name (comments are frozen too)"
        );
    }

    #[test]
    fn dht_struct_tags_match_the_proto() {
        let proto = include_str!("../../proto/p2p-dht-v1.proto");
        let declared: Vec<(String, u32)> = proto
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && l.ends_with(';') && l.contains(" = "))
            .filter_map(|l| {
                let (lhs, rhs) = l.trim_end_matches(';').split_once(" = ")?;
                Some((lhs.split_whitespace().collect::<Vec<_>>().join(" "), rhs.trim().parse().ok()?))
            })
            .collect();
        let expected: Vec<(String, u32)> = [("bytes announcement", 1), ("bytes publisher", 2), ("bytes signature", 3)]
            .into_iter()
            .map(|(f, t)| (f.to_string(), t))
            .collect();
        assert_eq!(declared, expected, "update WireGeneRecord and RECORD_SCHEMA with the .proto");
    }

    #[test]
    fn frozen_constants_are_the_ruled_ones() {
        assert_eq!(KAD_PROTOCOL, "/rotifer/gene-discovery/1.0.0");
        assert_eq!(KEY_PREFIX, "/rotifer/gene/");
        assert_eq!(MAX_RECORD_BYTES, 8192);
        assert_eq!(SIGNATURE_DOMAIN, b"rotifer-gene-record-v1");
        assert_eq!(MAX_AGE_MS, 172_800_000);
        assert_eq!(MAX_FUTURE_MS, 300_000);
        assert_eq!(STORE_TTL_MS, 86_400_000);
    }

    // Every vector from the independent implementation gets the same verdict
    // here — accept, reject or reject-charged, and the same refusing step —
    // and accepted records are stored as the same canonical bytes.
    #[test]
    fn dht_vectors_get_the_reference_verdicts() {
        let doc = vectors();
        let list = doc["vectors"].as_array().expect("vectors");
        assert!(list.len() >= 101, "the vector set shrank: {}", list.len());
        for v in list {
            let name = v["name"].as_str().unwrap();
            let key = v["key"].as_str().unwrap().as_bytes();
            let now = v["now_ms"].as_u64().unwrap();
            if v["kind"] == "replace" {
                let valid = |field: &str| validate_record(key, &unhex(&v[field]), now).unwrap_or_else(|e| panic!("{name}: {e:?}"));
                let (stored, incoming) = (valid("stored"), valid("incoming"));
                assert_eq!(incoming.supersedes(&stored), v["replaces"].as_bool().unwrap(), "{name}");
                continue;
            }
            let got = validate_record(key, &unhex(&v["value"]), now);
            match v["verdict"].as_str().unwrap() {
                "accept" => {
                    let rec = got.unwrap_or_else(|e| panic!("{name}: expected accept, got {e:?}"));
                    assert_eq!(hex::encode(&rec.canonical), v["stored"].as_str().unwrap(), "{name}: stored bytes");
                }
                verdict => {
                    let err = got.err().unwrap_or_else(|| panic!("{name}: expected a refusal, got accept"));
                    assert_eq!(
                        (err.step(), err.reason(), err.is_forgery()),
                        (v["step"].as_u64().unwrap() as u8, v["reason"].as_str().unwrap(), verdict == "reject-charged"),
                        "{name}: refusing step and charge"
                    );
                }
            }
        }
    }

    // The blacklist is form (b) of the small-order rule; the library's own
    // `is_weak` is form (a) on every entry it can decode. Its default verify
    // does not apply it, so the record code must.
    #[test]
    fn the_small_order_blacklist_matches_the_library() {
        for a in SMALL_ORDER_KEYS {
            let key = VerifyingKey::from_bytes(&a).expect("every entry decodes in dalek");
            assert!(key.is_weak(), "{}", hex::encode(a));
        }
        let mut seed = hex::decode(RFC8032_TEST1_SEED).unwrap();
        let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(&mut seed).unwrap();
        let public = libp2p::identity::ed25519::Keypair::from(secret).public().to_bytes();
        assert!(!SMALL_ORDER_KEYS.contains(&public));
        assert!(!VerifyingKey::from_bytes(&public).unwrap().is_weak());
    }

    // Rust signs the base announcement with the reference script's key and
    // gets the reference bytes: signing and verifying agree across the two
    // implementations, not only verifying.
    #[test]
    fn signing_matches_the_reference_bytes() {
        let doc = vectors();
        let base = doc["vectors"].as_array().unwrap().iter().find(|v| v["name"] == "V1-canonical").expect("V1");
        let record = WireGeneRecord::decode(unhex(&base["value"]).as_slice()).unwrap();
        let mut seed = hex::decode(RFC8032_TEST1_SEED).unwrap();
        let secret = libp2p::identity::ed25519::SecretKey::try_from_bytes(&mut seed).unwrap();
        let keypair = Keypair::from(libp2p::identity::ed25519::Keypair::from(secret));
        let signed = sign_record(&keypair, &record.announcement).unwrap();
        assert_eq!(hex::encode(signed), base["value"].as_str().unwrap());
        assert_eq!(
            String::from_utf8(record_key(
                &validate_record(base["key"].as_str().unwrap().as_bytes(), &unhex(&base["value"]), base["now_ms"].as_u64().unwrap())
                    .unwrap()
                    .announcement
                    .gene_id,
                &keypair.public().to_peer_id()
            ))
            .unwrap(),
            base["key"].as_str().unwrap()
        );
    }

    #[test]
    fn only_publisher_and_signature_failures_are_forgeries() {
        use RecordRejection::*;
        let forged: Vec<_> = [
            BadKey,
            Oversized,
            MalformedRecord,
            BadPublisher,
            BadAnnouncement,
            GeneIdMismatch,
            Stale,
            FromTheFuture,
            BadSignature,
        ]
        .into_iter()
        .filter(|r| r.is_forgery())
        .collect();
        assert_eq!(forged, vec![BadPublisher, BadSignature]);
    }

    #[test]
    fn a_record_lives_at_most_a_day_after_arrival() {
        let rec = ValidRecord {
            announcement: GeneAnnouncement {
                gene_id: String::new(),
                name: String::new(),
                domain: String::new(),
                fidelity: String::new(),
                ir_spec: String::new(),
                version: String::new(),
                timestamp_ms: 1_000_000_000_000,
            },
            announcement_bytes: Vec::new(),
            publisher: PeerId::random(),
            signature: [0; SIGNATURE_LEN],
            canonical: Vec::new(),
        };
        let ts = rec.announcement.timestamp_ms;
        // Arrives fresh: the 24 h store limit binds.
        assert_eq!(rec.expires_at_ms(ts), ts + STORE_TTL_MS);
        // Arrives 40 h old: the 48 h age limit binds.
        assert_eq!(rec.expires_at_ms(ts + 40 * 3600 * 1000), ts + MAX_AGE_MS);
    }

    #[test]
    fn provider_key_is_the_gene_ids_digest_as_a_multihash() {
        let digest: Vec<u8> = (0..32).map(|i| i * 7 + 1).collect();
        let id = format!("v2:{}", hex::encode(&digest));
        let key = provider_key(&id).expect("v2 id");
        assert_eq!(key.len(), 34);
        assert_eq!(key[..2], [0x12, 0x20]);
        assert_eq!(key[2..], digest[..]);
        for bad in ["v1:00", &format!("v2:{}", "AB".repeat(32)), &format!("{id}\n"), &id[..66]] {
            assert_eq!(provider_key(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn provider_keys_match_the_reference() {
        let list = vectors()["provider_keys"].as_array().expect("provider_keys").clone();
        assert!(list.len() >= 4, "provider key vectors: {}", list.len());
        for v in &list {
            let id = v["gene_id"].as_str().unwrap();
            assert_eq!(provider_key(id), Some(unhex(&v["multihash"])), "{id}");
        }
    }

    #[test]
    fn keys_spell_the_gene_and_publisher() {
        let id = format!("v2:{}", "ab".repeat(32));
        let peer = PeerId::random();
        assert_eq!(record_key(&id, &peer), format!("/rotifer/gene/{id}/{}", peer.to_base58()).into_bytes());
    }
}
