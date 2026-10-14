#!/usr/bin/env python3
"""Independent encoder for the frozen P2P wire format v1
(crates/rotifer-core/proto/p2p-wire-v1.proto). Standard library only; shares
no code with the Rust (prost) implementation.

Writes the golden vectors the Rust tests decode and re-encode byte for byte:
  python3 scripts/p2p-wire-v1-reference.py > crates/rotifer-core/tests/fixtures/p2p-wire-v1/vectors.json
"""

import json
import sys

FIELDS = [  # (name, tag, kind) in declaration order
    ("gene_id", 1, "string"),
    ("name", 2, "string"),
    ("domain", 3, "string"),
    ("fidelity", 4, "string"),
    ("ir_spec", 5, "string"),
    ("version", 6, "string"),
    ("timestamp_ms", 7, "uint64"),
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


def encode_announcement(a):
    out = bytearray()
    for name, tag, kind in FIELDS:
        v = a[name]
        if kind == "string":
            if v == "":
                continue  # proto3: default values are not encoded
            b = v.encode("utf-8")
            out += key(tag, 2) + varint(len(b)) + b
        else:
            if v == 0:
                continue
            out += key(tag, 0) + varint(v)
    inner = bytes(out)
    return key(1, 2) + varint(len(inner)) + inner  # GossipMessage.announcement


def main():
    vid = "v2:" + "3f" * 32
    vectors = [
        ("native", dict(gene_id=vid, name="math.sort", domain="math", fidelity="Native",
                        ir_spec="0.2.0", version="1.0.0", timestamp_ms=1760000000000)),
        ("wrapped-without-ir-spec", dict(gene_id=vid, name="writer", domain="content.writing", fidelity="Wrapped",
                                         ir_spec="", version="0.3.1", timestamp_ms=1760000000123)),
        ("unicode-display-name", dict(gene_id=vid, name="写作助手 ✍️", domain="content", fidelity="Hybrid",
                                      ir_spec="0.2.0", version="2.0.0-rc.1", timestamp_ms=1)),
        ("empty-optional-display-fields", dict(gene_id=vid, name="", domain="d", fidelity="Wrapped",
                                               ir_spec="", version="", timestamp_ms=18446744073709551615)),
        ("max-length-fields", dict(gene_id=vid, name="n" * 128, domain="d" * 128, fidelity="Native",
                                   ir_spec="i" * 32, version="v" * 64, timestamp_ms=300000)),
    ]
    doc = {
        "schema": "crates/rotifer-core/proto/p2p-wire-v1.proto",
        "generator": "scripts/p2p-wire-v1-reference.py",
        "vectors": [{"name": n, "announcement": a, "hex": encode_announcement(a).hex()} for n, a in vectors],
    }
    json.dump(doc, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
