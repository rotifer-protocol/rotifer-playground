#!/usr/bin/env python3
"""Independent reference implementation of Gene ID v2 (docs/gene-id-v2.md).

Standard library only, and deliberately shares no code with the Rust
implementation: the point is a second reading of the spec. The Rust tests
must reproduce every vector this script produces.

Usage:
  python3 scripts/gene-id-v2-reference.py check <vectors.json>
  python3 scripts/gene-id-v2-reference.py write <vectors.json>   # fill "expected"
  python3 scripts/gene-id-v2-reference.py dir <gene-dir>         # Wrapped genes only
"""

import hashlib
import json
import os
import struct
import sys
from decimal import Decimal

TAG = b"rotifer-gene-id-v2"
KINDS = {"Native": 1, "Wrapped": 2, "Hybrid": 3}
PROJECTION_KEYS = (
    "constraints", "dependencies", "domain", "fidelity", "inputSchema",
    "irSpec", "network", "outputSchema", "semanticRequirements",
)
ENTRY_FILES = ("SKILL.md", "system-prompt.md", "index.ts")


class NotComputable(Exception):
    pass


# --- RFC 8785 (JCS) -------------------------------------------------------

def _jcs_number(x):
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        if abs(x) >= 2 ** 53:
            raise NotComputable(f"integer {x} is not exactly representable as an IEEE 754 double")
        x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise NotComputable("NaN / Infinity are not valid JSON numbers")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _jcs_number(-x)
    # Shortest round-trip digits (Python repr == ECMAScript's choice of digits).
    sign, digits, exp = Decimal(repr(x)).as_tuple()
    s = "".join(map(str, digits)).rstrip("0") or "0"
    lead = len(digits) - len("".join(map(str, digits)).lstrip("0"))
    s = s[lead:] if lead else s
    n = len(digits) - lead + exp  # position of the decimal point relative to s
    k = len(s)
    # ECMAScript Number::toString (ECMA-262 §6.1.6.1.20).
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s
    e = n - 1
    mant = s if k == 1 else s[0] + "." + s[1:]
    return f"{mant}e{'+' if e >= 0 else '-'}{abs(e)}"


