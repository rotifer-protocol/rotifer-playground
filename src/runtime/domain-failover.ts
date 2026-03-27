/**
 * Domain-Based Gene Failover Engine
 *
 * L2 Calibration auto-failover: when a gene fails, try the next-best
 * gene in the same domain, ranked by running fitness score.
 *
 * Ported from experiments/api-apocalypse/rotifer-agent.ts into the
 * production runtime. Works with both WASM sandbox and Node.js execution.
 */

export interface GeneExecutor {
  (input: unknown): Promise<GeneExecutionResult>;
}

export interface GeneExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  engine: string;
  durationMs: number;
  fuelConsumed?: number;
}

export interface PoolEntry {
  name: string;
  domain: string;
  executor: GeneExecutor;
  fitness: number;
  successes: number;
  failures: number;
}

export interface FailoverResult {
  domain: string;
  status: "success" | "all_failed";
  output?: unknown;
  geneUsed?: string;
  switchedFrom?: string;
  attempts: number;
  durationMs: number;
}

const FITNESS_INITIAL = 0.5;
const FITNESS_REWARD = 0.05;
const FITNESS_PENALTY = 0.15;
const FITNESS_CEILING = 1.0;
const FITNESS_FLOOR = 0.0;

export class DomainFailoverEngine {
  private pools: Map<string, PoolEntry[]> = new Map();
  private activeGenes: Map<string, string> = new Map();

  registerGene(name: string, domain: string, executor: GeneExecutor): void {
    if (!this.pools.has(domain)) {
      this.pools.set(domain, []);
    }
    this.pools.get(domain)!.push({
      name,
      domain,
      executor,
      fitness: FITNESS_INITIAL,
      successes: 0,
      failures: 0,
    });
  }

  initialize(): void {
    for (const [domain, genes] of this.pools) {
      if (genes.length > 0 && !this.activeGenes.has(domain)) {
        this.activeGenes.set(domain, genes[0].name);
      }
    }
  }

  loadFitnessState(state: Record<string, { fitness: number; successes: number; failures: number }>): void {
    for (const [name, s] of Object.entries(state)) {
      const entry = this.findGene(name);
      if (entry) {
        entry.fitness = s.fitness;
        entry.successes = s.successes;
        entry.failures = s.failures;
      }
    }
    for (const [domain] of this.pools) {
      const ranked = this.getByDomain(domain);
      if (ranked.length > 0) {
        this.activeGenes.set(domain, ranked[0].name);
      }
    }
  }

  exportFitnessState(): Record<string, { fitness: number; successes: number; failures: number }> {
    const state: Record<string, { fitness: number; successes: number; failures: number }> = {};
    for (const genes of this.pools.values()) {
      for (const g of genes) {
        state[g.name] = {
          fitness: Math.round(g.fitness * 1000) / 1000,
          successes: g.successes,
          failures: g.failures,
        };
      }
    }
    return state;
  }

  getDomains(): string[] {
    return Array.from(this.pools.keys());
  }

  getPoolSize(domain: string): number {
    return this.pools.get(domain)?.length ?? 0;
  }

  getActiveGene(domain: string): string | undefined {
    return this.activeGenes.get(domain);
  }

  async executeDomain(domain: string, input: unknown): Promise<FailoverResult> {
    const startTime = performance.now();
    const pool = this.pools.get(domain);

    if (!pool || pool.length === 0) {
      return {
        domain,
        status: "all_failed",
        attempts: 0,
        durationMs: performance.now() - startTime,
      };
    }

    const activeName = this.activeGenes.get(domain) ?? pool[0].name;
    const activeGene = this.findGene(activeName);

    if (!activeGene) {
      return {
        domain,
        status: "all_failed",
        attempts: 0,
        durationMs: performance.now() - startTime,
      };
    }

    const result = await activeGene.executor(input);

    if (result.success) {
      this.reward(activeGene);
      return {
        domain,
        status: "success",
        output: result.output,
        geneUsed: activeName,
        attempts: 1,
        durationMs: performance.now() - startTime,
      };
    }

    this.penalize(activeGene);

    const candidates = this.getByDomain(domain).filter(
      (g) => g.name !== activeName
    );

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const altResult = await candidate.executor(input);

      if (altResult.success) {
        this.reward(candidate);
        this.activeGenes.set(domain, candidate.name);
        return {
          domain,
          status: "success",
          output: altResult.output,
          geneUsed: candidate.name,
          switchedFrom: activeName,
          attempts: i + 2,
          durationMs: performance.now() - startTime,
        };
      }

      this.penalize(candidate);
    }

    return {
      domain,
      status: "all_failed",
      attempts: candidates.length + 1,
      durationMs: performance.now() - startTime,
    };
  }

  async executeAll(input: unknown): Promise<FailoverResult[]> {
    const domains = this.getDomains();
    return Promise.all(domains.map((d) => this.executeDomain(d, input)));
  }

  private getByDomain(domain: string): PoolEntry[] {
    return (this.pools.get(domain) ?? []).sort(
      (a, b) => b.fitness - a.fitness
    );
  }

  private findGene(name: string): PoolEntry | undefined {
    for (const genes of this.pools.values()) {
      const found = genes.find((g) => g.name === name);
      if (found) return found;
    }
    return undefined;
  }

  private reward(gene: PoolEntry): void {
    gene.successes++;
    gene.fitness = Math.min(FITNESS_CEILING, gene.fitness + FITNESS_REWARD);
  }

  private penalize(gene: PoolEntry): void {
    gene.failures++;
    gene.fitness = Math.max(FITNESS_FLOOR, gene.fitness - FITNESS_PENALTY);
  }
}
