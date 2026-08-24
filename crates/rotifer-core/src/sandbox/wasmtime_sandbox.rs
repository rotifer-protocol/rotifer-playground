use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wasmtime::*;

use super::hybrid::{self, HybridConfig};
use super::{ConstraintSet, Sandbox, SandboxError};
use crate::types::gene::{Fidelity, Phenotype};
use crate::types::{Context, ExecutionMetadata, GeneResult, HostMetering};

/// Source-level shapes of an async `express()`, mirroring the compile-time
/// guard (E0025) in the CLI's Javy compiler.
const ASYNC_EXPRESS_MARKERS: [&str; 2] = ["async function express", "express = async"];

/// Detect an async/Promise-returning `express()` embedded in a compiled artifact.
///
/// Javy/QuickJS has no event loop, so an async `express()` hands back a Promise
/// instead of a result. The shim serialises that Promise to `{}` and exits 0, so
/// the gene silently produces empty output and still looks like a success — the
/// worst possible failure mode. The CLI rejects this shape at compile time, but
/// artifacts published before that guard existed still carry it, so the runtime
/// has to refuse them too.
///
/// Javy keeps the JS source text in the artifact, so a substring scan is enough.
/// It only ever fires positively: an artifact without the marker is left alone.
fn find_async_express(wasm_bytes: &[u8]) -> Option<&'static str> {
    ASYNC_EXPRESS_MARKERS.into_iter().find(|marker| {
        let needle = marker.as_bytes();
        wasm_bytes.len() >= needle.len()
            && wasm_bytes
                .windows(needle.len())
                .any(|window| window == needle)
    })
}

struct HostState {
    context_json: Vec<u8>,
    logical_timestamp: u64,
    stdin: Vec<u8>,
    stdin_offset: usize,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    limiter: StoreLimits,
    /// Hybrid capability state (ADR-327). `HybridRuntime::default()` denies
    /// everything, which is what the ungated `execute()` path carries.
    hybrid: hybrid::HybridRuntime,
}

impl ResourceLimiter for HostState {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let max = self.limiter.max_memory;
        Ok(desired <= max)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= self.limiter.max_table_elements as usize)
    }
}

struct StoreLimits {
    max_memory: usize,
    max_table_elements: u32,
}

/// [`Sandbox`] implementation backed by the `wasmtime` runtime.
///
/// Provides fuel-based metering, epoch interruption, and Rotifer host functions.
/// Supports two execution modes:
/// - **Direct**: module exports `express(i32, i32) -> i32` (hand-crafted / genesis WASM)
/// - **WASI**: module exports `_start` with WASI preview 1 imports (Javy-compiled TS genes)
pub struct WasmtimeSandbox {
    engine: Arc<Engine>,
    constraints: ConstraintSet,
    /// Deployer-granted env values for hybrid genes (ADR-327 D3): `plain`
    /// is readable via `rotifer.env.read`; `secret` is usable only through
    /// host-side `${env:NAME}` substitution and never enters guest memory.
    hybrid_env_plain: std::collections::HashMap<String, String>,
    hybrid_env_secret: std::collections::HashMap<String, String>,
    /// Test hook: admit plain-http loopback URLs in `rotifer.net.fetch`.
    /// Never derived from a phenotype and never wired to the CLI.
    insecure_loopback: bool,
}

impl WasmtimeSandbox {
    pub fn new(constraints: ConstraintSet) -> Result<Self, SandboxError> {
        let mut config = Config::new();
        config.consume_fuel(true);
        config.epoch_interruption(true);

        let engine = Engine::new(&config)
            .map_err(|e| SandboxError::CompilationFailed(e.to_string()))?;

        Ok(Self {
            engine: engine.into(),
            constraints,
            hybrid_env_plain: Default::default(),
            hybrid_env_secret: Default::default(),
            insecure_loopback: false,
        })
    }

    /// Grant env values to hybrid executions (binding deployment wiring).
    pub fn set_hybrid_env(
        &mut self,
        plain: std::collections::HashMap<String, String>,
        secret: std::collections::HashMap<String, String>,
    ) {
        self.hybrid_env_plain = plain;
        self.hybrid_env_secret = secret;
    }

    /// Binding-internal test hook — see the field doc.
    #[doc(hidden)]
    pub fn set_insecure_loopback(&mut self, on: bool) {
        self.insecure_loopback = on;
    }

    /// Create a sandbox with protocol-default constraints (64 MB, 1M fuel, 30 s).
    pub fn with_defaults() -> Result<Self, SandboxError> {
        Self::new(ConstraintSet::default())
    }

    /// Register the minimal WASI preview 1 host functions required by Javy modules.
    fn link_wasi(linker: &mut Linker<HostState>) -> Result<(), SandboxError> {
        let map_err = |e: wasmtime::Error| SandboxError::ExecutionFailed(e.to_string());

        // fd_read(fd, iovs_ptr, iovs_len, nread_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "fd_read",
                |mut caller: Caller<'_, HostState>,
                 fd: i32,
                 iovs_ptr: i32,
                 iovs_len: i32,
                 nread_ptr: i32|
                 -> i32 {
                    if fd != 0 {
                        return 8; // EBADF
                    }
                    let memory = match caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                    {
                        Some(m) => m,
                        None => return 8,
                    };

                    let mut total_read: u32 = 0;
                    for i in 0..iovs_len {
                        let iov_offset = (iovs_ptr as u32 + i as u32 * 8) as usize;
                        let data = memory.data(&caller);
                        if iov_offset + 8 > data.len() {
                            break;
                        }
                        let buf_ptr =
                            u32::from_le_bytes(data[iov_offset..iov_offset + 4].try_into().unwrap())
                                as usize;
                        let buf_len = u32::from_le_bytes(
                            data[iov_offset + 4..iov_offset + 8].try_into().unwrap(),
                        ) as usize;

                        let state = caller.data();
                        let remaining = &state.stdin[state.stdin_offset..];
                        let to_copy = remaining.len().min(buf_len);
                        if to_copy > 0 {
                            let src: Vec<u8> = remaining[..to_copy].to_vec();
                            if let Some(dst) = memory
                                .data_mut(&mut caller)
                                .get_mut(buf_ptr..buf_ptr + to_copy)
                            {
                                dst.copy_from_slice(&src);
                            }
                            caller.data_mut().stdin_offset += to_copy;
                            total_read += to_copy as u32;
                        }
                        if to_copy < buf_len {
                            break; // stdin exhausted
                        }
                    }
                    let data_mut = memory.data_mut(&mut caller);
                    let np = nread_ptr as usize;
                    if np + 4 <= data_mut.len() {
                        data_mut[np..np + 4].copy_from_slice(&total_read.to_le_bytes());
                    }
                    0 // success
                },
            )
            .map_err(map_err)?;

        // fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "fd_write",
                |mut caller: Caller<'_, HostState>,
                 fd: i32,
                 iovs_ptr: i32,
                 iovs_len: i32,
                 nwritten_ptr: i32|
                 -> i32 {
                    if fd != 1 && fd != 2 {
                        return 8; // EBADF
                    }
                    let memory = match caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                    {
                        Some(m) => m,
                        None => return 8,
                    };

                    let mut total_written: u32 = 0;
                    for i in 0..iovs_len {
                        let iov_offset = (iovs_ptr as u32 + i as u32 * 8) as usize;
                        let data = memory.data(&caller);
                        if iov_offset + 8 > data.len() {
                            break;
                        }
                        let buf_ptr =
                            u32::from_le_bytes(data[iov_offset..iov_offset + 4].try_into().unwrap())
                                as usize;
                        let buf_len = u32::from_le_bytes(
                            data[iov_offset + 4..iov_offset + 8].try_into().unwrap(),
                        ) as usize;

                        let end = (buf_ptr + buf_len).min(data.len());
                        let chunk = data[buf_ptr..end].to_vec();
                        if fd == 1 {
                            caller
                                .data()
                                .stdout
                                .lock()
                                .expect("stdout mutex poisoned")
                                .extend_from_slice(&chunk);
                        } else if fd == 2 {
                            // Capture stderr so a trap's diagnostic (e.g. the
                            // Javy/QuickJS error message) can be surfaced instead
                            // of only an opaque WASM backtrace.
                            caller
                                .data()
                                .stderr
                                .lock()
                                .expect("stderr mutex poisoned")
                                .extend_from_slice(&chunk);
                        }
                        total_written += chunk.len() as u32;
                    }
                    let data_mut = memory.data_mut(&mut caller);
                    let np = nwritten_ptr as usize;
                    if np + 4 <= data_mut.len() {
                        data_mut[np..np + 4].copy_from_slice(&total_written.to_le_bytes());
                    }
                    0
                },
            )
            .map_err(map_err)?;

        // clock_time_get(clock_id, precision, time_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "clock_time_get",
                |mut caller: Caller<'_, HostState>,
                 _clock_id: i32,
                 _precision: i64,
                 time_ptr: i32|
                 -> i32 {
                    let ts_ns = caller.data().logical_timestamp * 1_000_000;
                    let memory = match caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                    {
                        Some(m) => m,
                        None => return 8,
                    };
                    let data_mut = memory.data_mut(&mut caller);
                    let tp = time_ptr as usize;
                    if tp + 8 <= data_mut.len() {
                        data_mut[tp..tp + 8].copy_from_slice(&ts_ns.to_le_bytes());
                    }
                    0
                },
            )
            .map_err(map_err)?;

        // environ_sizes_get(count_ptr, buf_size_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "environ_sizes_get",
                |mut caller: Caller<'_, HostState>, count_ptr: i32, buf_size_ptr: i32| -> i32 {
                    let memory = match caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                    {
                        Some(m) => m,
                        None => return 8,
                    };
                    let data = memory.data_mut(&mut caller);
                    let cp = count_ptr as usize;
                    let bp = buf_size_ptr as usize;
                    if cp + 4 <= data.len() {
                        data[cp..cp + 4].copy_from_slice(&0u32.to_le_bytes());
                    }
                    if bp + 4 <= data.len() {
                        data[bp..bp + 4].copy_from_slice(&0u32.to_le_bytes());
                    }
                    0
                },
            )
            .map_err(map_err)?;

        // environ_get(environ_ptr, environ_buf_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "environ_get",
                |_caller: Caller<'_, HostState>, _environ_ptr: i32, _environ_buf_ptr: i32| -> i32 {
                    0
                },
            )
            .map_err(map_err)?;

        // fd_close(fd) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "fd_close",
                |_caller: Caller<'_, HostState>, _fd: i32| -> i32 { 0 },
            )
            .map_err(map_err)?;

        // fd_fdstat_get(fd, stat_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "fd_fdstat_get",
                |mut caller: Caller<'_, HostState>, fd: i32, stat_ptr: i32| -> i32 {
                    let memory = match caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                    {
                        Some(m) => m,
                        None => return 8,
                    };
                    let data = memory.data_mut(&mut caller);
                    let sp = stat_ptr as usize;
                    // fdstat structure: filetype(u8) + pad(u8) + flags(u16) + rights_base(u64) + rights_inheriting(u64) = 24 bytes
                    if sp + 24 <= data.len() {
                        data[sp..sp + 24].fill(0);
                        match fd {
                            0 => data[sp] = 2, // FILETYPE_CHARACTER_DEVICE
                            1 | 2 => data[sp] = 2,
                            _ => return 8, // EBADF
                        }
                    }
                    0
                },
            )
            .map_err(map_err)?;

        // fd_seek(fd, offset, whence, newoffset_ptr) -> errno
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "fd_seek",
                |_caller: Caller<'_, HostState>,
                 _fd: i32,
                 _offset: i64,
                 _whence: i32,
                 _newoffset_ptr: i32|
                 -> i32 {
                    70 // ENOSYS — seek not supported on stdin/stdout
                },
            )
            .map_err(map_err)?;

        // proc_exit(code)
        linker
            .func_wrap(
                "wasi_snapshot_preview1",
                "proc_exit",
                |_caller: Caller<'_, HostState>, code: i32| {
                    if code != 0 {
                        tracing::warn!(code, "WASI gene called proc_exit with non-zero code");
                    }
                },
            )
            .map_err(map_err)?;

        Ok(())
    }

    /// Register Rotifer spec host functions (§6.2).
    fn link_rotifer(linker: &mut Linker<HostState>) -> Result<(), SandboxError> {
        let map_err = |e: wasmtime::Error| SandboxError::ExecutionFailed(e.to_string());

        linker
            .func_wrap(
                "env",
                "log",
                |_caller: Caller<'_, HostState>, ptr: i32, len: i32| {
                    tracing::debug!(ptr, len, "wasm guest log call (legacy env.log)");
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer",
                "log",
                |mut caller: Caller<'_, HostState>, level: i32, ptr: i32, len: i32| {
                    if let Some(memory) =
                        caller.get_export("memory").and_then(|e| e.into_memory())
                    {
                        let data = memory.data(&caller);
                        let end = (ptr as usize).saturating_add(len as usize).min(data.len());
                        if let Ok(msg) = std::str::from_utf8(&data[ptr as usize..end]) {
                            match level {
                                0 => tracing::debug!("[gene] {msg}"),
                                1 => tracing::info!("[gene] {msg}"),
                                2 => tracing::warn!("[gene] {msg}"),
                                _ => tracing::error!("[gene] {msg}"),
                            }
                        }
                    }
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer",
                "readContext",
                |mut caller: Caller<'_, HostState>,
                 key_ptr: i32,
                 key_len: i32,
                 out_ptr: i32,
                 out_buf_len: i32|
                 -> i32 {
                    let memory = match caller
                        .get_export("memory")
                        .and_then(|e| e.into_memory())
                    {
                        Some(m) => m,
                        None => return -1,
                    };

                    let data = memory.data(&caller);
                    let key_end =
                        (key_ptr as usize).saturating_add(key_len as usize).min(data.len());
                    let key = match std::str::from_utf8(&data[key_ptr as usize..key_end]) {
                        Ok(k) => k.to_string(),
                        Err(_) => return -1,
                    };

                    let ctx_json: serde_json::Value =
                        serde_json::from_slice(&caller.data().context_json).unwrap_or_default();

                    let value_bytes = match ctx_json.get(&key) {
                        Some(v) => serde_json::to_vec(v).unwrap_or_default(),
                        None => return 0,
                    };

                    if value_bytes.len() > out_buf_len as usize {
                        return -1;
                    }

                    let data_mut = memory.data_mut(&mut caller);
                    let dst_start = out_ptr as usize;
                    let dst_end = dst_start + value_bytes.len();
                    if dst_end <= data_mut.len() {
                        data_mut[dst_start..dst_end].copy_from_slice(&value_bytes);
                    }

                    value_bytes.len() as i32
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer",
                "remainingBudget",
                |caller: Caller<'_, HostState>| -> i64 {
                    caller.get_fuel().unwrap_or(0) as i64
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer",
                "logicalTimestamp",
                |caller: Caller<'_, HostState>| -> i64 {
                    caller.data().logical_timestamp as i64
                },
            )
            .map_err(map_err)?;

        Ok(())
    }

    /// Register the hybrid capability modules `rotifer.net` / `rotifer.kv` /
    /// `rotifer.env` (ADR-327, `nonstandard` preview pending IR spec §6.2
    /// incorporation). Every permission decision happens per call against the
    /// store's `HybridRuntime`, so linking is unconditional-when-imported.
    fn link_hybrid(linker: &mut Linker<HostState>) -> Result<(), SandboxError> {
        let map_err = |e: wasmtime::Error| SandboxError::ExecutionFailed(e.to_string());

        linker
            .func_wrap(
                "rotifer.net",
                "fetch",
                |mut caller: Caller<'_, HostState>,
                 req_ptr: i32,
                 req_len: i32,
                 out_ptr: i32,
                 out_cap: i32|
                 -> i32 {
                    let timer = hybrid::HostCallTimer::start();
                    let code = Self::net_fetch_call(&mut caller, req_ptr, req_len, out_ptr, out_cap);
                    timer.stop_into(&mut caller.data_mut().hybrid);
                    code
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer.kv",
                "put",
                |mut caller: Caller<'_, HostState>,
                 key_ptr: i32,
                 key_len: i32,
                 val_ptr: i32,
                 val_len: i32|
                 -> i32 {
                    let timer = hybrid::HostCallTimer::start();
                    let code = Self::kv_put_call(&mut caller, key_ptr, key_len, val_ptr, val_len);
                    timer.stop_into(&mut caller.data_mut().hybrid);
                    code
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer.kv",
                "get",
                |mut caller: Caller<'_, HostState>,
                 key_ptr: i32,
                 key_len: i32,
                 out_ptr: i32,
                 out_cap: i32|
                 -> i32 {
                    let timer = hybrid::HostCallTimer::start();
                    let code = Self::kv_get_call(&mut caller, key_ptr, key_len, out_ptr, out_cap);
                    timer.stop_into(&mut caller.data_mut().hybrid);
                    code
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer.kv",
                "del",
                |mut caller: Caller<'_, HostState>, key_ptr: i32, key_len: i32| -> i32 {
                    let timer = hybrid::HostCallTimer::start();
                    let code = Self::kv_del_call(&mut caller, key_ptr, key_len);
                    timer.stop_into(&mut caller.data_mut().hybrid);
                    code
                },
            )
            .map_err(map_err)?;

        linker
            .func_wrap(
                "rotifer.env",
                "read",
                |mut caller: Caller<'_, HostState>,
                 key_ptr: i32,
                 key_len: i32,
                 out_ptr: i32,
                 out_cap: i32|
                 -> i32 {
                    let timer = hybrid::HostCallTimer::start();
                    let code = Self::env_read_call(&mut caller, key_ptr, key_len, out_ptr, out_cap);
                    timer.stop_into(&mut caller.data_mut().hybrid);
                    code
                },
            )
            .map_err(map_err)?;

        Ok(())
    }

    // ── hybrid host call bodies ─────────────────────────────────────────

    fn hybrid_memory(caller: &mut Caller<'_, HostState>) -> Option<Memory> {
        caller.get_export("memory").and_then(|e| e.into_memory())
    }

    /// Bounds-checked guest read; `None` on out-of-range args.
    fn hybrid_read(
        caller: &mut Caller<'_, HostState>,
        memory: &Memory,
        ptr: i32,
        len: i32,
    ) -> Option<Vec<u8>> {
        if ptr < 0 || len < 0 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        memory.read(&mut *caller, ptr as usize, &mut buf).ok()?;
        Some(buf)
    }

    /// Bounds-checked guest write.
    fn hybrid_write(
        caller: &mut Caller<'_, HostState>,
        memory: &Memory,
        ptr: i32,
        data: &[u8],
    ) -> bool {
        ptr >= 0 && memory.write(&mut *caller, ptr as usize, data).is_ok()
    }

    /// Deduct a fuel surcharge (ADR-327 D4). Saturates at zero: an
    /// underfunded call leaves the guest with no fuel, so its next
    /// instruction traps as fuel-exhausted — the surcharge is a real bill,
    /// not advisory.
    fn hybrid_charge(caller: &mut Caller<'_, HostState>, amount: u64) {
        let fuel = caller.get_fuel().unwrap_or(0);
        let _ = caller.set_fuel(fuel.saturating_sub(amount));
    }

    fn net_fetch_call(
        caller: &mut Caller<'_, HostState>,
        req_ptr: i32,
        req_len: i32,
        out_ptr: i32,
        out_cap: i32,
    ) -> i32 {
        use hybrid::errors::*;
        use sha2::{Digest, Sha256};

        if caller.data().hybrid.host_budget_exhausted() {
            return ERR_TIMEOUT;
        }
        let Some(memory) = Self::hybrid_memory(caller) else {
            return ERR_INVALID_REQUEST;
        };
        let Some(req_bytes) = Self::hybrid_read(caller, &memory, req_ptr, req_len) else {
            return ERR_INVALID_REQUEST;
        };
        if out_cap < 0 {
            return ERR_INVALID_REQUEST;
        }

        let digest: [u8; 32] = Sha256::digest(&req_bytes).into();

        // Retained-response retry (ADR-327 §2.1): a byte-identical repeat is
        // served from the buffer — no new network I/O, no new surcharge.
        if let Some((held_digest, held)) = &caller.data().hybrid.retained {
            if *held_digest == digest {
                let held = held.clone();
                if held.len() <= out_cap as usize {
                    if !Self::hybrid_write(caller, &memory, out_ptr, &held) {
                        return ERR_INVALID_REQUEST;
                    }
                    caller.data_mut().hybrid.retained = None;
                    return held.len() as i32;
                }
                return ERR_BUFFER_TOO_SMALL;
            }
            // A different request invalidates the buffer.
            caller.data_mut().hybrid.retained = None;
        }

        let (policy, plain, secret, loopback) = {
            let cfg = &caller.data().hybrid.config;
            (
                cfg.net.clone(),
                cfg.env_plain.clone(),
                cfg.env_secret.clone(),
                cfg.allow_insecure_loopback,
            )
        };
        let Some(policy) = policy else {
            return ERR_PERMISSION_DENIED;
        };

        let req = match hybrid::parse_request_envelope(&req_bytes) {
            Ok(r) => r,
            Err(code) => return code,
        };
        if let Err(code) = hybrid::check_url(&policy, &req.url, loopback) {
            return code;
        }
        if caller.data().hybrid.requests_made >= policy.max_requests {
            return ERR_RATE_LIMITED;
        }
        let resolved_headers = match hybrid::substitute_headers(&req.headers, &plain, &secret) {
            Ok(h) => h,
            Err(code) => return code,
        };

        caller.data_mut().hybrid.requests_made += 1;
        let envelope = match hybrid::perform_fetch(&policy, loopback, &req, &resolved_headers) {
            Ok(e) => e,
            Err(code) => return code,
        };

        let bytes_out = req_bytes.len() as u64;
        let bytes_in = envelope.len() as u64;
        {
            let rt = &mut caller.data_mut().hybrid;
            rt.host_bytes_out += bytes_out;
            rt.host_bytes_in += bytes_in;
        }
        Self::hybrid_charge(
            caller,
            hybrid::fuel_surcharge(
                hybrid::constants::BASE_CALL_FUEL_NET_FETCH,
                bytes_in,
                bytes_out,
            ),
        );

        if envelope.len() > out_cap as usize {
            caller.data_mut().hybrid.retained = Some((digest, envelope));
            return ERR_BUFFER_TOO_SMALL;
        }
        if !Self::hybrid_write(caller, &memory, out_ptr, &envelope) {
            return ERR_INVALID_REQUEST;
        }
        envelope.len() as i32
    }

    fn kv_put_call(
        caller: &mut Caller<'_, HostState>,
        key_ptr: i32,
        key_len: i32,
        val_ptr: i32,
        val_len: i32,
    ) -> i32 {
        use hybrid::errors::*;

        if caller.data().hybrid.host_budget_exhausted() {
            return ERR_TIMEOUT;
        }
        let Some(memory) = Self::hybrid_memory(caller) else {
            return ERR_INVALID_REQUEST;
        };
        let Some(key) = Self::hybrid_read(caller, &memory, key_ptr, key_len)
            .and_then(|b| String::from_utf8(b).ok())
        else {
            return ERR_INVALID_REQUEST;
        };
        let Some(value) = Self::hybrid_read(caller, &memory, val_ptr, val_len) else {
            return ERR_INVALID_REQUEST;
        };

        let bytes_out = (key.len() + value.len()) as u64;
        let code = {
            let rt = &mut caller.data_mut().hybrid;
            rt.host_bytes_out += bytes_out;
            rt.kv.put(&key, &value)
        };
        Self::hybrid_charge(
            caller,
            hybrid::fuel_surcharge(hybrid::constants::BASE_CALL_FUEL_KV, 0, bytes_out),
        );
        code
    }

    fn kv_get_call(
        caller: &mut Caller<'_, HostState>,
        key_ptr: i32,
        key_len: i32,
        out_ptr: i32,
        out_cap: i32,
    ) -> i32 {
        use hybrid::errors::*;

        if caller.data().hybrid.host_budget_exhausted() {
            return ERR_TIMEOUT;
        }
        let Some(memory) = Self::hybrid_memory(caller) else {
            return ERR_INVALID_REQUEST;
        };
        let Some(key) = Self::hybrid_read(caller, &memory, key_ptr, key_len)
            .and_then(|b| String::from_utf8(b).ok())
        else {
            return ERR_INVALID_REQUEST;
        };
        if out_cap < 0 {
            return ERR_INVALID_REQUEST;
        }

        let Some(value) = caller.data().hybrid.kv.get(&key).map(|v| v.to_vec()) else {
            Self::hybrid_charge(caller, hybrid::constants::BASE_CALL_FUEL_KV);
            return 0;
        };
        if value.len() > out_cap as usize {
            return ERR_BUFFER_TOO_SMALL;
        }
        if !Self::hybrid_write(caller, &memory, out_ptr, &value) {
            return ERR_INVALID_REQUEST;
        }
        let bytes_in = value.len() as u64;
        caller.data_mut().hybrid.host_bytes_in += bytes_in;
        Self::hybrid_charge(
            caller,
            hybrid::fuel_surcharge(hybrid::constants::BASE_CALL_FUEL_KV, bytes_in, 0),
        );
        value.len() as i32
    }

    fn kv_del_call(caller: &mut Caller<'_, HostState>, key_ptr: i32, key_len: i32) -> i32 {
        use hybrid::errors::*;

        if caller.data().hybrid.host_budget_exhausted() {
            return ERR_TIMEOUT;
        }
        let Some(memory) = Self::hybrid_memory(caller) else {
            return ERR_INVALID_REQUEST;
        };
        let Some(key) = Self::hybrid_read(caller, &memory, key_ptr, key_len)
            .and_then(|b| String::from_utf8(b).ok())
        else {
            return ERR_INVALID_REQUEST;
        };
        let code = caller.data_mut().hybrid.kv.del(&key);
        Self::hybrid_charge(caller, hybrid::constants::BASE_CALL_FUEL_KV);
        code
    }

    fn env_read_call(
        caller: &mut Caller<'_, HostState>,
        key_ptr: i32,
        key_len: i32,
        out_ptr: i32,
        out_cap: i32,
    ) -> i32 {
        use hybrid::errors::*;

        if caller.data().hybrid.host_budget_exhausted() {
            return ERR_TIMEOUT;
        }
        let Some(memory) = Self::hybrid_memory(caller) else {
            return ERR_INVALID_REQUEST;
        };
        let Some(name) = Self::hybrid_read(caller, &memory, key_ptr, key_len)
            .and_then(|b| String::from_utf8(b).ok())
        else {
            return ERR_INVALID_REQUEST;
        };
        if out_cap < 0 {
            return ERR_INVALID_REQUEST;
        }

        // Secret-tier names are substitution-only (ADR-327 D3): reading one
        // is a permission error, and its bytes never reach guest memory.
        if caller.data().hybrid.config.env_secret.contains_key(&name) {
            Self::hybrid_charge(caller, hybrid::constants::BASE_CALL_FUEL_ENV_READ);
            return ERR_PERMISSION_DENIED;
        }
        let Some(value) = caller.data().hybrid.config.env_plain.get(&name).cloned() else {
            Self::hybrid_charge(caller, hybrid::constants::BASE_CALL_FUEL_ENV_READ);
            return 0;
        };
        if value.len() > out_cap as usize {
            return ERR_BUFFER_TOO_SMALL;
        }
        if !Self::hybrid_write(caller, &memory, out_ptr, value.as_bytes()) {
            return ERR_INVALID_REQUEST;
        }
        let bytes_in = value.len() as u64;
        caller.data_mut().hybrid.host_bytes_in += bytes_in;
        Self::hybrid_charge(
            caller,
            hybrid::fuel_surcharge(hybrid::constants::BASE_CALL_FUEL_ENV_READ, bytes_in, 0),
        );
        value.len() as i32
    }

    /// Execute a WASI module (Javy-compiled) via stdin/stdout.
    fn execute_wasi(
        &self,
        store: &mut Store<HostState>,
        instance: &Instance,
    ) -> Result<serde_json::Value, SandboxError> {
        let start_fn = instance
            .get_typed_func::<(), ()>(&mut *store, "_start")
            .map_err(|e| SandboxError::ExecutionFailed(format!("missing '_start': {e}")))?;

        match start_fn.call(&mut *store, ()) {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                if !msg.contains("proc_exit") {
                    let fuel_remaining = store.get_fuel().unwrap_or(0);
                    if fuel_remaining == 0 {
                        return Err(SandboxError::ResourceLimitExceeded(
                            "fuel exhausted".into(),
                        ));
                    }
                    return Err(SandboxError::ExecutionFailed(msg));
                }
            }
        }

        let stdout_bytes = store
            .data()
            .stdout
            .lock()
            .expect("stdout mutex poisoned")
            .clone();
        serde_json::from_slice(&stdout_bytes).map_err(|e| {
            SandboxError::ExecutionFailed(format!(
                "WASI gene stdout is not valid JSON: {e} (got {} bytes: {:?})",
                stdout_bytes.len(),
                String::from_utf8_lossy(
                    &stdout_bytes[..stdout_bytes.len().min(200)]
                ),
            ))
        })
    }

    /// Execute a direct-export module via `express(ptr, len) -> ptr`.
    fn execute_direct(
        &self,
        store: &mut Store<HostState>,
        instance: &Instance,
        input_bytes: &[u8],
    ) -> Result<serde_json::Value, SandboxError> {
        let memory = instance
            .get_memory(&mut *store, "memory")
            .ok_or_else(|| SandboxError::ExecutionFailed("no memory export".into()))?;

        let alloc_fn = instance
            .get_typed_func::<i32, i32>(&mut *store, "alloc")
            .ok();

        let express_fn = instance
            .get_typed_func::<(i32, i32), i32>(&mut *store, "express")
            .map_err(|e| {
                SandboxError::ExecutionFailed(format!("missing 'express' export: {e}"))
            })?;

        let input_ptr = if let Some(alloc) = alloc_fn {
            let ptr = alloc
                .call(&mut *store, input_bytes.len() as i32)
                .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;
            memory
                .write(&mut *store, ptr as usize, input_bytes)
                .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;
            ptr
        } else {
            memory
                .write(&mut *store, 0, input_bytes)
                .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;
            0
        };

        let result_ptr = express_fn
            .call(&mut *store, (input_ptr, input_bytes.len() as i32))
            .map_err(|e| {
                let fuel_remaining = store.get_fuel().unwrap_or(0);
                if fuel_remaining == 0 {
                    SandboxError::ResourceLimitExceeded("fuel exhausted".into())
                } else {
                    SandboxError::ExecutionFailed(e.to_string())
                }
            })?;

        if result_ptr >= 0 {
            let mem_data = memory.data(&*store);
            let result_slice = &mem_data[result_ptr as usize..];
            let null_pos = result_slice
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(result_slice.len());
            Ok(serde_json::from_slice(&result_slice[..null_pos])
                .unwrap_or(serde_json::Value::Null))
        } else {
            Err(SandboxError::ExecutionFailed(format!(
                "gene returned error code: {result_ptr}"
            )))
        }
    }
}

