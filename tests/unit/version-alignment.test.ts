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
  /** Writes both Status files. `zh` defaults to a translation naming the same
   *  version as `readme`, since that is the state the check demands; tests that
   *  care about divergence pass it explicitly. */
  function withReadme(readme: string, npmVersion: string, zh?: string | null) {
    const root = mkdtempSync(join(tmpdir(), "rotifer-readme-status-"));
    tempRoots.push(root);
    writeFile(join(root, "package.json"), JSON.stringify({ version: npmVersion }));
    writeFile(join(root, "README.md"), readme);
    if (zh !== null) {
      writeFile(join(root, "README.zh.md"), zh ?? mirrorInChinese(readme));
    }
    return root;
  }

  /** The Chinese Status line for whatever version the English one names. */
  function mirrorInChinese(readme: string) {
    const version = readme.match(/v(\d+)\.(\d+)/);
    return `> **状态：** v${version?.[1] ?? 0}.${version?.[2] ?? 0}.x——与英文版同一个版本的中文说明。`;
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

/**
 * README.zh.md drifted for three months — English at v0.25.x, Chinese still
 * describing v0.9.0's Open Mesh — while this very check passed on every run,
 * because it read one file and there were two. Found on 2026-09-06, by reading
 * the file rather than by anything reporting it.
 *
 * Each test below is a failure mode that was, until then, invisible.
 */
describe("README Status freshness — every translation, not just English", () => {
  function withBoth(en: string, zh: string | null, npmVersion: string) {
    const root = mkdtempSync(join(tmpdir(), "rotifer-readme-status-zh-"));
    tempRoots.push(root);
    writeFile(join(root, "package.json"), JSON.stringify({ version: npmVersion }));
    writeFile(join(root, "README.md"), en);
    if (zh !== null) writeFile(join(root, "README.zh.md"), zh);
    return root;
  }

  const EN = "> **Status:** v0.25.x — the fitness formula correction.";
  const ZH = "> **状态：** v0.25.x——适应度公式修正。";

  it("passes when both translations name the released minor", () => {
    expect(verifyReadmeStatusFreshness(withBoth(EN, ZH, "0.25.0")).ok).toBe(true);
  });

  it("fails on the drift that actually shipped: English current, Chinese sixteen minors behind", () => {
    const stale = "> **状态：** v0.9.0——Open Mesh + 经济基座。";
    const result = verifyReadmeStatusFreshness(withBoth(EN, stale, "0.25.0"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("README.zh.md");
    expect(result.errors.join("\n")).toContain("v0.9.x");
  });

  it("fails when the translations disagree even though each is within range on its own", () => {
    // 0.25 released, so both "this release" (0.25) and "the next" (0.26) pass
    // the per-file rule. Only comparing the files catches this.
    const next = "> **Status:** v0.26.x — being prepared.";
    const result = verifyReadmeStatusFreshness(withBoth(next, ZH, "0.25.0"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("disagree");
  });

  it("fails when a translation loses its Status line rather than reporting nothing to check", () => {
    const result = verifyReadmeStatusFreshness(withBoth(EN, "> 状态段被改写成了别的东西。", "0.25.0"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("README.zh.md");
  });

  it("fails when a listed translation is missing, instead of silently covering one less file", () => {
    const result = verifyReadmeStatusFreshness(withBoth(EN, null, "0.25.0"));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("README_STATUS_FILES");
  });

  it("names every file it checks, so a file cannot drop out of coverage unnoticed", async () => {
    const { README_STATUS_FILES } = await import("../../scripts/lib/version-alignment.mjs");
    expect(README_STATUS_FILES.map((f: { path: string }) => f.path)).toEqual([
      "README.md",
      "README.zh.md",
    ]);
  });
});
