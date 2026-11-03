#!/usr/bin/env python3
"""Independent implementation of the frozen DHT gene record v1
(crates/rotifer-core/proto/p2p-dht-v1.proto). Standard library only; shares no
code with the Rust implementation (prost, ed25519-dalek): its own protobuf
reader and writer, its own Ed25519 (RFC 8032, cofactorless verification).

It builds the vectors, runs its own validator on each, and refuses to write
them unless every verdict is the intended one. The Rust tests must then reach
the same verdicts and store the same bytes:
  python3 scripts/p2p-dht-v1-reference.py > crates/rotifer-core/tests/fixtures/p2p-dht-v1/vectors.json
"""

import hashlib
import json
import re
import sys

# ---- Ed25519 (RFC 8032 §5.1) ------------------------------------------------

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = -121665 * pow(121666, P - 2, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)
IDENTITY = (0, 1, 1, 0)


def inv(x):
    return pow(x, P - 2, P)


def add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % P
    b = (p[1] + p[0]) * (q[1] + q[0]) % P
    c = 2 * p[3] * q[3] * D % P
    d = 2 * p[2] * q[2] % P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def mul(s, p):
    q = IDENTITY
    while s > 0:
        if s & 1:
            q = add(q, p)
        p = add(p, p)
        s >>= 1
    return q


def neg(p):
    return ((P - p[0]) % P, p[1], p[2], (P - p[3]) % P)


def same(p, q):
    return (p[0] * q[2] - q[0] * p[2]) % P == 0 and (p[1] * q[2] - q[1] * p[2]) % P == 0


def recover_x(y, sign):
    if y >= P:
        return None  # not a canonical encoding
    x2 = (y * y - 1) * inv(D * y * y + 1) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


