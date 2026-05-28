import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for Issue #50 Bug 3 — `rotifer reputation @username`
 * routed straight into the gene-reputation path with a bogus UUID
 * (PostgREST then errored with "invalid input syntax for type uuid").
 *
 * The new behavior:
 *   @username           → getProfileByUsername → getDeveloperReputation
 *   @owner/name | UUID  → getGene (resolves to UUID) → getGeneReputation
 */

const {
  getGeneMock,
  getGeneReputationMock,
  getDeveloperReputationMock,
  getProfileByUsernameMock,
  getReputationLeaderboardMock,
} = vi.hoisted(() => ({
  getGeneMock: vi.fn(),
  getGeneReputationMock: vi.fn(),
  getDeveloperReputationMock: vi.fn(),
  getProfileByUsernameMock: vi.fn(),
  getReputationLeaderboardMock: vi.fn(),
}));

vi.mock("../../src/cloud/client.js", () => ({
  getGene: getGeneMock,
  getGeneReputation: getGeneReputationMock,
  getDeveloperReputation: getDeveloperReputationMock,
  getProfileByUsername: getProfileByUsernameMock,
  getReputationLeaderboard: getReputationLeaderboardMock,
}));

import { reputationCommand } from "../../src/commands/reputation.js";

describe("reputation command routing (Issue #50 Bug 3)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // process.exit(1) terminates the test runner; convert to a throw so
    // tests can assert the failure path without aborting the whole suite.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    getGeneMock.mockReset();
    getGeneReputationMock.mockReset();
    getDeveloperReputationMock.mockReset();
    getProfileByUsernameMock.mockReset();
    getReputationLeaderboardMock.mockReset();
  });

  it("@username routes to creator-reputation (NOT gene-reputation)", async () => {
    getProfileByUsernameMock.mockResolvedValue({
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      username: "alice",
      avatar_url: null,
    });
    getDeveloperReputationMock.mockResolvedValue({
      score: 0.65,
      genes_published: 5,
      total_downloads: 1234,
      arena_wins: 3,
      community_bonus: 0.06,
    });

    await reputationCommand.parseAsync(["@alice"], { from: "user" });

    expect(getProfileByUsernameMock).toHaveBeenCalledTimes(1);
    expect(getProfileByUsernameMock).toHaveBeenCalledWith("alice");
    expect(getDeveloperReputationMock).toHaveBeenCalledTimes(1);
    expect(getDeveloperReputationMock).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    // These MUST stay unused on the @username path
    expect(getGeneMock).not.toHaveBeenCalled();
    expect(getGeneReputationMock).not.toHaveBeenCalled();
  });

  it("@username with no matching profile shows error (does NOT call developer-reputation)", async () => {
    getProfileByUsernameMock.mockResolvedValue(null);

    await expect(
      reputationCommand.parseAsync(["@nobody"], { from: "user" }),
    ).rejects.toThrow("process.exit:1");

    expect(getProfileByUsernameMock).toHaveBeenCalledTimes(1);
    expect(getDeveloperReputationMock).not.toHaveBeenCalled();
  });

  it("@owner/name resolves via getGene first, then passes the UUID to getGeneReputation", async () => {
    getGeneMock.mockResolvedValue({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      name: "scope-cli-2026",
      owner: "xiaoba-dev",
    });
    getGeneReputationMock.mockResolvedValue({
      gene_name: "scope-cli-2026",
      score: 0.42,
      arena_score: 0.5,
      usage_score: 0.3,
      stability_score: 0.4,
      epoch: 2,
      computed_at: "2026-05-28T00:00:00Z",
    });

    await reputationCommand.parseAsync(["@xiaoba-dev/scope-cli-2026"], {
      from: "user",
    });

    expect(getGeneMock).toHaveBeenCalledTimes(1);
    expect(getGeneMock).toHaveBeenCalledWith("@xiaoba-dev/scope-cli-2026");
    expect(getGeneReputationMock).toHaveBeenCalledTimes(1);
    // Critically: getGeneReputation MUST receive the resolved UUID, not
    // the original `@owner/name` string (which would re-trigger Bug 3).
    expect(getGeneReputationMock).toHaveBeenCalledWith(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
    expect(getProfileByUsernameMock).not.toHaveBeenCalled();
  });

  it("UUID input still resolves via getGene → getGeneReputation pipeline", async () => {
    getGeneMock.mockResolvedValue({
      id: "11111111-1111-1111-1111-111111111111",
      name: "some-gene",
      owner: "alice",
    });
    getGeneReputationMock.mockResolvedValue({
      gene_name: "some-gene",
      score: 0.1,
      arena_score: 0.1,
      usage_score: 0.1,
      stability_score: 0.1,
      epoch: 1,
      computed_at: "2026-05-28T00:00:00Z",
    });

    await reputationCommand.parseAsync(
      ["11111111-1111-1111-1111-111111111111"],
      { from: "user" },
    );

    expect(getGeneMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(getGeneReputationMock).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
    );
    expect(getProfileByUsernameMock).not.toHaveBeenCalled();
  });

  it("--leaderboard ignores ref routing entirely", async () => {
    getReputationLeaderboardMock.mockResolvedValue([
      {
        username: "alice",
        avatar_url: null,
        score: 0.8,
        genes_published: 3,
        total_downloads: 100,
        arena_wins: 2,
      },
    ]);

    await reputationCommand.parseAsync(["--leaderboard"], { from: "user" });

    expect(getReputationLeaderboardMock).toHaveBeenCalledTimes(1);
    expect(getProfileByUsernameMock).not.toHaveBeenCalled();
    expect(getGeneMock).not.toHaveBeenCalled();
  });
});
