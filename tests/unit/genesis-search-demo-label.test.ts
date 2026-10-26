import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { express as webSearch } from "../../genes/genesis-web-search/index.js";
import { express as liteSearch } from "../../genes/genesis-web-search-lite/index.js";

/**
 * The two bundled search genes return made-up example.com results — they are
 * demos of a search gene's shape, not a search. Their descriptions said "Search
 * the web …", `rotifer list` and the README table said the same, and the
 * web-search titles read like real hits (#452). Whatever a user or an agent
 * reads first — the phenotype, the README row, the first field of the output —
 * has to say it is simulated.
 */

const ROOT = join(__dirname, "..", "..");
const phenotype = (gene: string) =>
  JSON.parse(readFileSync(join(ROOT, "genes", gene, "phenotype.json"), "utf8")) as { description: string };
const README = readFileSync(join(ROOT, "README.md"), "utf8");

describe.each(["genesis-web-search", "genesis-web-search-lite"])("%s says it is a demo", (gene) => {
  it("in its phenotype description", () => {
    const { description } = phenotype(gene);
    expect(description).toMatch(/simulated/i);
    expect(description).toMatch(/not a live web search/i);
  });

  it("in its README Genesis table row", () => {
    const row = README.split("\n").find((l) => l.startsWith(`| \`${gene}\` |`));
    expect(row, `README row for ${gene}`).toBeDefined();
    expect(row).toMatch(/simulated/i);
  });
});

describe("the simulated output is labelled in the field read first", () => {
  it("every genesis-web-search result title starts with [Simulated]", () => {
    const out = webSearch({ query: "rotifer protocol", maxResults: 3 });
    expect(out.results).toHaveLength(3);
    for (const r of out.results) {
      expect(r.title.startsWith("[Simulated] ")).toBe(true);
      expect(r.url.startsWith("https://example.com/")).toBe(true);
    }
  });

  it("genesis-web-search-lite's answer starts with [Simulated]", () => {
    const out = liteSearch({ query: "rotifer protocol" });
    expect(out.answer.startsWith("[Simulated] ")).toBe(true);
  });
});
