import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

/**
 * `wrap --from-clawhub` end to end — the real CLI, a real download, unzip and
 * the files it writes — against a recorded ClawHub (tests/fixtures/clawhub/)
 * served from this process.
 *
 * Why not the live ClawHub here: its backend fails about one request in six
 * with HTTP 500 and takes 4–11 s when it works (measured 2026-10-31), so a
 * live call in the PR gate failed PRs for reasons no PR could fix. The live
 * endpoints are still checked, on a schedule that opens an issue when they
 * fail (tests/live/clawhub-live.test.ts, .github/workflows/clawhub-live.yml).
 *
 * The fixture keeps what the live suite was added for (2026-08-31): the
 * download endpoint answers 307, which an earlier client did not follow and
 * which failed every wrap with a generic E0011. The suite must attempt the
 * whole path, not pass when a file is missing.
 */

const CLI = join(__dirname, "../../dist/index.js");
const FIXTURE = join(__dirname, "../fixtures/clawhub");
const TMP = join(tmpdir(), `rotifer-clawhub-test-${Date.now()}`);

let server: Server;
let base = "";
const requests: string[] = [];

function run(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [CLI, ...args],
      {
        cwd: TMP,
        timeout: 30_000,
        env: {
          ...process.env,
          NO_COLOR: "1",
          ROTIFER_CLAWHUB_API_URL: `${base}/api/skill`,
          ROTIFER_CLAWHUB_DOWNLOAD_URL: `${base}/api/v1/download`,
        },
      },
      (_err, stdout, stderr) => resolve(`${stdout}${stderr}`),
    );
  });
}

function initProject(): void {
  mkdirSync(join(TMP, "genes"), { recursive: true });
  writeFileSync(
    join(TMP, "rotifer.json"),
    JSON.stringify({ name: "test-clawhub", genes_dir: "genes", default_domain: "general", author: "test" }),
  );
}

beforeAll(async () => {
  initProject();
  // The package, zipped flat as ClawHub serves it.
  const zipPath = join(TMP, "fixture-skill.zip");
  execFileSync("zip", ["-q", "-r", zipPath, "."], { cwd: join(FIXTURE, "fixture-skill") });
  const zip = readFileSync(zipPath);
  const info = readFileSync(join(FIXTURE, "info.json"));

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const slug = url.searchParams.get("slug") ?? "";
    requests.push(`${url.pathname}?slug=${slug}`);
    if (url.pathname === "/api/skill" && slug === "fixture-skill") {
      res.writeHead(200, { "content-type": "application/json" }).end(info);
    } else if (url.pathname === "/api/v1/download" && slug === "fixture-skill") {
      res.writeHead(307, { location: `${base}/files/fixture-skill.zip?slug=${slug}` }).end();
    } else if (url.pathname === "/files/fixture-skill.zip") {
      res.writeHead(200, { "content-type": "application/zip" }).end(zip);
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(TMP, { recursive: true, force: true });
});

describe("rotifer wrap --from-clawhub", () => {
  it("wrap --help lists --from-clawhub option", async () => {
    const output = await run(["wrap", "--help"]);
    expect(output).toContain("--from-clawhub");
    expect(output).toContain("ClawHub");
  });

  it("wrap --help lists --from-skill option alongside --from-clawhub", async () => {
    const output = await run(["wrap", "--help"]);
    expect(output).toContain("--from-skill");
    expect(output).toContain("--from-clawhub");
  });

  it("--from-clawhub with nonexistent slug fails with E0010", async () => {
    const output = await run(["wrap", "test-gene", "--from-clawhub", "this-slug-does-not-exist-ever-999"]);
    expect(output).toContain("E0010");
    expect(output).toContain("not found (HTTP 404)");
  });

  it("--from-clawhub without slug value shows usage error", async () => {
    const output = await run(["wrap", "test-gene", "--from-clawhub"]);
    expect(output).toMatch(/error|argument|required/i);
  });
});

describe("ClawHub migration output structure (recorded ClawHub)", () => {
  const GENE_DIR = join(TMP, "genes", "clawhub-fixture-gene");
  let wrapOutput = "";

  beforeAll(async () => {
    wrapOutput = await run(["wrap", "clawhub-fixture-gene", "--from-clawhub", "fixture-skill"]);
  }, 30_000);

  it("wrap succeeds against the recorded endpoint", () => {
    expect(wrapOutput, wrapOutput).toContain("Fixture Skill");
    expect(existsSync(join(GENE_DIR, "phenotype.json")), wrapOutput).toBe(true);
  });

  it("the package is reached through the download endpoint's 307", () => {
    expect(requests).toContain("/api/v1/download?slug=fixture-skill");
    expect(requests).toContain("/files/fixture-skill.zip?slug=fixture-skill");
  });

  it("phenotype.json contains source: clawhub when migrated", () => {
    const phenotype = JSON.parse(readFileSync(join(GENE_DIR, "phenotype.json"), "utf-8"));
    expect(phenotype.source).toBe("clawhub");
    expect(phenotype.clawhub).toBeDefined();
    expect(phenotype.clawhub.slug).toBeDefined();
    expect(phenotype.clawhub.originalAuthor).toBeDefined();
    expect(phenotype.clawhub.downloads).toBeTypeOf("number");
    expect(phenotype.clawhub.migratedAt).toBeDefined();
  });

  it(".gene-manifest.json contains fromClawhub field", () => {
    const manifest = JSON.parse(readFileSync(join(GENE_DIR, ".gene-manifest.json"), "utf-8"));
    expect(manifest.fromClawhub).toBeDefined();
    expect(manifest.clawhubVersion).toBeDefined();
  });
});
