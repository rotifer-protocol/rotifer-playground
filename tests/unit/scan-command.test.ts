import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "../../src/commands/scan.js";

describe("parseSkillFrontmatter", () => {
  it("parses name and description from valid frontmatter", () => {
    const content = `---
name: my-skill
description: A useful skill
---
# My Skill
`;
    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-skill");
    expect(result!.description).toBe("A useful skill");
  });

  it("returns null for content without frontmatter", () => {
    const content = `# Just a heading\nSome text`;
    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("returns null when frontmatter has no name", () => {
    const content = `---
description: No name here
---
`;
    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("handles quoted values", () => {
    const content = `---
name: "quoted-skill"
description: 'single quoted desc'
---
`;
    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("quoted-skill");
    expect(result!.description).toBe("single quoted desc");
  });

  it("handles description with special characters", () => {
    const content = `---
name: special
description: Uses AI & ML for NLP tasks (v2.0)
---
`;
    const result = parseSkillFrontmatter(content);
    expect(result!.description).toContain("AI & ML");
  });

  it("trims whitespace from values", () => {
    const content = `---
name:   spacey-name   
description:   lots of spaces   
---
`;
    const result = parseSkillFrontmatter(content);
    expect(result!.name).toBe("spacey-name");
    expect(result!.description).toBe("lots of spaces");
  });

  it("handles empty description", () => {
    const content = `---
name: no-desc
description: 
---
`;
    const result = parseSkillFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("no-desc");
  });

  it("ignores content after frontmatter closing", () => {
    const content = `---
name: test-skill
description: Test
---
name: should-be-ignored
description: Also ignored
`;
    const result = parseSkillFrontmatter(content);
    expect(result!.name).toBe("test-skill");
  });
});
