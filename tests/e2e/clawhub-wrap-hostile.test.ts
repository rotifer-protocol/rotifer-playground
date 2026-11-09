import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { buildZip } from "../helpers/build-zip.js";
import { isExternallySourced } from "../../src/utils/l0-gate.js";

/**
 * `wrap --from-clawhub` against packages built to attack it: the real CLI and
 * real zip files, served the way ClawHub serves them. A ClawHub package is
 * someone else's upload, so nothing in it decides what the CLI reads, writes
 * or trusts.
 */

const CLI = join(__dirname, "../../dist/index.js");
const FIXTURE = join(__dirname, "../fixtures/clawhub");
const TMP = join(tmpdir(), `rotifer-clawhub-hostile-${Date.now()}`);
const SECRET = "SECRET-CONTENT-OF-A-FILE-OUTSIDE-THE-PACKAGE";
const SECRET_FILE = join(TMP, "outside", "credentials.txt");
const SKILL_MD = "---\nname: hostile\ndescription: test package\n---\n\n# Hostile\n";

let server: Server;
let base = "";
const packages = new Map<string, Buffer>();

function run(args: string[]): Promise<{ output: string; code: number }> {
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
      (err, stdout, stderr) => {
        const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        resolve({ output: `${stdout}${stderr}`, code });
      },
    );
  });
}

/** Zip a real directory with the real `zip`; -y stores links as links. */
function zipDirectory(slug: string, build: (dir: string) => void): void {
  const dir = join(TMP, "packages", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
  build(dir);
  const zipPath = join(TMP, "packages", `${slug}.zip`);
  execFileSync("zip", ["-q", "-r", "-y", zipPath, "."], { cwd: dir });
  packages.set(slug, readFileSync(zipPath));
}

function geneDirOf(name: string): string {
  return join(TMP, "genes", name);
}

/** Every regular file under `dir`, with its content. */
function allFileContents(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isDirectory()) out += allFileContents(p);
    else if (st.isFile()) out += readFileSync(p, "utf-8");
  }
  return out;
}

