/**
 * Does a Gene's declared fidelity match what is actually on disk / in the
 * registry record?
 *
 * spec §4.2 defines NATIVE as "core logic compiled to Rotifer IR". A record
 * declaring Native with no artifact is therefore self-contradicting, and until
 * 2026-09-07 both commands that meet one said nothing about it:
 *
 *   install  downloaded nothing (no else branch on `if (gene.wasm_url)`) and
 *            then reported "Gene installed! Fidelity: Native" — for a Gene that
 *            answers `rotifer run` with "No runnable source found".
 *   compile  wrote `.compile-result.json` with `fidelity: "Wrapped"` while
 *            leaving phenotype.json saying Native, and reported *success*:
 *            "validated (Wrapped fidelity)". Two files in one directory
 *            disagreeing, and a green tick over a Gene that cannot run.
 *
 * The judgement lives here, apart from the commands, so it can be tested
 * without a network or a compiler.
 */

export type ArtifactVerdict =
  | { status: "consistent" }
  /** Declared Native, nothing to run. The Gene cannot do what it claims. */
  | { status: "native-without-artifact"; message: string; hint: string[] };

export function checkNativeArtifact(input: {
  geneName: string;
  fidelity: string | undefined;
  /** A compiled artifact is present (installed .wasm, or a registry wasm_url). */
  hasArtifact: boolean;
  /** Source is present, so the Gene can still be compiled locally. */
  hasSource: boolean;
}): ArtifactVerdict {
  if (input.fidelity !== "Native") return { status: "consistent" };
  if (input.hasArtifact) return { status: "consistent" };

  // Source but no artifact is a normal working state — it compiles into one.
  // Only the case with neither is a Gene that claims Native and cannot be.
  if (input.hasSource) return { status: "consistent" };

  return {
    status: "native-without-artifact",
    message:
      `'${input.geneName}' declares fidelity Native but ships no compiled artifact. ` +
      `spec §4.2 defines Native as core logic compiled to Rotifer IR, so this Gene ` +
      `cannot run: 'rotifer run ${input.geneName}' will report "No runnable source found".`,
    hint: [
      `This is the Gene's own defect, not your setup — nothing you can configure fixes it.`,
      `Ask its author to republish with the artifact, or pick another Gene.`,
    ],
  };
}
