import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { shouldAutoPublish } from "../utils/user-config.js";
import { isLoggedIn, requireAuth } from "../cloud/auth.js";
import { publishSingleGene } from "../commands/publish.js";

/**
 * Offer to publish a freshly wrapped Gene to Rotifer Cloud, defaulting to yes.
 *
 * This is ADR-247 R3 ("自家通道默认上链", 6:0) finally reaching the CLI. The
 * config knob it reads — `default-publish`, plus the ROTIFER_AUTO_PUBLISH
 * override — shipped in c7983de on 2026-05-15 along with ten passing unit
 * tests, and was then never called from anywhere: `shouldAutoPublish()` had
 * zero production call sites for three and a half months while both the plan
 * and the changelog recorded §3.4 as delivered. The knob was real; the
 * behaviour it was supposed to gate did not exist. Nothing about that is
 * visible from a green test run, which is the whole reason this comment names
 * the commit.
 *
 * The decision says "prompt, default Y" — not "publish silently". That
 * distinction is load-bearing, and the gate below exists to keep it:
 *
 *   - No TTY (CI, a pipe, `rotifer wrap` inside a script) means there is no
 *     human to answer, so a default of Y would become an unattended upload of
 *     whatever a build just wrapped. Skip, and say why.
 *   - JSON output mode is machine-facing for the same reason.
 *   - Signed out, publishing cannot succeed at all (publish.ts requires auth),
 *     so asking would only produce an error the user cannot act on inline.
 *   - A Native Gene without gene.ir.wasm is rejected downstream by
 *     publishSingleGene. Asking first and failing after is a worse experience
 *     than pointing at `rotifer compile`.
 *
 * Every skip prints the next step it skipped to, so the path back is always on
 * screen — the risk ADR-247 logged as "用户发现不到关闭路径", inverted.
 */

export type AutoPublishSkipReason =
  | "disabled-by-config"
  | "non-interactive"
  | "needs-compile"
  | "not-logged-in";

export interface AutoPublishGateInput {
  /** `default-publish` config, after the ROTIFER_AUTO_PUBLISH override. */
  enabled: boolean;
  /** A human can answer a prompt: stdin is a TTY and output is not JSON. */
  interactive: boolean;
  /** Cloud credentials are present and unexpired. */
  loggedIn: boolean;
  /** Native fidelity with no compiled gene.ir.wasm on disk. */
  needsWasm: boolean;
}

export interface AutoPublishGateResult {
  offer: boolean;
  reason?: AutoPublishSkipReason;
}

/**
 * Pure decision: should `wrap` ask about publishing?
 *
 * Ordered so the reported reason is the one the user can act on first. An
 * explicit opt-out wins over everything (never second-guess it); a build
 * environment is next because nothing else matters when nobody is watching;
 * an uncompilable Gene outranks being signed out, because logging in would not
 * make it publishable.
 */
export function autoPublishGate(input: AutoPublishGateInput): AutoPublishGateResult {
  if (!input.enabled) return { offer: false, reason: "disabled-by-config" };
  if (!input.interactive) return { offer: false, reason: "non-interactive" };
  if (input.needsWasm) return { offer: false, reason: "needs-compile" };
  if (!input.loggedIn) return { offer: false, reason: "not-logged-in" };
  return { offer: true };
}

/** True when publishing this Gene would be rejected for a missing WASM artifact. */
export function needsCompileBeforePublish(geneDir: string, fidelity: string): boolean {
  if (fidelity !== "Native") return false;
  return !existsSync(join(geneDir, "gene.ir.wasm"));
}

/**
 * The next step a skipped offer points at.
 *
 * Exported as a pure function because most skip reasons are unreachable from a
 * spawned-CLI test: a child process never has a TTY, so `non-interactive`
 * shadows every reason below it. Testing the message through the gate would
 * quietly cover one branch and leave three unexercised.
 */
export function skipHintFor(reason: AutoPublishSkipReason, geneName: string): string {
  if (reason === "needs-compile") {
    return `  rotifer compile ${geneName}       # required before publishing a Native gene`;
  }
  if (reason === "not-logged-in") {
    return `  rotifer login                    # then: rotifer publish ${geneName}`;
  }
  return `  rotifer publish ${geneName}       # upload to Rotifer Cloud`;
}

/**
 * Ask, defaulting to yes. Empty input (a bare Enter) is the default — that is
 * what makes it a default rather than a question with a suggested answer.
 */
async function confirmPublish(geneName: string): Promise<boolean> {
  console.log();
  display.hint(
    c.dim(`Publishing is on by default — turn it off with 'rotifer config set default-publish false'`),
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Publish '${geneName}' to Rotifer Cloud? [Y/n] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
  });
  return answer === "" || answer === "y" || answer === "yes";
}

/**
 * Run the offer. Returns whether the Gene was actually published, so callers
 * can decide what to print next. Never throws: a wrap that succeeded must not
 * be reported as failed because the optional upload afterwards did not work.
 */
export async function offerAutoPublish(opts: {
  geneName: string;
  geneDir: string;
  fidelity: string;
}): Promise<boolean> {
  const { geneName, geneDir, fidelity } = opts;

  const gate = autoPublishGate({
    enabled: shouldAutoPublish(),
    interactive: Boolean(process.stdin.isTTY) && !display.isJsonMode(),
    loggedIn: isLoggedIn(),
    needsWasm: needsCompileBeforePublish(geneDir, fidelity),
  });

  // Printed for every skip, opt-out included: turning off the *prompt* is not
  // a request to hide that publishing exists, and this line is what `wrap`
  // already printed before the offer was wired in.
  if (!gate.offer) {
    display.hint(skipHintFor(gate.reason!, geneName));
    return false;
  }

  if (!(await confirmPublish(geneName))) {
    console.log();
    display.hint(`  rotifer publish ${geneName}       # upload later`);
    return false;
  }

  console.log();
  try {
    const creds = await requireAuth();
    const result = await publishSingleGene(geneName, geneDir, creds, {});
    if (result.status === "failed") {
      display.warn(`Publish failed: ${result.error ?? "unknown error"}`);
      display.hint(`  rotifer publish ${geneName}       # retry`);
      return false;
    }
    return true;
  } catch (e) {
    display.warn(`Publish failed: ${e instanceof Error ? e.message : String(e)}`);
    display.hint(`  rotifer publish ${geneName}       # retry`);
    return false;
  }
}
