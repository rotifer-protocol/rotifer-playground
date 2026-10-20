import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

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
// Random-looking Base64 of 32 and 64 bytes, derived from a fixed test string — not key material.
const FAKE_BASE64_KEY_32 = createHash("sha256").update("rotifer-test-fixed-seed").digest("base64");
const FAKE_BASE64_KEY_64 = createHash("sha512").update("rotifer-test-fixed-seed").digest("base64");
/** n characters drawn from the Base64 alphabet, deterministic and random-looking. */
const base64Run = (n: number) =>
  [1, 2, 3].map((i) => createHash("sha512").update(`run-${i}`).digest("base64").replace(/=+$/, "")).join("").slice(0, n);
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
      [FAKE_BASE64_KEY_32, "Bare Base64 key (32/64 bytes)"],
      [FAKE_BASE64_KEY_64, "Bare Base64 key (32/64 bytes)"],
    ];
    for (const [value, rule] of cases) {
      const bp = blueprint();
      bp.metadata.description = `see ${value}`;
      const findings = scanBlueprint(bp);
      expect(findings).toContainEqual({ pointer: "/metadata/description", layer: "value-pattern", rule });
    }
  });

  it("Base64 rule fires only for 43–44 and 86–88 character runs", () => {
    const b64 = (n: number) => scanForCredentials({ v: base64Run(n) }).some((f) => f.rule.startsWith("Bare Base64"));
    expect([42, 43, 44, 45, 85, 86, 88, 89].map(b64)).toEqual([false, true, true, false, false, true, true, false]);
  });

  it("path text of key length is not mistaken for a Base64 key", () => {
    // The acceptance probe: the `/`-joined run is exactly 44 characters.
    const probe = "Pipeline reads docs/protocol/specification/genome/blueprint";
    expect("docs/protocol/specification/genome/blueprint").toHaveLength(44);
    for (const text of [probe, "see Docs/Protocol/Specification/Genome/Blueprint2"]) {
      expect(scanForCredentials({ d: text }).filter((f) => f.rule.startsWith("Bare Base64"))).toEqual([]);
    }
    writeAgent(root, "path-desc", ["alpha"], { type: "Single" });
    const { code, written } = exportAgent("path-desc", { description: probe });
    expect(code).toBe(0);
    expect(written).toBe(true);
  });

  it("a random 32-byte Base64 key in metadata.description → blocked, value not echoed", () => {
    writeAgent(root, "b64-desc", ["alpha"], { type: "Single" });
    const { code, written, text } = exportAgent("b64-desc", { description: `backup ${FAKE_BASE64_KEY_32}` });
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).toContain("Bare Base64 key (32/64 bytes)");
    expect(text).not.toContain(FAKE_BASE64_KEY_32);
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

// ── Natural-language text and the entropy layer (T-19) ───────────────────
// Real schemas: 73 description strings in 22 of 205 published versions were
// flagged — 71 in Chinese (no spaces, many distinct characters), 2 with
// non-ASCII symbols. Credentials are printable ASCII, so entropy is judged on
// runs of printable ASCII only.

describe("entropy layer: natural-language descriptions are not credentials", () => {
  const ZH = "根据用户提供的合同文本识别风险条款并给出修改建议，输出结构化的审查结果与依据";
  const ZH_MIXED = "支持PDF、DOCX与Markdown三种输入格式，自动识别标题层级并生成目录结构";
  const SYMBOLS = "weight—kept≥0.5→rises≈linearly·until≤0.9±0.05×scale÷n↓drops∑total";

  it("a Chinese description is not flagged", () => {
    expect(shannonEntropy(ZH)).toBeGreaterThan(4.5);
    expect(scanForCredentials({ description: ZH })).toEqual([]);
  });

  it("a Chinese description with English words inside is not flagged", () => {
    expect(scanForCredentials({ description: ZH_MIXED })).toEqual([]);
  });

  it("prose with non-ASCII symbols is not flagged", () => {
    expect(shannonEntropy(SYMBOLS)).toBeGreaterThan(4.5);
    expect(scanForCredentials({ description: SYMBOLS })).toEqual([]);
  });

  it("export of a gene whose schema descriptions are Chinese succeeds", () => {
    writeGene(root, "zh-gene", {
      inputSchema: { type: "object", properties: { text: { type: "string", description: ZH } } },
      outputSchema: { type: "object", properties: { result: { type: "string", description: ZH_MIXED } } },
    });
    writeAgent(root, "zh-agent", ["zh-gene"], { type: "Single" });
    const { code, written } = exportAgent("zh-agent");
    expect(code).toBe(0);
    expect(written).toBe(true);
  });

  it("a high-entropy ASCII secret is still caught on its own, after a space, or glued to Chinese text", () => {
    for (const text of [FAKE_HIGH_ENTROPY, `key ${FAKE_HIGH_ENTROPY}`, `密钥是${FAKE_HIGH_ENTROPY}请妥善保管`, `${ZH}${FAKE_HIGH_ENTROPY}`]) {
      expect(scanForCredentials({ note: text })).toContainEqual(expect.objectContaining({ pointer: "/note", layer: "entropy" }));
    }
  });

  it("the value-pattern rules still catch keys inside Chinese text", () => {
    expect(scanForCredentials({ note: `私钥：${FAKE_HEX_KEY}` })).toContainEqual(
      expect.objectContaining({ rule: "Bare 32-byte hex key" }),
    );
    expect(scanForCredentials({ note: `令牌${FAKE_AWS_KEY}已失效` })).toContainEqual(expect.objectContaining({ rule: "AWS key" }));
  });
});

// ── Red-team findings on the RFC draft (T-10 #1, #8) ─────────────────────

/** 32 bytes of obviously fake key material as a number array (all 0xde/0xad/0xbe/0xef). */
const FAKE_KEY_BYTES = Array.from({ length: 32 }, (_, i) => [0xde, 0xad, 0xbe, 0xef][i % 4]);

describe("#1 a key name that is itself a secret never appears in a finding", () => {
  const leaks = (findings: Array<{ pointer: string; rule: string }>, secret: string) =>
    findings.some((f) => f.pointer.includes(secret) || f.rule.includes(secret));

  it("the key is flagged, but its pointer token is masked", () => {
    const findings = scanForCredentials({ [FAKE_HEX_KEY]: "x" });
    expect(findings.length).toBeGreaterThan(0);
    expect(leaks(findings, FAKE_HEX_KEY)).toBe(false);
    expect(findings[0].pointer).toMatch(/^\/<redacted key #0>$/);
  });

  it("findings below a secret key use the masked token too", () => {
    const findings = scanForCredentials({ outer: { [FAKE_HEX_KEY]: { inner: FAKE_AWS_KEY } } });
    expect(findings.map((f) => f.pointer)).toContain("/outer/<redacted key #0>/inner");
    expect(leaks(findings, FAKE_HEX_KEY)).toBe(false);
  });

  it("ordinary keys, including credential-named ones, stay readable", () => {
    const findings = scanForCredentials({ config: { apiKey: "not-a-real-key-000" } });
    expect(findings.map((f) => f.pointer)).toContain("/config/apiKey");
  });

  it("export: a secret used as a schema property name is reported without echoing it", () => {
    writeGene(root, "keyed-prop", {
      inputSchema: { type: "object", properties: { [FAKE_HEX_KEY]: { type: "string" } } },
    });
    writeAgent(root, "keyed-prop-agent", ["keyed-prop"], { type: "Single" });
    const { code, written, text } = exportAgent("keyed-prop-agent");
    expect(code).toBe(1);
    expect(written).toBe(false);
    expect(text).toContain("<redacted key #0>");
    expect(text).not.toContain(FAKE_HEX_KEY);
  });
});

describe("#8 non-string key material and code in extension fields are caught", () => {
  it("a credential-named field holding a number array is flagged", () => {
    const findings = scanForCredentials({ privateKey: FAKE_KEY_BYTES });
    expect(findings).toContainEqual(expect.objectContaining({ pointer: "/privateKey", layer: "key-name" }));
  });

  it("a credential-named field holding a number is flagged", () => {
    expect(scanForCredentials({ pin_token: 482913 })).toContainEqual(expect.objectContaining({ pointer: "/pin_token", layer: "key-name" }));
  });

  it("a 32- or 64-byte array under any key is flagged as key material", () => {
    for (const bytes of [FAKE_KEY_BYTES, [...FAKE_KEY_BYTES, ...FAKE_KEY_BYTES]]) {
      expect(scanForCredentials({ seed: bytes })).toContainEqual(
        expect.objectContaining({ pointer: "/seed", layer: "value-pattern", rule: "Byte array of key length (32/64)" }),
      );
    }
  });

  it("short number lists, other lengths, and non-byte numbers are not", () => {
    expect(scanForCredentials({ enum: [1, 2, 3] })).toEqual([]);
    expect(scanForCredentials({ seed: FAKE_KEY_BYTES.slice(0, 31) })).toEqual([]);
    expect(scanForCredentials({ weights: FAKE_KEY_BYTES.map((n) => n + 0.5) })).toEqual([]);
    expect(scanForCredentials({ ids: FAKE_KEY_BYTES.map((n) => n + 1000) })).toEqual([]);
  });

  it("code under bindingExtensions is flagged, in any binding's extension", () => {
    for (const ext of [
      { "rotifer-playground": { parMerge: "first", source: "return 1;" } },
      { "other-binding": { script: "() => fetch(url)" } },
      { "other-binding": { hook: "eval(payload)" } },
      { "other-binding": { nested: { code: "function run(x) { return x }" } } },
    ]) {
      const bp = blueprint();
      bp.bindingExtensions = ext;
      expect(scanBlueprint(bp)).toContainEqual(expect.objectContaining({ layer: "value-pattern", rule: "Code in extension field" }));
    }
  });

  it("plain extension values and code-like prose elsewhere are not flagged", () => {
    const bp = blueprint();
    bp.bindingExtensions = { "rotifer-playground": { parMerge: "first", minVg: 0.8 }, "other-binding": { note: "merge outputs by key" } };
    bp.metadata.description = "Calls the function, then returns the summary";
    expect(scanBlueprint(bp)).toEqual([]);
  });
});
