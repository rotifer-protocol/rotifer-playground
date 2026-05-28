import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for Issue #50 "Inconsistency surfaced" — `versions` was
 * the only subcommand accepting `<owner> <gene-name>` as two positional
 * args while info/stats/compare/reputation accepted `@owner/name`. This
 * pins the new dual-accept behavior so the unification doesn't regress.
 */

const { listGeneVersionsMock } = vi.hoisted(() => ({
  listGeneVersionsMock: vi.fn(),
}));

vi.mock("../../src/cloud/client.js", () => ({
  listGeneVersions: listGeneVersionsMock,
}));

import { versionsCommand } from "../../src/commands/versions.js";

describe("versions command — dual ref syntax (Issue #50 inconsistency)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    listGeneVersionsMock.mockResolvedValue([
      {
        id: "v1-uuid",
        version: "0.1.0",
        changelog: null,
        previous_version_id: null,
        created_at: "2026-05-28T00:00:00Z",
      },
    ]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    listGeneVersionsMock.mockReset();
  });

  it("accepts the legacy <owner> <gene-name> two-arg form", async () => {
    await versionsCommand.parseAsync(["alice", "my-gene"], { from: "user" });

    expect(listGeneVersionsMock).toHaveBeenCalledTimes(1);
    expect(listGeneVersionsMock).toHaveBeenCalledWith("alice", "my-gene");
  });

  it("accepts the new @owner/name single-arg form (unified with info/stats/compare)", async () => {
    await versionsCommand.parseAsync(["@alice/my-gene"], { from: "user" });

    expect(listGeneVersionsMock).toHaveBeenCalledTimes(1);
    expect(listGeneVersionsMock).toHaveBeenCalledWith("alice", "my-gene");
  });

  it("rejects mixing both forms (@owner/name + extra positional)", async () => {
    await expect(
      versionsCommand.parseAsync(["@alice/my-gene", "extra"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");

    expect(listGeneVersionsMock).not.toHaveBeenCalled();
  });

  it("rejects single bare argument that is neither @owner/name nor followed by name", async () => {
    // commander treats `[gene-name]` as optional, so a single bare `alice`
    // (no @ prefix, no second arg) must be rejected — otherwise the user
    // would get a confusing error from listGeneVersions(undefined, ...).
    await expect(
      versionsCommand.parseAsync(["alice"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");

    expect(listGeneVersionsMock).not.toHaveBeenCalled();
  });

  it("preserves owner/name normalization when @owner/name contains dashes and dots", async () => {
    await versionsCommand.parseAsync(["@xiaoba-dev/scope-cli.v2"], {
      from: "user",
    });

    expect(listGeneVersionsMock).toHaveBeenCalledWith(
      "xiaoba-dev",
      "scope-cli.v2",
    );
  });
});
