import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialScope,
  decideConsent,
  declaredCredentials,
  executeAlgebra,
  executeGene,
  externalRequests,
  parseAllowCredentials,
  printable,
  requireCredentialConsent,
  type ConsentIo,
  type GeneCredentialRequest,
} from "../../src/utils/env-grant-consent.js";

const ESC = String.fromCharCode(0x1b);

function hybrid(deps: unknown[]): Record<string, unknown> {
  return { fidelity: "Hybrid", network: { allowedDomains: [] }, externalDependencies: deps };
}

const dep = (credentials: unknown, domains: unknown) => ({ credentials, domains });

describe("parseAllowCredentials", () => {
  it("reads NAME@host entries and lowercases the host", () => {
    expect([...parseAllowCredentials("KEY@API.example.com, KEY2@other.example.com")]).toEqual([
      "KEY@api.example.com",
      "KEY2@other.example.com",
    ]);
  });

  it("is empty when the flag is not given", () => {
    expect(parseAllowCredentials(undefined).size).toBe(0);
  });

  it.each([
    ["no host", "KEY"],
    ["empty host", "KEY@"],
    ["empty name", "@api.example.com"],
    ["two separators", "KEY@a.example@b.example"],
    ["a wildcard", "KEY@*.example.com"],
    ["a name that is not an env name", "A-B@api.example.com"],
    ["a trailing comma", "KEY@api.example.com,"],
    ["empty", ""],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseAllowCredentials(raw)).toThrow(/NAME@host/);
  });
});

describe("declaredCredentials", () => {
  it("lists each credential at each host of its own dependency", () => {
    const { pairs, notGrantable } = declaredCredentials(
      hybrid([dep(["A"], ["a.example", "b.example"]), dep(["B"], ["c.example"])]),
    );
    expect(pairs).toEqual([
      { credential: "A", domain: "a.example" },
      { credential: "A", domain: "b.example" },
      { credential: "B", domain: "c.example" },
    ]);
    expect(notGrantable).toEqual([]);
  });

  it("lowercases hosts and drops repeats", () => {
    expect(declaredCredentials(hybrid([dep(["A"], ["A.Example", "a.example"])])).pairs).toEqual([
      { credential: "A", domain: "a.example" },
    ]);
  });

  it.each([
    ["Wrapped", { fidelity: "Wrapped", network: {}, externalDependencies: [dep(["A"], ["a.example"])] }],
    ["no network block", { fidelity: "Hybrid", externalDependencies: [dep(["A"], ["a.example"])] }],
    ["unreadable", null],
  ])("asks for nothing when the gene could not be given any: %s", (_label, phenotype) => {
    expect(declaredCredentials(phenotype)).toEqual({ pairs: [], notGrantable: [] });
  });

  it.each([
    ["no hosts", dep(["A"], undefined), { credential: "A", domain: "" }],
    ["a wildcard host", dep(["A"], ["*.example.com"]), { credential: "A", domain: "*.example.com" }],
    ["shell text in the name", dep(["A;rm"], ["a.example"]), { credential: "A;rm", domain: "a.example" }],
    ["shell text in the host", dep(["A"], ["a.example;rm"]), { credential: "A", domain: "a.example;rm" }],
  ])("cannot grant %s", (_label, d, expected) => {
    expect(declaredCredentials(hybrid([d]))).toEqual({ pairs: [], notGrantable: [expected] });
  });
});

describe("printable", () => {
  it.each([
    ["ESC", ESC + "[31m"],
    ["newline", "a\nb"],
    ["BEL", String.fromCharCode(7)],
    ["DEL", String.fromCharCode(0x7f)],
    ["C1", String.fromCharCode(0x9b) + "31m"],
    ["line separator", String.fromCharCode(0x2028)],
    ["right-to-left override", String.fromCharCode(0x202e)],
    ["isolate", String.fromCharCode(0x2066)],
  ])("escapes %s", (_label, raw) => {
    const out = printable(raw);
    expect(out).toContain("\\u{");
    for (const ch of Array.from(raw).filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) >= 0x7f)) {
      expect(out).not.toContain(ch);
    }
  });

  it("leaves ordinary text alone", () => {
    expect(printable("api.example.com")).toBe("api.example.com");
  });
});

