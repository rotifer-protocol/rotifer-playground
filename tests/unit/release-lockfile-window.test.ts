/**
 * The release lockfile window, and the three guards that watch it.
 *
 * `npm install --package-lock-only` cannot write a lockfile entry for a package
 * that is not on the registry yet — and it does not fail when asked to. It drops
 * the entry and exits 0. The four `@rotifer/playground-*` platform packages are
 * published from the tag that the release PR creates, so on a release branch
 * they always drop, and the job that regenerates the lock there has been
 * committing that deletion under the word "sync" since v0.11.0.
 *
 * What lands on main is a lock whose root manifest asks for v0.18.0 platform
 * packages while carrying no entry for them at all, and `npm ci` refuses it:
 *
 *     npm error Missing: @rotifer/playground-win32-x64-msvc@0.18.0 from lock file
 *
 * Three of the five checks branch protection requires run `npm ci`, so from that
 * moment every open PR is unmergeable through no fault of its own, until the
 * post-publish sync PR restores the entries. That wait was 17 minutes after
 * v0.18.0, 13 hours after v0.15.0, and never for v0.10.2, v0.11.0 and v0.14.0,
 * whose sync PRs were closed unmerged and repaired by hand.
 *
 * The window itself cannot be closed — `resolved` and `integrity` need a
 * published tarball — so the workflows instead (1) say out loud on the release
 * branch which entries were dropped, (2) tell a contributor mid-window that the
 * red is not theirs, and (3) confirm after the repair merges that main really
 * does install again. Those three guards live inside workflow YAML, where
 * nothing type-checks them and nothing runs them until a release is underway.
 * This file runs them.
 *
 * Every case has its opposite. A guard that is asserted only on the input it
 * was written for cannot be distinguished from a guard that returns a constant.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();

const PLATFORM_PACKAGES = [
  "@rotifer/playground-darwin-arm64",
  "@rotifer/playground-darwin-x64",
  "@rotifer/playground-linux-x64-gnu",
  "@rotifer/playground-win32-x64-msvc",
] as const;

interface LockEntry {
  version?: string;
  integrity?: string;
  resolved?: string;
  optional?: boolean;
  optionalDependencies?: Record<string, string>;
}

interface Lockfile {
  packages: Record<string, LockEntry>;
}

/**
 * Lift a `node -e '...'` guard out of a workflow by the step that owns it.
 *
 * Failing to find one is a test failure, not a skip: a guard that cannot be
 * located cannot be checked, and quietly passing anyway is how a suite stops
 * meaning anything. If a step is renamed or restructured, this fails and asks
 * for the guard to be re-verified — which is the point.
 */
function guardFrom(workflow: string, stepName: string, nth = 0): string {
  const text = readFileSync(join(ROOT, ".github/workflows", workflow), "utf-8");
  const stepAt = text.indexOf(`- name: ${stepName}`);
  expect(stepAt, `step "${stepName}" is gone from ${workflow}`).toBeGreaterThanOrEqual(0);

  let rest = text.slice(stepAt);
  const marker = "node -e '";
  for (let seen = 0; seen < nth; seen += 1) {
    const at = rest.indexOf(marker);
    expect(at, `${workflow} "${stepName}" has fewer than ${nth + 1} guards`).toBeGreaterThanOrEqual(0);
    rest = rest.slice(at + marker.length);
  }

  const open = rest.indexOf(marker);
  expect(open, `no node -e guard under "${stepName}" in ${workflow}`).toBeGreaterThanOrEqual(0);
  const body = rest.slice(open + marker.length);
  const close = body.indexOf("'");
  expect(close, "unterminated node -e guard").toBeGreaterThan(0);
  return body.slice(0, close);
}

function runGuard(source: string, options: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const stdout = execFileSync("node", ["-e", source], {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      encoding: "utf-8",
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "" };
  }
}

/**
 * The repo's own lockfile, in whatever state it happens to be.
 *
 * Read it for shape, never for health. Between a release landing and its lock
 * repair, this file IS the window state — the exact condition under test. The
 * first version of this file used it directly as the healthy fixture, and so
 * failed on the v0.19.0 release commit and blocked the publish. A fixture may
 * not assume the absence of the thing it exists to describe.
 */
function repoLock(): Lockfile {
  return JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8")) as Lockfile;
}

/** The version the root manifest asks for — true in both states, so safe to read. */
function releasedVersion(): string {
  const declared = repoLock().packages[""].optionalDependencies ?? {};
  const version = declared[PLATFORM_PACKAGES[0]];
  expect(version, "the root manifest no longer declares the platform packages").toBeTruthy();
  return version as string;
}

/** A lock that covers every platform package, whichever state the repo is in. */
function healthyLock(): Lockfile {
  const lock = repoLock();
  const version = releasedVersion();
  for (const name of PLATFORM_PACKAGES) {
    const path = `node_modules/${name}`;
    lock.packages[path] = {
      ...(lock.packages[path] ?? {}),
      version,
      resolved: lock.packages[path]?.resolved ?? `https://registry.npmjs.org/${name}/-/fixture-${version}.tgz`,
      integrity: lock.packages[path]?.integrity ?? "sha512-fixture",
      optional: true,
    };
  }
  return lock;
}

