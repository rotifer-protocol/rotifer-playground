import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

describe("Integration: publish flow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parseSkillMd extracts name from markdown heading", async () => {
    const { parseSkillMd } = await import("../../src/skill-publisher");
    const content = `# My Cool Gene

> A description line

Some content here.`;
    const result = parseSkillMd(content);
    expect(result.name).toBe("my-cool-gene");
    expect(result.description).toBe("A description line");
  });

  it("parseSkillMd returns undefined for empty content", async () => {
    const { parseSkillMd } = await import("../../src/skill-publisher");
    const result = parseSkillMd("");
    expect(result.name).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("parseSkillMd handles content without heading", async () => {
    const { parseSkillMd } = await import("../../src/skill-publisher");
    const result = parseSkillMd("just some text without a heading");
    expect(result.name).toBeUndefined();
  });

  it("parseSkillMd normalizes heading to kebab-case", async () => {
    const { parseSkillMd } = await import("../../src/skill-publisher");
    const content = "# Hello World Test Gene\n\nSome content.";
    const result = parseSkillMd(content);
    expect(result.name).toBe("hello-world-test-gene");
  });
});
