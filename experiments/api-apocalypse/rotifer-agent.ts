/**
 * Rotifer Agent — Evolutionary Failover
 *
 * The core innovation: when a gene fails, the agent automatically
 * switches to the next-best gene in the same domain, ranked by
 * running fitness score. This is the L2 Calibration auto-failover
 * mechanism that Rotifer Protocol specifies but hasn't had a
 * runtime implementation until now.
 */

import type { WeatherParserInput, WeatherParserOutput } from "./genes/types.js";

type ExpressFn = (input: WeatherParserInput) => Promise<WeatherParserOutput>;

interface GeneEntry {
  name: string;
  domain: string;
  express: ExpressFn;
  fitness: number;
  successes: number;
  failures: number;
}

export interface TickResult {
  tick: number;
  timestampMs: number;
  elapsedSec: number;
  sources: Record<
    string,
    {
      status: "success" | "fetch_error" | "parse_error" | "no_gene";
      temperature?: number;
      geneUsed?: string;
      switchedFrom?: string;
      error?: string;
      latencyMs: number;
    }
  >;
  aggregatedTemperature?: number;
  successfulSources: number;
}

const FITNESS_INITIAL = 0.5;
const FITNESS_REWARD = 0.05;
const FITNESS_PENALTY = 0.15;
const FITNESS_FLOOR = 0.0;
const FITNESS_CEILING = 1.0;

export class RotiferAgent {
  private genePool: Map<string, GeneEntry[]> = new Map();
  private activeGenes: Map<string, string> = new Map();
  private startTime = 0;
  private tickCount = 0;

  registerGene(name: string, domain: string, expressFn: ExpressFn): void {
    if (!this.genePool.has(domain)) {
      this.genePool.set(domain, []);
    }
    this.genePool.get(domain)!.push({
      name,
      domain,
      express: expressFn,
      fitness: FITNESS_INITIAL,
      successes: 0,
      failures: 0,
    });
  }

  start(): void {
    this.startTime = Date.now();
    this.tickCount = 0;
    for (const [domain, genes] of this.genePool) {
      this.activeGenes.set(domain, genes[0].name);
    }
  }

  private getGenesByDomain(domain: string): GeneEntry[] {
    return (this.genePool.get(domain) ?? []).sort(
      (a, b) => b.fitness - a.fitness
    );
  }

  private getGene(name: string): GeneEntry | undefined {
    for (const genes of this.genePool.values()) {
      const found = genes.find((g) => g.name === name);
      if (found) return found;
    }
    return undefined;
  }

  private updateFitness(gene: GeneEntry, success: boolean): void {
    if (success) {
      gene.successes++;
      gene.fitness = Math.min(
        FITNESS_CEILING,
        gene.fitness + FITNESS_REWARD
      );
    } else {
      gene.failures++;
      gene.fitness = Math.max(
        FITNESS_FLOOR,
        gene.fitness - FITNESS_PENALTY
      );
    }
  }

  async tick(
    fetchData: (source: string) => Promise<string>
  ): Promise<TickResult> {
    this.tickCount++;
    const tickStart = Date.now();

    const sources: TickResult["sources"] = {};
    const temperatures: number[] = [];

    for (const [domain] of this.genePool) {
      const sourceId = domain.split(".").pop()!;
      const callStart = Date.now();

      let rawData: string;
      try {
        rawData = await fetchData(sourceId);
      } catch (err: any) {
        sources[sourceId] = {
          status: "fetch_error",
          error: err.message,
          latencyMs: Date.now() - callStart,
        };
        continue;
      }

      const activeName = this.activeGenes.get(domain)!;
      const activeGene = this.getGene(activeName)!;
      const input: WeatherParserInput = { rawData, source: sourceId };

      try {
        const result = await activeGene.express(input);
        this.updateFitness(activeGene, true);
        temperatures.push(result.temperature);
        sources[sourceId] = {
          status: "success",
          temperature: result.temperature,
          geneUsed: activeName,
          latencyMs: Date.now() - callStart,
        };
      } catch (primaryErr: any) {
        this.updateFitness(activeGene, false);

        // --- CORE INNOVATION: Domain-level fitness-ordered failover ---
        const candidates = this.getGenesByDomain(domain).filter(
          (g) => g.name !== activeName
        );

        let recovered = false;
        for (const candidate of candidates) {
          try {
            const result = await candidate.express(input);
            this.updateFitness(candidate, true);
            this.activeGenes.set(domain, candidate.name);
            temperatures.push(result.temperature);
            sources[sourceId] = {
              status: "success",
              temperature: result.temperature,
              geneUsed: candidate.name,
              switchedFrom: activeName,
              latencyMs: Date.now() - callStart,
            };
            recovered = true;
            break;
          } catch {
            this.updateFitness(candidate, false);
          }
        }

        if (!recovered) {
          sources[sourceId] = {
            status: "parse_error",
            geneUsed: activeName,
            error: primaryErr.message,
            latencyMs: Date.now() - callStart,
          };
        }
      }
    }

    const aggregatedTemperature =
      temperatures.length > 0
        ? Math.round(
            (temperatures.reduce((a, b) => a + b, 0) / temperatures.length) * 10
          ) / 10
        : undefined;

    return {
      tick: this.tickCount,
      timestampMs: Date.now(),
      elapsedSec: Math.round((Date.now() - this.startTime) / 1000),
      sources,
      aggregatedTemperature,
      successfulSources: temperatures.length,
    };
  }

  getGeneStats(): Record<string, { fitness: number; successes: number; failures: number }> {
    const stats: Record<string, { fitness: number; successes: number; failures: number }> = {};
    for (const genes of this.genePool.values()) {
      for (const g of genes) {
        stats[g.name] = {
          fitness: Math.round(g.fitness * 1000) / 1000,
          successes: g.successes,
          failures: g.failures,
        };
      }
    }
    return stats;
  }
}