beforeAll(async () => {
  mkdirSync(join(TMP, "genes"), { recursive: true });
  mkdirSync(join(TMP, "outside"), { recursive: true });
  mkdirSync(join(TMP, "packages"), { recursive: true });
  writeFileSync(SECRET_FILE, SECRET);
  writeFileSync(
    join(TMP, "rotifer.json"),
    JSON.stringify({ name: "test-clawhub", genes_dir: "genes", default_domain: "general", author: "test" }),
  );

  zipDirectory("symlink-file", (dir) => symlinkSync(SECRET_FILE, join(dir, "notes.md")));
  zipDirectory("symlink-dir", (dir) => symlinkSync(join(TMP, "outside"), join(dir, "assets")));
  zipDirectory("nested-symlink", (dir) => {
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    symlinkSync("../../../../outside/credentials.txt", join(dir, "a", "b", "c.md"));
  });
  zipDirectory("forged-phenotype", (dir) => {
    writeFileSync(
      join(dir, "phenotype.json"),
      JSON.stringify({ domain: "forged", source: "local", fidelity: "Native", forged: true }),
    );
    writeFileSync(join(dir, "README.md"), "kept\n");
  });
  zipDirectory("forged-phenotype-case", (dir) => {
    writeFileSync(join(dir, "PHENOTYPE.JSON"), JSON.stringify({ forged: true }));
  });
  zipDirectory("forged-manifests", (dir) => {
    writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ published_at: "2026-01-01T00:00:00Z" }));
    writeFileSync(join(dir, ".gene-manifest.json"), JSON.stringify({ geneId: "forged", forged: true }));
    writeFileSync(join(dir, ".clawhub-origin.json"), JSON.stringify({ forged: true }));
    writeFileSync(join(dir, ".compile-result.json"), JSON.stringify({ forged: true }));
    writeFileSync(join(dir, ".arena-cache.json"), JSON.stringify({ forged: true }));
    writeFileSync(join(dir, "index.ts"), "export async function express() { return { ran: true }; }\n");
  });

  // `zip` will not write these two; the byte-level builder writes what an
  // attacker's tool would.
  packages.set(
    "traversal",
    buildZip([
      { name: "SKILL.md", content: SKILL_MD },
      { name: "../../../escaped.txt", content: "escaped" },
    ]),
  );
  packages.set(
    "absolute-path",
    buildZip([
      { name: "SKILL.md", content: SKILL_MD },
      { name: join(TMP, "outside", "absolute.txt"), content: "escaped" },
    ]),
  );
  packages.set("not-a-zip", Buffer.from("this is not a zip file at all"));

  const info = readFileSync(join(FIXTURE, "info.json"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const slug = url.searchParams.get("slug") ?? "";
    if (url.pathname === "/api/skill" && packages.has(slug)) {
      res.writeHead(200, { "content-type": "application/json" }).end(info);
    } else if (url.pathname === "/api/v1/download" && packages.has(slug)) {
      res.writeHead(200, { "content-type": "application/zip" }).end(packages.get(slug));
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(TMP, { recursive: true, force: true });
});

describe("a package that reaches outside itself is refused whole", () => {
  for (const slug of ["symlink-file", "symlink-dir", "nested-symlink"]) {
    it(`${slug}: refused, and nothing from outside the package is copied in`, async () => {
      const gene = `gene-${slug}`;
      const { output, code } = await run(["wrap", gene, "--from-clawhub", slug]);
      expect(code, output).toBe(1);
      expect(output).toContain("E0013");
      expect(output).toMatch(/link/i);
      expect(allFileContents(geneDirOf(gene))).not.toContain(SECRET);
      expect(existsSync(join(geneDirOf(gene), "phenotype.json")), output).toBe(false);
    });
  }

  it("a path that climbs out of the package is refused", async () => {
    const { output, code } = await run(["wrap", "gene-traversal", "--from-clawhub", "traversal"]);
    expect(code, output).toBe(1);
    expect(output).toContain("E0013");
    expect(existsSync(join(geneDirOf("gene-traversal"), "phenotype.json")), output).toBe(false);
  });

  it("an absolute path is refused and nothing lands there", async () => {
    const { output, code } = await run(["wrap", "gene-absolute", "--from-clawhub", "absolute-path"]);
    expect(code, output).toBe(1);
    expect(output).toContain("E0013");
    expect(existsSync(join(TMP, "outside", "absolute.txt"))).toBe(false);
  });

  it("the refusal does not tell the user to retry a transient failure", async () => {
    const { output } = await run(["wrap", "gene-retry", "--from-clawhub", "symlink-file"]);
    expect(output).not.toMatch(/transient|try again/i);
  });

  it("a file that is not a readable zip is refused", async () => {
    const { output, code } = await run(["wrap", "gene-notzip", "--from-clawhub", "not-a-zip"]);
    expect(code, output).toBe(1);
    expect(output).toContain("E0013");
    expect(existsSync(join(geneDirOf("gene-notzip"), "phenotype.json")), output).toBe(false);
  });
});

describe("a package cannot write what the CLI writes", () => {
  it("phenotype.json is the one wrap generated, not the package's", async () => {
    const { output } = await run(["wrap", "gene-phenotype", "--from-clawhub", "forged-phenotype"]);
    const phenotype = JSON.parse(readFileSync(join(geneDirOf("gene-phenotype"), "phenotype.json"), "utf-8"));
    expect(phenotype.forged, output).toBeUndefined();
    expect(phenotype.source).toBe("clawhub");
    expect(phenotype.fidelity).not.toBe("Native");
    expect(output).toMatch(/Skipped.*phenotype\.json/i);
    expect(readFileSync(join(geneDirOf("gene-phenotype"), "README.md"), "utf-8")).toBe("kept\n");
  });

  it("a different-case PHENOTYPE.JSON does not get in either", async () => {
    await run(["wrap", "gene-case", "--from-clawhub", "forged-phenotype-case"]);
    const dir = geneDirOf("gene-case");
    expect(readdirSync(dir)).not.toContain("PHENOTYPE.JSON");
    expect(JSON.parse(readFileSync(join(dir, "phenotype.json"), "utf-8")).forged).toBeUndefined();
  });

  it("the package's manifests are not kept", async () => {
    await run(["wrap", "gene-manifests", "--from-clawhub", "forged-manifests"]);
    const dir = geneDirOf("gene-manifests");
    expect(existsSync(join(dir, ".cloud-manifest.json"))).toBe(false);
    expect(existsSync(join(dir, ".compile-result.json"))).toBe(false);
    expect(existsSync(join(dir, ".arena-cache.json"))).toBe(false);
    expect(existsSync(join(dir, ".clawhub-origin.json"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, ".gene-manifest.json"), "utf-8"));
    expect(manifest.forged).toBeUndefined();
    expect(manifest.fromClawhub).toBe("forged-manifests");
  });
});

describe("a gene wrapped from ClawHub is external code", () => {
  // The order matters: the wrap in the describe above left the gene on disk.
  it("is external even though its package shipped a manifest with only published_at", () => {
    expect(isExternallySourced(geneDirOf("gene-manifests"))).toBe(true);
  });

  it("`rotifer run` refuses it on the unsandboxed path and says how to allow it", async () => {
    const { output, code } = await run(["run", "gene-manifests", "--no-sandbox", "--input", "{}"]);
    expect(code, output).toBe(1);
    expect(output).toContain("Genes wrapped from ClawHub cannot run via Node.js without sandbox.");
    expect(output).toContain("--trust-unsigned");
    expect(output).not.toContain('"ran"');
  });

  it("wrap says so when it finishes, before the first run surprises anyone", async () => {
    const { output } = await run(["wrap", "gene-hint", "--from-clawhub", "forged-phenotype"]);
    expect(output).toContain("external code");
  });
});

describe("wrapping an existing ClawHub gene again does not make it the user's own", () => {
  async function wrappedFromClawhub(name: string): Promise<string> {
    await run(["wrap", name, "--from-clawhub", "forged-manifests"]);
    expect(isExternallySourced(geneDirOf(name))).toBe(true);
    return geneDirOf(name);
  }

  function localSkill(name: string): string {
    const dir = join(TMP, "local-skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
    return dir;
  }

  async function expectStillRefused(name: string): Promise<void> {
    expect(isExternallySourced(geneDirOf(name))).toBe(true);
    const { output, code } = await run(["run", name, "--no-sandbox", "--input", "{}"]);
    expect(code, output).toBe(1);
    expect(output).not.toContain('"ran"');
  }

  it("a plain re-wrap keeps where it came from", async () => {
    const dir = await wrappedFromClawhub("gene-rewrap");
    const { output, code } = await run(["wrap", "gene-rewrap"]);
    expect(code, output).toBe(0);

    const manifest = JSON.parse(readFileSync(join(dir, ".gene-manifest.json"), "utf-8"));
    expect(manifest.fromClawhub).toBe("forged-manifests");
    expect(manifest.clawhubVersion).toBeDefined();
    await expectStillRefused("gene-rewrap");
  });

  it("wrapping a local skill over it keeps where it came from", async () => {
    await wrappedFromClawhub("gene-reskill");
    const skill = localSkill("reskill");
    const { output, code } = await run(["wrap", "gene-reskill", "--from-skill", skill, "--domain", "general"]);
    expect(code, output).toBe(0);
    await expectStillRefused("gene-reskill");
  });

  it("a manifest that cannot be read stays external after a re-wrap", async () => {
    const dir = await wrappedFromClawhub("gene-garbled");
    writeFileSync(join(dir, ".gene-manifest.json"), "not json");
    const { output, code } = await run(["wrap", "gene-garbled"]);
    expect(code, output).toBe(0);
    await expectStillRefused("gene-garbled");
  });

  it("a gene that never came from ClawHub is not marked", async () => {
    const name = "gene-local-rewrap";
    const skill = localSkill("local");
    await run(["wrap", name, "--from-skill", skill, "--domain", "general"]);
    await run(["wrap", name]);
    const manifest = JSON.parse(readFileSync(join(geneDirOf(name), ".gene-manifest.json"), "utf-8"));
    expect("fromClawhub" in manifest).toBe(false);
  });
});