def compress(p):
    z = inv(p[2])
    x, y = p[0] * z % P, p[1] * z % P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def decompress(b):
    y = int.from_bytes(b, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    x = recover_x(y, sign)
    return None if x is None else (x, y, 1, x * y % P)


B = decompress((4 * inv(5) % P).to_bytes(32, "little"))


def h_int(*parts):
    return int.from_bytes(hashlib.sha512(b"".join(parts)).digest(), "little")


def expand(seed):
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def public_key(seed):
    return compress(mul(expand(seed)[0], B))


def sign(seed, msg):
    a, prefix = expand(seed)
    pub = compress(mul(a, B))
    r = h_int(prefix, msg) % L
    big_r = compress(mul(r, B))
    s = (r + h_int(big_r, pub, msg) % L * a) % L
    return big_r + s.to_bytes(32, "little")


def small_order(point):
    return same(mul(8, point), IDENTITY)


def verify(pub, msg, sig):
    """Cofactorless: the encoding of [S]B - [k]A must equal R byte for byte; S < L."""
    if len(sig) != 64:
        return False
    a = decompress(pub)
    s = int.from_bytes(sig[32:], "little")
    if a is None or s >= L:
        return False
    k = h_int(sig[:32], pub, msg) % L
    return compress(add(mul(s, B), mul(k, neg(a)))) == sig[:32]


# RFC 8032 §7.1 TEST 1 and TEST 2 secret keys — published test vectors, not
# credentials. The Rust test signs with TEST 1 and must get the same bytes.
SEED_1 = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")  # gitleaks:allow
SEED_2 = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")  # gitleaks:allow

# The Ed25519 above must reproduce RFC 8032 TEST 1 before it signs anything.
assert public_key(SEED_1).hex() == "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
assert sign(SEED_1, b"").hex() == (
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
)
assert verify(public_key(SEED_1), b"", sign(SEED_1, b""))

# The ten encodings (y < p) of points of small order — §2.4 rule 2, form (b).
# Form (a) is: decode per RFC 8032 §5.1.3 (x = 0 with the sign bit set is a
# decoding failure) and require [8]A != identity. The two forms are checked to
# agree right below, by enumerating the torsion subgroup.
BLACKLIST = [bytes.fromhex(h) for h in (
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "0100000000000000000000000000000000000000000000000000000000000080",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
)]


def lenient_decompress(b):
    """What common libraries do: x = 0 decodes whatever the sign bit says."""
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    x = recover_x(y, int.from_bytes(b, "little") >> 255)
    if x is None and y < P and (y * y - 1) % P == 0:
        x = 0
    return None if x is None else (x, y, 1, x * y % P)


def lenient_verify(pub, msg, sig):
    a = lenient_decompress(pub)
    s = int.from_bytes(sig[32:], "little")
    if a is None or s >= L:
        return False
    k = h_int(sig[:32], pub, msg) % L
    return compress(add(mul(s, B), mul(k, neg(a)))) == sig[:32]


def cofactored_verify(pub, msg, sig):
    """The cofactored equation [8]([S]B - [k]A - R) = identity, with R decoded
    leniently (y >= p reduced). §2.4 rule 7 forbids it; the generator only uses
    it to prove that V21d-V21f tell the two equations apart."""
    a = decompress(pub)
    y = int.from_bytes(sig[:32], "little")
    sign, y = y >> 255, (y & ((1 << 255) - 1)) % P
    x = recover_x(y, sign)
    if x is None and (y * y - 1) % P == 0:
        x = 0
    s = int.from_bytes(sig[32:], "little")
    if a is None or x is None or s >= L:
        return False
    k = h_int(sig[:32], pub, msg) % L
    diff = add(add(mul(s, B), mul(k, neg(a))), neg((x, y, 1, x * y % P)))
    return same(mul(8, diff), IDENTITY)


def torsion_encodings():
    t8 = decompress(BLACKLIST[4])
    assert not same(mul(4, t8), IDENTITY) and same(mul(8, t8), IDENTITY)
    out = set()
    for i in range(8):
        enc = compress(mul(i, t8))
        out.add(enc)
        if mul(i, t8)[0] % P == 0:  # x = 0: the sign-bit spelling too
            out.add(enc[:31] + bytes([enc[31] | 0x80]))
    return out


assert torsion_encodings() == set(BLACKLIST) and len(BLACKLIST) == 10
assert all(decompress(e) is None or small_order(decompress(e)) for e in BLACKLIST)

# ---- protobuf ---------------------------------------------------------------

# Field numbers are 1 ..= 2^29 - 1; anything else is refused.
MAX_FIELD_NUMBER = 2**29 - 1


def varint(n):
    out = bytearray()
    while True:
        b, n = n & 0x7F, n >> 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def key(number, wire):
    return varint((number << 3) | wire)


def ld(number, payload):
    return key(number, 2) + varint(len(payload)) + payload


class Malformed(Exception):
    pass


def read_varint(buf, pos):
    value = 0
    for i in range(10):
        if pos >= len(buf):
            raise Malformed("truncated varint")
        b = buf[pos]
        pos += 1
        if i == 9 and b > 1:
            raise Malformed("varint over 64 bits")
        value |= (b & 0x7F) << (7 * i)
        if not b & 0x80:
            return value, pos
    raise AssertionError("unreachable")


def parse_fields(buf, schema):
    """The frozen grammar. schema: {number: "bytes" | "utf8" | "uint"}."""
    out, pos = {}, 0
    while pos < len(buf):
        k, pos = read_varint(buf, pos)
        number, wire = k >> 3, k & 7
        if not 1 <= number <= MAX_FIELD_NUMBER:
            raise Malformed("field number")
        if wire == 0:
            value, pos = read_varint(buf, pos)
        elif wire in (1, 5):
            n = 8 if wire == 1 else 4
            if pos + n > len(buf):
                raise Malformed("truncated fixed")
            value, pos = buf[pos:pos + n], pos + n
        elif wire == 2:
            n, pos = read_varint(buf, pos)
            if pos + n > len(buf):
                raise Malformed("length past the end")
            value, pos = buf[pos:pos + n], pos + n
        else:
            raise Malformed("wire type %d" % wire)
        kind = schema.get(number)
        if kind is None:
            continue
        if number in out:
            raise Malformed("field %d twice" % number)
        if kind == "uint":
            if wire != 0:
                raise Malformed("wire type")
        else:
            if wire != 2:
                raise Malformed("wire type")
            if kind == "utf8":
                try:
                    value.decode("utf-8", errors="strict")
                except UnicodeDecodeError:
                    raise Malformed("utf-8")
        out[number] = value
    return out


# ---- the record -------------------------------------------------------------

PREFIX = "/rotifer/gene/"
MAX_RECORD = 8192
MAX_AGE = 48 * 3600 * 1000
MAX_FUTURE = 300 * 1000
DOMAIN = b"rotifer-gene-record-v1"
PUBLISHER_PREFIX = bytes([0x00, 0x24, 0x08, 0x01, 0x12, 0x20])
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
# Exactly 67 bytes: "v2:" and 64 of 0-9a-f, nothing before or after. Always
# fullmatch: Python's `$` also matches before a final newline.
GENE_ID = re.compile(r"v2:[0-9a-f]{64}")
ANN_SCHEMA = {1: "utf8", 2: "utf8", 3: "utf8", 4: "utf8", 5: "utf8", 6: "utf8", 7: "uint"}
REC_SCHEMA = {1: "bytes", 2: "bytes", 3: "bytes"}


def provider_key(gid):
    """The provider-record key: G's 32-byte digest as a sha2-256 multihash."""
    assert GENE_ID.fullmatch(gid)
    return bytes([0x12, 0x20]) + bytes.fromhex(gid[3:])


def b58(data):
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def b58decode(text):
    """None unless every character is in the Bitcoin alphabet."""
    if any(c not in B58 for c in text):
        return None
    n = 0
    for c in text:
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(text) - len(text.lstrip("1"))) + body


