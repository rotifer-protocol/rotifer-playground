import { describe, expect, it } from "vitest";
import { splitVersionSuffix, chooseVersion } from "../../src/commands/unpublish.js";
import type { OwnedGeneVersion } from "../../src/cloud/client.js";

/**
 * ADR-319 plan item 2.6. Unpublish is the supported way for an author to take a
 * version down, which is *why* the invalidation criteria refuse to penalise a
 * gene anonymous callers cannot read: an unreadable gene is an unpublished one,
 * not a defective one. So this path has to actually work, and has to be
 * distinguishable from doing nothing.
 */

function v(version: string, published = true, created = "2026-08-01T00:00:00Z"): OwnedGeneVersion {
  return { id: `id-${version}`, name: "demo", version, published, created_at: created };
}

describe("splitVersionSuffix", () => {
  it("splits a trailing version", () => {
    expect(splitVersionSuffix("markdown-formatter@0.2.0")).toEqual({
      name: "markdown-formatter",
      version: "0.2.0",
    });
  });

  it("leaves a bare name alone", () => {
    expect(splitVersionSuffix("markdown-formatter")).toEqual({
      name: "markdown-formatter",
      version: null,
    });
  });

  /** `@owner/name` is a whole reference, not a name with a version stuck on it. */
  it("does not mistake an owner prefix for a version", () => {
    expect(splitVersionSuffix("@alice/markdown-formatter")).toEqual({
      name: "@alice/markdown-formatter",
      version: null,
    });
  });

  it("splits a version off an owner-qualified reference", () => {
    expect(splitVersionSuffix("@alice/markdown-formatter@1.0.0")).toEqual({
      name: "@alice/markdown-formatter",
      version: "1.0.0",
    });
  });

  it("treats a dangling @ as no version", () => {
    expect(splitVersionSuffix("demo@")).toEqual({ name: "demo", version: null });
  });

  it("trims surrounding whitespace", () => {
    expect(splitVersionSuffix("  demo@1.0.0  ")).toEqual({ name: "demo", version: "1.0.0" });
  });
});

describe("chooseVersion", () => {
  it("reports a gene the caller does not own", () => {
    expect(chooseVersion([], null).reason).toBe("no-such-gene");
  });

  it("takes the exact version when one is named", () => {
    const versions = [v("2.0.0"), v("1.0.0")];
    expect(chooseVersion(versions, "1.0.0").chosen?.version).toBe("1.0.0");
  });

  it("reports a version the caller does not have", () => {
    expect(chooseVersion([v("1.0.0")], "9.9.9").reason).toBe("no-such-version");
  });

  /**
   * "Unpublish my gene" is about what people can currently see. Picking the
   * newest of any state would let a repeated command report success while the
   * visible version stayed up.
   */
  it("skips already-unpublished versions when none is named", () => {
    const versions = [
      v("3.0.0", false, "2026-08-03T00:00:00Z"),
      v("2.0.0", true, "2026-08-02T00:00:00Z"),
      v("1.0.0", true, "2026-08-01T00:00:00Z"),
    ];
    expect(chooseVersion(versions, null).chosen?.version).toBe("2.0.0");
  });

  it("takes the newest published version when none is named", () => {
    const versions = [
      v("2.0.0", true, "2026-08-02T00:00:00Z"),
      v("1.0.0", true, "2026-08-01T00:00:00Z"),
    ];
    expect(chooseVersion(versions, null).chosen?.version).toBe("2.0.0");
  });

  it("says so rather than acting when everything is already down", () => {
    const result = chooseVersion([v("1.0.0", false)], null);
    expect(result.chosen).toBeNull();
    expect(result.reason).toBe("all-unpublished");
  });

  /** Naming an already-down version is a no-op, not a second takedown. */
  it("refuses to re-unpublish a named version that is already down", () => {
    const result = chooseVersion([v("1.0.0", false)], "1.0.0");
    expect(result.chosen).toBeNull();
    expect(result.reason).toBe("already-unpublished");
  });
});
