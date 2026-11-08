import { getGene, GeneNotFoundError } from "./client.js";

/**
 * Can a gene a `hello` template needs be fetched and run? Asked only after a
 * template turned out to be missing genes; read-only, nothing is downloaded.
 *
 * The lookup is qualified with the publisher on purpose. A bare name resolves
 * to the newest row of that name from anyone, and most template gene names are
 * unclaimed: a command printed with a bare name would install whatever someone
 * published under it first.
 */
export const OFFICIAL_GENE_PUBLISHER = "rotifer-protocol";

const LOOKUP_TIMEOUT_MS = 5_000;

export type GeneAvailability =
  /** On the Registry from the official publisher, with a WASM artifact. */
  | "installable"
  /** No such gene from the official publisher. */
  | "not_published"
  /** Exists, but has no code that can run. */
  | "metadata_only"
  /** The Registry could not be asked. Says nothing about the gene. */
  | "unknown";

export interface GeneDiagnosis {
  name: string;
  status: GeneAvailability;
  fidelity: string | null;
  install_command: string | null;
  /** Reads after "<name>: ". */
  detail: string;
}

class LookupTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LookupTimeout()), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

export async function diagnoseRegistryGene(
  name: string,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<GeneDiagnosis> {
  const ref = `@${OFFICIAL_GENE_PUBLISHER}/${name}`;
  try {
    const gene = await withTimeout(getGene(ref), timeoutMs);
    if (gene.wasm_url) {
      const command = `rotifer install ${ref}`;
      return { name, status: "installable", fidelity: gene.fidelity, install_command: command, detail: `install with: ${command}` };
    }
    return {
      name,
      status: "metadata_only",
      fidelity: gene.fidelity,
      install_command: null,
      detail: `on Rotifer Cloud (${gene.fidelity}) with no runnable code, so installing it would not make this template work`,
    };
  } catch (err) {
    if (err instanceof GeneNotFoundError) {
      return {
        name,
        status: "not_published",
        fidelity: null,
        install_command: null,
        detail: `not published on Rotifer Cloud by ${OFFICIAL_GENE_PUBLISHER}, so it cannot be installed`,
      };
    }
    const reason = err instanceof LookupTimeout
      ? `no answer within ${Math.round(timeoutMs / 1000)}s`
      : err instanceof Error ? err.message : String(err);
    return {
      name,
      status: "unknown",
      fidelity: null,
      install_command: null,
      detail: `could not check Rotifer Cloud (${reason})`,
    };
  }
}

/** A gene present in this workspace that has nothing to execute. */
export function diagnoseLocalGene(name: string, fidelity: string | null): GeneDiagnosis {
  return {
    name,
    status: "metadata_only",
    fidelity,
    install_command: null,
    detail: `installed here (${fidelity ?? "no fidelity declared"}) with no runnable code`,
  };
}
