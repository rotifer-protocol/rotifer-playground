import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(__dirname, "../..");

function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (path.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  walk(join(repoRoot, "tests"));
  return found;
}

/**
 * Test helpers here build the child env as `{ ...process.env }`, so the CLI a
 * test spawns resolves `~/.rotifer` from whatever HOME the runner has —
 * credentials, run logs, the update-check cache. A test that only reads is
 * merely flaky; one that writes damages the person running it.
 *
 * Both happened:
 *
 *  - `tests/security/token-safety.test.ts` runs `logout`, and
 *    `clearCredentials()` truncates then unlinks `~/.rotifer/credentials.json`.
 *    A full `npm test` while signed in DELETED the developer's real login.
 *  - `tests/resilience/token-expiry.test.ts` asserted `reputation --mine` exits
 *    nonzero "without login" — true only while the machine happened to be
 *    signed out. It passed alone and failed inside a full run on 2026-08-18.
 *
 * Redirecting HOME globally from a vitest setup file was tried and reverted:
 * `javy-cli` caches its downloaded binary under `$HOME/Library/Caches`, and npx
 * its packages under `$HOME/.npm`, so a moved HOME turned every toolchain probe
 * into a cold download and blew the 10s timeout — doctor took 21s. Chasing each
 * third-party cache location is a guess that rots, so isolation stays at the
 * call sites that need it, and this guard is what keeps them honest.
 */
describe("credential isolation in tests", () => {
  it("pins HOME wherever a test can mutate real credentials", () => {
    // `logout` deletes the credentials file; `login` writes one. Neither may
    // touch the home of whoever runs the suite.
    const mutating = /\brun\(\s*["'`](logout|login)(\s|["'`])/;
    const offenders = testFiles()
      .filter((path) => {
        const source = readFileSync(path, "utf-8");
        return mutating.test(source) && !/HOME\s*:/.test(source);
      })
      .map((path) => relative(repoRoot, path));

    expect(offenders, "these spawn logout/login without pinning HOME").toEqual([]);
  });

  it("pins HOME wherever a test asserts on login state", () => {
    // "fails when not logged in" is only true while the runner is logged out.
    // The assertion is fine; inheriting the ambient answer is not.
    const assertsAuth = /not logged in|not currently logged in|unauthenticated/i;
    const offenders = testFiles()
      .filter((path) => {
        const source = readFileSync(path, "utf-8");
        if (!assertsAuth.test(source)) return false;
        // Only care when the file actually spawns the CLI.
        if (!/execSync|spawnSync|execFileSync/.test(source)) return false;
        return !/HOME\s*:/.test(source);
      })
      .map((path) => relative(repoRoot, path));

    expect(offenders, "these assert on login state without pinning HOME").toEqual([]);
  });

  it("gives every credential-touching call in token-expiry its own home", () => {
    // The file that regressed: two of its three cases passed a fake home and
    // the third did not, which is precisely how it went unnoticed.
    const source = readFileSync(
      join(repoRoot, "tests/resilience/token-expiry.test.ts"),
      "utf-8",
    );
    const calls = source.match(/\brun\(/g) ?? [];
    const homes = source.match(/HOME:\s*fakeHome/g) ?? [];

    // One run() is the helper definition itself; every real call site pins HOME.
    expect(calls.length).toBeGreaterThan(1);
    expect(homes.length).toBe(calls.length - 1);
  });
});
