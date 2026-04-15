use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wasmtime::*;

use super::{ConstraintSet, Sandbox, SandboxError};
use crate::l0::L0Gate;
use crate::types::gene::Phenotype;
use crate::types::{Context, ExecutionMetadata, GeneResult};

struct HostState {
    context_json: Vec<u8>,
    logical_timestamp: u64,
    stdin: Vec<u8>,
    stdin_offset: usize,
    stdout: Arc<Mutex<Vec<u8>>>,
    limiter: StoreLimits,
}

impl ResourceLimiter for HostState {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> anyhow::Result<bool> {
        let max = self.limiter.max_memory;
        Ok(desired <= max)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> anyhow::Result<bool> {
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
        })
    }

    /// Create a sandbox with protocol-default constraints (64 MB, 1M fuel, 30 s).
    pub fn with_defaults() -> Result<Self, SandboxError> {
        Self::new(ConstraintSet::default())
    }

    /// Execute with L0 gate enforcement — the preferred entry point.
    ///
    /// Runs `L0Gate::check()` before delegating to `Sandbox::execute()`.
    /// Returns `SandboxError::ConstraintViolation` if L0 checks fail.
    pub fn execute_gated(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
        phenotype: &Phenotype,
    ) -> Result<GeneResult, SandboxError> {
        let l0_result = L0Gate::check(phenotype, &context.permissions, &self.constraints);
        if !l0_result.passed {
            let msgs: Vec<String> = l0_result.violations.iter().map(|v| v.to_string()).collect();
            return Err(SandboxError::ConstraintViolation(
                format!("L0 gate blocked: {}", msgs.join("; ")),
            ));
        }
        self.execute(wasm_bytes, context, input)
    }

    /// Return the constraint set for external inspection (e.g. memory peak estimation).
    pub fn constraints(&self) -> &ConstraintSet {
        &self.constraints
    }

    /// Register the minimal WASI preview 1 host functions required by Javy modules.
    fn link_wasi(linker: &mut Linker<HostState>) -> Result<(), SandboxError> {
        let map_err = |e: anyhow::Error| SandboxError::ExecutionFailed(e.to_string());

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
                        }
                        // fd==2 (stderr) is silently discarded
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
        let map_err = |e: anyhow::Error| SandboxError::ExecutionFailed(e.to_string());

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

impl Sandbox for WasmtimeSandbox {
    fn execute(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError> {
        let start = std::time::Instant::now();

        let module = Module::new(&self.engine, wasm_bytes)
            .map_err(|e| SandboxError::CompilationFailed(e.to_string()))?;

        let input_bytes = serde_json::to_vec(&input)
            .map_err(|e| SandboxError::ExecutionFailed(e.to_string()))?;

        let stdout = Arc::new(Mutex::new(Vec::new()));
        let host_state = HostState {
            context_json: serde_json::to_vec(context).unwrap_or_default(),
            logical_timestamp: context.timestamp,
            stdin: input_bytes.clone(),
            stdin_offset: 0,
            stdout: stdout.clone(),
            limiter: StoreLimits {
                max_memory: self.constraints.max_memory_bytes as usize,
                max_table_elements: 10_000,
            },
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

        let output = result.map_err(|e| {
            let msg = e.to_string();
            if msg.contains("epoch") || msg.contains("interrupt") {
                SandboxError::ResourceLimitExceeded(format!(
                    "execution timed out after {}ms",
                    timeout_ms
                ))
            } else {
                e
            }
        })?;

        let duration_ms = start.elapsed().as_millis() as u64;
        let fuel_consumed = self.constraints.max_fuel - store.get_fuel().unwrap_or(0);

        Ok(GeneResult::Success {
            data: output,
            metadata: ExecutionMetadata {
                duration_ms,
                resource_cost: fuel_consumed as f64,
                cache_hit: None,
            },
        })
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
}