impl WasmtimeSandbox {
    /// Execute with an explicit hybrid capability configuration. The public
    /// `execute()` passes `HybridConfig::disabled()`; the phenotype-aware
    /// entry (`execute_with_phenotype`) derives the config from the
    /// phenotype + deployer permissions.
    pub(crate) fn execute_inner(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
        hybrid_config: HybridConfig,
    ) -> Result<GeneResult, SandboxError> {
        let start = std::time::Instant::now();

        if let Some(marker) = find_async_express(wasm_bytes) {
            return Err(SandboxError::InvalidWasm(format!(
                "gene artifact declares `{marker}` — Javy/QuickJS has no event loop, so express() \
                 returns a Promise that serialises to `{{}}`: the gene would silently produce empty \
                 output and still exit 0. Recompile with a synchronous express(), or run it under \
                 Node (--no-sandbox) / publish it as a Hybrid gene for async I/O."
            )));
        }

        let module = Module::new(&self.engine, wasm_bytes)
            .map_err(|e| SandboxError::CompilationFailed(e.to_string()))?;

        let input_bytes = serde_json::to_vec(&input)
            .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;

        let stdout = Arc::new(Mutex::new(Vec::new()));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let host_state = HostState {
            context_json: serde_json::to_vec(context).unwrap_or_default(),
            logical_timestamp: context.timestamp,
            stdin: input_bytes.clone(),
            stdin_offset: 0,
            stdout: stdout.clone(),
            stderr: stderr.clone(),
            limiter: StoreLimits {
                max_memory: self.constraints.max_memory_bytes as usize,
                max_table_elements: 10_000,
            },
            hybrid: hybrid::HybridRuntime::new(hybrid_config),
        };

        let mut store = Store::new(&self.engine, host_state);
        store.limiter(|state| state);
        store
            .set_fuel(self.constraints.max_fuel)
            .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;

        let timeout_ms = self.constraints.max_execution_time_ms;
        let epoch_interval_ms = 100u64;
        let ticks_until_deadline = (timeout_ms / epoch_interval_ms).max(1);
        store.set_epoch_deadline(ticks_until_deadline);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = stop_flag.clone();
        let engine_handle = self.engine.clone();
        let epoch_thread = std::thread::spawn(move || {
            while !stop_clone.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(epoch_interval_ms));
                engine_handle.increment_epoch();
            }
        });

        let mut linker: Linker<HostState> = Linker::new(&self.engine);

        // Detect if module needs WASI imports
        let needs_wasi = module
            .imports()
            .any(|imp| imp.module() == "wasi_snapshot_preview1");

        if needs_wasi {
            Self::link_wasi(&mut linker)?;
        }

        // Always provide Rotifer host functions (ignored if not imported)
        let has_rotifer_imports = module
            .imports()
            .any(|imp| imp.module() == "rotifer" || imp.module() == "env");
        if has_rotifer_imports {
            Self::link_rotifer(&mut linker)?;
        }

        // Hybrid capability modules (ADR-327, nonstandard preview). Linked
        // whenever imported — permission checks happen per call, so an
        // ungranted gene observes -2 instead of an instantiation trap and can
        // run its declared degradation behavior.
        let has_hybrid_imports = module
            .imports()
            .any(|imp| hybrid::CAPABILITY_MODULES.contains(&imp.module()));
        if has_hybrid_imports {
            Self::link_hybrid(&mut linker)?;
        }

        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;

        let is_wasi = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .is_ok();

        let result = if is_wasi {
            self.execute_wasi(&mut store, &instance)
        } else {
            self.execute_direct(&mut store, &instance, &input_bytes)
        };

        stop_flag.store(true, Ordering::Relaxed);
        let _ = epoch_thread.join();

        // Surface any stderr the guest wrote before failing (Javy/QuickJS writes
        // throw messages to fd 2). Without this the host returns only an opaque
        // WASM backtrace. (R4)
        let stderr_text = {
            let buf = stderr.lock().expect("stderr mutex poisoned");
            String::from_utf8_lossy(&buf).trim().to_string()
        };
        let output = result.map_err(|e| {
            let msg = e.to_string();
            if msg.contains("epoch") || msg.contains("interrupt") {
                SandboxError::ResourceLimitExceeded(format!(
                    "execution timed out after {}ms",
                    timeout_ms
                ))
            } else if !stderr_text.is_empty() {
                SandboxError::ExecutionFailed(format!("{msg}\n  gene stderr: {stderr_text}"))
            } else {
                e
            }
        })?;

        let duration_ms = start.elapsed().as_millis() as u64;
        let fuel_consumed = self.constraints.max_fuel - store.get_fuel().unwrap_or(0);

        // Host metering (ADR-327 D4): fuel surcharges are already inside
        // fuel_consumed; the host-side channel is reported alongside.
        let hy = &store.data().hybrid;
        let host = (hy.host_calls > 0).then_some(HostMetering {
            host_call_millis: hy.host_call_millis,
            host_calls: hy.host_calls,
            host_bytes_in: hy.host_bytes_in,
            host_bytes_out: hy.host_bytes_out,
        });

        Ok(GeneResult::Success {
            data: output,
            metadata: ExecutionMetadata {
                duration_ms,
                resource_cost: fuel_consumed as f64,
                cache_hit: None,
                host,
            },
        })
    }
}

