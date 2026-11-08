/**
 * What `rotifer hello --template <id>` says when a template cannot run (T-167).
 *
 * Five of the six templates need genes a fresh workspace does not have. It
 * used to answer "Install/import the required genes" without naming a way to
 * do that — for genes that, in eight cases of ten, are not on the Registry at
 * all. Two more are on the Registry with no runnable code, and installing them
 * ended in "Execution complete" over output equal to the input.
 *
 * These run the real CLI against a local stand-in for the Registry, so the
 * outcome does not depend on what the real one holds today. It runs in this
 * process, which is why these call the CLI with execFile and not execSync.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const OFFICIAL = "rotifer-protocol";

interface RegistryRow {
  owner: string;
  fidelity: string;
  wasm_path: string | null;
}

function row(name: string, r: RegistryRow): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name,
    domain: "test",
    version: "0.1.0",
    fidelity: r.fidelity,
    description: null,
    phenotype: { fidelity: r.fidelity },
    wasm_path: r.wasm_path,
    wasm_size: 0,
    wasm_hash: null,
    content_hash: null,
    downloads: 0,
    reputation_score: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    profiles: { username: r.owner },
  };
}

/** Answers the two lookups `getGene` makes, the way PostgREST filters them. */
function registry(rows: Record<string, RegistryRow>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const name = (url.searchParams.get("name") ?? "").replace(/^eq\./, "");
    const owner = url.searchParams.get("profiles.username")?.replace(/^eq\./, "");
    const found = rows[name];
    const body = found && (owner === undefined || owner === found.owner) ? [row(name, found)] : [];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () => {
      done({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    }),
  );
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

interface Result {
  stdout: string;
  stderr: string;
  out: string;
  code: number | null;
  ms: number;
}

function run(args: string[], cwd: string, endpoint: string, home: string): Promise<Result> {
  const started = performance.now();
  return new Promise((done) => {
    const child = execFile(
      "node",
      [CLI, ...args],
      {
        cwd,
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: home,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ROTIFER_TELEMETRY: "0",
          ROTIFER_CLOUD_ENDPOINT: endpoint,
          ROTIFER_CLOUD_ANON_KEY: "anon-test-key",
        },
      },
      (_err, stdout, stderr) =>
        done({ stdout, stderr, out: `${stdout}${stderr}`, code: child.exitCode, ms: performance.now() - started }),
    );
    child.stdin?.end();
  });
}

function writeProject(root: string): string {
  mkdirSync(join(root, "genes"), { recursive: true });
  mkdirSync(join(root, ".rotifer", "agents"), { recursive: true });
  writeFileSync(
    join(root, "rotifer.json"),
    JSON.stringify({ name: "t", version: "0.1.0", author: "t", genes_dir: "genes" }) + "\n",
  );
  return root;
}

function writePhenotypeOnlyGene(project: string, name: string, fidelity: string): void {
  const dir = join(project, "genes", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phenotype.json"),
    JSON.stringify({ name, version: "0.1.0", domain: "test", fidelity, inputSchema: {}, outputSchema: {} }),
  );
}

