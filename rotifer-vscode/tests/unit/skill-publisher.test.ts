import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

import { parseSkillMd } from "../../src/skill-publisher";

describe("parseSkillMd", () => {
  it("extracts name from # heading", () => {
    const result = parseSkillMd("# My Cool Skill\n\n> A description");
    expect(result.name).toBe("my-cool-skill");
  });

  it("extracts description from > blockquote", () => {
    const result = parseSkillMd("# Title\n\n> This is the description line");
    expect(result.description).toBe("This is the description line");
  });

  it("converts name to lowercase kebab-case", () => {
    const result = parseSkillMd("# API Designer Tool\n\nSome content here that is long enough");
    expect(result.name).toBe("api-designer-tool");
  });

  it("returns undefined for content without heading", () => {
    const result = parseSkillMd("No heading here\nJust plain text that is very long");
    expect(result.name).toBeUndefined();
  });

  it("handles YAML frontmatter followed by heading", () => {
    const content = `---
name: test
---

# Actual Title

> Actual description`;
    const result = parseSkillMd(content);
    expect(result.name).toBe("actual-title");
    expect(result.description).toBe("Actual description");
  });
});
