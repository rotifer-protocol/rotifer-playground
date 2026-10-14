# Gene ID v2

A **gene ID** names a gene by its content. Two genes with the same contract and the same code have the same ID, no matter who built them, when, or under which version label. Change one byte of logic or one field of the contract, and the ID changes.

```
v2:3f1c…(64 lowercase hex digits)
```

This document is the normative definition. An independent reference implementation lives in [`scripts/gene-id-v2-reference.py`](../scripts/gene-id-v2-reference.py), and the shared test vectors are in [`crates/rotifer-core/tests/fixtures/gene-id-v2/`](../crates/rotifer-core/tests/fixtures/gene-id-v2/). Every implementation must reproduce every vector byte for byte.

## 1. What goes in, and what stays out

| In the ID | Not in the ID |
|---|---|
| `domain`, `inputSchema`, `outputSchema`, `fidelity`, `semanticRequirements`, `dependencies`, `network` | `author`, `createdAt`, `version` (SemVer), `description`, `tags`, `regulatoryTags` |
| The IR spec version and constraints of a compiled module | Custom sections of the module, including the `rotifer.*` sections themselves |
| Every standard section of the WASM module (Native, Hybrid) | Local directory name |
| The declared source files (Wrapped) | File timestamps, permissions, the directory the gene lives in |

The rule of thumb: what the gene **is** goes in; who published it and when stays out.

## 2. The ID

```
id       = "v2:" || lowercase_hex(SHA-256(preimage))
preimage = ASCII("rotifer-gene-id-v2")
        || kind                 (1 byte: 0x01 Native, 0x02 Wrapped, 0x03 Hybrid)
        || u32be(len(P)) || P   (P = the canonical projection, §3)
        || u32be(32)     || B   (B = the 32-byte body digest, §4)
```

`u32be` / `u64be` are unsigned big-endian integers. `kind` follows `fidelity`; a gene whose `fidelity` is anything other than `Native`, `Wrapped` or `Hybrid` has no v2 ID.

## 3. The projection

The projection is a JSON object with **exactly** these keys, always present:

| Key | Value |
|---|---|
| `constraints` | Native, Hybrid: the module's `rotifer.constraints` section, decoded from MessagePack to JSON. Wrapped: `null` |
| `dependencies` | Array of the dependencies' v2 IDs, de-duplicated, sorted by byte value. `[]` when there are none |
| `domain` | `phenotype.domain` |
| `fidelity` | `"Native"`, `"Wrapped"` or `"Hybrid"` |
| `inputSchema` | `phenotype.inputSchema`, or `null` |
| `irSpec` | Native, Hybrid: `spec_version` from the module's `rotifer.version` section. Wrapped: `null` |
| `network` | `phenotype.network`, or `null` |
| `outputSchema` | `phenotype.outputSchema`, or `null` |
| `semanticRequirements` | `phenotype.semanticRequirements`, or `null` |

`P` is that object serialized with the JSON Canonicalization Scheme, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (UTF-8, keys sorted by UTF-16 code units, no insignificant whitespace, numbers in ECMAScript form). Values are copied as they appear in `phenotype.json`; nothing inside them is dropped or renamed.

**Dependencies.** The projection holds IDs, not names. A tool may resolve a dependency written as a local gene name to that gene's v2 ID. A dependency that cannot be resolved to a v2 ID (for example a wildcard such as `"*"`) makes the gene's ID **not computable**.

## 4. The body digest

### Native and Hybrid

Read the compiled module (`gene.ir.wasm`). Walk its sections in file order. For every section whose id is not `0` (custom), feed `section_id (1 byte) || u32be(len(payload)) || payload` into one SHA-256. `B` is that digest.

Every standard section counts: types, imports, functions, tables, memory, globals, exports, start, elements, data count, code, data. Hashing only the code section would let a module change its embedded data or its imports without changing its ID.

### Wrapped

`B` hashes the gene's source files:

```
B     = SHA-256( u32be(n) || entry_1 || … || entry_n )
entry = u32be(len(path)) || path || u64be(len(content)) || SHA-256(content)
```

`path` is the file's path relative to the gene directory, UTF-8, `/`-separated. Entries are sorted by `path` bytes. Content is hashed as-is: no newline or encoding normalization.

Which files count:

1. If `phenotype.sources` is present, exactly those paths. Each must be a regular file inside the gene directory: no absolute paths, no `..`, no symlinks.
2. Otherwise, by convention, the single entry file among `SKILL.md`, `system-prompt.md` and `index.ts`. This only applies when exactly one of them exists **and** the directory holds nothing else apart from `phenotype.json` and hidden files (names starting with `.`).

Anything else (no entry file, several candidates, extra files or subdirectories without a `sources` list) makes the ID **not computable**. A tool must say so rather than guess.

A Wrapped gene's ID covers its wrapper, not the remote service it calls. If that service changes its behavior, the ID does not change. That is exactly what `fidelity: "Wrapped"` declares.

## 5. Not computable

A gene has no v2 ID when:

- `fidelity` is missing or unknown;
- a Native or Hybrid gene has no compiled `gene.ir.wasm`, or the module lacks its `rotifer.version` / `rotifer.constraints` sections;
- a dependency cannot be resolved to a v2 ID;
- a Wrapped gene's source files cannot be determined (§4).

Such a gene cannot be announced on the P2P network.

## 6. Relationship to other identifiers

| Identifier | Status |
|---|---|
| `irHash` (inside compiled modules) | Kept as an integrity value of the IR format. It includes author and creation time and only the code section, so it is **not** a gene ID. |
| Cloud UUIDs | Registry row numbers. Not content-derived. |
| The unprefixed "Gene ID" older `rotifer wrap` versions printed | A hash of `phenotype.json` alone. Superseded by v2. |

The `v2:` prefix names the whole derivation above. A future change to it gets a new prefix; a `v2:` ID never changes meaning.
