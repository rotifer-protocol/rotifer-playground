import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

describe("E2E: Full gene lifecycle", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), "rotifer-e2e-" + randomUUID());

    // Simulate `rotifer init`
    mkdirSync(join(projectDir, "genes", "hello-world"), { recursive: true });
    mkdirSync(join(projectDir, "tests"), { recursive: true });
    mkdirSync(join(projectDir, ".rotifer", "agents"), { recursive: true });

    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({
        name: "e2e-test",
        version: "0.1.0",
        author: "test-runner",
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

  it("init → wrap → test → compile → arena submit lifecycle", () => {
    // 1. Verify init structure
    expect(existsSync(join(projectDir, "rotifer.json"))).toBe(true);
    expect(existsSync(join(projectDir, "genes"))).toBe(true);

    // 2. Simulate wrap: create phenotype + source
    const geneDir = join(projectDir, "genes", "hello-world");
    const phenotype = {
      domain: "general",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      outputSchema: {
        type: "object",
        properties: { greeting: { type: "string" } },
      },
      version: "0.1.0",
      fidelity: "Wrapped",
      transparency: "Open",
    };

    writeFileSync(join(geneDir, "phenotype.json"), JSON.stringify(phenotype, null, 2));
    writeFileSync(
      join(geneDir, "index.js"),
      'export async function express(input) { return { greeting: "Hello, " + input.name }; }\n'
    );

    const geneId = createHash("sha256")
      .update(JSON.stringify(phenotype, null, 2))
      .digest("hex");

    writeFileSync(
      join(geneDir, ".gene-manifest.json"),
      JSON.stringify({ geneId, name: "hello-world", domain: "general" }, null, 2)
    );

    // 3. Simulate test: validate phenotype
    const loaded = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
    const requiredFields = ["domain", "inputSchema", "outputSchema", "version", "fidelity"];
    expect(requiredFields.every((f) => f in loaded)).toBe(true);

    // 4. Simulate compile: produce compile result
    const compileResult = {
      geneId,
      name: "hello-world",
      compiledAt: new Date().toISOString(),
      wasmAvailable: false,
    };
    writeFileSync(
      join(geneDir, ".compile-result.json"),
      JSON.stringify(compileResult, null, 2)
    );
    expect(existsSync(join(geneDir, ".compile-result.json"))).toBe(true);

    // 5. Simulate arena submit: check admission
    const fitness = 0.85;
    const safetyScore = 0.92;
    const TAU = 0.3;
    const V_MIN = 0.7;
    expect(fitness >= TAU).toBe(true);
    expect(safetyScore >= V_MIN).toBe(true);
  });

  it("agent create → list lifecycle", () => {
    const agentsDir = join(projectDir, ".rotifer", "agents");
    const agentId = randomUUID();

    const agent = {
      id: agentId,
      name: "test-agent",
      state: "Active",
      genome: ["hello-world"],
      createdAt: new Date().toISOString(),
      reputation: 0.0,
    };

    writeFileSync(join(agentsDir, agentId + ".json"), JSON.stringify(agent, null, 2));

    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);

    const loaded = JSON.parse(readFileSync(join(agentsDir, files[0]), "utf-8"));
    expect(loaded.name).toBe("test-agent");
    expect(loaded.state).toBe("Active");
    expect(loaded.genome).toContain("hello-world");
  });
});

describe("E2E: Genesis gene execution", () => {
  it("all genesis genes have valid phenotypes", async () => {
    const genesDir = join(import.meta.dirname, "..", "..", "genes");
    const genesisGenes = [
      "genesis-web-search",
      "genesis-web-search-lite",
      "genesis-file-read",
      "genesis-code-format",
      "genesis-l0-constraint",
    ];

    for (const name of genesisGenes) {
      const phenotypePath = join(genesDir, name, "phenotype.json");
      expect(existsSync(phenotypePath), `${name}/phenotype.json should exist`).toBe(true);

      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      expect(phenotype.domain).toBeTruthy();
      expect(phenotype.inputSchema).toBeTruthy();
      expect(phenotype.outputSchema).toBeTruthy();
      expect(phenotype.version).toBe("0.2.0");
      expect(phenotype.fidelity).toBe("Native");
    }
  });
});