impl Sandbox for WasmtimeSandbox {
    fn constraints(&self) -> &ConstraintSet {
        &self.constraints
    }

    fn execute(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError> {
        self.execute_inner(wasm_bytes, context, input, HybridConfig::disabled())
    }

    /// Phenotype-aware entry: fidelity honesty gate (ADR-327 D1) + policy
    /// derivation from the phenotype and deployer permissions.
    fn execute_with_phenotype(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
        phenotype: &Phenotype,
    ) -> Result<GeneResult, SandboxError> {
        if hybrid::imports_capability_modules(wasm_bytes)
            && phenotype.fidelity == Fidelity::Native
        {
            return Err(SandboxError::ConstraintViolation(
                "fidelity honesty: module imports capability host functions \
                 (rotifer.net/kv/env) but the phenotype declares fidelity \
                 'native' — declare 'hybrid' or 'wrapped' (ADR-327 D1)"
                    .into(),
            ));
        }
        let mut config = HybridConfig::from_phenotype(phenotype, &context.permissions);
        config.env_plain = self.hybrid_env_plain.clone();
        config.env_secret = self.hybrid_env_secret.clone();
        config.allow_insecure_loopback = self.insecure_loopback;
        self.execute_inner(wasm_bytes, context, input, config)
    }

    fn validate(
        &self,
        wasm_bytes: &[u8],
        _constraints: &ConstraintSet,
    ) -> Result<bool, SandboxError> {
        Module::validate(&self.engine, wasm_bytes)
            .map(|_| true)
            .map_err(|e| SandboxError::InvalidWasm(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::Sandbox;
    use crate::types::PermissionSet;
    use crate::compiler::genesis;

    fn test_context() -> Context {
        Context {
            agent_id: "test".into(),
            timestamp: 12345,
            permissions: PermissionSet::default(),
            trace_id: Some("trace-001".into()),
            binding_extensions: None,
        }
    }

    /// Build a minimal WASI echo module: reads stdin, writes it verbatim to stdout.
    fn build_wasi_echo_wasm() -> Vec<u8> {
        use wasm_encoder::*;

        let mut module = Module::new();

        // Type section: (i32, i32, i32, i32) -> i32 for fd_read/fd_write, () -> () for _start
        let mut types = TypeSection::new();
        types
            .ty()
            .function(vec![ValType::I32; 4], vec![ValType::I32]);
        types.ty().function(vec![], vec![]);
        module.section(&types);

        // Import section: wasi_snapshot_preview1.{fd_read, fd_write}
        let mut imports = ImportSection::new();
        imports.import(
            "wasi_snapshot_preview1",
            "fd_read",
            EntityType::Function(0),
        );
        imports.import(
            "wasi_snapshot_preview1",
            "fd_write",
            EntityType::Function(0),
        );
        module.section(&imports);

        // Function section: _start uses type 1
        let mut functions = FunctionSection::new();
        functions.function(1);
        module.section(&functions);

        // Memory section
        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: 1,
            maximum: Some(2),
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);

        // Export section: memory + _start
        let mut exports = ExportSection::new();
        exports.export("memory", ExportKind::Memory, 0);
        exports.export("_start", ExportKind::Func, 2); // func index 2 (after 2 imports)
        module.section(&exports);

        // Code section: _start body
        let mut code = CodeSection::new();
        let mut f = Function::new(vec![]);

        // Set up iovec at addr 0: {buf_ptr: 64, buf_len: 4096}
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(64)); // buf_ptr = 64
        f.instruction(&Instruction::I32Store(MemArg {
            offset: 0,
            align: 2,
            memory_index: 0,
        }));
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(4096)); // buf_len = 4096
        f.instruction(&Instruction::I32Store(MemArg {
            offset: 4,
            align: 2,
            memory_index: 0,
        }));

        // fd_read(fd=0, iovs=0, iovs_count=1, nread_ptr=8)
        f.instruction(&Instruction::I32Const(0)); // fd = stdin
        f.instruction(&Instruction::I32Const(0)); // iovs
        f.instruction(&Instruction::I32Const(1)); // iovs count
        f.instruction(&Instruction::I32Const(8)); // nread ptr
        f.instruction(&Instruction::Call(0)); // fd_read
        f.instruction(&Instruction::Drop);

        // Update iovec.buf_len = nread
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(8));
        f.instruction(&Instruction::I32Load(MemArg {
            offset: 0,
            align: 2,
            memory_index: 0,
        }));
        f.instruction(&Instruction::I32Store(MemArg {
            offset: 4,
            align: 2,
            memory_index: 0,
        }));

        // fd_write(fd=1, iovs=0, iovs_count=1, nwritten_ptr=12)
        f.instruction(&Instruction::I32Const(1)); // fd = stdout
        f.instruction(&Instruction::I32Const(0)); // iovs
        f.instruction(&Instruction::I32Const(1)); // iovs count
        f.instruction(&Instruction::I32Const(12)); // nwritten ptr
        f.instruction(&Instruction::Call(1)); // fd_write
        f.instruction(&Instruction::Drop);

        f.instruction(&Instruction::End);
        code.function(&f);
        module.section(&code);

        // Data section: empty (we set up iovec in the code)
        module.finish()
    }

