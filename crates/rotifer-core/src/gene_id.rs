//! Gene ID v2 — content-derived gene identity.
//!
//! Normative definition: `docs/gene-id-v2.md`. An independent reference
//! implementation (`scripts/gene-id-v2-reference.py`) produces the shared test
//! vectors in `tests/fixtures/gene-id-v2/vectors.json`; this module must
//! reproduce every one of them byte for byte.
//!
//! ```text
//! id       = "v2:" || hex(SHA-256(preimage))
//! preimage = "rotifer-gene-id-v2" || kind || u32be(len P) || P || u32be(32) || B
//! ```
//! `P` is the RFC 8785 canonical JSON of the contract projection, `B` the
//! body digest (all standard WASM sections, or the declared source files).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::compiler::ir_sections::{SECTION_CONSTRAINTS, SECTION_VERSION, VersionSection};

/// Prefix of every v2 gene ID.
pub const PREFIX: &str = "v2:";

/// Domain-separation tag at the start of the preimage.
const TAG: &[u8] = b"rotifer-gene-id-v2";

/// Conventional Wrapped entry files, used when `phenotype.sources` is absent.
const ENTRY_FILES: [&str; 3] = ["SKILL.md", "system-prompt.md", "index.ts"];

/// File name of a compiled gene module inside its directory.
pub const IR_MODULE_FILE: &str = "gene.ir.wasm";

/// Largest integer an IEEE 754 double represents exactly. JCS serializes
/// numbers as doubles, so larger integers would silently round.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Why a gene has no v2 ID (docs/gene-id-v2.md §5).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("gene ID not computable: {0}")]
pub struct NotComputable(pub String);

fn nc<T>(reason: impl Into<String>) -> Result<T, NotComputable> {
    Err(NotComputable(reason.into()))
}

/// Gene fidelity as it enters the ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Native,
    Wrapped,
    Hybrid,
}

impl Kind {
    pub fn from_fidelity(fidelity: &str) -> Result<Self, NotComputable> {
        match fidelity {
            "Native" => Ok(Self::Native),
            "Wrapped" => Ok(Self::Wrapped),
            "Hybrid" => Ok(Self::Hybrid),
            other => nc(format!("fidelity {other:?} is not Native / Wrapped / Hybrid")),
        }
    }

    fn byte(self) -> u8 {
        match self {
            Self::Native => 1,
            Self::Wrapped => 2,
            Self::Hybrid => 3,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Native => "Native",
            Self::Wrapped => "Wrapped",
            Self::Hybrid => "Hybrid",
        }
    }

    /// Native and Hybrid genes carry a compiled module.
    pub fn is_compiled(self) -> bool {
        !matches!(self, Self::Wrapped)
    }
}

/// Whether `id` is a syntactically valid v2 gene ID (`v2:` + 64 lowercase hex).
pub fn is_valid(id: &str) -> bool {
    id.strip_prefix(PREFIX).is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// What a compiled module contributes to the projection.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledInputs {
    pub ir_spec: String,
    pub constraints: Value,
}

/// Build the projection (docs/gene-id-v2.md §3) from a parsed `phenotype.json`.
pub fn projection(
    phenotype: &Value,
    compiled: Option<&CompiledInputs>,
    dependency_ids: &[String],
) -> Result<(Kind, Value), NotComputable> {
    let fidelity = phenotype.get("fidelity").and_then(Value::as_str).unwrap_or("");
    let kind = Kind::from_fidelity(fidelity)?;
    let compiled = match (kind.is_compiled(), compiled) {
        (true, Some(c)) => Some(c),
        (true, None) => return nc("a compiled gene needs irSpec and constraints from its module"),
        (false, _) => None,
    };
    let mut deps: Vec<String> = dependency_ids.to_vec();
    if let Some(bad) = deps.iter().find(|d| !is_valid(d)) {
        return nc(format!("dependency {bad:?} is not a v2 gene ID"));
    }
    deps.sort();
    deps.dedup();
    let field = |k: &str| phenotype.get(k).cloned().unwrap_or(Value::Null);
    let mut p = Map::new();
    p.insert("constraints".into(), compiled.map_or(Value::Null, |c| c.constraints.clone()));
    p.insert("dependencies".into(), Value::from(deps));
    p.insert("domain".into(), field("domain"));
    p.insert("fidelity".into(), Value::from(kind.name()));
    p.insert("inputSchema".into(), field("inputSchema"));
    p.insert("irSpec".into(), compiled.map_or(Value::Null, |c| Value::from(c.ir_spec.clone())));
    p.insert("network".into(), field("network"));
    p.insert("outputSchema".into(), field("outputSchema"));
    p.insert("semanticRequirements".into(), field("semanticRequirements"));
    Ok((kind, Value::Object(p)))
}

