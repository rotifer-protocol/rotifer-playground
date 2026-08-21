import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  verifyRustVersionAlignment,
  verifyReadmeStatusFreshness,
} from "../../scripts/lib/version-alignment.mjs";

const tempRoots: string[] = [];

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "win32-x64-msvc"];

function createFixture(options?: {
  workspaceVersion?: string;
  npmVersion?: string;
  napiPackageVersion?: string;
  rotiferCoreDependencyVersion?: string;
  corePublish?: boolean;
  napiPublish?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "rotifer-version-alignment-"));
  tempRoots.push(root);

  const workspaceVersion = options?.workspaceVersion ?? "0.5.0";
  const npmVersion = options?.npmVersion ?? workspaceVersion;
  const napiPackageVersion = options?.napiPackageVersion ?? workspaceVersion;
  const rotiferCoreDependencyVersion = options?.rotiferCoreDependencyVersion ?? workspaceVersion;
  const corePublish = options?.corePublish ?? false;
  const napiPublish = options?.napiPublish ?? false;

  writeFile(
    join(root, "Cargo.toml"),
    `[workspace]
members = ["crates/rotifer-core", "crates/rotifer-napi"]
resolver = "2"

[workspace.package]
version = "${workspaceVersion}"
edition = "2024"
license = "Apache-2.0"
repository = "https://github.com/rotifer-protocol/rotifer-playground"
`,
  );

  const optDeps: Record<string, string> = {};
  for (const p of PLATFORMS) {
    optDeps[`@rotifer/playground-${p}`] = npmVersion;
  }
  writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "@rotifer/playground", version: npmVersion, optionalDependencies: optDeps }, null, 2) + "\n",
  );

  for (const p of PLATFORMS) {
    writeFile(
      join(root, "npm", p, "package.json"),
      JSON.stringify({ name: `@rotifer/playground-${p}`, version: npmVersion }, null, 2) + "\n",
    );
  }

  writeFile(
    join(root, "crates/rotifer-core/Cargo.toml"),
    `[package]
name = "rotifer-core"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = ${String(corePublish)}
description = "Core"
`,
  );

  writeFile(
    join(root, "crates/rotifer-napi/Cargo.toml"),
    `[package]
name = "rotifer-napi"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = ${String(napiPublish)}
description = "NAPI"

[dependencies]
rotifer-core = { version = "${rotiferCoreDependencyVersion}", path = "../rotifer-core" }
`,
  );

  writeFile(
    join(root, "crates/rotifer-napi/package.json"),
    `${JSON.stringify({ name: "rotifer-napi", version: napiPackageVersion }, null, 2)}\n`,
  );

  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("verifyRustVersionAlignment", () => {
  it("passes when workspace, napi package, and publish flags are aligned", () => {
    const root = createFixture();

    expect(verifyRustVersionAlignment(root)).toEqual({
      ok: true,
      workspaceVersion: "0.5.0",
      errors: [],
    });
  });

  it("fails when rotifer-napi package.json drifts from the Rust workspace version", () => {
    const root = createFixture({ napiPackageVersion: "0.4.0-alpha.1" });

    const result = verifyRustVersionAlignment(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "crates/rotifer-napi/package.json: expected version 0.5.0, got 0.4.0-alpha.1",
    );
  });

  it("fails when rotifer-core dependency version drifts from the Rust workspace version", () => {
    const root = createFixture({ rotiferCoreDependencyVersion: "0.5.0-alpha.1" });

    const result = verifyRustVersionAlignment(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "crates/rotifer-napi/Cargo.toml: expected rotifer-core version 0.5.0, got 0.5.0-alpha.1",
    );
  });

  it("fails when crate publish guards are missing", () => {
    const root = createFixture({ corePublish: true, napiPublish: true });

    const result = verifyRustVersionAlignment(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("crates/rotifer-core/Cargo.toml: expected publish = false");
    expect(result.errors).toContain("crates/rotifer-napi/Cargo.toml: expected publish = false");
  });
});

/**
 * The README's `Status:` line is the paragraph npm prints under the package
 * title, and it is hand-written. On 2026-08-21 the npm page showed 0.19.2 above
 * a paragraph describing v0.10.1's P2P work — nine days and thirty-six
 * changelog entries stale, while the real work had moved to Arena integrity.
 * The badge beside it was right because it is generated; the sentence was the
 * project's public first impression and nobody owned keeping it true.
 *
 * The interesting assertions here are the ones where the check must stay quiet.
 * A guard that fires on a patch release trains people to bump the number and
 * move on, and a guard that fires on the roadmap's protocol-line versions —
 * a separate numbering line that is *meant* to differ — gets deleted.
 */
describe("README Status freshness", () => {
  function withReadme(readme: string, npmVersion: string) {
    const root = mkdtempSync(join(tmpdir(), "rotifer-readme-status-"));
    tempRoots.push(root);
    writeFile(join(root, "package.json"), JSON.stringify({ version: npmVersion }));
    writeFile(join(root, "README.md"), readme);
    return root;
  }

  const CURRENT = "> **Status:** v0.19.x — Arena integrity, on top of v0.9's Open Mesh.";

  it("passes when the Status line names the released minor", () => {
    const result = verifyReadmeStatusFreshness(withReadme(CURRENT, "0.19.2"));
    expect(result.ok).toBe(true);
  });

  it("stays quiet across a patch release, so the red lands only when the phase moved", () => {
    const result = verifyReadmeStatusFreshness(withReadme(CURRENT, "0.19.9"));
    expect(result.ok).toBe(true);
  });

  it("fails on the drift that was actually shipped, and says not to bump the number alone", () => {
    const stale = "> **Status:** v0.10.1 — P2P Reliability on top of v0.9's Open Mesh.";
    const result = verifyReadmeStatusFreshness(withReadme(stale, "0.19.2"));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("describes v0.10.x but the released version is 0.19.2");
    expect(result.errors[0]).toContain("Do not bump the number alone");
  });

  it("fails on a minor bump, which is where a re-read is owed", () => {
    const result = verifyReadmeStatusFreshness(withReadme(CURRENT, "0.20.0"));
    expect(result.ok).toBe(false);
    // Pin WHICH complaint fires. Without this the test passes even when the
    // behind-check is gone entirely, because a stale line also trips the
    // ahead-check from the other side — red for the wrong reason, and the
    // message a reader gets would tell them the opposite of what to do.
    expect(result.errors[0]).toContain("Do not bump the number alone");
  });

  // The tolerance below is the whole reason this check has a workable shape.
  // Requiring equality made the paragraph editable only on release-please's
  // branch — updating it on main turned main red, because main's package.json
  // still holds the previous number all cycle. That is not a hypothetical: it
  // blocked the v0.20.0 release PR on the day the check shipped.
  it("lets main carry the paragraph for the release being prepared", () => {
    const ahead = "> **Status:** v0.20.x — The authoring Skills get public source.";
    const result = verifyReadmeStatusFreshness(withReadme(ahead, "0.19.2"));
    expect(result.ok).toBe(true);
  });

  it("still fails when the Status line runs further out than the next release", () => {
    const tooFar = "> **Status:** v0.21.x — a phase nobody can install yet.";
    const result = verifyReadmeStatusFreshness(withReadme(tooFar, "0.19.2"));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("beyond the next release");
  });

  it("counts the next major as the next release, since release-please can bump there", () => {
    const nextMajor = "> **Status:** v1.0.x — Stable release: L0-L3 complete.";
    const result = verifyReadmeStatusFreshness(withReadme(nextMajor, "0.19.2"));
    expect(result.ok).toBe(true);
  });

  it("does not let a major jump smuggle the check into permanent silence", () => {
    // v9.9 would otherwise sit ahead of every release this repo will ever cut.
    const distant = "> **Status:** v9.9.x — quiet forever.";
    const result = verifyReadmeStatusFreshness(withReadme(distant, "0.19.2"));
    expect(result.ok).toBe(false);
  });

  it("reads a Status line left behind by a major release as behind, not ahead", () => {
    const result = verifyReadmeStatusFreshness(withReadme(CURRENT, "1.0.0"));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Do not bump the number alone");
  });

  it("ignores the roadmap's protocol-line versions, which are meant to differ", () => {
    // These sit further down the same README. They track the protocol, not the
    // npm releases; matching them would make the check fire forever.
    const readme = [
      CURRENT,
      "",
      "- **v0.9** — economic framework design",
      "- **v0.9.1** — P2P network (metadata discovery)",
      "- **v1.0** — Stable release: L0-L3 complete",
    ].join("\n");
    const result = verifyReadmeStatusFreshness(withReadme(readme, "0.19.2"));
    expect(result.ok).toBe(true);
  });

  it("fails loudly when the Status line is gone, rather than passing on nothing found", () => {
    const result = verifyReadmeStatusFreshness(withReadme("> **Note:** moved.", "0.19.2"));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("re-point this check at it");
  });
});
