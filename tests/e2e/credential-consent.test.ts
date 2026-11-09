import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The real CLI, with no terminal attached: how MCP and other agents call it. */

const CLI = join(__dirname, "../../dist/index.js");
const ESC = String.fromCharCode(0x1b);
const GRANT = "--allow-credentials=T508_KEY@api.example.com";
const TIMEOUT = 40_000;

let root: string;

function phenotype(credentials: string[] = ["T508_KEY"]): string {
  return JSON.stringify({
    domain: "test.consent",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    version: "0.1.0",
    fidelity: "Hybrid",
    network: { allowedDomains: ["api.example.com"], maxTimeoutMs: 5000, maxResponseBytes: 1024, maxRequestsPerMin: 1 },
    externalDependencies: [{ apiType: "rest", semanticTag: "t", domains: ["api.example.com"], credentials }],
  });
}

function addGene(name: string, opts: { external: boolean; credentials?: string[] }): void {
  const dir = join(root, "genes", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phenotype.json"), phenotype(opts.credentials));
  writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  if (opts.external) {
    writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ installed_at: "2026-01-01T00:00:00Z" }));
  }
}

function addAgent(name: string, genome: string[]): void {
  const dir = join(root, ".rotifer", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ id: name, name, genome, composition: "Seq", state: "Active", createdAt: "2026-01-01T00:00:00Z" }),
  );
}

function cli(args: string[]): Promise<{ stdout: string; output: string; code: number }> {
  return new Promise((resolve) => {
    const env = { ...process.env, NO_COLOR: "1" };
    delete env.T508_KEY;
    execFile("node", [CLI, ...args], { cwd: root, timeout: 30_000, env }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ stdout, output: `${stdout}${stderr}`, code });
    });
  });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rotifer-credential-consent-"));
  mkdirSync(join(root, "genes"));
  writeFileSync(join(root, "rotifer.json"), JSON.stringify({ project_name: "t", genes_dir: "genes" }));
  addGene("external", { external: true });
  addGene("external-two", { external: true, credentials: ["T508_OTHER"] });
  addGene("local-gene", { external: false });
  addGene("evil-name", { external: true, credentials: [`K${ESC}[2J`] });
  addAgent("pair", ["external", "external-two"]);
  addGene("gene-health-scanner", { external: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("an external gene that declares credentials, with no terminal", () => {
  it.each([
    ["run", ["run", "external", "--input", "{}"]],
    ["test", ["test", "external"]],
    ["hello", ["hello", "--template", "quality-advisor", "--input", "{}"]],
  ])("%s stops and says what to pass", { timeout: TIMEOUT }, async (_label, args) => {
    const { output, code } = await cli(args);
    expect(code, output).toBe(1);
    expect(output).toContain("credentials_not_granted");
    expect(output).toContain("--allow-credentials T508_KEY@api.example.com");
  });

  it("agent run names every gene at once", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["agent", "run", "pair", "--input", "{}"]);
    expect(code, output).toBe(1);
    expect(output).toContain("external: T508_KEY → api.example.com");
    expect(output).toContain("external-two: T508_OTHER → api.example.com");
    expect(output).toContain("--allow-credentials T508_KEY@api.example.com,T508_OTHER@api.example.com");
  });

  it("--json gives an agent what it needs to act", { timeout: TIMEOUT }, async () => {
    const { stdout, code } = await cli(["--json", "run", "external", "--input", "{}"]);
    expect(code, stdout).toBe(1);
    const report = JSON.parse(stdout.trim().split("\n").pop() as string);
    expect(report.ok).toBe(false);
    expect(report.code).toBe("credentials_not_granted");
    expect(report.missing).toEqual([{ gene: "external", credential: "T508_KEY", domain: "api.example.com" }]);
    expect(report.next_step).toContain("--allow-credentials T508_KEY@api.example.com");
    expect(report.next_step).toMatch(/ask the user/i);
  });

  it("a grant for another host does not count", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["run", "external", "--input", "{}", "--allow-credentials=T508_KEY@evil.example"]);
    expect(code, output).toBe(1);
    expect(output).toContain("credentials_not_granted");
  });

  it("the grant lets it past the question, to the check that the variable is set", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["run", "external", "--input", "{}", GRANT]);
    expect(code, output).toBe(1);
    expect(output).not.toContain("credentials_not_granted");
    expect(output).toContain("missing credential");
    expect(output).toContain("T508_KEY");
  });

  it("a badly written flag is refused", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["run", "external", "--input", "{}", "--allow-credentials=T508_KEY"]);
    expect(code, output).toBe(1);
    expect(output).toContain("NAME@host");
  });

  it("control characters from the phenotype do not reach the terminal", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["run", "evil-name", "--input", "{}"]);
    expect(code, output).toBe(1);
    expect(output).toContain("credentials_not_grantable");
    expect(output).not.toContain(ESC);
  });
});

describe("what stays the same", () => {
  it("a gene from this workspace is not asked about", { timeout: TIMEOUT }, async () => {
    const { output } = await cli(["run", "local-gene", "--input", "{}"]);
    expect(output).not.toContain("credentials_not_granted");
    expect(output).toContain("missing credential");
  });

  it("arena submit scores a Hybrid gene without running it, so there is nothing to ask", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["arena", "submit", "external"]);
    expect(code, output).toBe(0);
    expect(output).not.toContain("credentials_not_granted");
    expect(output).not.toContain("Executing gene in WASM sandbox");
  });

  it("publish has no such flag", { timeout: TIMEOUT }, async () => {
    const { output, code } = await cli(["publish", "external", GRANT]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/unknown option/i);
  });
});
