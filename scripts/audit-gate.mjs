#!/usr/bin/env node
// Dependency audit gate: fails on any advisory at or above `high`, except
// advisories listed in .github/audit-allowlist.json that are still in force.
//
// An allowlist entry stops applying, with nobody having to remember it, when
// either of these happens first:
//   1. its `expires` date (UTC, end of day) has passed;
//   2. GitHub's advisory database lists a first patched version for it.
// From then on the advisory fails the build like any other.
//
// Inputs (all optional; for tests):
//   AUDIT_JSON_FILE     read `npm audit --json` output from this file instead of running npm
//   ADVISORY_JSON_FILE  read the GitHub advisory record from this file instead of the API
//   AUDIT_GATE_NOW      ISO timestamp to use as "now"
//   AUDIT_ALLOWLIST     path to the allowlist (default .github/audit-allowlist.json)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const THRESHOLD = LEVELS.high;

const now = process.env.AUDIT_GATE_NOW ? new Date(process.env.AUDIT_GATE_NOW) : new Date();
const allowlist = JSON.parse(readFileSync(process.env.AUDIT_ALLOWLIST || '.github/audit-allowlist.json', 'utf8'));

function runAudit() {
  if (process.env.AUDIT_JSON_FILE) return readFileSync(process.env.AUDIT_JSON_FILE, 'utf8');
  try {
    return execFileSync('npx', ['-y', 'npm@11', 'audit', '--json',
      '--fetch-timeout=60000', '--fetch-retries=1', '--fetch-retry-maxtimeout=15000'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
    if (err.stdout) return err.stdout;
    // npx or npm did not start at all (for example, npm@11 could not be
    // downloaded). Like a failed fetch, this is worth another attempt.
    console.log(`::error::npm audit did not run: ${err.message}`);
    process.exit(2);
  }
}

async function firstPatched(ghsa) {
  let record;
  if (process.env.ADVISORY_JSON_FILE) {
    record = JSON.parse(readFileSync(process.env.ADVISORY_JSON_FILE, 'utf8'));
  } else {
    // GitHub's REST API refuses requests that carry no User-Agent.
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'rotifer-audit-gate' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/advisories/${ghsa}`, { headers });
    if (!res.ok) throw new Error(`GitHub advisory API returned ${res.status} for ${ghsa}`);
    record = await res.json();
  }
  const patched = (record.vulnerabilities || [])
    .map((v) => v.first_patched_version)
    .filter(Boolean);
  return patched;
}

const raw = runAudit();
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.log(raw);
  console.log('::error::npm audit did not return JSON. The dependency tree was not checked.');
  process.exit(2);
}
if (!report.vulnerabilities) {
  // e.g. { error: { code: 'ENOAUDIT', ... } } when the registry could not be reached.
  console.log(`::error::npm audit could not run: ${report.error?.summary || report.message || 'no vulnerability data'}`);
  process.exit(2);
}

// Every advisory npm attached to any package, by GHSA id. Packages flagged only
// because a dependency is vulnerable carry package names, not advisories, so
// collecting the advisory objects is enough to see every root cause.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via !== 'object') continue;
    const id = String(via.url || '').split('/').pop();
    advisories.set(id, { id, name: via.name, severity: via.severity, range: via.range, title: via.title });
  }
}

const blocking = [];
const exempted = [];
for (const adv of advisories.values()) {
  if ((LEVELS[adv.severity] ?? 0) < THRESHOLD) continue;
  const entry = allowlist.find((e) => e.id === adv.id);
  if (!entry) { blocking.push({ ...adv, why: 'not on the allowlist' }); continue; }
  const expiresAt = new Date(`${entry.expires}T23:59:59Z`);
  if (now > expiresAt) { blocking.push({ ...adv, why: `allowlist entry expired on ${entry.expires}` }); continue; }
  let patched;
  try {
    patched = await firstPatched(adv.id);
  } catch (err) {
    blocking.push({ ...adv, why: `could not confirm it is still unpatched (${err.message})` });
    continue;
  }
  if (patched.length) { blocking.push({ ...adv, why: `a fix has shipped (${patched.join(', ')}); upgrade and remove the allowlist entry` }); continue; }
  exempted.push({ ...adv, expires: entry.expires });
}

const counts = report.metadata?.vulnerabilities || {};
console.log(`npm audit: ${JSON.stringify(counts)}`);
for (const e of exempted) {
  console.log(`::warning::Allowed by .github/audit-allowlist.json: ${e.id} (${e.name} ${e.range}, ${e.severity}). No fixed version exists yet. This stops applying on ${e.expires} or as soon as a fix ships, whichever comes first.`);
}
for (const b of blocking) {
  console.log(`::error::${b.id} (${b.name} ${b.range}, ${b.severity}): ${b.why}. ${b.title}`);
}
if (blocking.length) process.exit(1);
console.log(`Audit gate passed: no advisory at or above high outside the allowlist (${exempted.length} allowed).`);