/// RFC 8785 canonical bytes of `v`. Rejects integers a double cannot hold.
pub fn canonical_json(v: &Value) -> Result<Vec<u8>, NotComputable> {
    check_safe_integers(v)?;
    serde_jcs::to_vec(v).or_else(|e| nc(format!("canonical JSON: {e}")))
}

fn check_safe_integers(v: &Value) -> Result<(), NotComputable> {
    match v {
        Value::Number(n) => {
            let too_big = n.as_u64().is_some_and(|u| u > MAX_SAFE_INTEGER)
                || n.as_i64().is_some_and(|i| i.unsigned_abs() > MAX_SAFE_INTEGER);
            if too_big {
                return nc(format!("integer {n} is not exactly representable as a double"));
            }
            Ok(())
        }
        Value::Array(a) => a.iter().try_for_each(check_safe_integers),
        Value::Object(o) => o.values().try_for_each(check_safe_integers),
        _ => Ok(()),
    }
}

/// The ID from a projection and a body digest.
pub fn gene_id(kind: Kind, projection: &Value, body: &[u8; 32]) -> Result<String, NotComputable> {
    let p = canonical_json(projection)?;
    let len = u32::try_from(p.len()).or_else(|_| nc("projection too large"))?;
    let mut h = Sha256::new();
    h.update(TAG);
    h.update([kind.byte()]);
    h.update(len.to_be_bytes());
    h.update(&p);
    h.update(32u32.to_be_bytes());
    h.update(body);
    Ok(format!("{PREFIX}{}", hex::encode(h.finalize())))
}

/// Walk a WASM module's sections: `(id, payload)` in file order.
fn sections(wasm: &[u8]) -> Result<Vec<(u8, &[u8])>, NotComputable> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        return nc("not a WASM module");
    }
    let mut out = Vec::new();
    let mut i = 8;
    while i < wasm.len() {
        let id = wasm[i];
        let (size, next) = leb128_u32(wasm, i + 1)?;
        let end = next.checked_add(size as usize).filter(|&e| e <= wasm.len());
        let Some(end) = end else { return nc("truncated WASM section") };
        out.push((id, &wasm[next..end]));
        i = end;
    }
    Ok(out)
}

fn leb128_u32(buf: &[u8], mut i: usize) -> Result<(u32, usize), NotComputable> {
    let mut result: u64 = 0;
    for shift in (0..35).step_by(7) {
        let Some(&b) = buf.get(i) else { return nc("truncated LEB128") };
        i += 1;
        result |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return u32::try_from(result).map(|r| (r, i)).or_else(|_| nc("LEB128 overflow"));
        }
    }
    nc("LEB128 too long")
}

/// Body digest of a compiled module: every standard (non-custom) section.
pub fn native_body_digest(wasm: &[u8]) -> Result<[u8; 32], NotComputable> {
    let mut h = Sha256::new();
    for (id, payload) in sections(wasm)? {
        if id == 0 {
            continue;
        }
        h.update([id]);
        h.update((payload.len() as u32).to_be_bytes());
        h.update(payload);
    }
    Ok(h.finalize().into())
}

/// Payload of the custom section called `name`, if present.
fn custom_section<'a>(wasm: &'a [u8], name: &str) -> Result<Option<&'a [u8]>, NotComputable> {
    for (id, payload) in sections(wasm)? {
        if id != 0 {
            continue;
        }
        let (len, start) = leb128_u32(payload, 0)?;
        let end = start + len as usize;
        if end <= payload.len() && &payload[start..end] == name.as_bytes() {
            return Ok(Some(&payload[end..]));
        }
    }
    Ok(None)
}

