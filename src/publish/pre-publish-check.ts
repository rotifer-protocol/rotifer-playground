import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { scan } from "../scanner/index.js";
import type { Grade, ScanResult } from "../scanner/types.js";

export interface CheckItem {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface PrePublishResult {
  passed: boolean;
  grade: Grade;
  checks: CheckItem[];
  blocking: CheckItem[];
  scanResult: ScanResult | null;
}

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d]); // \0asm
const MAX_WASM_SIZE = 50 * 1024 * 1024; // 50 MB — suspiciously large for a Gene

const SENSITIVE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "AWS key", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "GitHub token", pattern: /ghp_[A-Za-z0-9]{36}/ },
  { label: "npm token", pattern: /npm_[A-Za-z0-9]{36}/ },
  { label: "Supabase service key", pattern: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{50,}/ },
  { label: "Private key block", pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { label: "Generic secret assignment", pattern: /(?:secret|password|token|api_key)\s*[:=]\s*["'][A-Za-z0-9+/=]{20,}["']/i },
];

const SCAN_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cjs", ".json", ".md"]);

function collectAllFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(d, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (SCAN_EXTENSIONS.has(extname(entry))) {
          files.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
  };
  walk(dir);
  return files;
}

function checkVgScan(geneDir: string, geneName: string): { check: CheckItem; scanResult: ScanResult } {
  const result = scan(geneDir, geneName, { scanAll: true });

  if (result.grade === "?") {
    return {
      check: { name: "V(g) Security Scan", status: "pass", message: "No code files found (pure-config gene)" },
      scanResult: result,
    };
  }

  if (result.grade === "D") {
    const criticals = result.findings.filter((f) => f.severity === "CRITICAL");
    return {
      check: {
        name: "V(g) Security Scan",
        status: "fail",
        message: `Grade D — ${criticals.length} CRITICAL finding(s): ${criticals.map((f) => f.rule).join(", ")}`,
      },
      scanResult: result,
    };
  }

  if (result.grade === "C") {
    return {
      check: {
        name: "V(g) Security Scan",
        status: "warn",
        message: `Grade C — ${result.findings.length} finding(s). Consider fixing HIGH-severity issues before publish.`,
      },
      scanResult: result,
    };
  }

  return {
    check: {
      name: "V(g) Security Scan",
      status: "pass",
      message: `Grade ${result.grade} — ${result.findings.length} finding(s), ${result.stats.files_scanned} file(s) scanned`,
    },
    scanResult: result,
  };
}

function checkIrWasm(geneDir: string): CheckItem {
  const wasmPath = join(geneDir, "gene.ir.wasm");
  if (!existsSync(wasmPath)) {
    return { name: "IR WASM Integrity", status: "pass", message: "No WASM binary (non-Native gene)" };
  }

  const buf = readFileSync(wasmPath);

  if (buf.length === 0) {
    return { name: "IR WASM Integrity", status: "fail", message: "WASM binary is empty (0 bytes)" };
  }

  const header = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(4, buf.length));
  if (header.length < 4 || !WASM_MAGIC.every((b, i) => header[i] === b)) {
    return { name: "IR WASM Integrity", status: "fail", message: "Invalid WASM magic bytes — file may be corrupted" };
  }

  if (buf.length > MAX_WASM_SIZE) {
    const sizeMB = (buf.length / (1024 * 1024)).toFixed(1);
    return { name: "IR WASM Integrity", status: "warn", message: `WASM binary unusually large (${sizeMB} MB)` };
  }

  const sizeKB = (buf.length / 1024).toFixed(1);
  return { name: "IR WASM Integrity", status: "pass", message: `Valid WASM binary (${sizeKB} KB)` };
}

function checkPhenotypeSchema(geneDir: string): CheckItem {
  const phenotypePath = join(geneDir, "phenotype.json");
  if (!existsSync(phenotypePath)) {
    return { name: "Phenotype Schema", status: "fail", message: "Missing phenotype.json" };
  }

  let phenotype: Record<string, unknown>;
  try {
    phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
  } catch (e) {
    return { name: "Phenotype Schema", status: "fail", message: `Invalid JSON: ${(e as Error).message}` };
  }

  const missing: string[] = [];
  for (const field of ["domain", "version", "description", "inputSchema"]) {
    if (!phenotype[field]) missing.push(field);
  }

  if (missing.length > 0) {
    return { name: "Phenotype Schema", status: "warn", message: `Missing recommended fields: ${missing.join(", ")}` };
  }

  const fidelity = phenotype.fidelity as string | undefined;
  if (fidelity && !["Wrapped", "Native", "Hybrid"].includes(fidelity)) {
    return { name: "Phenotype Schema", status: "fail", message: `Invalid fidelity value: "${fidelity}"` };
  }

  return { name: "Phenotype Schema", status: "pass", message: "All required fields present" };
}

function checkSensitiveData(geneDir: string): CheckItem {
  const files = collectAllFiles(geneDir);
  const leaks: string[] = [];

  for (const file of files) {
    if (file.endsWith(".wasm")) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const { label, pattern } of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        const relPath = file.replace(geneDir + "/", "");
        leaks.push(`${label} in ${relPath}`);
      }
    }
  }

  if (leaks.length > 0) {
    return {
      name: "Sensitive Data Scan",
      status: "fail",
      message: `Found ${leaks.length} potential secret(s): ${leaks.slice(0, 3).join("; ")}${leaks.length > 3 ? ` (+${leaks.length - 3} more)` : ""}`,
    };
  }

  return { name: "Sensitive Data Scan", status: "pass", message: `Scanned ${files.length} file(s), no secrets detected` };
}

