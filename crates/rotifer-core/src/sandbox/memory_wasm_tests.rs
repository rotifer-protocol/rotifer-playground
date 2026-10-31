//! `rotifer.*Memory` host functions end to end: real modules
//! that import them, run through the gated sandbox and the algebra executor.

use std::collections::HashMap;
use std::sync::Arc;

use crate::algebra::{AlgebraExecutor, AlgebraExpr};
use crate::memory::{MemoryCategory, MemoryStore, RecordingSink};
use crate::sandbox::memory_calls::MEMORY_CALL_FUEL;
use crate::sandbox::{CALLER_GENE_ID_EXTENSION, ConstraintSet, Sandbox, WasmtimeSandbox};
use crate::types::gene::{Gene, Phenotype};
use crate::types::{Context, ErrorCode, GeneId, GeneResult, PermissionSet};

const AGENT: &str = "agent-mem";
/// Host function import indices in the guests below.
const READ: u32 = 0;
const WRITE: u32 = 1;
const QUERY: u32 = 2;
const DELETE: u32 = 3;

fn v2(n: u8) -> String {
    format!("v2:{}", hex::encode([n; 32]))
}

fn phenotype(domain: &str) -> Phenotype {
    serde_json::from_value(serde_json::json!({
        "domain": domain,
        "inputSchema": {"type": "object"},
        "outputSchema": {},
        "version": "0.1.0",
        "fidelity": "Native",
    }))
    .unwrap()
}

/// A guest whose `express` makes each `(import, request)` call in turn and
/// returns the response buffer of the last one (fresh memory is zeroed, so
/// it is NUL-terminated). An error writes the `__rotifer_error` envelope
/// there, which the guest then returns as its own output.
fn guest(calls: &[(u32, &str)]) -> Vec<u8> {
    use wasm_encoder::*;
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32; 4], vec![ValType::I32]); // host call
    types
        .ty()
        .function(vec![ValType::I32; 2], vec![ValType::I32]); // express
    module.section(&types);

    let mut imports = ImportSection::new();
    for name in ["readMemory", "writeMemory", "queryMemory", "deleteMemory"] {
        imports.import("rotifer", name, EntityType::Function(0));
    }
    module.section(&imports);

    let mut functions = FunctionSection::new();
    functions.function(1);
    module.section(&functions);

    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 2,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);

    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, 4);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);

    // Requests from 8 KiB: without an `alloc` export the sandbox writes the
    // gene's input at address 0.
    const OUT_CAP: i32 = 16 * 1024;
    let req_base = |i: usize| 8 * 1024 + (i as i32) * 1024;
    let out_base = |i: usize| 32 * 1024 + (i as i32) * OUT_CAP;

    let mut code = CodeSection::new();
    let mut body = Function::new(vec![]);
    for (i, (import, _)) in calls.iter().enumerate() {
        body.instruction(&Instruction::I32Const(req_base(i)));
        body.instruction(&Instruction::I32Const(calls[i].1.len() as i32));
        body.instruction(&Instruction::I32Const(out_base(i)));
        body.instruction(&Instruction::I32Const(OUT_CAP - 1));
        body.instruction(&Instruction::Call(*import));
        body.instruction(&Instruction::Drop);
    }
    body.instruction(&Instruction::I32Const(out_base(calls.len() - 1)));
    body.instruction(&Instruction::End);
    code.function(&body);
    module.section(&code);

    let mut data = DataSection::new();
    for (i, (_, request)) in calls.iter().enumerate() {
        assert!(request.len() < 1024);
        data.active(0, &ConstExpr::i32_const(req_base(i)), request.bytes());
    }
    module.section(&data);

    module.finish()
}

fn store() -> (Arc<MemoryStore>, Arc<RecordingSink>) {
    let sink = Arc::new(RecordingSink::default());
    (
        Arc::new(MemoryStore::in_memory(sink.clone()).unwrap()),
        sink,
    )
}