/// IR spec version and constraints recorded in a compiled module.
pub fn compiled_inputs(ir_wasm: &[u8]) -> Result<CompiledInputs, NotComputable> {
    let Some(version) = custom_section(ir_wasm, SECTION_VERSION)? else {
        return nc(format!("module has no {SECTION_VERSION} section"));
    };
    let Some(constraints) = custom_section(ir_wasm, SECTION_CONSTRAINTS)? else {
        return nc(format!("module has no {SECTION_CONSTRAINTS} section"));
    };
    let version: VersionSection =
        rmp_serde::from_slice(version).or_else(|e| nc(format!("{SECTION_VERSION}: {e}")))?;
    let constraints: Value =
        rmp_serde::from_slice(constraints).or_else(|e| nc(format!("{SECTION_CONSTRAINTS}: {e}")))?;
    Ok(CompiledInputs { ir_spec: version.spec_version, constraints })
}

/// Body digest of a Wrapped gene's source files (`path` → content).
pub fn wrapped_body_digest(files: &[(String, Vec<u8>)]) -> [u8; 32] {
    let mut entries: Vec<&(String, Vec<u8>)> = files.iter().collect();
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut h = Sha256::new();
    h.update((entries.len() as u32).to_be_bytes());
    for (path, content) in entries {
        h.update((path.len() as u32).to_be_bytes());
        h.update(path.as_bytes());
        h.update((content.len() as u64).to_be_bytes());
        h.update(Sha256::digest(content));
    }
    h.finalize().into()
}

fn read_regular_file(path: &Path, label: &str) -> Result<Vec<u8>, NotComputable> {
    let meta = std::fs::symlink_metadata(path).or_else(|_| nc(format!("{label} does not exist")))?;
    if !meta.is_file() {
        return nc(format!("{label} is not a regular file"));
    }
    std::fs::read(path).or_else(|e| nc(format!("{label}: {e}")))
}

/// Source files of a Wrapped gene (docs/gene-id-v2.md §4).
pub fn wrapped_sources(gene_dir: &Path, phenotype: &Value) -> Result<Vec<(String, Vec<u8>)>, NotComputable> {
    if let Some(declared) = phenotype.get("sources") {
        let Some(list) = declared.as_array() else { return nc("phenotype.sources must be an array") };
        let mut files = Vec::new();
        for entry in list {
            let Some(rel) = entry.as_str() else { return nc("phenotype.sources entries must be strings") };
            let invalid = rel.is_empty()
                || rel.starts_with('/')
                || rel.contains('\\')
                || rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..");
            if invalid {
                return nc(format!("invalid source path {rel:?}"));
            }
            let full = rel.split('/').fold(gene_dir.to_path_buf(), |p, seg| p.join(seg));
            files.push((rel.to_string(), read_regular_file(&full, &format!("source {rel:?}"))?));
        }
        return Ok(files);
    }
    let mut names: Vec<String> = std::fs::read_dir(gene_dir)
        .or_else(|e| nc(format!("{}: {e}", gene_dir.display())))?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|n| !n.starts_with('.') && n != "phenotype.json")
        .collect();
    names.sort();
    match names.as_slice() {
        [only] if ENTRY_FILES.contains(&only.as_str()) => {
            Ok(vec![(only.clone(), read_regular_file(&gene_dir.join(only), only)?)])
        }
        _ => nc(format!("cannot determine source files (found {names:?}); declare phenotype.sources")),
    }
}

