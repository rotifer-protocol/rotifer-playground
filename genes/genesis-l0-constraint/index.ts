interface ConstraintCheckInput {
  geneId: string;
  constraints?: {
    maxMemoryBytes?: number;
    maxFuel?: number;
    allowedHostFunctions?: string[];
    deniedHostFunctions?: string[];
  };
}

interface ConstraintCheckOutput {
  compliant: boolean;
  violations: string[];
  constraintSet: {
    maxMemoryBytes: number;
    maxFuel: number;
    allowedHostFunctions: string[];
    deniedHostFunctions: string[];
  };
}

const DEFAULT_MAX_MEMORY = 16 * 1024 * 1024; // 16 MiB
const DEFAULT_MAX_FUEL = 1_000_000;

/**
 * Genesis Gene: L0 Constraint Checker
 *
 * Validates that a gene's resource usage profile conforms to L0 sandbox
 * constraints. This is a meta-gene used by the Arena admission process
 * and the testing framework.
 */
export async function express(input: ConstraintCheckInput): Promise<ConstraintCheckOutput> {
  const maxMem = input.constraints?.maxMemoryBytes ?? DEFAULT_MAX_MEMORY;
  const maxFuel = input.constraints?.maxFuel ?? DEFAULT_MAX_FUEL;
  const allowed = input.constraints?.allowedHostFunctions ?? [];
  const denied = input.constraints?.deniedHostFunctions ?? ["fs.write", "net.listen", "process.exit"];

  const violations: string[] = [];

  if (!input.geneId || input.geneId.length !== 64) {
    violations.push("Invalid gene ID format (expected 64-char hex)");
  }

  if (maxMem > 256 * 1024 * 1024) {
    violations.push(`Memory limit ${maxMem} exceeds protocol maximum (256 MiB)`);
  }

  if (maxFuel > 100_000_000) {
    violations.push(`Fuel limit ${maxFuel} exceeds protocol maximum (100M)`);
  }

  return {
    compliant: violations.length === 0,
    violations,
    constraintSet: {
      maxMemoryBytes: maxMem,
      maxFuel: maxFuel,
      allowedHostFunctions: allowed,
      deniedHostFunctions: denied,
    },
  };
}
