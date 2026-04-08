import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyRustVersionAlignment } from "../../scripts/lib/version-alignment.mjs";

const tempRoots: string[] = [];

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function createFixture(options?: {
  workspaceVersion?: string;
  napiPackageVersion?: string;
  rotiferCoreDependencyVersion?: string;
  corePublish?: boolean;
  napiPublish?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "rotifer-version-alignment-"));
  tempRoots.push(root);

  const workspaceVersion = options?.workspaceVersion ?? "0.5.0";
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