/// v2 ID of the gene in `gene_dir`. `resolve` maps a dependency written as a
/// local name to that gene's v2 ID; dependencies already in v2 form pass through.
pub fn gene_id_from_dir(
    gene_dir: &Path,
    resolve: &mut dyn FnMut(&str) -> Result<String, NotComputable>,
) -> Result<String, NotComputable> {
    let raw = read_regular_file(&gene_dir.join("phenotype.json"), "phenotype.json")?;
    let phenotype: Value =
        serde_json::from_slice(&raw).or_else(|e| nc(format!("phenotype.json: {e}")))?;
    let mut deps = Vec::new();
    if let Some(list) = phenotype.get("dependencies").and_then(Value::as_array) {
        for d in list {
            let Some(name) = d.as_str() else { return nc("dependencies must be strings") };
            deps.push(if is_valid(name) { name.to_string() } else { resolve(name)? });
        }
    }
    let fidelity = phenotype.get("fidelity").and_then(Value::as_str).unwrap_or("");
    let kind = Kind::from_fidelity(fidelity)?;
    let (compiled, body) = if kind.is_compiled() {
        let wasm = read_regular_file(&gene_dir.join(IR_MODULE_FILE), IR_MODULE_FILE)?;
        (Some(compiled_inputs(&wasm)?), native_body_digest(&wasm)?)
    } else {
        (None, wrapped_body_digest(&wrapped_sources(gene_dir, &phenotype)?))
    };
    let (kind, proj) = projection(&phenotype, compiled.as_ref(), &deps)?;
    gene_id(kind, &proj, &body)
}

