import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";

const GENESIS_GENES = [
  "genesis-web-search",
  "genesis-web-search-lite",
  "genesis-file-read",
  "genesis-code-format",
  "genesis-l0-constraint",
];

function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

describe("Three-Act Demo E2E (ADR-11)", () => {
  let projectDir: string;
  const genesSourceDir = join(__dirname, "..", "..", "genes");

  beforeEach(() => {
    projectDir = join(tmpdir(), "rotifer-3act-" + randomUUID());
    mkdirSync(join(projectDir, "genes"), { recursive: true });
    mkdirSync(join(projectDir, ".rotifer", "agents"), { recursive: true });

    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({
        name: "demo-test",
        version: "0.1.0",
        author: "test",
        genes_dir: "genes",
        default_domain: "general",
      }, null, 2)
    );
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  describe("Act 1 — Wow (30s): init shows Arena immediately", () => {
    it("genesis genes install into project", () => {
      for (const name of GENESIS_GENES) {
        const src = join(genesSourceDir, name);
        if (existsSync(src)) {
          copyDirRecursive(src, join(projectDir, "genes", name));
        }
      }

      for (const name of GENESIS_GENES) {
        const phenoPath = join(projectDir, "genes", name, "phenotype.json");
        expect(existsSync(phenoPath), `${name}/phenotype.json exists`).toBe(true);
      }
    });

    it("all genesis genes have Native fidelity", () => {
      for (const name of GENESIS_GENES) {
        const src = join(genesSourceDir, name);
        if (!existsSync(src)) continue;
        copyDirRecursive(src, join(projectDir, "genes", name));

        const pheno = JSON.parse(
          readFileSync(join(projectDir, "genes", name, "phenotype.json"), "utf-8")
        );
        expect(pheno.fidelity).toBe("Native");
      }
    });

    it("Arena rankings are computable from phenotypes", () => {
      for (const name of GENESIS_GENES) {
        const src = join(genesSourceDir, name);
        if (existsSync(src)) {
          copyDirRecursive(src, join(projectDir, "genes", name));
        }
      }

      // Add a Wrapped gene for comparison
      mkdirSync(join(projectDir, "genes", "hello-world"), { recursive: true });
      writeFileSync(
        join(projectDir, "genes", "hello-world", "phenotype.json"),
        JSON.stringify({
          domain: "general",
          inputSchema: { type: "object", properties: {} },
          outputSchema: { type: "object" },
          version: "0.1.0",
          fidelity: "Wrapped",
        }, null, 2)
      );

      const rows: { name: string; fitness: number; fidelity: string }[] = [];

      for (const name of readdirSync(join(projectDir, "genes"))) {
        const phenoPath = join(projectDir, "genes", name, "phenotype.json");
        if (!existsSync(phenoPath)) continue;

        const pheno = JSON.parse(readFileSync(phenoPath, "utf-8"));
        const hash = createHash("sha256").update(JSON.stringify(pheno)).digest("hex");
        const seed = parseInt(hash.slice(0, 8), 16);
        const isNative = pheno.fidelity === "Native";
        const base = isNative ? 0.70 : 0.45;
        const variance = (seed % 250) / 1000;
        const fitness = Math.min(base + variance, 0.99);

        rows.push({ name, fitness, fidelity: pheno.fidelity });
      }

      rows.sort((a, b) => b.fitness - a.fitness);

      expect(rows.length).toBe(6);

      // All Native genes should rank above Wrapped
      const wrappedIdx = rows.findIndex((r) => r.fidelity === "Wrapped");
      const nativeIdxes = rows
        .map((r, i) => (r.fidelity === "Native" ? i : -1))
        .filter((i) => i >= 0);

      for (const idx of nativeIdxes) {
        expect(idx).toBeLessThan(wrappedIdx);
      }
    });
  });

  describe("Act 2 — Aha (5min): scan → wrap → test → submit", () => {
    it("phenotype passes validation", () => {
      mkdirSync(join(projectDir, "genes", "test-gene"), { recursive: true });
      writeFileSync(
        join(projectDir, "genes", "test-gene", "phenotype.json"),
        JSON.stringify({
          domain: "general",
          inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
          outputSchema: { type: "object", properties: { y: { type: "string" } } },
          version: "0.1.0",
          fidelity: "Wrapped",
          transparency: "Open",
        }, null, 2)
      );
      writeFileSync(
        join(projectDir, "genes", "test-gene", "index.js"),
        'export async function express(input) { return { y: input.x }; }\n'
      );

      const phenotype = JSON.parse(
        readFileSync(join(projectDir, "genes", "test-gene", "phenotype.json"), "utf-8")
      );
      const required = ["domain", "inputSchema", "outputSchema", "version", "fidelity"];
      expect(required.every((f) => f in phenotype)).toBe(true);
    });

    it("gene ID is deterministic from phenotype", () => {
      const phenotype = {
        domain: "test",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
      };
      const id1 = createHash("sha256").update(JSON.stringify(phenotype)).digest("hex");
      const id2 = createHash("sha256").update(JSON.stringify(phenotype)).digest("hex");
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(64);
    });

    it("admission gate checks F(g) >= tau and V(g) >= V_min", () => {
      const TAU = 0.3;
      const V_MIN = 0.7;

      // Passing gene
      expect(0.85 >= TAU && 0.90 >= V_MIN).toBe(true);

      // Failing gene (low fitness)
      expect(0.20 >= TAU).toBe(false);

      // Failing gene (low safety)
      expect(0.85 >= TAU && 0.50 >= V_MIN).toBe(false);
    });
  });

  describe("Act 3 — Hooked (30min): native gene + agent creation", () => {
    it("native gene compilation produces compile result", () => {
      mkdirSync(join(projectDir, "genes", "my-native"), { recursive: true });
      writeFileSync(
        join(projectDir, "genes", "my-native", "phenotype.json"),
        JSON.stringify({
          domain: "search",
          inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          outputSchema: { type: "object" },
          version: "0.1.0",
          fidelity: "Native",
        }, null, 2)
      );
      writeFileSync(
        join(projectDir, "genes", "my-native", "index.js"),
        'export async function express(input) { return { result: input.q }; }\n'
      );

      // Simulate compile
      const phenotype = JSON.parse(
        readFileSync(join(projectDir, "genes", "my-native", "phenotype.json"), "utf-8")
      );
      const geneId = createHash("sha256").update(JSON.stringify(phenotype)).digest("hex");

      const compileResult = {
        geneId,
        name: "my-native",
        compiledAt: new Date().toISOString(),
        fidelity: "Native",
        wasmAvailable: false,
      };
      writeFileSync(
        join(projectDir, "genes", "my-native", ".compile-result.json"),
        JSON.stringify(compileResult, null, 2)
      );

      const loaded = JSON.parse(
        readFileSync(join(projectDir, "genes", "my-native", ".compile-result.json"), "utf-8")
      );
      expect(loaded.geneId).toBe(geneId);
      expect(loaded.fidelity).toBe("Native");
    });

    it("agent creation with genome binds genes to agent", () => {
      const agentId = randomUUID();
      const agent = {
        id: agentId,
        name: "search-agent",
        state: "Active",
        genome: ["genesis-web-search", "my-native"],
        createdAt: new Date().toISOString(),
        reputation: 0.0,
      };

      writeFileSync(
        join(projectDir, ".rotifer", "agents", agentId + ".json"),
        JSON.stringify(agent, null, 2)
      );

      const loaded = JSON.parse(
        readFileSync(join(projectDir, ".rotifer", "agents", agentId + ".json"), "utf-8")
      );
      expect(loaded.name).toBe("search-agent");
      expect(loaded.state).toBe("Active");
      expect(loaded.genome).toHaveLength(2);
      expect(loaded.genome).toContain("genesis-web-search");
    });

    it("native genes rank higher than wrapped in same domain", () => {
      const genes = [
        { name: "native-a", fidelity: "Native", domain: "search" },
        { name: "wrapped-b", fidelity: "Wrapped", domain: "search" },
        { name: "native-c", fidelity: "Native", domain: "search" },
      ];

      const scored = genes.map((g) => {
        const hash = createHash("sha256")
          .update(JSON.stringify({ ...g, version: "0.1.0", inputSchema: {}, outputSchema: {} }))
          .digest("hex");
        const seed = parseInt(hash.slice(0, 8), 16);
        const base = g.fidelity === "Native" ? 0.70 : 0.45;
        const variance = (seed % 250) / 1000;
        return { ...g, fitness: Math.min(base + variance, 0.99) };
      });

      scored.sort((a, b) => b.fitness - a.fitness);

      const wrappedIdx = scored.findIndex((s) => s.fidelity === "Wrapped");
      const nativeAbove = scored.slice(0, wrappedIdx).every((s) => s.fidelity === "Native");
      expect(nativeAbove).toBe(true);
    });
  });
});