def publisher_of(seed):
    return PUBLISHER_PREFIX + public_key(seed)


def signed(announcement):
    return DOMAIN + b"\0" + len(announcement).to_bytes(4, "big") + announcement


def record(announcement, publisher, signature):
    return ld(1, announcement) + ld(2, publisher) + ld(3, signature)


def sign_record(seed, announcement):
    return record(announcement, publisher_of(seed), sign(seed, signed(announcement)))


def check_fields(a):
    """The field rules, as frozen in GeneRecord v1 (§2.5 rule 13) — not imported
    from the gossip format, which may change without changing this."""
    if not GENE_ID.fullmatch(a[1]):
        return False
    if len(a[2].encode()) > 128:
        return False
    if not a[3] or len(a[3].encode()) > 128:
        return False
    if a[4] not in ("Native", "Hybrid", "Wrapped"):
        return False
    if len(a[5].encode()) > 32 or (a[4] == "Wrapped" and a[5]):
        return False
    return len(a[6].encode()) <= 64


def sound_key(a_bytes):
    """§2.4 rule 2, form (a): decodes per RFC 8032 §5.1.3 and [8]A is not the
    identity. (The Rust implementation uses form (b), the blacklist.)"""
    point = decompress(a_bytes)
    return point is not None and not small_order(point)


def validate(key_text, value, now):
    """("accept", stored_bytes) or (verdict, step, reason), verdict being
    "reject" or "reject-charged"."""
    # 2. key shape
    rest = key_text[len(PREFIX):] if key_text.startswith(PREFIX) else None
    parts = rest.split("/", 1) if rest is not None else []
    if len(parts) != 2 or not GENE_ID.fullmatch(parts[0]):
        return ("reject", 2, "bad_key")
    gene, named = parts[0], b58decode(parts[1]) if len(parts[1]) <= 64 else None
    if named is None or len(named) != 38 or named[:6] != PUBLISHER_PREFIX:
        return ("reject", 2, "bad_key")
    # 3. size
    if len(value) > MAX_RECORD:
        return ("reject", 3, "oversized")
    # 4. outer grammar
    try:
        outer = parse_fields(value, REC_SCHEMA)
    except Malformed:
        return ("reject", 4, "malformed_record")
    if len(outer) != 3:
        return ("reject", 4, "malformed_record")
    ann, pub, sig = outer[1], outer[2], outer[3]
    # 5. publisher binding: the bytes the key names, and a sound key
    if pub != named or not sound_key(pub[6:]):
        return ("reject-charged", 5, "bad_publisher")
    # 6. announcement
    try:
        fields = parse_fields(ann, ANN_SCHEMA)
    except Malformed:
        return ("reject", 6, "bad_announcement")
    a = {n: fields.get(n, b"").decode() if n < 7 else fields.get(n, 0) for n in range(1, 8)}
    if not check_fields(a):
        return ("reject", 6, "bad_announcement")
    if a[1] != gene:
        return ("reject", 6, "gene_id_mismatch")
    # 7. time
    if a[7] < max(now - MAX_AGE, 0):
        return ("reject", 7, "stale")
    if a[7] > now + MAX_FUTURE:
        return ("reject", 7, "from_the_future")
    # 8. signature
    if not verify(pub[6:], signed(ann), sig):
        return ("reject-charged", 8, "bad_signature")
    return ("accept", record(ann, pub, sig))


def timestamp_of(value):
    return parse_fields(parse_fields(value, REC_SCHEMA)[1], ANN_SCHEMA).get(7, 0)


def replaces(incoming, stored):
    """§2.7 rule 2."""
    ti, ts = timestamp_of(incoming), timestamp_of(stored)
    si, ss = parse_fields(incoming, REC_SCHEMA)[3], parse_fields(stored, REC_SCHEMA)[3]
    return ti > ts or (ti == ts and si < ss)


# ---- vectors ----------------------------------------------------------------

NOW = 1760000000000
GENE = "v2:" + hashlib.sha256(b"rotifer dht v1 vector gene").hexdigest()
OTHER_GENE = "v2:" + hashlib.sha256(b"rotifer dht v1 another gene").hexdigest()
TS = NOW - 60_000
PUB_1 = publisher_of(SEED_1)
PUB_2 = publisher_of(SEED_2)


def announcement(gene=GENE, name="summarizer", domain="text", fidelity="Native", ir_spec="1.0", version="1.2.0", ts=TS, extra=b""):
    out = b""
    for number, text in ((1, gene), (2, name), (3, domain), (4, fidelity), (5, ir_spec), (6, version)):
        if text:
            out += ld(number, text.encode() if isinstance(text, str) else text)
    return out + key(7, 0) + varint(ts) + extra


def rkey(gene=GENE, publisher=PUB_1):
    return PREFIX + gene + "/" + (publisher if isinstance(publisher, str) else b58(publisher))