/// The CLI's starting budget (`src/utils/sandbox-defaults.ts`): the Rust
/// default of 1e6 fuel is below a single memory call.
const CLI_FUEL: u64 = 500_000_000;

fn sandbox(store: &Arc<MemoryStore>) -> WasmtimeSandbox {
    sandbox_with(
        store,
        ConstraintSet {
            max_fuel: CLI_FUEL,
            ..Default::default()
        },
    )
}

fn sandbox_with(store: &Arc<MemoryStore>, constraints: ConstraintSet) -> WasmtimeSandbox {
    let mut sb = WasmtimeSandbox::new(constraints).unwrap();
    sb.set_memory_store(store.clone());
    sb
}

fn context(caller: Option<&str>) -> Context {
    Context {
        agent_id: AGENT.into(),
        timestamp: 1000,
        permissions: PermissionSet::default(),
        trace_id: None,
        binding_extensions: caller.map(|id| {
            HashMap::from([(
                CALLER_GENE_ID_EXTENSION.to_string(),
                serde_json::Value::String(id.into()),
            )])
        }),
    }
}

fn run(
    sb: &WasmtimeSandbox,
    calls: &[(u32, &str)],
    caller: Option<&str>,
    domain: &str,
) -> GeneResult {
    let ph = phenotype(domain);
    let ctx = Context {
        permissions: PermissionSet::declared_by(&ph),
        ..context(caller)
    };
    sb.execute_gated(&guest(calls), &ctx, serde_json::json!({}), &ph)
        .unwrap()
}

fn data(r: GeneResult) -> serde_json::Value {
    match r {
        GeneResult::Success { data, .. } => data,
        GeneResult::Error { message, .. } => panic!("expected success, got error: {message}"),
    }
}

const WRITE_LANG: &str = r#"{"key":"lang","value":"emgtQ04=","category":"PREFERENCE"}"#;
const READ_LANG: &str = r#"{"key":"lang"}"#;

#[test]
fn a_gene_writes_and_reads_its_agent_memory() {
    let (st, sink) = store();
    let sb = sandbox(&st);
    let entry = data(run(
        &sb,
        &[(WRITE, WRITE_LANG), (READ, READ_LANG)],
        Some(&v2(1)),
        "text.x",
    ));
    assert_eq!(entry["value"], "emgtQ04=");
    assert_eq!(entry["createdBy"], v2(1));
    assert_eq!(entry["lastAccessedBy"], v2(1));
    assert_eq!(entry["category"], "PREFERENCE");
    // Native fidelity is fine: memory is not a network capability.
    assert!(
        sink.audits
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.action == crate::memory::events::MemoryAction::Write)
    );
}

#[test]
fn memory_outlives_the_run_and_is_seen_by_a_later_one() {
    let (st, _) = store();
    let sb = sandbox(&st);
    data(run(&sb, &[(WRITE, WRITE_LANG)], Some(&v2(1)), "text.x"));
    // A different gene of the same domain, in a later run.
    let entry = data(run(&sb, &[(READ, READ_LANG)], Some(&v2(2)), "text.x"));
    assert_eq!(entry["createdBy"], v2(1));
    assert_eq!(entry["lastAccessedBy"], v2(2));
}

