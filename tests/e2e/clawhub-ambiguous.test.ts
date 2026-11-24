import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

/**
 * A slug more than one publisher uses (#625). ClawHub answers it with HTTP 409
 * and wants the publisher named: `@owner/slug`, the form its own `ref` field
 * and CLI use. `wrap --from-clawhub grilling` used to stop at a bare
 * "HTTP 409" with nothing to do next.
 *
 * Choosing a publisher is choosing whose code to install, so the CLI must not
 * choose: it lists the publishers ClawHub names and a command for each, and
 * writes nothing. The 409 answers are recorded from the real ClawHub
 * (tests/fixtures/clawhub/ambiguous-409*), publishers renamed.
 */

const CLI = join(__dirname, "../../dist/index.js");
const FIXTURE = join(__dirname, "../fixtures/clawhub");
const TMP = join(tmpdir(), `rotifer-clawhub-ambiguous-${Date.now()}`);

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

const requested = (prefix: string) => requests.filter((r) => r.startsWith(prefix));

beforeAll(async () => {
  mkdirSync(join(TMP, "genes"), { recursive: true });
  writeFileSync(
    join(TMP, "rotifer.json"),
    JSON.stringify({ name: "clawhub-ambiguous", genes_dir: "genes", default_domain: "general", author: "test" }),
  );
  const zipPath = join(TMP, "fixture-skill.zip");
  execFileSync("zip", ["-q", "-r", zipPath, "."], { cwd: join(FIXTURE, "fixture-skill") });
  const zip = readFileSync(zipPath);
  const ambiguousText = readFileSync(join(FIXTURE, "ambiguous-409.txt"));
  const ambiguousJson = readFileSync(join(FIXTURE, "ambiguous-409-matches.json"));
  const publishers = new Set(["alice-demo", "bob-demo"]);

  /** The recorded metadata, as ClawHub answers it for one publisher's "grilling". */
  const infoFor = (owner: string) => {
    const info = JSON.parse(readFileSync(join(FIXTURE, "info.json"), "utf-8"));
    info.skill.slug = "grilling";
    info.owner.handle = owner;
    return JSON.stringify(info);
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${url.pathname}${url.search}`);
    const slug = url.searchParams.get("slug") ?? "";
    const owner = url.searchParams.get("ownerHandle");
    const ambiguous = slug === "grilling" || slug === "lonely";

    if ((url.pathname === "/api/skill" || url.pathname === "/api/v1/download") && ambiguous && owner === null) {
      res.writeHead(409, { "content-type": "text/plain; charset=utf-8" }).end(ambiguousText);
    } else if (url.pathname === "/api/v1/skills/grilling") {
      res.writeHead(409, { "content-type": "application/json" }).end(ambiguousJson);
    } else if (url.pathname === "/api/v1/skills/lonely") {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code: "Server Error" }));
    } else if (url.pathname === "/api/skill" && slug === "grilling" && owner !== null && publishers.has(owner)) {
      res.writeHead(200, { "content-type": "application/json" }).end(infoFor(owner));
    } else if (url.pathname === "/api/skill" && slug === "grilling" && owner === "mallory-demo") {
      // An answer for a publisher other than the one asked for.
      res.writeHead(200, { "content-type": "application/json" }).end(infoFor("alice-demo"));
    } else if (url.pathname === "/api/v1/download" && slug === "grilling" && owner !== null && publishers.has(owner)) {
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

describe("wrap --from-clawhub with a slug more than one publisher uses", () => {
  it("says so, lists a command for each publisher, and writes nothing", async () => {
    requests.length = 0;
    const out = await run(["wrap", "g-ambiguous", "--from-clawhub", "grilling"]);
    expect(out, out).toContain("E0010");
    expect(out, out).toContain("more than one publisher");
    expect(out, out).toContain("HTTP 409");
    expect(out, out).toContain("rotifer wrap g-ambiguous --from-clawhub @alice-demo/grilling");
    expect(out, out).toContain("rotifer wrap g-ambiguous --from-clawhub @bob-demo/grilling");
    expect(out, out).not.toMatch(/transient|Try again in a minute/i);
    // Asked once, not retried; nothing downloaded or written.
    expect(requested("/api/skill")).toEqual(["/api/skill?slug=grilling"]);
    expect(requested("/api/v1/download")).toEqual([]);
    expect(existsSync(join(TMP, "genes", "g-ambiguous"))).toBe(false);
  });

  it("without ClawHub's list of publishers, still says how to name one", async () => {
    requests.length = 0;
    const out = await run(["wrap", "g-lonely", "--from-clawhub", "lonely"]);
    expect(out, out).toContain("E0010");
    expect(out, out).toContain("more than one publisher");
    expect(out, out).toContain("rotifer wrap g-lonely --from-clawhub @<owner>/lonely");
    expect(out, out).toContain("https://clawhub.ai/search?q=lonely");
    expect(existsSync(join(TMP, "genes", "g-lonely"))).toBe(false);
  });

  it("@owner/slug asks for that publisher's skill and wraps it", async () => {
    requests.length = 0;
    const geneDir = join(TMP, "genes", "g-alice");
    const out = await run(["wrap", "g-alice", "--from-clawhub", "@alice-demo/grilling"]);
    expect(out, out).toContain("Fixture Skill");
    expect(requested("/api/skill")).toEqual(["/api/skill?slug=grilling&ownerHandle=alice-demo"]);
    expect(requested("/api/v1/download")).toEqual(["/api/v1/download?slug=grilling&ownerHandle=alice-demo"]);
    const phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
    expect(phenotype.clawhub.slug).toBe("grilling");
    expect(phenotype.clawhub.originalAuthor).toBe("alice-demo");
    const manifest = JSON.parse(readFileSync(join(geneDir, ".gene-manifest.json"), "utf-8"));
    expect(manifest.fromClawhub).toBe("@alice-demo/grilling");
  });

  it("refuses an answer for a publisher other than the one named", async () => {
    requests.length = 0;
    const out = await run(["wrap", "g-mallory", "--from-clawhub", "@mallory-demo/grilling"]);
    expect(out, out).toContain("E0010");
    expect(out, out).toContain("mallory-demo");
    expect(out, out).toContain("alice-demo");
    expect(requested("/api/v1/download")).toEqual([]);
    expect(existsSync(join(TMP, "genes", "g-mallory"))).toBe(false);
  });

  it("a publisher named without the @ is not guessed at", async () => {
    requests.length = 0;
    const out = await run(["wrap", "g-noat", "--from-clawhub", "alice-demo/grilling"]);
    expect(out, out).toContain("@owner/slug");
    expect(requests).toEqual([]);
    expect(existsSync(join(TMP, "genes", "g-noat"))).toBe(false);
  });
});