/** Exactly what `npm install --package-lock-only` leaves on a release branch. */
function releaseWindowLock(): Lockfile {
  const lock = healthyLock();
  for (const name of PLATFORM_PACKAGES) delete lock.packages[`node_modules/${name}`];
  return lock;
}

/** An ordinary contributor's drift: some unrelated dependency moved. */
function unrelatedDrift(lock: Lockfile): Lockfile {
  const victim = Object.keys(lock.packages).find(
    (path) => path.startsWith("node_modules/") && !path.includes("@rotifer/playground-") && lock.packages[path].version,
  );
  expect(victim, "no third-party entry to perturb").toBeTruthy();
  lock.packages[victim as string].version = "9.9.9";
  return lock;
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lockwindow-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the fixtures themselves", () => {
  // This suite is only meaningful if its two fixtures actually differ in the way
  // the guards look for. They did not, on a release commit, and three tests then
  // failed the v0.19.0 publish. Check the premise before checking the guards.
  it("differ in exactly the four platform entries, in either repo state", () => {
    const healthy = healthyLock();
    const window = releaseWindowLock();
    const paths = new Set([...Object.keys(healthy.packages), ...Object.keys(window.packages)]);
    const changed = [...paths].filter(
      (path) => JSON.stringify(healthy.packages[path]) !== JSON.stringify(window.packages[path]),
    );
    expect(changed.sort()).toEqual(PLATFORM_PACKAGES.map((name) => `node_modules/${name}`).sort());
  });

  it("gives the healthy fixture a resolvable entry for every platform package", () => {
    const healthy = healthyLock();
    const version = releasedVersion();
    for (const name of PLATFORM_PACKAGES) {
      const entry = healthy.packages[`node_modules/${name}`];
      expect(entry, `healthy fixture is missing ${name}`).toBeTruthy();
      expect(entry.version).toBe(version);
      expect(entry.integrity).toBeTruthy();
    }
  });
});

describe("the release-branch guard names what npm dropped", () => {
  const guard = guardFrom("release-please.yml", "Commit the lockfiles if they moved");

  it("lists every platform package whose entry npm silently removed", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(releaseWindowLock(), null, 2));
      const { code, stdout } = runGuard(guard, { cwd: dir });
      expect(code).toBe(0);
      for (const name of PLATFORM_PACKAGES) expect(stdout).toContain(name);
    });
  });

  it("says nothing when the lock is whole", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(healthyLock(), null, 2));
      const { code, stdout } = runGuard(guard, { cwd: dir });
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("");
    });
  });
});

describe("the post-publish verifier checks that main installs, not that a PR merged", () => {
  const guard = guardFrom("release.yml", "Verify main's lockfile now resolves the released platform packages", 1);
  const version = releasedVersion();

  function underGuard(lock: Lockfile, forVersion: string) {
    return withTempDir((dir) => {
      const path = join(dir, "main-lock.json");
      writeFileSync(path, JSON.stringify(lock, null, 2));
      // The workflow hands it a fixed path; point the same guard at the fixture.
      return runGuard(guard.replace("/tmp/main-lock.json", path), { env: { VERSION: forVersion } });
    });
  }

  it("passes once every platform package resolves at the released version", () => {
    const { code, stdout } = underGuard(healthyLock(), version);
    expect(code).toBe(0);
    expect(stdout).toContain(`platform packages at v${version}`);
  });

  it("fails and names each package still missing from the lock", () => {
    const { code, stdout } = underGuard(releaseWindowLock(), version);
    expect(code).toBe(1);
    for (const name of PLATFORM_PACKAGES) expect(stdout).toContain(name);
  });

  it("fails when the entries are present but pin a different version", () => {
    // Without this the guard could pass on any lock that merely mentions them,
    // which is the state a stale sync PR would leave behind.
    const { code } = underGuard(healthyLock(), "0.0.0-not-this-release");
    expect(code).toBe(1);
  });
});

describe("CI can tell a contributor the red is not theirs", () => {
  const guard = guardFrom("ci.yml", "Lockfiles must already match the manifests");

  function inRepo(committed: Lockfile, working: Lockfile): string {
    return withTempDir((dir) => {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
          cwd: dir,
          stdio: "pipe",
        });
      git("init", "-q", ".");
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(committed, null, 2));
      git("add", "package-lock.json");
      git("commit", "-q", "-m", "committed state");
      // What the regeneration step leaves in the working tree.
      writeFileSync(join(dir, "package-lock.json"), JSON.stringify(working, null, 2));
      return runGuard(guard, { cwd: dir }).stdout.trim();
    });
  }

  it("recognises the window: only the platform entries came back", () => {
    expect(inRepo(releaseWindowLock(), healthyLock())).toBe("yes");
  });

  it("does not claim the window when an unrelated dependency also moved", () => {
    expect(inRepo(releaseWindowLock(), unrelatedDrift(healthyLock()))).toBe("no");
  });

  it("does not claim the window for ordinary lock drift", () => {
    expect(inRepo(healthyLock(), unrelatedDrift(healthyLock()))).toBe("no");
  });
});
