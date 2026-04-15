export const DEFAULT_SANDBOX_CONSTRAINTS = {
  max_fuel: 500_000_000,
  max_memory_bytes: 256 * 1024 * 1024,
  max_execution_time_ms: 60_000,
  allowed_host_functions: [] as string[],
  denied_host_functions: [] as string[],
};

export const DEFAULT_SANDBOX_CONSTRAINTS_JSON = JSON.stringify(
  DEFAULT_SANDBOX_CONSTRAINTS,
);
