#!/usr/bin/env python3
"""Independent encoder for the frozen P2P node heartbeat v1
(crates/rotifer-core/proto/p2p-heartbeat-v1.proto). Standard library only;
shares no code with the Rust (prost) implementation.

Writes the golden vectors the Rust tests decode and re-encode byte for byte:
  python3 scripts/p2p-heartbeat-v1-reference.py > crates/rotifer-core/tests/fixtures/p2p-heartbeat-v1/vectors.json
"""

import json
import sys

FIELDS = [  # (name, tag, kind) in declaration order
    ("genes_hosted", 1, "uint"),
    ("uptime_seconds", 2, "uint"),
    ("rotifer_version", 3, "string"),
    ("bindings", 4, "repeated_string"),
    ("cloud_attestation", 5, "bytes"),
    ("timestamp_ms", 6, "uint"),
]


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def key(tag, wire_type):
    return varint((tag << 3) | wire_type)


def length_delimited(tag, b):
    return key(tag, 2) + varint(len(b)) + b


def encode_heartbeat(h):
    out = bytearray()
    for name, tag, kind in FIELDS:
        v = h[name]
        if kind == "uint":
            if v != 0:  # proto3: default values are not encoded
                out += key(tag, 0) + varint(v)
        elif kind == "string":
            if v != "":
                out += length_delimited(tag, v.encode("utf-8"))
        elif kind == "repeated_string":
            for s in v:  # every element is encoded, empty ones included
                out += length_delimited(tag, s.encode("utf-8"))
        else:  # bytes, given as text in the vectors
            if v != "":
                out += length_delimited(tag, v.encode("ascii"))
    return bytes(out)


def main():
    token = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJodHRwczovL3JvdGlmZXIuZGV2In0.c2ln"
    vectors = [
        ("anonymous", dict(genes_hosted=0, uptime_seconds=0, rotifer_version="0.34.0", bindings=[],
                           cloud_attestation="", timestamp_ms=1760000000000)),
        ("attested", dict(genes_hosted=12, uptime_seconds=86400, rotifer_version="0.34.0",
                          bindings=["local", "cloud"], cloud_attestation=token, timestamp_ms=1760000000123)),
        ("pre-release-version", dict(genes_hosted=1, uptime_seconds=300, rotifer_version="1.0.0-rc.1+build.7",
                                     bindings=["local"], cloud_attestation="", timestamp_ms=1)),
        ("max-values", dict(genes_hosted=4294967295, uptime_seconds=18446744073709551615,
                            rotifer_version="1." + "0" * 60 + ".0", bindings=["b" * 64] * 16,
                            cloud_attestation="", timestamp_ms=18446744073709551615)),
    ]
    doc = {
        "schema": "crates/rotifer-core/proto/p2p-heartbeat-v1.proto",
        "generator": "scripts/p2p-heartbeat-v1-reference.py",
        "vectors": [{"name": n, "heartbeat": h, "hex": encode_heartbeat(h).hex()} for n, h in vectors],
    }
    json.dump(doc, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
