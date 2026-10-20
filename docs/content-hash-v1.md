# Content hash v1 (legacy)

`content_hash` is the hash the CLI computes over a Gene's phenotype when it publishes. This page defines it exactly as `src/utils/content-hash.ts` implements it today. The definition is frozen: it is kept for compatibility with the values already stored, not improved.

It is **not** an identity and **not** an integrity guarantee. A Gene's identity is its [Gene ID v2](gene-id-v2.md). The Registry does not recompute `content_hash` (it used to, and the result never matched; ADR-341). It only uses the value the client sends to stop two published Genes from carrying the same hash. A client can send any value, so until v1.0 this check stops accidental duplicates, not deliberate ones.

## Definition

```
content_hash = lowercase_hex( SHA-256( UTF-8( canonical(phenotype) ) ) )
canonical(p) = JSON.stringify( sortKeysDeep(p) )
```

`phenotype` is the object sent as the Gene's `phenotype`, exactly as uploaded. The stored value is the 64 hex digits, with no prefix.

`sortKeysDeep(v)`, with ECMAScript semantics:

- `null`, a string, a number or a boolean: returned unchanged.
- An array: a new array of `sortKeysDeep` applied to each element, in the original order. Arrays are never reordered.
- An object: a new plain object. Its keys are `Object.keys(v)` sorted with the default `Array.prototype.sort` (UTF-16 code unit order), and each one is assigned, in that order, to `sortKeysDeep(v[key])`.

`JSON.stringify` then writes the result with no whitespace:

- Strings are escaped as `JSON.stringify` escapes them: `"` and `\` with a backslash; U+0008, U+0009, U+000A, U+000C and U+000D as `\b \t \n \f \r`; other characters below U+0020, and lone surrogates, as `\u` and four lowercase hex digits. Every other character, including non-ASCII, is written as itself, then encoded as UTF-8.
- Numbers are written as `Number.prototype.toString` writes them (`1e+21`, and `-0` as `0`).

## Two quirks, kept on purpose

Both come from how JavaScript objects behave, not from the sort. A reimplementation in another language must reproduce them, or it will compute different hashes for some stored phenotypes.

1. **Integer-like keys come first, in numeric order.** An ordinary object always enumerates array-index keys (canonical decimal integers from `0` to 2³²−2) before every other key, in ascending numeric order. So `{"10": …, "2": …, "a": …}` serializes as `{"2":…,"10":…,"a":…}`, where plain lexicographic order would give `"10"` first. Keys such as `"01"` or `"-1"` are not array indices and sort as ordinary strings.
2. **A key named `__proto__` is dropped.** Assigning `__proto__` on a plain object sets its prototype instead of creating a property, so the key and its value vanish from the output. Adding a `__proto__` key to a phenotype therefore does not change its hash.

## Rules for the phenotype

- A phenotype must not contain its own hash, under any field name: `content_hash`, `contentHash` or anything else. The hash is computed at publish time and sent alongside the phenotype, never inside it. (`scripts/verify-content-hashes.ts` used to write it back into `phenotype.json` as `contentHash`; it no longer does.)
- New code must not treat `content_hash` as an identity or as proof that content is unchanged. Use Gene ID v2.

## Test vectors

`tests/unit/content-hash-vectors.test.ts` pins these values. Any implementation must reproduce every row.

| Input phenotype | `canonical(phenotype)` | `content_hash` |
|---|---|---|
| `{"domain":"search","inputSchema":{"type":"object","properties":{"q":{"type":"string"}}},"version":"0.1.0"}` | `{"domain":"search","inputSchema":{"properties":{"q":{"type":"string"}},"type":"object"},"version":"0.1.0"}` | `cff03e8e7acc8a315aad4e7b75999f4f6221c70b47229746c841de7de0b15dac` |
| `{"b":1,"10":"ten","2":"two","a":0}` | `{"2":"two","10":"ten","a":0,"b":1}` | `d19d5a233fdcba9edb48df766223621769218377fd724b18fc3458d504c9e875` |
| `{"domain":"x","__proto__":{"polluted":true},"version":"1"}` (parsed with `JSON.parse`, so `__proto__` is an own key) | `{"domain":"x","version":"1"}` | `a605c4fcc40ed8f2321113c841aa06f39c703255022124d54e83ca95b7f7f642` |
| `{"tags":["z","a",{"y":1,"x":2}],"domain":"d"}` | `{"domain":"d","tags":["z","a",{"x":2,"y":1}]}` | `f419a457a37ff4eed1845face256077b7d527397ac53686f36e7cf29471cffad` |
| `{"description":"语法检查 — café ✓","domain":"content.grammar"}` | `{"description":"语法检查 — café ✓","domain":"content.grammar"}` | `e00c5575f6b4786bdf872e66dcbdeff97dbabab52515c44588792f909f658350` |

Each hash is SHA-256 over the UTF-8 bytes of the canonical string in the same row. This was checked independently in Python, not only in Node.
