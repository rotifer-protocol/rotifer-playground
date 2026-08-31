import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

/**
 * `rotifer wrap` offers to publish, defaulting to yes (ADR-247 R3). This suite
 * covers the half of that decision that can do damage: the offer must never
 * reach a run with no human behind it.
 *
 * Two shapes of "no human", both real:
 *
 *   - stdin closed (a CI step, `rotifer wrap … < /dev/null`). Without the TTY
 *     check the prompt is printed and readline never gets an answer, so the
 *     gene is not published — but the prompt text lands in the build log, and
 *     the next shape is one keystroke away.
 *   - stdin piped with content (`echo y | rotifer wrap …`, or any script that
 *     feeds answers to a CLI). Without the TTY check this publishes. That is
 *     the case worth a regression test: a build pipeline that wraps genes would
 *     start uploading them to the Cloud registry under whoever's credentials
 *     the machine happens to hold.
 *
 * HOME and ROTIFER_CONFIG_DIR are redirected to a scratch directory for every
 * run. Developer machines are signed in — that is exactly how a broken gate
 * would publish for real from a test suite, and it is not hypothetical: this
 * repo published four invocation records straight into production on
 * 2026-08-18 for the same reason (see src/cloud/invocation.ts).
 */

const PROMPT = "to Rotifer Cloud? [Y/n]";

let testDir: string;
let fakeHome: string;

function run(
  args: string,
  cwd: string,
  opts: { input?: string } = {},
): { stdout: string; exitCode: number; durationMs: number } {
  const started = Date.now();
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
      input: opts.input ?? "",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        HOME: fakeHome,
        ROTIFER_CONFIG_DIR: join(fakeHome, ".config", "rotifer"),
        ROTIFER_NO_UPDATE_CHECK: "1",
      },
    });
    return { stdout, exitCode: 0, durationMs: Date.now() - started };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Sign the scratch HOME in, pointed at a dead endpoint.
 *
 * Without this the suite proves nothing: an unauthenticated HOME trips the
 * `not-logged-in` skip, which masks the TTY check entirely — deleting the TTY
 * check left all five tests green until these credentials were added. Being
 * signed in makes the TTY check the only thing between a piped `y` and an
 * upload, which is the property under test.
 *
 * The endpoint is a closed port so that a regression fails fast and locally
 * instead of reaching cloud.rotifer.dev with a bogus token.
 */
function writeSignedInCredentials(): void {
  const rotiferHome = join(fakeHome, ".rotifer");
  mkdirSync(rotiferHome, { recursive: true });
  writeFileSync(
    join(rotiferHome, "credentials.json"),
    JSON.stringify({
      access_token: "e2e-fake-token-not-a-real-credential",
      refresh_token: "e2e-fake-refresh",
      expires_at: Date.now() + 3600_000,
      provider: "github",
      user: { id: "00000000-0000-4000-8000-000000000000", email: "e2e@example.invalid" },
    }) + "\n",
  );
  writeFileSync(
    join(rotiferHome, "cloud.json"),
    JSON.stringify({ endpoint: "http://127.0.0.1:1", anonKey: "e2e-fake-anon" }) + "\n",
  );
}

beforeEach(() => {
  testDir = join(tmpdir(), "rotifer-wrap-autopub-" + randomUUID());
  fakeHome = join(testDir, "home");
  mkdirSync(fakeHome, { recursive: true });
  writeSignedInCredentials();
  const init = run("init proj --no-genesis", testDir);
  expect(init.exitCode).toBe(0);
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

function projectDir(): string {
  return join(testDir, "proj");
}

function makeGeneDir(name: string): string {
  const dir = join(projectDir(), "genes", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), "export function express(x: unknown) { return x; }\n");
  return dir;
}

describe("rotifer wrap default-publish offer", () => {
  it("never prompts when stdin is closed", () => {
    makeGeneDir("quiet-gene");
    const result = run("wrap quiet-gene --domain test.unit", projectDir());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wrapped successfully");
    expect(result.stdout).not.toContain(PROMPT);
    // A prompt that is printed and then waits would sit here until the 30s
    // timeout kills it; completing fast is part of the assertion.
    expect(result.durationMs).toBeLessThan(20000);
  });

  it("never prompts when a script pipes 'y' in — the case that would publish", () => {
    makeGeneDir("piped-gene");
    const result = run("wrap piped-gene --domain test.unit", projectDir(), { input: "y\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(PROMPT);
    expect(result.stdout).not.toContain("Publishing");
    expect(result.stdout).not.toContain("Uploading");
  });

  it("points at the next step it skipped, so the path forward stays on screen", () => {
    makeGeneDir("hinted-gene");
    const result = run("wrap hinted-gene --domain test.unit", projectDir());

    expect(result.exitCode).toBe(0);
    // A child process never has a TTY, so `non-interactive` is the reason here
    // regardless of sign-in state — the other reasons' messages are covered in
    // tests/unit/auto-publish-gate.test.ts, where they are reachable.
    expect(result.stdout).toContain("rotifer publish hinted-gene");
  });

  it("does not prompt on the --from-skill path either", () => {
    const skillDir = join(projectDir(), "src-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: a demo skill\n---\n\nBody.\n",
    );

    const result = run(
      "wrap skill-gene --from-skill src-skill --domain test.unit",
      projectDir(),
      { input: "y\n" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("wrapped as gene");
    expect(result.stdout).not.toContain(PROMPT);
  });

  it("stays silent about publishing when the user turned default-publish off", () => {
    makeGeneDir("opted-out-gene");
    mkdirSync(join(fakeHome, ".config", "rotifer"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".config", "rotifer", "config.json"),
      JSON.stringify({ "default-publish": false }) + "\n",
    );

    const result = run("wrap opted-out-gene --domain test.unit", projectDir());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(PROMPT);
    expect(result.stdout).not.toContain("rotifer login");
  });
});