#[test]
fn query_and_delete_work_from_a_guest() {
    let (st, _) = store();
    let sb = sandbox(&st);
    let list = data(run(
        &sb,
        &[(WRITE, WRITE_LANG), (QUERY, r#"{"category":"PREFERENCE"}"#)],
        Some(&v2(1)),
        "text.x",
    ));
    assert_eq!(list.as_array().unwrap().len(), 1);
    data(run(
        &sb,
        &[(DELETE, READ_LANG), (READ, READ_LANG)],
        Some(&v2(1)),
        "text.x",
    ));
    assert!(
        st.read(
            AGENT,
            &crate::memory::CallerGene {
                gene_id: v2(1),
                domain: "text.x".into()
            },
            "lang",
            None
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn a_denial_reaches_the_gene_as_an_envelope_it_can_return() {
    let (st, sink) = store();
    let sb = sandbox(&st);
    data(run(&sb, &[(WRITE, WRITE_LANG)], Some(&v2(1)), "text.x"));
    // Another domain: the guest returns the envelope the host wrote, and the
    // sandbox reads it as the gene refusing (ADR-334).
    match run(&sb, &[(READ, READ_LANG)], Some(&v2(3)), "search.web") {
        GeneResult::Error { code, message, .. } => {
            assert_eq!(code, ErrorCode::InvalidInput);
            assert!(message.starts_with("MEMORY_ACCESS_DENIED: "), "{message}");
        }
        other => panic!("expected the refusal, got {other:?}"),
    }
    assert_eq!(sink.telemetry.lock().unwrap().len(), 1);
}

#[test]
fn a_run_without_a_gene_id_or_through_ungated_execute_is_denied() {
    let (st, _) = store();
    let sb = sandbox(&st);
    for result in [
        run(&sb, &[(WRITE, WRITE_LANG)], None, "text.x"),
        run(&sb, &[(WRITE, WRITE_LANG)], Some("not-a-v2-id"), "text.x"),
        sb.execute(
            &guest(&[(WRITE, WRITE_LANG)]),
            &context(Some(&v2(1))),
            serde_json::json!({}),
        )
        .unwrap(),
    ] {
        match result {
            GeneResult::Error { message, .. } => {
                assert!(message.starts_with("MEMORY_ACCESS_DENIED: "), "{message}")
            }
            other => panic!("expected a denial, got {other:?}"),
        }
    }
    assert!(
        st.get_memory(AGENT).is_err(),
        "a denied write created memory"
    );
}

#[test]
fn a_gene_run_outside_an_agent_still_links_and_is_denied_every_call() {
    // A sandbox without a memory store is how a gene runs on its own (no
    // memoryContext). Its memory imports still link — the gene runs — and
    // each of the four calls answers MEMORY_ACCESS_DENIED / "no agent
    // context", which this guest returns as its output.
    let sb = WasmtimeSandbox::new(ConstraintSet {
        max_fuel: CLI_FUEL,
        ..Default::default()
    })
    .unwrap();
    for (op, req) in [
        (READ, READ_LANG),
        (WRITE, WRITE_LANG),
        (QUERY, "{}"),
        (DELETE, READ_LANG),
    ] {
        match run(&sb, &[(op, req)], Some(&v2(1)), "text.x") {
            GeneResult::Error { message, .. } => assert!(
                message.starts_with("MEMORY_ACCESS_DENIED: no agent context"),
                "{message}"
            ),
            other => panic!("expected a denial, got {other:?}"),
        }
    }
}

#[test]
fn a_run_outside_an_agent_records_its_denial_as_telemetry_only() {
    // A store attached without an agent (the CLI running a gene with no
    // memoryContext), or a context that names no agent: the call is denied
    // as "no agent context", nothing is written, and only telemetry records
    // it — whatever agent id the context carries.
    for (bound, agent) in [(false, AGENT), (true, "")] {
        let (st, sink) = store();
        let mut sb = sandbox(&st);
        if !bound {
            sb.set_memory_store_without_agent(st.clone());
        }
        let ph = phenotype("text.x");
        let ctx = Context {
            agent_id: agent.into(),
            permissions: PermissionSet::declared_by(&ph),
            ..context(Some(&v2(1)))
        };
        match sb
            .execute_gated(
                &guest(&[(WRITE, WRITE_LANG)]),
                &ctx,
                serde_json::json!({}),
                &ph,
            )
            .unwrap()
        {
            GeneResult::Error { message, .. } => assert!(
                message.starts_with("MEMORY_ACCESS_DENIED: no agent context"),
                "{message}"
            ),
            other => panic!("expected a denial, got {other:?}"),
        }
        assert!(
            st.get_memory(AGENT).is_err(),
            "a run outside an agent wrote memory"
        );
        assert!(sink.audits.lock().unwrap().is_empty());
        let telemetry = sink.telemetry.lock().unwrap();
        assert_eq!(telemetry.len(), 1, "bound {bound}");
        assert!(telemetry[0].metadata["agentId"].is_null());
        assert_eq!(telemetry[0].gene_id.as_deref(), Some(v2(1).as_str()));
    }
}

#[test]
fn the_algebra_executor_runs_each_gene_as_itself() {
    let (st, _) = store();
    let sb = sandbox(&st);
    let gene = |n: u8, domain: &str, calls: &[(u32, &str)]| -> (GeneId, Gene) {
        let id = [n; 32];
        (
            id,
            Gene {
                id,
                phenotype: phenotype(domain),
                wasm_bytes: Some(guest(calls)),
                source_code: None,
            },
        )
    };
    let (writer_id, writer) = gene(10, "text.x", &[(WRITE, WRITE_LANG)]);
    let (reader_id, reader) = gene(11, "text.x", &[(READ, READ_LANG)]);
    let (anon_id, anon) = gene(12, "text.x", &[(READ, READ_LANG)]);
    let genes: HashMap<GeneId, Gene> =
        [(writer_id, writer), (reader_id, reader), (anon_id, anon)].into();
    let ids: HashMap<GeneId, String> = [(writer_id, v2(10)), (reader_id, v2(11))].into();
    let exec = AlgebraExecutor::new(&sb, &genes)
        .with_gene_ids(ids)
        .with_declared_permissions();

    let seq = AlgebraExpr::Seq(vec![
        AlgebraExpr::Gene(writer_id),
        AlgebraExpr::Gene(reader_id),
    ]);
    let entry = data(
        exec.execute(&seq, &context(None), serde_json::json!({}))
            .unwrap(),
    );
    assert_eq!(entry["createdBy"], v2(10));
    assert_eq!(entry["lastAccessedBy"], v2(11));

    // A gene the executor has no content id for is denied, not anonymous.
    match exec
        .execute(
            &AlgebraExpr::Gene(anon_id),
            &context(None),
            serde_json::json!({}),
        )
        .unwrap()
    {
        GeneResult::Error { message, .. } => {
            assert!(message.contains("content-derived id"), "{message}")
        }
        other => panic!("expected a denial, got {other:?}"),
    }
    assert_eq!(
        st.get_memory(AGENT).unwrap().entries[0].category,
        MemoryCategory::Preference
    );
}

/// `express` calls readMemory(req_ptr, req_len, out, cap) with raw
/// arguments and returns `{"rejected":true}` if it got -10, else its out
/// buffer.
fn raw_guest(req_ptr: i32, req_len: i32) -> Vec<u8> {
    use wasm_encoder::*;
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32; 4], vec![ValType::I32]);
    types
        .ty()
        .function(vec![ValType::I32; 2], vec![ValType::I32]);
    module.section(&types);
    let mut imports = ImportSection::new();
    imports.import("rotifer", "readMemory", EntityType::Function(0));
    module.section(&imports);
    let mut functions = FunctionSection::new();
    functions.function(1);
    module.section(&functions);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, 1);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut body = Function::new(vec![]);
    body.instruction(&Instruction::I32Const(req_ptr));
    body.instruction(&Instruction::I32Const(req_len));
    body.instruction(&Instruction::I32Const(16384));
    body.instruction(&Instruction::I32Const(4096));
    body.instruction(&Instruction::Call(0));
    body.instruction(&Instruction::I32Const(-10));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    body.instruction(&Instruction::I32Const(8192));
    body.instruction(&Instruction::Else);
    body.instruction(&Instruction::I32Const(16384));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::End);
    code.function(&body);
    module.section(&code);
    let mut data = DataSection::new();
    data.active(
        0,
        &ConstExpr::i32_const(8192),
        br#"{"rejected":true}"#.iter().copied(),
    );
    module.section(&data);
    module.finish()
}

#[test]
fn an_out_of_range_or_huge_request_is_refused_before_anything_is_copied() {
    let (st, _) = store();
    let sb = sandbox(&st);
    let ph = phenotype("text.x");
    let ctx = Context {
        permissions: PermissionSet::declared_by(&ph),
        ..context(Some(&v2(1)))
    };
    for (ptr, len) in [(0, i32::MAX), (65_000, 1_000), (-1, 4), (8, -4)] {
        let out = sb
            .execute_gated(&raw_guest(ptr, len), &ctx, serde_json::json!({}), &ph)
            .unwrap();
        assert_eq!(
            data(out),
            serde_json::json!({"rejected": true}),
            "ptr {ptr} len {len}"
        );
    }
}

#[test]
fn every_memory_call_burns_real_fuel_once() {
    // Each call takes MEMORY_CALL_FUEL out of the run's
    // wasmtime fuel — not a surcharge billed beside it, and not both.
    let (st, _) = store();
    let sb = sandbox(&st);
    let ph = phenotype("text.x");
    let ctx = Context {
        permissions: PermissionSet::declared_by(&ph),
        ..context(Some(&v2(1)))
    };
    let cost = |calls: &[(u32, &str)]| match sb
        .execute_gated(&guest(calls), &ctx, serde_json::json!({}), &ph)
        .unwrap()
    {
        GeneResult::Success { metadata, .. } => (
            metadata.resource_cost as u64,
            metadata.host.map_or(0, |h| h.host_fuel_surcharge),
        ),
        GeneResult::Error { message, .. } => panic!("{message}"),
    };
    let (one, one_surcharge) = cost(&[(READ, READ_LANG)]);
    let (three, three_surcharge) = cost(&[(READ, READ_LANG), (READ, READ_LANG), (READ, READ_LANG)]);
    assert_eq!(
        (one_surcharge, three_surcharge),
        (0, 0),
        "billed beside the fuel"
    );
    // Two more calls: two charges plus a handful of guest instructions.
    let extra = three - one;
    assert!(
        (2 * MEMORY_CALL_FUEL..2 * MEMORY_CALL_FUEL + 1_000).contains(&extra),
        "two more calls cost {extra}"
    );
}

#[test]
fn a_call_the_fuel_cannot_pay_for_is_not_run() {
    // The charge comes first: a run left with less than MEMORY_CALL_FUEL
    // gets -4 and the store is never touched. The rest of the fuel is
    // drained: the run gets no free computation once its budget is spent.
    let (st, _) = store();
    let sb = sandbox_with(
        &st,
        ConstraintSet {
            max_fuel: MEMORY_CALL_FUEL / 2,
            ..Default::default()
        },
    );
    let ph = phenotype("text.x");
    let ctx = Context {
        permissions: PermissionSet::declared_by(&ph),
        ..context(Some(&v2(1)))
    };
    let out = sb
        .execute_gated(
            &code_guest(WRITE, WRITE_LANG, -4),
            &ctx,
            serde_json::json!({}),
            &ph,
        )
        .unwrap();
    let GeneResult::Success { data, metadata } = out else {
        panic!("expected the guest's own answer, got {out:?}");
    };
    assert_eq!(data, serde_json::json!({"matched": true}));
    assert_eq!(
        metadata.resource_cost as u64,
        MEMORY_CALL_FUEL / 2,
        "fuel left after -4"
    );
    assert!(
        st.get_memory(AGENT).is_err(),
        "the unpaid write was applied"
    );
}

#[test]
fn a_call_after_the_deadline_is_minus_four_and_not_run() {
    // Host calls do not stop for the epoch deadline,
    // so each memory call checks the wall clock first. A run whose deadline
    // has already passed gets -4 (no envelope, as rotifer.kv / rotifer.net).
    let (st, _) = store();
    let sb = sandbox_with(
        &st,
        ConstraintSet {
            max_fuel: CLI_FUEL,
            max_execution_time_ms: 0,
            ..Default::default()
        },
    );
    let ph = phenotype("text.x");
    let mut permissions = PermissionSet::declared_by(&ph);
    // The L0 gate refuses a run whose granted time exceeds the sandbox's.
    permissions.resource_limits.max_execution_time_ms = Some(0);
    let ctx = Context {
        permissions,
        ..context(Some(&v2(1)))
    };
    let out = sb
        .execute_gated(
            &code_guest(WRITE, WRITE_LANG, -4),
            &ctx,
            serde_json::json!({}),
            &ph,
        )
        .unwrap();
    assert_eq!(data(out), serde_json::json!({"matched": true}));
    assert!(
        st.get_memory(AGENT).is_err(),
        "a write past the deadline was applied"
    );
}

/// `express` makes one host call (import index as in [`guest`]) and returns
/// `{"matched":true}` if it returned `code`, else `{"matched":false}`.
fn code_guest(import: u32, request: &str, code: i32) -> Vec<u8> {
    use wasm_encoder::*;
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32; 4], vec![ValType::I32]);
    types
        .ty()
        .function(vec![ValType::I32; 2], vec![ValType::I32]);
    module.section(&types);
    let mut imports = ImportSection::new();
    for name in ["readMemory", "writeMemory", "queryMemory", "deleteMemory"] {
        imports.import("rotifer", name, EntityType::Function(0));
    }
    module.section(&imports);
    let mut functions = FunctionSection::new();
    functions.function(1);
    module.section(&functions);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, 4);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);
    let mut code_section = CodeSection::new();
    let mut body = Function::new(vec![]);
    body.instruction(&Instruction::I32Const(8192));
    body.instruction(&Instruction::I32Const(request.len() as i32));
    body.instruction(&Instruction::I32Const(32768));
    body.instruction(&Instruction::I32Const(16384));
    body.instruction(&Instruction::Call(import));
    body.instruction(&Instruction::I32Const(code));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    body.instruction(&Instruction::I32Const(4096));
    body.instruction(&Instruction::Else);
    body.instruction(&Instruction::I32Const(6144));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::End);
    code_section.function(&body);
    module.section(&code_section);
    let mut data_section = DataSection::new();
    data_section.active(
        0,
        &ConstExpr::i32_const(4096),
        br#"{"matched":true}"#.iter().copied(),
    );
    data_section.active(
        0,
        &ConstExpr::i32_const(6144),
        br#"{"matched":false}"#.iter().copied(),
    );
    data_section.active(0, &ConstExpr::i32_const(8192), request.bytes());
    module.section(&data_section);
    module.finish()
}

