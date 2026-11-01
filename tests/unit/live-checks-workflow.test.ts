import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * .github/workflows/live-checks.yml opens or refreshes one standing issue when
 * a live lane fails, quoting the CLI's own error lines. That path only runs
 * when a real service fails, so it can be exercised on purpose:
 * `simulate_failure` makes one lane really fail, and `issue_dry_run` (the
 * default when simulating) prints the issue and the gh command instead of
 * filing it in a public repository.
 *
 * These tests run the issue step's own script in bash, with a fake `gh` on
 * PATH that records every call.
 */

const WORKFLOW = join(__dirname, "../../.github/workflows/live-checks.yml");

interface Step { name?: string; run?: string; env?: Record<string, string>; if?: string }
interface Workflow {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs?: Record<string, Record<string, unknown>> } };
  jobs: { live: { strategy: { matrix: { include: Array<Record<string, string>> } }; steps: Step[] } };
}

const wf = yaml.load(readFileSync(WORKFLOW, "utf-8")) as Workflow;
const steps = wf.jobs.live.steps;
const issueStep = steps.find((s) => s.name === "Open or refresh the issue")!;
const liveStep = steps.find((s) => s.name === "Live check")!;
const lanes = wf.jobs.live.strategy.matrix.include;

/** What the CLI prints when ClawHub's backend keeps failing, as it lands in live.log. */
const CLAWHUB_LOG = [
  " RUN  v4.1.11",
  "ClawHub: HTTP 500 — [Request ID: abc] Server Error; trying again (2/3)",
  "error[E0010]: ClawHub skill 'grilling' could not be fetched: HTTP 500 — [Request ID: abc] Server Error (3 attempts)",
  " FAIL  tests/live/clawhub-live.test.ts > live ClawHub > wrap --from-clawhub grilling downloads, unpacks and writes the gene",
  "AssertionError: expected 'x' to contain 'Grilling'",
  // vitest repeats the received output as a diff, and quotes the test source.
  "+ error[E0010]: ClawHub skill 'grilling' could not be fetched: HTTP 500 — [Request ID: abc] Server Error (3 attempts)",
  "     42|     expect(output, output).toContain(\"ClawHub: \");",
  "unrelated noise",
].join("\n");

let dir = "";
const ghCalls = () => (existsSync(join(dir, "gh-calls")) ? readFileSync(join(dir, "gh-calls"), "utf-8") : "");

/** Runs the issue step as the clawhub lane, in `dir`, with `gh` faked. */
function runIssueStep(extraEnv: Record<string, string>, openIssue = "") {
  const lane = lanes.find((l) => l.key === "clawhub")!;
  writeFileSync(join(dir, "live.log"), CLAWHUB_LOG);
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash\necho "gh $*" >> "${join(dir, "gh-calls")}"\nif [ "$1 $2" = "issue list" ]; then printf '%s' "${openIssue}"; fi\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  return spawnSync("bash", ["-e", "-c", issueStep.run!], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      GH_TOKEN: "not-a-token",
      RUN_URL: "https://github.com/o/r/actions/runs/1",
      SERVICE: lane.service,
      SUITE: lane.suite,
      EXCERPT: lane.excerpt,
      FIX: lane.fix,
      ...extraEnv,
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "live-checks-wf-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("live-checks.yml: simulating a failure", () => {
  it("offers simulate_failure (none / clawhub / cloud) and issue_dry_run (default true) on manual runs", () => {
    const inputs = wf.on.workflow_dispatch.inputs ?? {};
    expect(inputs.simulate_failure).toMatchObject({ type: "choice", default: "none", options: ["none", "clawhub", "cloud"] });
    expect(inputs.issue_dry_run).toMatchObject({ type: "boolean", default: true });
  });

  it("keeps the daily schedule as it was", () => {
    expect(wf.on.schedule).toEqual([{ cron: "41 4 * * *" }]);
  });

  it("each lane names the simulation it gets, and only a manual input turns it on", () => {
    expect(lanes.map((l) => [l.key, l.simulate])).toEqual([
      ["clawhub", "http-500"],
      ["cloud", "refused"],
    ]);
    // On a schedule `inputs` is empty, so the expression is '' and the lane is real.
    expect(liveStep.env?.ROTIFER_LIVE_SIMULATE).toBe("${{ inputs.simulate_failure == matrix.key && matrix.simulate || '' }}");
    expect(issueStep.env?.DRY_RUN).toBe(
      "${{ inputs.simulate_failure != '' && inputs.simulate_failure != 'none' && inputs.issue_dry_run }}",
    );
  });
});

describe("live-checks.yml: the issue step", () => {
  it("in a dry run prints the title, the body with the CLI's status line, and the command — and never calls gh", () => {
    const r = runIssueStep({ DRY_RUN: "true" });
    expect(r.status, r.stderr).toBe(1); // the lane still fails
    expect(ghCalls()).toBe("");
    expect(r.stdout).toContain("Dry run: no issue is filed.");
    expect(r.stdout).toContain('Title: ClawHub live check is failing');
    expect(r.stdout).toContain(
      "error[E0010]: ClawHub skill 'grilling' could not be fetched: HTTP 500 — [Request ID: abc] Server Error (3 attempts)",
    );
    expect(r.stdout).toContain("ClawHub: HTTP 500 — [Request ID: abc] Server Error; trying again (2/3)");
    expect(r.stdout).not.toContain("unrelated noise");
    expect(r.stdout).toContain('gh issue create --title "ClawHub live check is failing" --body-file issue-body.md');
    expect(r.stdout).toContain("gh issue comment <number> --body-file comment.md");
  });

  it("quotes each CLI line once, without vitest's diff copies or source excerpts", () => {
    runIssueStep({ DRY_RUN: "true" });
    const excerpt = readFileSync(join(dir, "excerpt.txt"), "utf-8").split("\n").filter(Boolean);
    expect(excerpt.filter((l) => l.includes("Server Error (3 attempts)"))).toHaveLength(1);
    expect(excerpt.some((l) => l.startsWith("+ "))).toBe(false);
    expect(excerpt.some((l) => /^ *\d+\| /.test(l))).toBe(false);
  });

  it("says a simulated failure is simulated", () => {
    const r = runIssueStep({ DRY_RUN: "true", SIMULATED: "http-500" });
    expect(r.stdout).toContain("**Simulated failure** (simulate_failure, ROTIFER_LIVE_SIMULATE=http-500): not a real outage.");
    expect(issueStep.env?.SIMULATED).toBe(liveStep.env?.ROTIFER_LIVE_SIMULATE);
  });

  it("otherwise files a new issue when none is open", () => {
    const r = runIssueStep({ DRY_RUN: "false" });
    expect(r.status, r.stderr).toBe(1);
    expect(ghCalls()).toContain("gh issue list");
    expect(ghCalls()).toContain("gh issue create --title ClawHub live check is failing --body-file issue-body.md");
    const body = readFileSync(join(dir, "issue-body.md"), "utf-8");
    expect(body).toContain("HTTP 500 — [Request ID: abc] Server Error (3 attempts)");
  });

  it("otherwise comments on the open one", () => {
    const r = runIssueStep({ DRY_RUN: "false" }, "17");
    expect(r.status, r.stderr).toBe(1);
    expect(ghCalls()).toContain("gh issue comment 17 --body-file comment.md");
    expect(ghCalls()).not.toContain("gh issue create");
  });

  it("an empty DRY_RUN (a scheduled run) files for real", () => {
    const r = runIssueStep({ DRY_RUN: "" });
    expect(ghCalls()).toContain("gh issue create");
    expect(r.stdout).not.toContain("Dry run");
  });
});
