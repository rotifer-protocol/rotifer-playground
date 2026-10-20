import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { AgentRecord } from "../../src/commands/agent-create.js";

/** Deterministic stand-in for the native v2 gene ID (sha256 of the name). */
export function fakeV2(name: string): string {
  return "v2:" + createHash("sha256").update(name).digest("hex");
}

export interface GeneFixture {
  fidelity?: string;
  domain?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Registry manifest as `install` writes it; omit for a local-only gene. */
  manifest?: Record<string, unknown>;
}

export function writeGene(root: string, name: string, fx: GeneFixture = {}): void {
  const dir = join(root, "genes", name);
  mkdirSync(dir, { recursive: true });
  const phenotype: Record<string, unknown> = {
    name,
    version: "0.1.0",
    fidelity: fx.fidelity ?? "Native",
    inputSchema: fx.inputSchema ?? { type: "object", properties: { text: { type: "string" } } },
    outputSchema: fx.outputSchema ?? { type: "object", properties: { result: { type: "string" } } },
  };
  if (fx.domain !== "") phenotype.domain = fx.domain ?? "text.transform";
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify(phenotype, null, 2));
  if (fx.manifest) writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify(fx.manifest, null, 2));
}

export function writeAgent(
  root: string,
  name: string,
  genome: string[],
  composition: Record<string, unknown> | string,
): AgentRecord {
  const agent = {
    id: randomUUID(),
    name,
    state: "Active",
    genome,
    composition,
    strategy: "manual",
    createdAt: "2026-10-20T00:00:00.000Z",
    reputation: 0,
  } as AgentRecord;
  const dir = join(root, ".rotifer", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent.id}.json`), JSON.stringify(agent, null, 2));
  return agent;
}

/** Collect everything the command prints, on every channel it uses. */
export function captureOutput(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const push = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  const log = vi.spyOn(console, "log").mockImplementation(push);
  const err = vi.spyOn(console, "error").mockImplementation(push);
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return {
    text: () => chunks.join("\n"),
    restore: () => {
      log.mockRestore();
      err.mockRestore();
      out.mockRestore();
    },
  };
}