#[test]
fn a_gene_without_a_v2_id_does_not_inherit_the_callers_identity() {
    // The incoming context already names gene 10 as the caller
    // (a host that runs a genome on behalf of a gene). A gene the executor
    // has no v2 id for must not run as gene 10.
    let (st, _) = store();
    let sb = sandbox(&st);
    st.write(
        AGENT,
        &crate::memory::CallerGene {
            gene_id: v2(10),
            domain: "text.x".into(),
        },
        "lang",
        b"zh",
        MemoryCategory::Preference,
        Some(crate::memory::MemoryAccessPolicy {
            read_scope: crate::memory::AccessScope::CreatorGeneOnly,
            write_scope: crate::memory::AccessScope::CreatorGeneOnly,
            share_policy: crate::memory::SharePolicy::Private,
        }),
        None,
    )
    .unwrap();
    let anon_id = [12u8; 32];
    let genes: HashMap<GeneId, Gene> = [(
        anon_id,
        Gene {
            id: anon_id,
            phenotype: phenotype("text.x"),
            wasm_bytes: Some(guest(&[(READ, READ_LANG)])),
            source_code: None,
        },
    )]
    .into();
    let exec = AlgebraExecutor::new(&sb, &genes)
        .with_gene_ids(HashMap::new())
        .with_declared_permissions();
    match exec
        .execute(
            &AlgebraExpr::Gene(anon_id),
            &context(Some(&v2(10))),
            serde_json::json!({}),
        )
        .unwrap()
    {
        GeneResult::Error { message, .. } => {
            assert!(message.contains("content-derived id"), "{message}")
        }
        GeneResult::Success { data, .. } => {
            panic!("a gene without an id read as gene 10: {data}")
        }
    }
}

