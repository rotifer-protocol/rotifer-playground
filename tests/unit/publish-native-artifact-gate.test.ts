import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { publishSingleGene } from "../../src/commands/publish.js";
import type { CloudCredentials } from "../../src/cloud/types.js";

/**
 * A Native gene must not reach the registry without its compiled artifact.
 *
 * spec §4.2 defines NATIVE as "core logic compiled to Rotifer IR". Publishing
 * Native without `gene.ir.wasm` produces a record that installs — reporting
 * "Fidelity: Native" — and then cannot run: `rotifer run` reports "No runnable
 * source found". 62 of the 99 published Native genes are in exactly that state,
 * `grammar-checker` and `source-linker` among them; both were published
 * 2026-02-24 / 2026-03-17, months before the guard in publish.ts existed
 * (2026-08-22). The guard is therefore the thing standing between that history
 * and a repeat — and it had no test until this file.
 *
 * All three cases stay offline. publishSingleGene is purely local up to the
 * version check, so an intentionally malformed version stops the control case
 * before any network call: reaching "Invalid version format" is itself the
 * proof that the artifact gate let it through.
 *
 * See internal plan: chat-widget-genuine-dogfooding-plan.md (stage 0).
 */

const CREDS: CloudCredentials = {
  access_token: "test-token-not-used-offline",
  refresh_token: "test-refresh-not-used-offline",
  expires_at: Date.now() + 3_600_000,
  provider: "github",
  user: {
    id: "00000000-0000-0000-0000-000000000000",
    username: "offline-test",
    avatar_url: null,
    provider_id: "offline-test",
  },
};

const WASM_ERROR = /Native gene requires compiled WASM/;

let root: string;

function makeGene(
  name: string,
  phenotype: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phenotype.json"),
    JSON.stringify({ name, version: "0.1.0", ...phenotype }, null, 2),
  );
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

beforeEach(() => {
  root = join(tmpdir(), `publish-gate-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Native genes cannot be published without their compiled artifact", () => {
  it("blocks a Native gene that has no gene.ir.wasm", async () => {
    const dir = makeGene("no-artifact", { fidelity: "Native" });

    const result = await publishSingleGene(
      "no-artifact",
      dir,
      CREDS,
      { skipSecurity: true, skipArena: true, skipVg: true },
      true,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(WASM_ERROR);
  });

  it("does not fire for a Hybrid gene, which produces no WASM by design", async () => {
    // Control 1 — proves the gate keys on fidelity, not merely on a missing
    // file. `rotifer compile` says so explicitly for Hybrid: "runs under
    // Node.js with the network gateway; no WASM artifact is produced". This
    // gene is also missing allowedDomains, so it fails the Hybrid check
    // instead — a different, earlier branch, and still offline.
    const dir = makeGene("hybrid-no-artifact", { fidelity: "Hybrid" });

    const result = await publishSingleGene(
      "hybrid-no-artifact",
      dir,
      CREDS,
      { skipSecurity: true, skipArena: true, skipVg: true },
      true,
    );

    expect(result.status).toBe("failed");
    expect(result.error).not.toMatch(WASM_ERROR);
    expect(result.error).toMatch(/allowedDomains/);
  });

  it("lets a Native gene through once the artifact is present", async () => {
    // Control 2 — a gate that rejected everything would pass the first test
    // for the wrong reason. The malformed version is the offline stop: getting
    // as far as the version check means the artifact gate was cleared.
    const dir = makeGene(
      "with-artifact",
      { fidelity: "Native", version: "not-a-semver" },
      { "gene.ir.wasm": "\0asm\x01\x00\x00\x00" },
    );

    const result = await publishSingleGene(
      "with-artifact",
      dir,
      CREDS,
      { skipSecurity: true, skipArena: true, skipVg: true },
      true,
    );

    expect(result.status).toBe("failed");
    expect(result.error).not.toMatch(WASM_ERROR);
    expect(result.error).toMatch(/Invalid version format/);
  });
});
