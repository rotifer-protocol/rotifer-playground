import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const SCRIPT_PATH = join(__dirname, "../../../scripts/scan-top50.sh");
const LIST_FILE = join(__dirname, "../../../internal/market/clawhub-top50-list.json");
const HAS_SCRIPT_FILE = existsSync(SCRIPT_PATH);
const HAS_LIST_FILE = existsSync(LIST_FILE);

describe.skipIf(!HAS_SCRIPT_FILE)("scan-top50.sh smoke tests", () => {
  it("script file exists and is executable", () => {
    const mode = statSync(SCRIPT_PATH).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  it("passes bash syntax check", () => {
    const result = execSync(`bash -n "${SCRIPT_PATH}" 2>&1`, { encoding: "utf-8" });
    expect(result).toBe("");
  });

  it("references required variables", () => {
    const content = readFileSync(SCRIPT_PATH, "utf-8");
    expect(content).toContain("ROTIFER_CLI");
    expect(content).toContain("clawhub-top50-list.json");
    expect(content).toContain("RESULTS_DIR");
  });

  it("uses set -euo pipefail for safety", () => {
    const content = readFileSync(SCRIPT_PATH, "utf-8");
    expect(content).toContain("set -euo pipefail");
  });
});

describe.skipIf(!HAS_LIST_FILE)("clawhub-top50-list.json data integrity", () => {
  it("contains skills array with rank, slug, name, downloads", () => {
    const data = JSON.parse(readFileSync(LIST_FILE, "utf-8"));
    expect(data.skills).toBeDefined();
    expect(Array.isArray(data.skills)).toBe(true);
    expect(data.skills.length).toBeGreaterThanOrEqual(40);

    const first = data.skills[0];
    expect(first.rank).toBeDefined();
    expect(first.slug).toBeDefined();
    expect(first.name).toBeDefined();
    expect(first.downloads).toBeTypeOf("number");
  });

  it("all slugs are unique", () => {
    const data = JSON.parse(readFileSync(LIST_FILE, "utf-8"));
    const slugs = data.skills.map((s: any) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("ranks are sequential from 1", () => {
    const data = JSON.parse(readFileSync(LIST_FILE, "utf-8"));
    const ranks = data.skills.map((s: any) => s.rank).sort((a: number, b: number) => a - b);
    expect(ranks[0]).toBe(1);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBe(ranks[i - 1] + 1);
    }
  });
});