function checkDependencies(geneDir: string): CheckItem {
  const phenotypePath = join(geneDir, "phenotype.json");
  if (!existsSync(phenotypePath)) {
    return { name: "Dependency Audit", status: "pass", message: "No phenotype.json to audit" };
  }

  let phenotype: Record<string, unknown>;
  try {
    phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
  } catch {
    return { name: "Dependency Audit", status: "pass", message: "Could not parse phenotype.json" };
  }

  const deps = phenotype.dependencies;
  if (!Array.isArray(deps) || deps.length === 0) {
    return { name: "Dependency Audit", status: "pass", message: "No gene dependencies declared" };
  }

  const pkgJsonPath = join(geneDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return { name: "Dependency Audit", status: "pass", message: `${deps.length} gene dependency(ies) — no package.json to audit` };
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return { name: "Dependency Audit", status: "warn", message: "Could not parse package.json" };
  }

  const allDeps = { ...(pkg.dependencies as Record<string, string> || {}), ...(pkg.devDependencies as Record<string, string> || {}) };
  const warnings: string[] = [];

  for (const [name, ver] of Object.entries(allDeps)) {
    if (typeof ver === "string" && (ver.startsWith("file:") || ver.startsWith("link:"))) {
      warnings.push(`${name}: local reference (${ver})`);
    }
    if (typeof ver === "string" && ver.includes("github:")) {
      warnings.push(`${name}: GitHub reference (unversioned)`);
    }
  }

  if (warnings.length > 0) {
    return {
      name: "Dependency Audit",
      status: "warn",
      message: `${warnings.length} concern(s): ${warnings.join("; ")}`,
    };
  }

  return { name: "Dependency Audit", status: "pass", message: `${Object.keys(allDeps).length} package(s) OK` };
}

export function runPrePublishChecks(geneDir: string, geneName: string): PrePublishResult {
  const checks: CheckItem[] = [];
  let scanResult: ScanResult | null = null;

  const vg = checkVgScan(geneDir, geneName);
  checks.push(vg.check);
  scanResult = vg.scanResult;

  checks.push(checkIrWasm(geneDir));
  checks.push(checkPhenotypeSchema(geneDir));
  checks.push(checkSensitiveData(geneDir));
  checks.push(checkDependencies(geneDir));

  const blocking = checks.filter((c) => c.status === "fail");
  const grade = scanResult?.grade ?? "?";

  return {
    passed: blocking.length === 0,
    grade,
    checks,
    blocking,
    scanResult,
  };
}