/// v2 ID of the gene called `name` under `genes_root`, resolving local
/// dependencies to their sibling genes' IDs. Cycles are not computable.
pub fn gene_id_in_workspace(genes_root: &Path, name: &str) -> Result<String, NotComputable> {
    fn go(root: &Path, name: &str, stack: &mut HashSet<String>) -> Result<String, NotComputable> {
        let dir: PathBuf = root.join(name);
        let safe = !name.is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..";
        if !safe || !dir.is_dir() {
            return nc(format!("dependency {name:?} is not a local gene"));
        }
        if !stack.insert(name.to_string()) {
            return nc(format!("dependency cycle through {name:?}"));
        }
        let result = gene_id_from_dir(&dir, &mut |dep| go(root, dep, stack));
        stack.remove(name);
        result
    }
    go(genes_root, name, &mut HashSet::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Vec<Value> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gene-id-v2/vectors.json");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        doc["vectors"].as_array().unwrap().clone()
    }

    fn by_name(name: &str) -> Value {
        vectors().into_iter().find(|v| v["name"] == name).unwrap()
    }

    /// Every vector produced by the independent reference implementation.
    #[test]
    fn reproduces_reference_vectors() {
        for v in vectors() {
            let name = v["name"].as_str().unwrap();
            if v["kind"] == "jcs" {
                let got = String::from_utf8(canonical_json(&v["value"]).unwrap()).unwrap();
                assert_eq!(got, v["expected"].as_str().unwrap(), "{name}");
                continue;
            }
            let phenotype = &v["phenotype"];
            let body = if phenotype["fidelity"] == "Wrapped" {
                let files: Vec<(String, Vec<u8>)> = v["files"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(p, h)| (p.clone(), hex::decode(h.as_str().unwrap()).unwrap()))
                    .collect();
                wrapped_body_digest(&files)
            } else {
                native_body_digest(&hex::decode(v["wasm_hex"].as_str().unwrap()).unwrap()).unwrap()
            };
            let compiled = v.get("irSpec").map(|s| CompiledInputs {
                ir_spec: s.as_str().unwrap().into(),
                constraints: v["constraints"].clone(),
            });
            let deps: Vec<String> = v
                .get("dependencyIds")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|d| d.as_str().unwrap().to_string()).collect())
                .unwrap_or_default();
            let (kind, proj) = projection(phenotype, compiled.as_ref(), &deps).unwrap();
            let expected = &v["expected"];
            assert_eq!(hex::encode(body), expected["bodyDigest"].as_str().unwrap(), "{name}: body");
            assert_eq!(
                String::from_utf8(canonical_json(&proj).unwrap()).unwrap(),
                expected["projection"].as_str().unwrap(),
                "{name}: projection"
            );
            assert_eq!(gene_id(kind, &proj, &body).unwrap(), expected["id"].as_str().unwrap(), "{name}: id");
        }
    }

    #[test]
    fn metadata_does_not_change_the_id() {
        let a = by_name("wrapped-convention-entry");
        let b = by_name("wrapped-metadata-changed");
        assert_ne!(a["phenotype"]["author"], b["phenotype"]["author"]);
        assert_eq!(a["expected"]["id"], b["expected"]["id"]);
    }

    #[test]
    fn data_section_is_covered_and_custom_sections_are_not() {
        let base = by_name("native-module")["expected"]["id"].clone();
        assert_eq!(by_name("native-module-without-custom-section")["expected"]["id"], base);
        assert_ne!(by_name("native-module-different-data")["expected"]["id"], base);
    }

    #[test]
    fn id_syntax() {
        assert!(is_valid(&format!("v2:{}", "0a".repeat(32))));
        assert!(!is_valid(&format!("v2:{}", "0A".repeat(32))), "uppercase hex");
        assert!(!is_valid(&format!("v1:{}", "0a".repeat(32))));
        assert!(!is_valid("v2:abc"));
        assert!(!is_valid("my-gene"), "a directory name is not an ID");
    }

    #[test]
    fn unsafe_integers_are_not_computable() {
        let v = serde_json::json!({ "n": 9_007_199_254_740_993u64 });
        assert!(canonical_json(&v).is_err());
        assert!(canonical_json(&serde_json::json!({ "n": 9_007_199_254_740_991u64 })).is_ok());
    }

    #[test]
    fn unknown_fidelity_and_unresolved_dependency_are_not_computable() {
        let p = serde_json::json!({ "fidelity": "Unknown", "domain": "x" });
        assert!(projection(&p, None, &[]).is_err());
        let p = serde_json::json!({ "fidelity": "Wrapped", "domain": "x" });
        assert!(projection(&p, None, &["*".into()]).is_err());
    }

    fn gene_dir(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, content) in files {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        dir
    }

    const WRAPPED: &str = r#"{"fidelity":"Wrapped","domain":"x"}"#;

    #[test]
    fn wrapped_convention_takes_the_single_entry_file() {
        let d = gene_dir(&[("phenotype.json", WRAPPED), ("SKILL.md", "hi"), (".gene-manifest.json", "{}")]);
        let id = gene_id_from_dir(d.path(), &mut |_| unreachable!()).unwrap();
        assert!(is_valid(&id));
    }

    #[test]
    fn wrapped_with_ambiguous_sources_is_not_computable() {
        for extra in [("index.ts", "x"), ("package.json", "{}"), ("scripts/run.sh", "x")] {
            let d = gene_dir(&[("phenotype.json", WRAPPED), ("SKILL.md", "hi"), extra]);
            let err = gene_id_from_dir(d.path(), &mut |_| unreachable!()).unwrap_err();
            assert!(err.0.contains("declare phenotype.sources"), "{extra:?}: {err}");
        }
        let empty = gene_dir(&[("phenotype.json", WRAPPED)]);
        assert!(gene_id_from_dir(empty.path(), &mut |_| unreachable!()).is_err());
    }

    #[test]
    fn declared_sources_reject_escaping_paths() {
        for bad in ["../x", "/etc/passwd", "a//b", "./a", "a\\b"] {
            let pheno = format!(r#"{{"fidelity":"Wrapped","domain":"x","sources":["{}"]}}"#, bad.replace('\\', "\\\\"));
            let d = gene_dir(&[("phenotype.json", &pheno)]);
            assert!(gene_id_from_dir(d.path(), &mut |_| unreachable!()).is_err(), "{bad}");
        }
    }

    #[test]
    fn workspace_resolves_local_dependencies_and_rejects_cycles() {
        let root = tempfile::tempdir().unwrap();
        let write = |name: &str, pheno: &str| {
            let dir = root.path().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("phenotype.json"), pheno).unwrap();
            std::fs::write(dir.join("SKILL.md"), name).unwrap();
        };
        write("leaf", WRAPPED);
        write("top", r#"{"fidelity":"Wrapped","domain":"x","dependencies":["leaf"]}"#);
        let leaf = gene_id_in_workspace(root.path(), "leaf").unwrap();
        let top = gene_id_in_workspace(root.path(), "top").unwrap();
        assert_ne!(leaf, top);
        // Writing the dependency as its ID gives the same result as the name.
        write("top2", &format!(r#"{{"fidelity":"Wrapped","domain":"x","dependencies":["{leaf}"]}}"#));
        std::fs::write(root.path().join("top2/SKILL.md"), "top").unwrap();
        assert_eq!(gene_id_in_workspace(root.path(), "top2").unwrap(), top);

        write("a", r#"{"fidelity":"Wrapped","domain":"x","dependencies":["b"]}"#);
        write("b", r#"{"fidelity":"Wrapped","domain":"x","dependencies":["a"]}"#);
        assert!(gene_id_in_workspace(root.path(), "a").unwrap_err().0.contains("cycle"));
        assert!(gene_id_in_workspace(root.path(), "../etc").is_err());
    }

    #[test]
    fn compiled_inputs_come_from_the_ir_sections() {
        use crate::compiler::ir_sections::CustomSectionPayloads;
        use crate::types::gene::Phenotype;
        // The injector requires `memory` + `_start` exports, so build a module
        // of the same shape as the vector's but with those two exports.
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        wasm.extend([1, 5, 1, 0x60, 0, 1, 0x7f]); // type: () -> i32
        wasm.extend([3, 2, 1, 0]); // function 0
        wasm.extend([5, 3, 1, 0, 1]); // memory, min 1 page
        wasm.extend([7, 19, 2, 6]);
        wasm.extend(b"memory");
        wasm.extend([2, 0, 6]);
        wasm.extend(b"_start");
        wasm.extend([0, 0]);
        wasm.extend([10, 6, 1, 4, 0, 0x41, 0x2a, 0x0b]); // code: i32.const 42
        wasm.extend([11, 8, 1, 0, 0x41, 0, 0x0b, 2, b'h', b'i']); // data "hi"
        let phenotype: Phenotype = serde_json::from_value(serde_json::json!({
            "domain": "math", "inputSchema": {}, "outputSchema": {}, "version": "0.1.0",
            "author": "a", "createdAt": 1, "fidelity": "Native"
        }))
        .unwrap();
        let payloads = CustomSectionPayloads::build(&phenotype, None, None).unwrap();
        let ir = crate::compiler::ir_injector::inject_custom_sections(&wasm, &payloads).unwrap().wasm_bytes;
        let inputs = compiled_inputs(&ir).unwrap();
        assert_eq!(inputs.ir_spec, crate::compiler::ir_sections::IR_SPEC_VERSION);
        assert_eq!(inputs.constraints, by_name("native-module")["constraints"]);
        // Injecting rotifer.* sections must not move the body digest.
        assert_eq!(native_body_digest(&ir).unwrap(), native_body_digest(&wasm).unwrap());

        // Recompiling by someone else, later, changes irHash (author and
        // createdAt live in the phenotype section) but not the v2 ID.
        let mut later = phenotype.clone();
        later.author = "someone-else".into();
        later.created_at += 86_400_000;
        let payloads2 = CustomSectionPayloads::build(&later, None, None).unwrap();
        let ir2 = crate::compiler::ir_injector::inject_custom_sections(&wasm, &payloads2).unwrap();
        let first = crate::compiler::ir_injector::inject_custom_sections(&wasm, &payloads).unwrap();
        assert_ne!(first.ir_hash, ir2.ir_hash, "irHash (v1) does change on recompile");
        let pheno_json = serde_json::json!({ "fidelity": "Native", "domain": "math", "inputSchema": {}, "outputSchema": {} });
        let id_of = |module: &[u8]| {
            let (kind, proj) = projection(&pheno_json, Some(&compiled_inputs(module).unwrap()), &[]).unwrap();
            gene_id(kind, &proj, &native_body_digest(module).unwrap()).unwrap()
        };
        assert_eq!(id_of(&ir), id_of(&ir2.wasm_bytes), "v2 must not change on recompile");
    }
}
