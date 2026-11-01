#!/usr/bin/env node
// The Quality Observatory row for one vitest JSON results file, as shell
// assignments: TOTAL, PASSED, FAILED, SKIPPED, DURATION_MS.
//
//   eval "$(node scripts/quality-test-counts.mjs test-results.json)"
//
// SKIPPED is vitest's pending (skip, skipIf) plus todo — the table's
// `skipped` column, which the report used to leave at its default of 0. A
// test with no result at all (its worker died before reporting it) is in
// numTotalTests but in none of the other counts; it is counted as FAILED, so
// the four always add up and a crashed run never reads as a smaller green one.
// Exits 1, printing nothing, on a file that is not vitest JSON.
// tests/unit/quality-report-counts.test.ts

import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`quality-test-counts: ${message}`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) fail("usage: quality-test-counts.mjs <vitest JSON results>");

let results;
try {
  results = JSON.parse(readFileSync(file, "utf-8"));
} catch (err) {
  fail(`cannot read ${file}: ${err.message}`);
}

const fields = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"];
for (const field of fields) {
  if (!Number.isInteger(results?.[field]) || results[field] < 0) fail(`${file} is not vitest JSON results (no ${field})`);
}

const total = results.numTotalTests;
const passed = results.numPassedTests;
const skipped = results.numPendingTests + results.numTodoTests;
const unreported = total - passed - results.numFailedTests - skipped;
if (unreported < 0) fail(`${file} counts more results than tests (${total} tests)`);
const failed = results.numFailedTests + unreported;
if (unreported > 0) console.error(`quality-test-counts: ${unreported} test(s) have no result; counted as failed`);

const files = Array.isArray(results.testResults) ? results.testResults : [];
const durationMs = Math.round(files.reduce((sum, r) => sum + (r.endTime - r.startTime || 0), 0));

console.log(`TOTAL=${total}`);
console.log(`PASSED=${passed}`);
console.log(`FAILED=${failed}`);
console.log(`SKIPPED=${skipped}`);
console.log(`DURATION_MS=${durationMs}`);
