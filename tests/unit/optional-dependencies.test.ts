import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Everything in the published package's `optionalDependencies` is installed
 * on users' machines. The only things that belong there are our own native
 * bindings, one package per platform under npm/.
 *
 * `@rolldown/binding-linux-x64-gnu` sat there from 0.8.5 to 0.33.0: a CI
 * workaround (2026-04-08, for npm dropping other platforms' optional
 * bindings from a lockfile written on macOS) that every Linux user then
 * installed too — a build tool's binary they never run. The release
 * workflows only look at `@rotifer/playground-*` names, so nothing noticed.
 */

const ROOT = join(__dirname, "../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8"));

/** The platform packages this repo builds and publishes, from npm/<platform>/. */
const platformPackages = readdirSync(join(ROOT, "npm"))
  .filter((dir) => existsSync(join(ROOT, "npm", dir, "package.json")))
  .map((dir) => JSON.parse(readFileSync(join(ROOT, "npm", dir, "package.json"), "utf-8")).name as string)
  .sort();

describe("optionalDependencies", () => {
  it("holds only @rotifer/playground-* platform packages", () => {
    const foreign = Object.keys(pkg.optionalDependencies ?? {}).filter(
      (name) => !name.startsWith("@rotifer/playground-"),
    );
    expect(foreign, "these would be installed on every user's machine").toEqual([]);
  });

  it("is exactly the platform packages under npm/", () => {
    expect(platformPackages.length).toBeGreaterThan(0);
    expect(Object.keys(pkg.optionalDependencies ?? {}).sort()).toEqual(platformPackages);
  });

  it("matches the lockfile's root entry", () => {
    expect(lock.packages[""].optionalDependencies).toEqual(pkg.optionalDependencies);
  });
});