def _jcs_string(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif c < 0x20:
            out.append(f"\\u{c:04x}")
        elif 0xD800 <= c <= 0xDFFF:
            raise NotComputable("lone surrogate in string")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jcs(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _jcs_number(v)
    if isinstance(v, str):
        return _jcs_string(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(_jcs_string(k) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError(f"not JSON: {type(v)}")


# --- body digests -----------------------------------------------------------

def _leb128(buf, i):
    result = shift = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def native_body_digest(wasm):
    if wasm[:4] != b"\0asm":
        raise NotComputable("not a WASM module")
    h = hashlib.sha256()
    i = 8
    while i < len(wasm):
        sid = wasm[i]
        size, i = _leb128(wasm, i + 1)
        payload = wasm[i:i + size]
        if len(payload) != size:
            raise NotComputable("truncated WASM section")
        if sid != 0:
            h.update(bytes([sid]) + struct.pack(">I", size) + payload)
        i += size
    return h.digest()


def wrapped_body_digest(files):
    """files: dict of relative POSIX path -> bytes."""
    entries = sorted(files.items(), key=lambda kv: kv[0].encode("utf-8"))
    h = hashlib.sha256(struct.pack(">I", len(entries)))
    for path, content in entries:
        p = path.encode("utf-8")
        h.update(struct.pack(">I", len(p)) + p + struct.pack(">Q", len(content)) + hashlib.sha256(content).digest())
    return h.digest()


# --- the ID -------------------------------------------------------------------

def projection(phenotype, ir_spec=None, constraints=None, dependency_ids=()):
    fidelity = phenotype.get("fidelity")
    if fidelity not in KINDS:
        raise NotComputable(f"fidelity {fidelity!r} is not Native / Wrapped / Hybrid")
    compiled = fidelity in ("Native", "Hybrid")
    if compiled and (ir_spec is None or constraints is None):
        raise NotComputable("compiled gene needs irSpec and constraints from its module")
    return {
        "constraints": constraints if compiled else None,
        "dependencies": sorted(set(dependency_ids), key=lambda d: d.encode("utf-8")),
        "domain": phenotype.get("domain"),
        "fidelity": fidelity,
        "inputSchema": phenotype.get("inputSchema"),
        "irSpec": ir_spec if compiled else None,
        "network": phenotype.get("network"),
        "outputSchema": phenotype.get("outputSchema"),
        "semanticRequirements": phenotype.get("semanticRequirements"),
    }


def gene_id(fidelity, proj, body):
    assert tuple(sorted(proj)) == PROJECTION_KEYS
    p = jcs(proj).encode("utf-8")
    pre = TAG + bytes([KINDS[fidelity]]) + struct.pack(">I", len(p)) + p + struct.pack(">I", len(body)) + body
    return "v2:" + hashlib.sha256(pre).hexdigest()


def wrapped_sources(gene_dir, phenotype):
    declared = phenotype.get("sources")
    if declared is not None:
        files = {}
        for rel in declared:
            if rel.startswith("/") or ".." in rel.split("/") or "\\" in rel:
                raise NotComputable(f"invalid source path {rel!r}")
            full = os.path.join(gene_dir, *rel.split("/"))
            if os.path.islink(full) or not os.path.isfile(full):
                raise NotComputable(f"source {rel!r} is not a regular file")
            files[rel] = open(full, "rb").read()
        return files
    names = [n for n in os.listdir(gene_dir) if not n.startswith(".") and n != "phenotype.json"]
    entries = [n for n in names if n in ENTRY_FILES]
    if len(entries) != 1 or len(names) != 1:
        raise NotComputable(f"cannot determine source files (found {sorted(names)}); declare phenotype.sources")
    full = os.path.join(gene_dir, entries[0])
    if os.path.islink(full) or not os.path.isfile(full):
        raise NotComputable(f"{entries[0]} is not a regular file")
    return {entries[0]: open(full, "rb").read()}


def wrapped_dir_id(gene_dir):
    phenotype = json.load(open(os.path.join(gene_dir, "phenotype.json"), encoding="utf-8"))
    if phenotype.get("fidelity") != "Wrapped":
        raise NotComputable("dir mode handles Wrapped genes only (compiled genes need a MessagePack decoder)")
    if phenotype.get("dependencies"):
        raise NotComputable("dir mode does not resolve dependencies")
    return gene_id("Wrapped", projection(phenotype), wrapped_body_digest(wrapped_sources(gene_dir, phenotype)))


# --- vectors --------------------------------------------------------------

def compute_vector(v):
    kind = v["kind"]
    if kind == "jcs":
        return jcs(v["value"])
    phenotype = v["phenotype"]
    if phenotype.get("fidelity") == "Wrapped":
        body = wrapped_body_digest({p: bytes.fromhex(h) for p, h in v["files"].items()})
    else:
        body = native_body_digest(bytes.fromhex(v["wasm_hex"]))
    proj = projection(phenotype, v.get("irSpec"), v.get("constraints"), v.get("dependencyIds", ()))
    return {"bodyDigest": body.hex(), "projection": jcs(proj), "id": gene_id(phenotype["fidelity"], proj, body)}


def main(argv):
    if len(argv) != 3 or argv[1] not in ("check", "write", "dir"):
        print(__doc__)
        return 2
    if argv[1] == "dir":
        try:
            print(wrapped_dir_id(argv[2]))
        except NotComputable as e:
            print(f"not computable: {e}")
            return 1
        return 0
    path = argv[2]
    doc = json.load(open(path, encoding="utf-8"))
    bad = 0
    for v in doc["vectors"]:
        got = compute_vector(v)
        if argv[1] == "write":
            v["expected"] = got
        elif got != v.get("expected"):
            bad += 1
            print(f"MISMATCH {v['name']}: expected {v.get('expected')!r}, got {got!r}")
    if argv[1] == "write":
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"WRITTEN {len(doc['vectors'])} vectors")
    else:
        print(f"{len(doc['vectors']) - bad}/{len(doc['vectors'])} vectors match")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