/** The line a downstream panel reads to learn what to install: its exact regex. */
function panelMissingGenes(text: string): string[] {
  const m = String(text || "").match(/Missing primary genes:\s*([^\n]+)/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

describe("rotifer hello when a template's genes are missing", () => {
  let tmp: string;
  let project: string;
  let reg: { server: Server; url: string };

  beforeAll(async () => {
    reg = await registry({
      "doc-retrieval": { owner: OFFICIAL, fidelity: "Hybrid", wasm_path: null },
      "answer-synthesizer": { owner: OFFICIAL, fidelity: "Hybrid", wasm_path: null },
      "solidity-parser": { owner: OFFICIAL, fidelity: "Native", wasm_path: "a/solidity-parser.wasm" },
      // Someone else's gene under a template's bare name.
      "security-scanner": { owner: "someone-else", fidelity: "Native", wasm_path: "x/scanner.wasm" },
    });
  });

  afterAll(async () => {
    await closeServer(reg.server);
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rotifer-hello-missing-"));
    project = writeProject(join(tmp, "ws"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const hello = (template: string, ...rest: string[]) =>
    run(["hello", "--template", template, ...rest], project, reg.url, tmp);

  it("says a gene is not published instead of pointing at an install that cannot work", async () => {
    const { out, code } = await hello("uiux-diagnosis");
    expect(code).toBe(1);
    expect(out).toMatch(/uiux-analyzer: not published/);
    expect(out).toMatch(/uiux-reporter: not published/);
    expect(out).not.toContain("rotifer install");
    expect(out).not.toContain("Install/import the required genes");
  });

  it("does not offer another publisher's gene that happens to have the template's name", async () => {
    const { out, code } = await hello("code-security");
    expect(code).toBe(1);
    expect(out).toMatch(/security-scanner: not published/);
    expect(out).not.toContain("rotifer install");
  });

  it("names a gene on the Registry with no runnable code, and gives no command for it", async () => {
    const { out, code } = await hello("doc-qa");
    expect(code).toBe(1);
    expect(out).toMatch(/doc-retrieval: on Rotifer Cloud \(Hybrid\) with no runnable code/);
    expect(out).toMatch(/answer-synthesizer: on Rotifer Cloud \(Hybrid\) with no runnable code/);
    expect(out).not.toContain("rotifer install");
  });

  it("prints a publisher-qualified command only for a gene that can be installed and run", async () => {
    const { out, code } = await hello("web3-toolkit");
    expect(code).toBe(1);
    expect(out).toContain(`rotifer install @${OFFICIAL}/solidity-parser`);
    expect(out).toMatch(/vuln-detector: not published/);
    expect(out).toMatch(/audit-reporter: not published/);
    // One of three installable is not a way to run the template.
    expect(out).toMatch(/cannot run yet/i);
  });

  it("keeps the line, and the stream, that a downstream panel reads", async () => {
    const { stdout } = await hello("uiux-diagnosis");
    expect(panelMissingGenes(stdout)).toEqual(["uiux-analyzer", "uiux-reporter"]);
  });

  it("says so when the Registry refuses the connection", async () => {
    const down = createServer();
    await new Promise<void>((done) => down.listen(0, "127.0.0.1", () => done()));
    const { port } = down.address() as AddressInfo;
    await closeServer(down);

    const { out, code } = await run(
      ["hello", "--template", "code-security"],
      project,
      `http://127.0.0.1:${port}`,
      tmp,
    );
    expect(code).toBe(1);
    expect(out).toMatch(/security-scanner: could not check Rotifer Cloud/);
    expect(out).not.toMatch(/not published/);
  });

  it("does not hang when the Registry accepts the connection and never answers", async () => {
    const hung = createServer(() => { /* never answers */ });
    await new Promise<void>((done) => hung.listen(0, "127.0.0.1", () => done()));
    const { port } = hung.address() as AddressInfo;
    try {
      const { out, code, ms } = await run(
        ["hello", "--template", "code-security"],
        project,
        `http://127.0.0.1:${port}`,
        tmp,
      );
      expect(code).toBe(1);
      expect(out).toMatch(/security-scanner: could not check Rotifer Cloud/);
      expect(ms).toBeLessThan(10_000);
    } finally {
      await closeServer(hung);
    }
  });

  it("refuses a metadata-only gene that is installed, rather than reporting success", async () => {
    writePhenotypeOnlyGene(project, "doc-retrieval", "Hybrid");
    writePhenotypeOnlyGene(project, "answer-synthesizer", "Hybrid");

    const { out, code } = await hello("doc-qa");
    expect(code).toBe(1);
    expect(out).toMatch(/doc-retrieval: installed here \(Hybrid\) with no runnable code/);
    expect(out).not.toContain("Execution complete");
    expect(out).not.toContain("passing through");
    expect(out).not.toContain("Genome Snapshot");
  });

  describe("--json", () => {
    it("writes one parseable object to stdout when genes are missing", async () => {
      const { stdout, code } = await hello("web3-toolkit", "--json");
      expect(code).toBe(1);
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ ok: false, code: "genes_unavailable", template: "web3-toolkit" });
      const byName = Object.fromEntries(
        (report.genes as Array<{ name: string }>).map((g) => [g.name, g]),
      );
      expect(byName["solidity-parser"]).toMatchObject({
        status: "installable",
        install_command: `rotifer install @${OFFICIAL}/solidity-parser`,
      });
      expect(byName["vuln-detector"]).toMatchObject({ status: "not_published", install_command: null });
    });

    it("reports a metadata-only installed gene as a failure", async () => {
      writePhenotypeOnlyGene(project, "doc-retrieval", "Hybrid");
      writePhenotypeOnlyGene(project, "answer-synthesizer", "Hybrid");
      const { stdout, code } = await hello("doc-qa", "--json");
      expect(code).toBe(1);
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({ ok: false, code: "genes_unavailable" });
      expect(report.genes[0]).toMatchObject({ name: "doc-retrieval", status: "metadata_only", fidelity: "Hybrid" });
    });

    it("writes only the gene's output to stdout when the run succeeds", async () => {
      const dir = join(project, "genes", "gene-health-scanner");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "phenotype.json"),
        JSON.stringify({ name: "gene-health-scanner", version: "0.1.0", domain: "t", fidelity: "Native", inputSchema: {}, outputSchema: {} }),
      );
      writeFileSync(
        join(dir, "index.js"),
        `module.exports.express = function(input) { console.log("noise from a gene"); return { computed: input.n * 2 }; };\n`,
      );
      const { stdout, stderr, code } = await hello("quality-advisor", "--json", "--input", '{"n":21}');
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ computed: 42 });
      expect(stderr).toContain("Execution complete");
    });

    it("writes a parseable failure when a gene fails partway", async () => {
      const dir = join(project, "genes", "gene-health-scanner");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "phenotype.json"),
        JSON.stringify({ name: "gene-health-scanner", version: "0.1.0", domain: "t", fidelity: "Native", inputSchema: {}, outputSchema: {} }),
      );
      writeFileSync(join(dir, "index.js"), `module.exports.express = function() { throw new Error("boom"); };\n`);
      const { stdout, code } = await hello("quality-advisor", "--json", "--input", "{}");
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        code: "execution_failed",
        failed_gene: "gene-health-scanner",
        error: "boom",
      });
    });

    it("writes a parseable failure for an unknown template", async () => {
      const { stdout, code } = await hello("no-such-template", "--json");
      expect(code).toBe(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: "template_not_found", template: "no-such-template" });
    });
  });

  describe("--list-templates", () => {
    /** Lines of one titled group of the listing. */
    function group(listing: string, title: RegExp): string {
      const lines = listing.split("\n");
      const start = lines.findIndex((l) => title.test(l));
      if (start < 0) return "";
      const end = lines.findIndex((l, i) => i > start && l.trim() === "");
      return lines.slice(start, end < 0 ? undefined : end).join("\n");
    }

    it("offers only what can run in a workspace init just created", async () => {
      const init = await run(["init", "fresh"], tmp, reg.url, tmp);
      expect(init.code).toBe(0);

      const { stdout, code } = await run(["hello", "--list-templates"], join(tmp, "fresh"), reg.url, tmp);
      expect(code).toBe(0);
      expect(stdout).not.toContain("works instantly");

      const quick = group(stdout, /Quick Start/);
      expect(quick).toContain("quality-advisor");
      for (const id of ["uiux-diagnosis", "content-analysis", "code-security", "doc-qa", "web3-toolkit"]) {
        expect(quick).not.toContain(id);
      }

      const needs = group(stdout, /Needs genes first/);
      for (const id of ["uiux-diagnosis", "content-analysis", "code-security", "doc-qa", "web3-toolkit"]) {
        expect(needs).toContain(id);
      }
      expect(needs).not.toContain("quality-advisor");
    });

    it("moves a template up once its genes can actually run here", async () => {
      const dir = join(project, "genes", "security-scanner");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "phenotype.json"),
        JSON.stringify({ name: "security-scanner", version: "0.1.0", domain: "t", fidelity: "Native", inputSchema: {}, outputSchema: {} }),
      );
      writeFileSync(join(dir, "index.js"), `module.exports.express = (i) => i;\n`);
      writePhenotypeOnlyGene(project, "doc-retrieval", "Hybrid");
      writePhenotypeOnlyGene(project, "answer-synthesizer", "Hybrid");

      const { stdout } = await run(["hello", "--list-templates"], project, reg.url, tmp);
      expect(group(stdout, /Quick Start/)).toContain("code-security");
      // Present but not runnable is not ready.
      expect(group(stdout, /Needs genes first/)).toContain("doc-qa");
    });

    it("does not touch the network", async () => {
      const { code, ms } = await run(["hello", "--list-templates"], project, "http://127.0.0.1:1", tmp);
      expect(code).toBe(0);
      expect(ms).toBeLessThan(5_000);
    });
  });
});