def with_sig(value, sig):
    f = parse_fields(value, REC_SCHEMA)
    return record(f[1], f[2], sig)


def overlong(n):
    """n as a varint one byte longer than needed (still in range)."""
    v = varint(n)
    return v[:-1] + bytes([v[-1] | 0x80, 0x00])


def padded_to(total):
    """A validly signed record of exactly `total` bytes, padded inside the
    announcement with an unknown field."""
    guess = total - len(sign_record(SEED_1, announcement(extra=ld(15, b"")))) - 4
    for pad in range(max(guess - 8, 0), guess + 8):
        value = sign_record(SEED_1, announcement(extra=ld(15, b"p" * pad)))
        if len(value) == total:
            return value
    raise AssertionError("no padding gives %d bytes" % total)


def noncanonical_y_key():
    """A non-canonical spelling (y + p) of a point that is not of small order."""
    for y in range(2, 19):
        point = decompress(y.to_bytes(32, "little"))
        if point is not None and not small_order(point):
            return (y + P).to_bytes(32, "little")
    raise AssertionError("no non-canonical spelling of a sound point")


def lenient_signature(pub, msg):
    """A signature that a common library's cofactorless verify accepts for a
    small-order key: R = [r]B with r chosen so that [k]A is the identity,
    S = r. Only the small-order rule stands between it and acceptance."""
    point = lenient_decompress(pub)
    for r in range(1, 1000):
        big_r = compress(mul(r, B))
        k = h_int(big_r, pub, msg) % L
        if same(mul(k, point), IDENTITY):
            sig = big_r + r.to_bytes(32, "little")
            assert lenient_verify(pub, msg, sig)
            return sig
    raise AssertionError("no signature found")