/// `express` makes one call to import `import` with `request` (at 8192) and
/// the given out pointer and capacity, and returns `{"rejected":true}` if
/// the call answered -10, else `{"rejected":false}`.
fn out_buffer_guest(import: u32, request: &str, out_ptr: i32, out_cap: i32) -> Vec<u8> {
    use wasm_encoder::*;
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32; 4], vec![ValType::I32]);
    types
        .ty()
        .function(vec![ValType::I32; 2], vec![ValType::I32]);
    module.section(&types);
    let mut imports = ImportSection::new();
    for name in ["readMemory", "writeMemory", "queryMemory", "deleteMemory"] {
        imports.import("rotifer", name, EntityType::Function(0));
    }
    module.section(&imports);
    let mut functions = FunctionSection::new();
    functions.function(1);
    module.section(&functions);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, 4);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut body = Function::new(vec![]);
    body.instruction(&Instruction::I32Const(8192));
    body.instruction(&Instruction::I32Const(request.len() as i32));
    body.instruction(&Instruction::I32Const(out_ptr));
    body.instruction(&Instruction::I32Const(out_cap));
    body.instruction(&Instruction::Call(import));
    body.instruction(&Instruction::I32Const(-10));
    body.instruction(&Instruction::I32Eq);
    body.instruction(&Instruction::If(BlockType::Result(ValType::I32)));
    body.instruction(&Instruction::I32Const(4096));
    body.instruction(&Instruction::Else);
    body.instruction(&Instruction::I32Const(4160));
    body.instruction(&Instruction::End);
    body.instruction(&Instruction::End);
    code.function(&body);
    module.section(&code);
    let mut data = DataSection::new();
    data.active(0, &ConstExpr::i32_const(8192), request.bytes());
    data.active(
        0,
        &ConstExpr::i32_const(4096),
        br#"{"rejected":true}"#.iter().copied(),
    );
    data.active(
        0,
        &ConstExpr::i32_const(4160),
        br#"{"rejected":false}"#.iter().copied(),
    );
    module.section(&data);
    module.finish()
}

#[test]
fn a_bad_out_buffer_is_refused_before_the_store_is_touched() {
    // With an out buffer outside guest memory the call must fail
    // before the write is applied, not after.
    let (st, _) = store();
    let sb = sandbox(&st);
    let ph = phenotype("text.x");
    let ctx = Context {
        permissions: PermissionSet::declared_by(&ph),
        ..context(Some(&v2(1)))
    };
    for (out_ptr, out_cap) in [(-1, 4096), (65_000, 4096), (0, -1), (i32::MAX, 16)] {
        let out = sb
            .execute_gated(
                &out_buffer_guest(WRITE, WRITE_LANG, out_ptr, out_cap),
                &ctx,
                serde_json::json!({}),
                &ph,
            )
            .unwrap();
        assert_eq!(
            data(out),
            serde_json::json!({"rejected": true}),
            "out {out_ptr} cap {out_cap}"
        );
        assert!(
            st.get_memory(AGENT).is_err(),
            "the write landed although its response could not be delivered (out {out_ptr} cap {out_cap})"
        );
    }
}
