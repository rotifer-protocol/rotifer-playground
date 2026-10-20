import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  geneIdV2: vi.fn(),
}));

import { geneIdV2 } from "../../src/utils/binding.js";
import { setOutputMode } from "../../src/utils/display.js";
import {
  runGenomeExport,
  scanBlueprint,
  scanForCredentials,
  shannonEntropy,
  type GenomeBlueprint,
} from "../../src/commands/genome.js";
import { captureOutput, fakeV2, writeAgent, writeGene } from "./genome-test-helpers.js";

// Every fake below is obviously fake and assembled at run time, so no
// credential-shaped literal sits in the source for scanners to trip on.
const FAKE_HEX_KEY = "deadbeef".repeat(8); // 64 hex chars — the shape of a 32-byte private key
const FAKE_HEX_KEY_0X = "0x" + FAKE_HEX_KEY;
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"; // AWS's documented example key
const FAKE_STRIPE_KEY = "sk_" + "live_" + "0".repeat(24);
const FAKE_OPENAI_KEY = "sk-" + "proj-" + "0".repeat(48);
const FAKE_JWT = ["eyJ" + "A".repeat(20), "eyJ" + "B".repeat(20), "C".repeat(20)].join(".");
const FAKE_BASE64_KEY = "A".repeat(43) + "=";
// 24 distinct characters → log2(24) ≈ 4.58 bits/char, above the 4.5 threshold.
const FAKE_HIGH_ENTROPY = "Zq8#mP2$vL9!xR4&kT7*wN1@";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `bp-scan-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  vi.mocked(geneIdV2).mockImplementation((_genesRoot, name) => ({ id: fakeV2(name) }));
  writeGene(root, "alpha", { manifest: { owner: "alice", version: "1.0.0" } });
  writeGene(root, "beta", { manifest: { owner: "bob", version: "1.0.0" } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(geneIdV2).mockReset();
  setOutputMode("human");
});

function exportAgent(ref: string, opts: Record<string, unknown> = {}) {
  const out = captureOutput();
  const file = join(root, `${randomUUID()}.rgenome`);
  try {
    const code = runGenomeExport(ref, { output: file, ...opts }, { root, genesDir: "genes" });
    return { code, written: existsSync(file), file, text: out.text() };
  } finally {
    out.restore();
  }
}

/** A minimal valid Blueprint to plant values into. */
function blueprint(): GenomeBlueprint {
  return {
    blueprintFormat: 1,
    protocolVersion: { major: 0, minor: 9, patch: 2, supportedFeatures: ["GENE_COMPOSITION_ALGEBRA"] },
    snapshot: {
      genes: [{ geneId: fakeV2("alpha"), role: "alpha", optional: false }],
      composition: { Gene: { geneRef: { geneId: fakeV2("alpha"), role: "alpha", optional: false } } },
      snapshotAt: "2026-10-20T00:00:00.000Z",
    },
    metadata: { name: "demo", createdAt: "2026-10-20T00:00:00.000Z" },
  };
}

describe("#29-c layer ① key names", () => {
  it("a credential-named field holding a string is blocked (export aborts, value not echoed)", () => {
    writeGene(root, "keyed", {
      inputSchema: { type: "object", examples: [{ apiKey: "not-a-real-key-000" }] },
    });
    writeAgent(root, "keyed-agent", ["keyed"], { type: "Single" });
    const { code, written, text } = exportAgent("keyed-agent");
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).toContain("/capabilities/keyed/inputSchemaCompat/examples/0/apiKey");
    expect(text).toContain("[key-name]");
    expect(text).not.toContain("not-a-real-key-000");
  });

  it("a schema that merely declares an apiKey parameter is not blocked", () => {
    writeGene(root, "declares", {
      inputSchema: {
        type: "object",
        properties: { apiKey: { type: "string", description: "Your provider key" } },
        required: ["apiKey"],
      },
    });
    writeAgent(root, "declares-agent", ["declares"], { type: "Single" });
    const { code, written } = exportAgent("declares-agent");
    expect(code).toBe(0);
    expect(written).toBe(true);
  });

  it("matches the whole name or its suffix, case and separators ignored", () => {
    const hits = scanForCredentials({ GITHUB_TOKEN: "x", dbPassword: "y", client_secret: "z" });
    expect(hits.map((h) => h.pointer).sort()).toEqual(["/GITHUB_TOKEN", "/client_secret", "/dbPassword"]);
    expect(scanForCredentials({ maxTokens: "100", tokenizer: "bpe", apiKey: "" })).toEqual([]);
  });
});

describe("#29-c layer ② value patterns", () => {
  it("bare hex private key (no prefix) in metadata.description → blocked, value not echoed", () => {
    writeAgent(root, "hex-desc", ["alpha"], { type: "Single" });
    const { code, written, text } = exportAgent("hex-desc", { description: `backup ${FAKE_HEX_KEY}` });
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).toContain("/metadata/description");
    expect(text).toContain("Bare 32-byte hex key");
    expect(text).not.toContain(FAKE_HEX_KEY);
  });

  it("bare hex private key with 0x prefix in metadata.description → blocked", () => {
    writeAgent(root, "hex0x-desc", ["alpha"], { type: "Single" });
    const { code, written, text } = exportAgent("hex0x-desc", { description: FAKE_HEX_KEY_0X });
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).not.toContain(FAKE_HEX_KEY);
  });

  it("the same hex as the v2 geneId at /snapshot/genes/0/geneId → not blocked", () => {
    vi.mocked(geneIdV2).mockImplementation(() => ({ id: "v2:" + FAKE_HEX_KEY }));
    writeAgent(root, "hex-geneid", ["alpha"], { type: "Single" });
    const { code, written, file } = exportAgent("hex-geneid");
    expect(code).toBe(0);
    expect(written).toBe(true);
    const bp = JSON.parse(readFileSync(file, "utf-8")) as GenomeBlueprint;
    expect(bp.snapshot.genes[0].geneId).toBe("v2:" + FAKE_HEX_KEY);
  });

  it("the same hex as metadata.name → blocked", () => {
    writeAgent(root, FAKE_HEX_KEY, ["alpha"], { type: "Single" });
    const { code, written, text } = exportAgent(FAKE_HEX_KEY);
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).toContain("/metadata/name");
    // The agent lookup echoes nothing either: the only place the value could appear.
    expect(text).not.toContain(FAKE_HEX_KEY);
  });

  it("hex exemption is by position and hash shape only", () => {
    const planted = (mutate: (bp: GenomeBlueprint) => void) => {
      const bp = blueprint();
      mutate(bp);
      return scanBlueprint(bp).filter((f) => f.rule === "Bare 32-byte hex key").map((f) => f.pointer);
    };
    // Exempt: a geneId in snapshot.genes, an excludeGeneIds entry, a composition leaf repeating a listed ID.
    expect(planted((bp) => { bp.snapshot.genes[0].geneId = "v2:" + FAKE_HEX_KEY; })).toEqual([
      "/snapshot/composition/Gene/geneRef/geneId", // leaf still holds alpha's ID, which is no longer listed
    ]);
    expect(planted(() => {})).toEqual([]);
    expect(
      planted((bp) => {
        bp.capabilities = {
          alpha: { domain: "d", inputSchemaCompat: {}, outputSchemaCompat: {}, minFitness: 0.3, excludeGeneIds: ["v2:" + FAKE_HEX_KEY] },
        };
      }),
    ).toEqual([]);
    // Not exempt: bare hex (no v2: prefix) even at the geneId position, and every other field.
    expect(planted((bp) => { bp.snapshot.genes[0].geneId = FAKE_HEX_KEY; })).toContain("/snapshot/genes/0/geneId");
    expect(planted((bp) => { bp.snapshot.genes[0].role = FAKE_HEX_KEY; })).toEqual(["/snapshot/genes/0/role"]);
    expect(
      planted((bp) => {
        bp.resolutionHints = { alpha: { owner: "o", name: "alpha", version: FAKE_HEX_KEY_0X, fidelity: "Native" } };
      }),
    ).toEqual(["/resolutionHints/alpha/version"]);
  });

  it("the shared publish patterns (AWS, Stripe, OpenAI, JWT) and bare Base64 keys are blocked", () => {
    const cases: Array<[string, string]> = [
      [FAKE_AWS_KEY, "AWS key"],
      [FAKE_STRIPE_KEY, "Stripe live key"],
      [FAKE_OPENAI_KEY, "OpenAI key"],
      [FAKE_JWT, "JWT"],
      [FAKE_BASE64_KEY, "Bare Base64 key (32/64 bytes)"],
    ];
    for (const [value, rule] of cases) {
      const bp = blueprint();
      bp.metadata.description = `see ${value}`;
      const findings = scanBlueprint(bp);
      expect(findings).toContainEqual({ pointer: "/metadata/description", layer: "value-pattern", rule });
    }
  });

  it("Base64 rule fires only for 43–44 and 86–88 character runs", () => {
    const b64 = (n: number) => scanForCredentials({ v: "B".repeat(n) }).some((f) => f.rule.startsWith("Bare Base64"));
    expect([42, 43, 44, 45, 85, 86, 88, 89].map(b64)).toEqual([false, true, true, false, false, true, true, false]);
  });
});

describe("#29-c layer ③ entropy", () => {
  it("a high-entropy token over 20 characters is blocked", () => {
    expect(shannonEntropy(FAKE_HIGH_ENTROPY)).toBeGreaterThan(4.5);
    writeAgent(root, "entropy", ["alpha"], { type: "Single" });
    const { code, written, text } = exportAgent("entropy", { description: `pass ${FAKE_HIGH_ENTROPY}` });
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).toContain("[entropy]");
    expect(text).not.toContain(FAKE_HIGH_ENTROPY);
  });

  it("ordinary prose and hex never trip the entropy layer", () => {
    expect(shannonEntropy(FAKE_HEX_KEY)).toBeLessThanOrEqual(4);
    const findings = scanForCredentials({
      d: "Cleans incoming support tickets, then summarizes them into three bullet points for triage.",
    });
    expect(findings).toEqual([]);
  });
});

describe("#29-c reporting", () => {
  it("--json reports pointer and layer, never the value, and exits 1", () => {
    setOutputMode("json");
    writeAgent(root, "json-agent", ["alpha"], { type: "Single" });
    const { code, written, text } = exportAgent("json-agent", { description: FAKE_HEX_KEY });
    expect(code).toBe(1);
    expect(written).toBe(false);
    const parsed = JSON.parse(text) as { ok: boolean; findings: Array<{ pointer: string; layer: string }> };
    expect(parsed.ok).toBe(false);
    expect(parsed.findings).toContainEqual({
      pointer: "/metadata/description",
      layer: "value-pattern",
      rule: "Bare 32-byte hex key",
    });
    expect(text).not.toContain(FAKE_HEX_KEY);
  });

  it("a clean Blueprint passes and is written", () => {
    writeAgent(root, "clean", ["alpha", "beta"], { type: "Seq" });
    const { code, written } = exportAgent("clean", { description: "Two-step demo" });
    expect(code).toBe(0);
    expect(written).toBe(true);
  });
});