describe("decideConsent", () => {
  const a: GeneCredentialRequest = {
    gene: "gene-a",
    pairs: [{ credential: "A", domain: "a.example" }],
    notGrantable: [],
  };
  const b: GeneCredentialRequest = {
    gene: "gene-b",
    pairs: [{ credential: "B", domain: "b.example" }],
    notGrantable: [],
  };

  function io(interactive: boolean, answer = ""): ConsentIo & { asked: string[]; said: string[] } {
    const asked: string[] = [];
    const said: string[] = [];
    return {
      interactive,
      asked,
      said,
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
      say: (l) => said.push(l),
    };
  }

  it("runs when nothing is asked for", async () => {
    expect((await decideConsent([], new Set(), io(false))).kind).toBe("granted");
  });

  it("runs without asking when the flag covers every pair", async () => {
    const term = io(true);
    const outcome = await decideConsent([a, b], new Set(["A@a.example", "B@b.example"]), term);
    expect(outcome.kind).toBe("granted");
    expect(term.asked).toEqual([]);
  });

  it("refuses without a terminal and names only what is missing", async () => {
    const outcome = await decideConsent([a, b], new Set(["A@a.example"]), io(false));
    expect(outcome).toEqual({
      kind: "not_granted",
      declined: false,
      missing: [{ gene: "gene-b", credential: "B", domain: "b.example" }],
    });
  });

  it("does not take a grant for another host", async () => {
    expect((await decideConsent([a], new Set(["A@other.example"]), io(false))).kind).toBe("not_granted");
  });

  it("asks once for all genes", async () => {
    const term = io(true, "y");
    const outcome = await decideConsent([a, b], new Set(), term);
    expect(term.asked).toHaveLength(1);
    expect(term.said.join("\n")).toContain("gene-a: A → a.example");
    expect(term.said.join("\n")).toContain("gene-b: B → b.example");
    expect(outcome.kind === "granted" && [...outcome.grant].sort()).toEqual(["A@a.example", "B@b.example"]);
  });

  it.each(["", "n", "no", "maybe"])("treats the answer %j as no", async (answer) => {
    expect(await decideConsent([a], new Set(), io(true, answer))).toMatchObject({ kind: "not_granted", declined: true });
  });

  it.each(["y", "Y", "yes", " YES "])("treats the answer %j as yes", async (answer) => {
    expect((await decideConsent([a], new Set(), io(true, answer))).kind).toBe("granted");
  });

  it("escapes what the gene wrote before showing it", async () => {
    const term = io(true, "n");
    const evil = ESC + "[2Jx";
    await decideConsent([{ gene: evil, pairs: [{ credential: evil, domain: evil }], notGrantable: [] }], new Set(), term);
    expect(term.said.join("\n")).not.toContain(ESC);
  });

  it("does not ask about a gene that cannot be granted", async () => {
    const term = io(true, "y");
    const bad = { gene: "bad", pairs: [], notGrantable: [{ credential: "A", domain: "" }] };
    expect((await decideConsent([a, bad], new Set(), term)).kind).toBe("not_grantable");
    expect(term.asked).toEqual([]);
  });
});

describe("what reaches the sandbox", () => {
  let root: string;
  let external: string;
  let local: string;
  const phenotype = hybrid([dep(["A"], ["a.example", "b.example"]), dep(["B"], ["c.example"])]);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-consent-"));
    external = join(root, "external");
    local = join(root, "local");
    for (const dir of [external, local]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "phenotype.json"), JSON.stringify(phenotype));
    }
    writeFileSync(join(external, ".cloud-manifest.json"), JSON.stringify({ installed_at: "2026-01-01" }));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a gene from this workspace gets no limit and is not asked about", () => {
    expect(credentialScope(local, phenotype, new Set())).toBeUndefined();
    expect(externalRequests([{ name: "local", dir: local }])).toEqual([]);
  });

  it("an external gene gets only the granted pairs it declared", () => {
    expect(credentialScope(external, phenotype, new Set(["A@a.example", "B@c.example", "A@evil.example"]))).toEqual({
      A: ["a.example"],
      B: ["c.example"],
    });
  });

  it("an external gene with no grant gets an empty scope, not no scope", () => {
    expect(credentialScope(external, phenotype, new Set())).toEqual({});
  });

  it("executeGene sends a scope for an external gene and none for a local one", () => {
    const binding = { executeGene: vi.fn(() => ({}) as never) };
    executeGene(binding, external, Buffer.alloc(0), "{}", JSON.stringify(phenotype));
    executeGene(binding, local, Buffer.alloc(0), "{}", JSON.stringify(phenotype));
    expect(binding.executeGene.mock.calls[0][5]).toBe("{}");
    expect(binding.executeGene.mock.calls[1][5]).toBeUndefined();
  });

  it("a phenotype that cannot be read still sends an empty scope for an external gene", () => {
    const binding = { executeGene: vi.fn(() => ({}) as never) };
    executeGene(binding, external, Buffer.alloc(0), "{}", "not json");
    expect(binding.executeGene.mock.calls[0][5]).toBe("{}");
  });

  it("--json never asks, even at a terminal", async () => {
    const before = [process.stdin.isTTY, process.stdout.isTTY];
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const written: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, done?: unknown) => {
      written.push(String(chunk));
      if (typeof done === "function") done();
      return true;
    }) as never);
    try {
      await expect(requireCredentialConsent([{ name: "external", dir: external }], { json: true })).rejects.toThrow("exit 1");
    } finally {
      exit.mockRestore();
      write.mockRestore();
      [process.stdin.isTTY, process.stdout.isTTY] = before;
    }
    expect(JSON.parse(written.join("").trim()).code).toBe("credentials_not_granted");
  });

  it("executeAlgebra keys the scope by gene and leaves local genes out", () => {
    const binding = { executeAlgebra: vi.fn(() => ({}) as never) };
    executeAlgebra(binding, { aa: { dir: external, phenotype }, bb: { dir: local, phenotype } }, "{}", "{}", "{}");
    expect(JSON.parse(binding.executeAlgebra.mock.calls[0][5] as string)).toEqual({ aa: {} });
  });
});
