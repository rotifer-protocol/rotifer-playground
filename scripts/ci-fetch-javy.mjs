#!/usr/bin/env node
// Fetch the javy binary before the tests start. CI only.
//
// javy-cli downloads its binary the first time it runs. Left to the test run,
// that happens inside the CLI's 10-second probe and in several parallel test
// files at once, and the failure is swallowed, so a slow download shows up as
// "javy: missing" in unrelated tests.
//
// An interrupted download leaves a partial file that javy-cli only removes on
// its next run, so one bad download can cost two attempts.

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const bin = process.env.FETCH_JAVY_BIN ?? "node_modules/.bin/javy";
const attempts = Number(process.env.FETCH_JAVY_ATTEMPTS ?? 6);
const timeout = Number(process.env.FETCH_JAVY_TIMEOUT_MS ?? 120_000);
const retryDelay = Number(process.env.FETCH_JAVY_RETRY_DELAY_MS ?? 5_000);

for (let attempt = 1; attempt <= attempts; attempt++) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout });
  if (result.status === 0) {
    console.log(`javy ready on attempt ${attempt}: ${result.stdout.trim()}`);
    process.exit(0);
  }
  const reason = result.error?.code ?? `exit ${result.status}`;
  console.log(`javy attempt ${attempt}/${attempts} failed (${reason}): ${(result.stderr ?? "").trim()}`);
  if (attempt < attempts) await sleep(retryDelay * attempt);
}

console.log(`::error::Could not get the javy binary after ${attempts} attempts. javy-cli downloads it from GitHub Releases; re-run this job, or check that the download is reachable.`);
process.exit(1);