def main():
    base_ann = announcement()
    base = sign_record(SEED_1, base_ann)
    base_sig = parse_fields(base, REC_SCHEMA)[3]
    msg = signed(base_ann)
    base_ok = ("accept", base)
    # V1 is itself the canonical outer encoding.
    assert validate(rkey(), base, NOW) == base_ok

    def reject(step, reason):
        return ("reject-charged" if step in (5, 8) else "reject", step, reason)

    vectors = []

    def add_vector(name, key_text, value, expect, now=NOW):
        got = validate(key_text, value, now)
        if got != expect:
            raise SystemExit("%s: reference validator says %r, intended %r" % (name, got[:3], expect[:3]))
        v = {"name": name, "key": key_text, "value": value.hex(), "now_ms": now, "verdict": expect[0]}
        if expect[0] == "accept":
            v["stored"] = expect[1].hex()
        else:
            v["step"], v["reason"] = expect[1], expect[2]
        vectors.append(v)

    def accept(value):
        return ("accept", value)

    # ---- accepted
    add_vector("V1-canonical", rkey(), base, base_ok)
    noncanon = (key(15, 2) + varint(1) + b"x") + ld(6, b"") + key(7, 0) + varint(TS) + ld(5, b"1.0") + ld(4, b"Native") + ld(3, b"text") + ld(2, b"summarizer") + ld(1, GENE.encode())
    v2 = sign_record(SEED_1, noncanon)
    add_vector("V2-announcement-reordered-unknown-field-explicit-default", rkey(), v2, accept(v2))
    v2b = sign_record(SEED_1, announcement()[: -len(varint(TS))] + overlong(TS))
    add_vector("V2b-announcement-overlong-value-varint", rkey(), v2b, accept(v2b))
    v2c = sign_record(SEED_1, overlong((2 << 3) | 2) + varint(10) + b"summarizer" + announcement(name=""))
    add_vector("V2c-announcement-overlong-tag-varint", rkey(), v2c, accept(v2c))
    v2d = sign_record(SEED_1, key(2, 2) + overlong(10) + b"summarizer" + announcement(name=""))
    add_vector("V2d-announcement-overlong-length-varint", rkey(), v2d, accept(v2d))
    v2e = sign_record(SEED_1, announcement(extra=ld(9, b"\xff\xed\xa0\x80")))
    add_vector("V2e-announcement-unknown-field-not-utf8", rkey(), v2e, accept(v2e))
    v2f = sign_record(SEED_1, announcement(name="n" * 128, domain="d" * 128, fidelity="Hybrid", ir_spec="i" * 32, version="v" * 64))
    add_vector("V2f-every-field-at-its-limit", rkey(), v2f, accept(v2f))
    add_vector("V15-outer-unknown-field-dropped", rkey(), base + ld(9, b"pad"), base_ok)
    f = parse_fields(base, REC_SCHEMA)
    add_vector("V15b-outer-fields-reordered", rkey(), ld(3, f[3]) + ld(2, f[2]) + ld(1, f[1]), base_ok)
    add_vector("V15c-outer-overlong-tag-varint", rkey(), overlong((1 << 3) | 2) + varint(len(f[1])) + f[1] + ld(2, f[2]) + ld(3, f[3]), base_ok)
    add_vector("V15d-outer-overlong-length-varint", rkey(), key(1, 2) + overlong(len(f[1])) + f[1] + ld(2, f[2]) + ld(3, f[3]), base_ok)
    add_vector("V15e-outer-unknown-field-number-2^29-1", rkey(), base + key(2**29 - 1, 0) + varint(1), base_ok)
    v18a = padded_to(8192)
    add_vector("V18a-exactly-8192-bytes", rkey(), v18a, accept(v18a))
    add_vector("V20a-exactly-48h-old", rkey(), base, base_ok, now=TS + MAX_AGE)
    add_vector("V20c-exactly-300s-ahead", rkey(), base, base_ok, now=TS - MAX_FUTURE)
    # R of small order is not checked (§2.4 rule 6): R = identity, S = k·a.
    a_scalar = expand(SEED_1)[0]
    r_id = compress(IDENTITY)
    s_id = (h_int(r_id, PUB_1[6:], msg) % L) * a_scalar % L
    v21c = with_sig(base, r_id + s_id.to_bytes(32, "little"))
    add_vector("V21c-small-order-r-is-accepted", rkey(), v21c, accept(v21c))
    # The largest 10-byte varint the grammar allows (10th byte 0x01, value >= 2^63),
    # in an unknown field: a reader keeping varints in a signed or float type
    # would refuse it.
    v2g = sign_record(SEED_1, announcement(extra=key(9, 0) + b"\xff" * 9 + b"\x01"))
    add_vector("V2g-10-byte-varint-10th-byte-0x01", rkey(), v2g, accept(v2g))
    # A mixed-order key A' + T (T of order 8) is accepted (§2.4 rule 4): S = r + k·a
    # with k ≡ 0 (mod 8), so [k]T vanishes and cofactorless verification holds.
    t8 = decompress(BLACKLIST[4])
    mixed = compress(add(mul(a_scalar, B), t8))
    assert not small_order(decompress(mixed)) and not same(mul(L, decompress(mixed)), IDENTITY)
    mixed_pub = PUBLISHER_PREFIX + mixed
    for r in range(1, 1000):
        big_r = compress(mul(r, B))
        k = h_int(big_r, mixed, msg) % L
        if k % 8 == 0:
            mixed_sig = big_r + ((r + k * a_scalar) % L).to_bytes(32, "little")
            break
    assert verify(mixed, msg, mixed_sig)
    v16m = record(base_ann, mixed_pub, mixed_sig)
    add_vector("V16m-mixed-order-key-is-accepted", rkey(publisher=mixed_pub), v16m, accept(v16m))

    # ---- step 2: key shape (not charged)
    add_vector("V24a-key-not-gene-namespace", "/foo", base, reject(2, "bad_key"))
    add_vector("V24b-key-uppercase-gene-id", rkey(gene=GENE.upper().replace("V2:", "v2:")), base, reject(2, "bad_key"))
    add_vector("V24c-key-without-publisher", PREFIX + GENE, base, reject(2, "bad_key"))
    add_vector("V24d-key-publisher-not-base58", rkey(publisher="0" + b58(PUB_1)[1:]), base, reject(2, "bad_key"))
    add_vector("V24e-key-publisher-multibase-z", rkey(publisher="z" + b58(PUB_1)), base, reject(2, "bad_key"))
    add_vector("V24f-key-trailing-slash", rkey() + "/", base, reject(2, "bad_key"))
    add_vector("V24g-key-names-39-bytes", rkey(publisher=PUB_1 + b"\0"), base, reject(2, "bad_key"))
    gene_nl = GENE + "\n"
    add_vector("V24h-key-gene-id-trailing-newline", rkey(gene=gene_nl), base, reject(2, "bad_key"))
    add_vector("V24i-key-and-announcement-gene-id-trailing-newline", rkey(gene=gene_nl), sign_record(SEED_1, announcement(gene=gene_nl)), reject(2, "bad_key"))
    alias42 = bytes([0x00, 0x2A]) + PUB_1[2:] + bytes.fromhex("1a04deadbeef")
    assert len(alias42) == 44
    add_vector("V3-key-names-a-44-byte-publisher-42-byte-digest", rkey(publisher=alias42), record(base_ann, alias42, base_sig), reject(2, "bad_key"))
    reordered = bytes([0x00, 0x24, 0x12, 0x20]) + PUB_1[6:] + bytes([0x08, 0x01])
    assert len(reordered) == 38
    add_vector("V3b-key-names-a-38-byte-reordered-alias", rkey(publisher=reordered), record(base_ann, reordered, base_sig), reject(2, "bad_key"))
    secp = bytes([0x00, 0x25, 0x08, 0x02, 0x12, 0x21, 0x02]) + b"\x11" * 32
    add_vector("V4-key-names-a-secp256k1-publisher", rkey(publisher=secp), record(base_ann, secp, base_sig), reject(2, "bad_key"))
    sha = bytes([0x12, 0x20]) + hashlib.sha256(PUB_1[2:]).digest()
    add_vector("V5-key-names-a-sha256-multihash", rkey(publisher=sha), record(base_ann, sha, base_sig), reject(2, "bad_key"))

    # ---- step 3: size
    add_vector("V18b-8193-bytes", rkey(), padded_to(8193), reject(3, "oversized"))

    # ---- step 4: outer grammar
    add_vector("V9-outer-signature-twice", rkey(), base + ld(3, base_sig), reject(4, "malformed_record"))
    add_vector("V11c-outer-key-varint-11-bytes", rkey(), base + b"\x80" * 10 + b"\x01", reject(4, "malformed_record"))
    add_vector("V14-outer-length-past-the-end", rkey(), base[:-1], reject(4, "malformed_record"))
    add_vector("V14b-outer-signature-missing", rkey(), ld(1, base_ann) + ld(2, PUB_1), reject(4, "malformed_record"))
    add_vector("V14b2-outer-announcement-missing", rkey(), ld(2, PUB_1) + ld(3, base_sig), reject(4, "malformed_record"))
    add_vector("V14c-outer-field-number-0", rkey(), base + ld(0, b"z"), reject(4, "malformed_record"))
    add_vector("V14d-empty-value", rkey(), b"", reject(4, "malformed_record"))
    add_vector("V14e-outer-field-number-2^29", rkey(), base + key(2**29, 0) + varint(1), reject(4, "malformed_record"))
    add_vector("V14g-outer-wire-type-6", rkey(), base + key(9, 6), reject(4, "malformed_record"))
    add_vector("V14h-outer-wire-type-7", rkey(), base + key(9, 7), reject(4, "malformed_record"))
    add_vector("V14i-outer-truncated-varint", rkey(), base + key(9, 0) + b"\x80", reject(4, "malformed_record"))
    add_vector("V14j-outer-truncated-fixed32", rkey(), base + key(9, 5) + b"\x00\x00", reject(4, "malformed_record"))
    add_vector("V14k-outer-truncated-tag", rkey(), base + b"\xc8", reject(4, "malformed_record"))
    add_vector("V14l-outer-announcement-as-fixed32", rkey(), key(1, 5) + b"\x00" * 4 + ld(2, PUB_1) + ld(3, base_sig), reject(4, "malformed_record"))

    # ---- step 5: publisher binding (charged)
    add_vector("V3c-44-byte-publisher-under-the-canonical-key", rkey(), record(base_ann, alias42, base_sig), reject(5, "bad_publisher"))
    add_vector("V3d-reordered-alias-under-the-canonical-key", rkey(), record(base_ann, reordered, base_sig), reject(5, "bad_publisher"))
    add_vector("V6-key-names-another-publisher", rkey(publisher=PUB_2), base, reject(5, "bad_publisher"))
    # Every small-order encoding, each with a signature a library's default
    # cofactorless verify accepts: rule 2 alone refuses them.
    names = {
        BLACKLIST[0]: "V16e-small-order-y0",
        BLACKLIST[1]: "V16f-small-order-y0-sign",
        BLACKLIST[2]: "V16d-identity",
        BLACKLIST[3]: "V16c-identity-negative-zero",
        BLACKLIST[4]: "V16a-order-8",
        BLACKLIST[5]: "V16g-order-8-sign",
        BLACKLIST[6]: "V16h-order-8-other",
        BLACKLIST[7]: "V16i-order-8-other-sign",
        BLACKLIST[8]: "V16j-order-2",
        BLACKLIST[9]: "V16k-order-2-negative-zero",
    }
    for enc in BLACKLIST:
        pub = PUBLISHER_PREFIX + enc
        add_vector(names[enc], rkey(publisher=pub), record(base_ann, pub, lenient_signature(enc, msg)), reject(5, "bad_publisher"))
    # y ≥ p: nobody holds a key for it, so this one also fails step 8 and
    # does not isolate rule 2 (it is still refused at step 5).
    noncanon_key = PUBLISHER_PREFIX + noncanonical_y_key()
    add_vector("V16b-non-canonical-y", rkey(publisher=noncanon_key), record(base_ann, noncanon_key, base_sig), reject(5, "bad_publisher"))
    # y < p but no x satisfies the curve equation: not a point at all, so not
    # on the blacklist either (§2.4 rule 3 applies to both forms of rule 4).
    off_curve = next(y.to_bytes(32, "little") for y in range(2, 100) if decompress(y.to_bytes(32, "little")) is None)
    off_pub = PUBLISHER_PREFIX + off_curve
    assert off_curve not in BLACKLIST
    add_vector("V16l-off-curve-key", rkey(publisher=off_pub), record(base_ann, off_pub, base_sig), reject(5, "bad_publisher"))

    # ---- step 6: announcement (not charged)
    add_vector("V8-announcement-gene-id-twice", rkey(), sign_record(SEED_1, ld(1, GENE.encode()) + announcement()), reject(6, "bad_announcement"))
    add_vector("V10-announcement-invalid-utf8", rkey(), sign_record(SEED_1, announcement(name=b"ab\xff")), reject(6, "bad_announcement"))
    add_vector("V10b-announcement-utf8-surrogate", rkey(), sign_record(SEED_1, announcement(name=b"ab\xed\xa0\x80")), reject(6, "bad_announcement"))
    add_vector("V10c-announcement-utf8-overlong", rkey(), sign_record(SEED_1, announcement(name=b"ab\xc0\xaf")), reject(6, "bad_announcement"))
    long_ts = announcement()[: -len(varint(TS))] + b"\x80" * 10 + b"\x01"
    add_vector("V11a-announcement-varint-11-bytes", rkey(), sign_record(SEED_1, long_ts), reject(6, "bad_announcement"))
    over = announcement()[: -len(varint(TS))] + b"\xff" * 9 + b"\x02"
    add_vector("V11b-announcement-varint-over-64-bits", rkey(), sign_record(SEED_1, over), reject(6, "bad_announcement"))
    add_vector("V12-announcement-group", rkey(), sign_record(SEED_1, announcement(extra=key(9, 3) + key(9, 4))), reject(6, "bad_announcement"))
    add_vector("V13-announcement-version-as-varint", rkey(), sign_record(SEED_1, announcement(version="") + key(6, 0) + varint(1)), reject(6, "bad_announcement"))
    add_vector("V14f-outer-announcement-empty-but-present", rkey(), record(b"", PUB_1, sign(SEED_1, signed(b""))), reject(6, "bad_announcement"))
    add_vector("V23-announcement-empty-domain", rkey(), sign_record(SEED_1, announcement(domain="")), reject(6, "bad_announcement"))
    add_vector("V23b-wrapped-with-ir-spec", rkey(), sign_record(SEED_1, announcement(fidelity="Wrapped")), reject(6, "bad_announcement"))
    add_vector("V23c-fidelity-lowercase", rkey(), sign_record(SEED_1, announcement(fidelity="native")), reject(6, "bad_announcement"))
    add_vector("V23d-name-129-bytes", rkey(), sign_record(SEED_1, announcement(name="n" * 129)), reject(6, "bad_announcement"))
    add_vector("V23e-domain-129-bytes", rkey(), sign_record(SEED_1, announcement(domain="d" * 129)), reject(6, "bad_announcement"))
    add_vector("V23f-version-65-bytes", rkey(), sign_record(SEED_1, announcement(version="v" * 65)), reject(6, "bad_announcement"))
    add_vector("V23g-ir-spec-33-bytes", rkey(), sign_record(SEED_1, announcement(ir_spec="i" * 33)), reject(6, "bad_announcement"))
    add_vector("V23h-announcement-gene-id-uppercase", rkey(), sign_record(SEED_1, announcement(gene=GENE.upper().replace("V2:", "v2:"))), reject(6, "bad_announcement"))
    add_vector("V22-gene-id-not-the-keys", rkey(gene=OTHER_GENE), base, reject(6, "gene_id_mismatch"))

    # ---- step 7: time (not charged); now is fixed per vector
    add_vector("V20b-48h-and-1ms-old", rkey(), base, reject(7, "stale"), now=TS + MAX_AGE + 1)
    add_vector("V20d-300s-and-1ms-ahead", rkey(), base, reject(7, "from_the_future"), now=TS - MAX_FUTURE - 1)

    # ---- step 8: signature (charged)
    add_vector("V7a-signature-63-bytes", rkey(), with_sig(base, base_sig[:63]), reject(8, "bad_signature"))
    add_vector("V7b-signature-65-bytes", rkey(), with_sig(base, base_sig + b"\0"), reject(8, "bad_signature"))
    add_vector("V7c-signature-empty-but-present", rkey(), with_sig(base, b""), reject(8, "bad_signature"))
    add_vector("V17-s-plus-l", rkey(), with_sig(base, base_sig[:32] + (int.from_bytes(base_sig[32:], "little") + L).to_bytes(32, "little")), reject(8, "bad_signature"))
    flipped = bytes([base_sig[0] ^ 1]) + base_sig[1:]
    add_vector("V21a-signature-r-bit-flipped", rkey(), with_sig(base, flipped), reject(8, "bad_signature"))
    add_vector("V21b-signed-by-another-key", rkey(), with_sig(base, sign(SEED_2, signed(base_ann))), reject(8, "bad_signature"))
    add_vector("V25a-signed-without-the-domain", rkey(), with_sig(base, sign(SEED_1, base_ann)), reject(8, "bad_signature"))
    le = DOMAIN + b"\0" + len(base_ann).to_bytes(4, "little") + base_ann
    add_vector("V25b-length-little-endian", rkey(), with_sig(base, sign(SEED_1, le)), reject(8, "bad_signature"))
    # Valid only under the cofactored equation RFC 8032 5.1.7 also permits;
    # rule 7 forbids it. Each is refused by the cofactorless byte comparison.
    t8 = decompress(BLACKLIST[4])
    r_t = compress(add(mul(12345, B), t8))
    sig_t = r_t + ((12345 + (h_int(r_t, PUB_1[6:], msg) % L) * a_scalar) % L).to_bytes(32, "little")
    assert not verify(PUB_1[6:], msg, sig_t) and cofactored_verify(PUB_1[6:], msg, sig_t)
    add_vector("V21d-r-plus-torsion-cofactored-only", rkey(), with_sig(base, sig_t), reject(8, "bad_signature"))
    r_nc = (1 + P).to_bytes(32, "little")
    sig_nc = r_nc + ((h_int(r_nc, PUB_1[6:], msg) % L) * a_scalar % L).to_bytes(32, "little")
    assert not verify(PUB_1[6:], msg, sig_nc) and cofactored_verify(PUB_1[6:], msg, sig_nc)
    add_vector("V21e-non-canonical-r-identity", rkey(), with_sig(base, sig_nc), reject(8, "bad_signature"))
    for r in range(1, 1000):
        r_m = compress(mul(r, B))
        k_m = h_int(r_m, mixed, msg) % L
        if k_m % 8:
            sig_m = r_m + ((r + k_m * a_scalar) % L).to_bytes(32, "little")
            break
    assert not verify(mixed, msg, sig_m) and cofactored_verify(mixed, msg, sig_m)
    add_vector("V21f-mixed-order-key-k-not-0-mod-8", rkey(publisher=mixed_pub), record(base_ann, mixed_pub, sig_m), reject(8, "bad_signature"))
    add_vector("V25c-domain-without-zero-byte", rkey(), with_sig(base, sign(SEED_1, DOMAIN + len(base_ann).to_bytes(4, "big") + base_ann)), reject(8, "bad_signature"))

    # ---- two failures in one record: the earlier step is the verdict (§2.8)
    add_vector("V28a-stale-and-bad-signature", rkey(), with_sig(base, flipped), reject(7, "stale"), now=TS + MAX_AGE + 1)
    add_vector("V28b-bad-field-and-bad-signature", rkey(), record(announcement(domain=""), PUB_1, base_sig), reject(6, "bad_announcement"))
    add_vector("V28c-other-publisher-and-bad-field", rkey(publisher=PUB_2), record(announcement(domain=""), PUB_1, base_sig), reject(5, "bad_publisher"))
    add_vector("V28d-bad-outer-and-other-publisher", rkey(publisher=PUB_2), base + ld(3, base_sig), reject(4, "malformed_record"))

    # ---- replacement under one key (§2.7 rule 2)
    def replace_vector(name, stored, incoming, expect):
        for value in (stored, incoming):
            assert validate(rkey(), value, NOW)[0] == "accept", name
        assert replaces(incoming, stored) == expect, name
        vectors.append({"name": name, "kind": "replace", "key": rkey(), "now_ms": NOW,
                        "stored": stored.hex(), "incoming": incoming.hex(), "replaces": expect})

    def sig_of(value):
        return parse_fields(value, REC_SCHEMA)[3]

    renamed = sign_record(SEED_1, announcement(name="summarizer-2"))
    small, large = sorted([base, renamed], key=sig_of)
    replace_vector("V19a-equal-timestamps-smaller-signature-replaces", large, small, True)
    replace_vector("V19b-equal-timestamps-larger-signature-does-not", small, large, False)
    # Older with the smaller signature: the timestamp still decides.
    older = next(v for v in (sign_record(SEED_1, announcement(ts=TS - 1000, name="old-%d" % i)) for i in range(64)) if sig_of(v) < sig_of(base))
    replace_vector("V19c-older-timestamp-does-not-replace", base, older, False)
    newer = next(v for v in (sign_record(SEED_1, announcement(ts=TS + 1000, name="new-%d" % i)) for i in range(64)) if sig_of(v) > sig_of(base))
    replace_vector("V19d-newer-timestamp-replaces", base, newer, True)

    json.dump({
        "schema": "crates/rotifer-core/proto/p2p-dht-v1.proto",
        "generator": "scripts/p2p-dht-v1-reference.py",
        "verdicts": "accept | reject (dropped, not charged) | reject-charged (one forgery against the PUT's sender)",
        "vectors": vectors,
        "provider_keys": [
            {"gene_id": g, "key": provider_key(g).hex()}
            for g in (GENE, OTHER_GENE, "v2:" + "0" * 64, "v2:" + "f" * 64)
        ],
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