    /// Like build_wasi_echo_wasm, but writes stdin to fd 2 (stderr) then traps
    /// (`unreachable`) — exercises stderr capture + surfacing on failure (R4).
    fn build_wasi_stderr_trap_wasm() -> Vec<u8> {
        use wasm_encoder::*;

        let mut module = Module::new();

        let mut types = TypeSection::new();
        types.ty().function(vec![ValType::I32; 4], vec![ValType::I32]);
        types.ty().function(vec![], vec![]);
        module.section(&types);

        let mut imports = ImportSection::new();
        imports.import("wasi_snapshot_preview1", "fd_read", EntityType::Function(0));
        imports.import("wasi_snapshot_preview1", "fd_write", EntityType::Function(0));
        module.section(&imports);

        let mut functions = FunctionSection::new();
        functions.function(1);
        module.section(&functions);

        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: 1,
            maximum: Some(2),
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);

        let mut exports = ExportSection::new();
        exports.export("memory", ExportKind::Memory, 0);
        exports.export("_start", ExportKind::Func, 2);
        module.section(&exports);

        let mut code = CodeSection::new();
        let mut f = Function::new(vec![]);
        // iovec at 0: {buf_ptr: 64, buf_len: 4096}
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(64));
        f.instruction(&Instruction::I32Store(MemArg { offset: 0, align: 2, memory_index: 0 }));
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(4096));
        f.instruction(&Instruction::I32Store(MemArg { offset: 4, align: 2, memory_index: 0 }));
        // fd_read(fd=0, iovs=0, count=1, nread=8)
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(1));
        f.instruction(&Instruction::I32Const(8));
        f.instruction(&Instruction::Call(0));
        f.instruction(&Instruction::Drop);
        // iovec.buf_len = nread
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(8));
        f.instruction(&Instruction::I32Load(MemArg { offset: 0, align: 2, memory_index: 0 }));
        f.instruction(&Instruction::I32Store(MemArg { offset: 4, align: 2, memory_index: 0 }));
        // fd_write(fd=2 = stderr, iovs=0, count=1, nwritten=12)
        f.instruction(&Instruction::I32Const(2));
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Const(1));
        f.instruction(&Instruction::I32Const(12));
        f.instruction(&Instruction::Call(1));
        f.instruction(&Instruction::Drop);
        // then trap
        f.instruction(&Instruction::Unreachable);
        f.instruction(&Instruction::End);
        code.function(&f);
        module.section(&code);

        module.finish()
    }

    #[test]
    fn surfaces_stderr_on_trap() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = build_wasi_stderr_trap_wasm();
        let result = sb.execute(&wasm, &test_context(), serde_json::json!("STDERR_MARKER_r4"));
        match result {
            Err(SandboxError::ExecutionFailed(msg)) => {
                assert!(msg.contains("gene stderr"), "expected stderr surfaced, got: {msg}");
                assert!(msg.contains("STDERR_MARKER_r4"), "expected marker in stderr, got: {msg}");
            }
            other => panic!("expected ExecutionFailed with stderr, got {other:?}"),
        }
    }

    #[test]
    fn with_defaults_constructor() {
        let sb = WasmtimeSandbox::with_defaults();
        assert!(sb.is_ok());
    }

    #[test]
    fn validate_valid_wasm() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = genesis::build_echo_gene_wasm();
        let result = sb.validate(&wasm, &ConstraintSet::default());
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn validate_invalid_wasm() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let result = sb.validate(&[0xFF, 0xFF, 0xFF, 0xFF], &ConstraintSet::default());
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), SandboxError::InvalidWasm(_)));
    }

    #[test]
    fn validate_empty_bytes() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let result = sb.validate(&[], &ConstraintSet::default());
        assert!(result.is_err());
    }

    #[test]
    fn execute_invalid_wasm_bytes() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let result = sb.execute(&[0xFF, 0xFF], &test_context(), serde_json::json!({}));
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), SandboxError::CompilationFailed(_)));
    }

    #[test]
    fn execute_echo_gene_happy_path() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = genesis::build_echo_gene_wasm();
        let input = serde_json::json!({"hello": "world"});
        let result = sb.execute(&wasm, &test_context(), input.clone());
        assert!(result.is_ok());
        match result.unwrap() {
            GeneResult::Success { data, metadata } => {
                assert_eq!(data, input);
                assert!(metadata.duration_ms < 5000);
                assert!(metadata.resource_cost > 0.0);
            }
            GeneResult::Error { message, .. } => panic!("expected success: {message}"),
        }
    }

    #[test]
    fn execute_missing_memory_export() {
        let mut module = wasm_encoder::Module::new();
        let mut types = wasm_encoder::TypeSection::new();
        types.ty().function(vec![wasm_encoder::ValType::I32, wasm_encoder::ValType::I32], vec![wasm_encoder::ValType::I32]);
        module.section(&types);
        let mut funcs = wasm_encoder::FunctionSection::new();
        funcs.function(0);
        module.section(&funcs);
        let mut exports = wasm_encoder::ExportSection::new();
        exports.export("express", wasm_encoder::ExportKind::Func, 0);
        module.section(&exports);
        let mut code = wasm_encoder::CodeSection::new();
        let mut f = wasm_encoder::Function::new(vec![]);
        f.instruction(&wasm_encoder::Instruction::LocalGet(0));
        f.instruction(&wasm_encoder::Instruction::End);
        code.function(&f);
        module.section(&code);
        let wasm = module.finish();

        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let result = sb.execute(&wasm, &test_context(), serde_json::json!({}));
        assert!(result.is_err());
        let err_msg = result.unwrap_err().to_string();
        assert!(err_msg.contains("memory"), "error should mention missing memory: {err_msg}");
    }

    #[test]
    fn execute_empty_json_input() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = genesis::build_echo_gene_wasm();
        let result = sb.execute(&wasm, &test_context(), serde_json::Value::Null);
        assert!(result.is_ok());
    }

    #[test]
    fn execute_custom_low_fuel_constraint() {
        let constraints = ConstraintSet {
            max_fuel: 10,
            ..ConstraintSet::default()
        };
        let sb = WasmtimeSandbox::new(constraints).unwrap();
        let wasm = genesis::build_echo_gene_wasm();
        let result = sb.execute(&wasm, &test_context(), serde_json::json!({"x": 1}));
        match result {
            Err(SandboxError::ResourceLimitExceeded(_)) => {}
            Err(SandboxError::ExecutionFailed(_)) => {}
            Ok(GeneResult::Error { .. }) => {}
            Ok(GeneResult::Success { .. }) => {}
            _ => panic!("unexpected result: {result:?}"),
        }
    }

    #[test]
    fn execute_wasi_echo_module() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = build_wasi_echo_wasm();
        let input = serde_json::json!({"msg": "hello from WASI"});
        let result = sb.execute(&wasm, &test_context(), input.clone());
        assert!(result.is_ok(), "WASI execution failed: {result:?}");
        match result.unwrap() {
            GeneResult::Success { data, metadata } => {
                assert_eq!(data, input, "WASI echo should return stdin as stdout");
                assert!(metadata.resource_cost > 0.0);
            }
            GeneResult::Error { message, .. } => panic!("expected success: {message}"),
        }
    }

    #[test]
    fn validate_wasi_module() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = build_wasi_echo_wasm();
        let result = sb.validate(&wasm, &ConstraintSet::default());
        assert!(result.is_ok());
        assert!(result.unwrap());
    }

    #[test]
    fn execute_wasi_empty_input() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = build_wasi_echo_wasm();
        let result = sb.execute(&wasm, &test_context(), serde_json::json!({}));
        assert!(result.is_ok());
        match result.unwrap() {
            GeneResult::Success { data, .. } => {
                assert_eq!(data, serde_json::json!({}));
            }
            GeneResult::Error { message, .. } => panic!("expected success: {message}"),
        }
    }

    #[test]
    fn execute_wasi_complex_json() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = build_wasi_echo_wasm();
        let input = serde_json::json!({
            "name": "Rotifer",
            "version": [0, 3, 0],
            "nested": {"deep": true},
            "tags": ["wasi", "javy"]
        });
        let result = sb.execute(&wasm, &test_context(), input.clone());
        assert!(result.is_ok());
        match result.unwrap() {
            GeneResult::Success { data, .. } => {
                assert_eq!(data, input);
            }
            GeneResult::Error { message, .. } => panic!("expected success: {message}"),
        }
    }

    /// Append a custom section carrying JS source text, mimicking how Javy
    /// embeds the gene source in a compiled artifact.
    fn with_embedded_source(wasm: &[u8], source: &str) -> Vec<u8> {
        use wasm_encoder::*;

        let mut module = Module::new();
        module.section(&CustomSection {
            name: std::borrow::Cow::Borrowed("rotifer_test_src"),
            data: std::borrow::Cow::Borrowed(source.as_bytes()),
        });
        let mut out = module.finish();
        // Splice the custom section in after the 8-byte magic + version header.
        let mut spliced = wasm[..8].to_vec();
        spliced.extend_from_slice(&out.split_off(8));
        spliced.extend_from_slice(&wasm[8..]);
        spliced
    }

    #[test]
    fn execute_rejects_async_express_artifact() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = with_embedded_source(
            &build_wasi_echo_wasm(),
            "var __gene = (() => { async function express(input) { return {ok:true}; } })();",
        );

        let result = sb.execute(&wasm, &test_context(), serde_json::json!({"a": 1}));

        let err = result.expect_err("async express artifact must not execute silently");
        let msg = err.to_string();
        assert!(
            msg.contains("async"),
            "error should name the async defect, got: {msg}"
        );
        assert!(
            msg.contains("express"),
            "error should name express(), got: {msg}"
        );
    }

    #[test]
    fn execute_rejects_async_express_arrow_form() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let wasm = with_embedded_source(
            &build_wasi_echo_wasm(),
            "var express = async (input) => ({ ok: true });",
        );

        let result = sb.execute(&wasm, &test_context(), serde_json::json!({"a": 1}));

        assert!(
            result.is_err(),
            "arrow-form async express must also be rejected"
        );
    }

    #[test]
    fn execute_allows_sync_express_artifact() {
        let sb = WasmtimeSandbox::with_defaults().unwrap();
        let input = serde_json::json!({"a": 1});
        let wasm = with_embedded_source(
            &build_wasi_echo_wasm(),
            "var __gene = (() => { function express(input) { return {ok:true}; } })();",
        );

        let result = sb.execute(&wasm, &test_context(), input.clone());

        assert!(
            result.is_ok(),
            "synchronous express must still run: {result:?}"
        );
        match result.unwrap() {
            GeneResult::Success { data, .. } => assert_eq!(data, input),
            GeneResult::Error { message, .. } => panic!("expected success: {message}"),
        }
    }
}
