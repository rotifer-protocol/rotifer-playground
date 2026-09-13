import { describe, it, expect } from "vitest";
import { checkNativeArtifact } from "../../src/utils/artifact-consistency.js";

/**
 * 62 registry rows declare Native with no artifact. Installing one succeeds and
 * reports "Fidelity: Native"; running it then fails. Both commands that meet
 * this case said nothing about it, so the user was left to conclude their own
 * setup was broken.
 */
const base = { geneName: "grammar-checker", hasArtifact: false, hasSource: false };

describe("a Gene declaring Native with nothing to run is a contradiction", () => {
  it("is flagged, and named as the Gene's defect rather than the user's setup", () => {
    const v = checkNativeArtifact({ ...base, fidelity: "Native" });
    expect(v.status).toBe("native-without-artifact");
    // The wording carries the weight: a user who reads "not your setup" stops
    // debugging their environment.
    expect((v as { hint: string[] }).hint.join(" ")).toMatch(/not your setup/);
    expect((v as { message: string }).message).toMatch(/No runnable source found/);
  });

  it("says nothing when the artifact is there", () => {
    expect(checkNativeArtifact({ ...base, fidelity: "Native", hasArtifact: true }).status)
      .toBe("consistent");
  });

  it("says nothing when source is present — that compiles into an artifact", () => {
    // A working local Gene before its first compile. Warning here would fire on
    // the normal path, and a warning that fires on the normal path gets ignored
    // on the one that matters.
    expect(checkNativeArtifact({ ...base, fidelity: "Native", hasSource: true }).status)
      .toBe("consistent");
  });

  it("says nothing for Wrapped or Hybrid, which are not required to carry one", () => {
    for (const fidelity of ["Wrapped", "Hybrid", undefined]) {
      expect(checkNativeArtifact({ ...base, fidelity }).status, `${fidelity}`).toBe("consistent");
    }
  });
});
