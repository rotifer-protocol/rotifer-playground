import { afterEach, describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOutputs,
  createBrandPng,
  diffOutputs,
  renderTemplate,
  syncOutputs,
  updateFamilyVersion,
  verifyPluginPackaging,
} from "../../scripts/lib/plugin-source.mjs";

const repoRoot = join(__dirname, "../..");
const tempRoots: string[] = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "rotifer-plugin-source-"));
  tempRoots.push(root);

  cpSync(join(repoRoot, "plugin-source"), join(root, "plugin-source"), { recursive: true });
  cpSync(join(repoRoot, "rotifer-vscode/package.json"), join(root, "rotifer-vscode/package.json"), {
    recursive: false,
  });

  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("plugin source helpers", () => {
  it("renders version placeholders in canonical skill content", () => {
    const rendered = renderTemplate("version: {{familyVersion}}", {
      familyVersion: "0.8.2",
    });

    expect(rendered).toBe("version: 0.8.2");
  });

  it("creates a valid PNG brand asset", () => {
    const png = createBrandPng(128);

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.length).toBeGreaterThan(500);
  });
});

describe("plugin source sync pipeline", () => {
  it("builds root and vscode outputs with family versions", () => {
    const root = createFixture();
    const outputs = buildOutputs(root);

    const rootCursorMarketplace = outputs.find(
      (entry) => entry.pathFromRoot === ".cursor-plugin/marketplace.json",
    );
    const rootCursorPlugin = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/.cursor-plugin/plugin.json",
    );
    const rootCodeBuddyPlugin = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/.codebuddy-plugin/plugin.json",
    );
    const vscodeCursor = outputs.find(
      (entry) => entry.pathFromRoot === "rotifer-vscode/.cursor-plugin/plugin.json",
    );
    const codebuddySkill = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/skills/evolve/SKILL.md",
    );

    expect(rootCursorMarketplace?.kind).toBe("json");
    expect(rootCursorPlugin?.kind).toBe("json");
    expect(rootCursorPlugin && "data" in rootCursorPlugin ? rootCursorPlugin.data.version : undefined).toBe(
      "0.8.2",
    );
    expect(rootCodeBuddyPlugin?.kind).toBe("json");
    expect(
      rootCodeBuddyPlugin && "data" in rootCodeBuddyPlugin
        ? rootCodeBuddyPlugin.data.version
        : undefined,
    ).toBe("0.8.2");
    expect(vscodeCursor?.kind).toBe("json");
    expect(vscodeCursor && "data" in vscodeCursor ? vscodeCursor.data.version : undefined).toBe(
      "0.8.1",
    );
    expect(codebuddySkill?.kind).toBe("text");
    expect(codebuddySkill && "content" in codebuddySkill ? codebuddySkill.content : "").toContain(
      "version: 0.8.2",
    );
  });

  it("preserves hand-authored vscode package sections while syncing owned fields", () => {
    const root = createFixture();
    const originalPackage = JSON.parse(
      readFileSync(join(root, "rotifer-vscode/package.json"), "utf8"),
    );
    const outputs = buildOutputs(root);
    const syncedPackage = outputs.find(
      (entry) => entry.pathFromRoot === "rotifer-vscode/package.json",
    );

    expect(syncedPackage?.kind).toBe("json");
    if (!syncedPackage || !("data" in syncedPackage)) {
      throw new Error("missing synced rotifer-vscode/package.json output");
    }

    expect(syncedPackage.data.version).toBe("0.8.1");
    expect("activationEvents" in syncedPackage.data).toBe(false);
    expect(syncedPackage.data.main).toBe(originalPackage.main);
    expect(syncedPackage.data.contributes.viewsContainers).toEqual(
      originalPackage.contributes.viewsContainers,
    );
    expect(syncedPackage.data.scripts).toEqual(originalPackage.scripts);
  });

  it("syncs outputs with zero drift on a fresh fixture", () => {
    const root = createFixture();

    syncOutputs(root);

    expect(diffOutputs(root)).toEqual([]);
    expect(existsSync(join(root, ".cursor-plugin/marketplace.json"))).toBe(true);
    expect(existsSync(join(root, "plugins/rotifer/.cursor-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(root, "plugins/rotifer/.codebuddy-plugin/plugin.json"))).toBe(true);
    expect(existsSync(join(root, "plugins/rotifer/assets/icon.png"))).toBe(true);
    expect(existsSync(join(root, "rotifer-vscode/assets/logo.png"))).toBe(true);
    expect(existsSync(join(root, "rotifer-vscode/icon.png"))).toBe(true);
  });

  it("verifies packaging references after sync", () => {
    const root = createFixture();

    syncOutputs(root);

    expect(verifyPluginPackaging(root)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("updates a family version once and propagates it through generated outputs", () => {
    const root = createFixture();

    updateFamilyVersion(root, "root", "0.9.0");
    syncOutputs(root);

    const rootCursor = JSON.parse(
      readFileSync(join(root, "plugins/rotifer/.cursor-plugin/plugin.json"), "utf8"),
    );
    const rootCodeBuddyMarketplace = JSON.parse(
      readFileSync(join(root, ".codebuddy-plugin/marketplace.json"), "utf8"),
    );
    const rootCodeBuddyPlugin = JSON.parse(
      readFileSync(join(root, "plugins/rotifer/.codebuddy-plugin/plugin.json"), "utf8"),
    );
    const evolveSkill = readFileSync(join(root, "plugins/rotifer/skills/evolve/SKILL.md"), "utf8");

    expect(rootCursor.version).toBe("0.9.0");
    expect(rootCodeBuddyMarketplace.plugins[0].version).toBe("0.9.0");
    expect(rootCodeBuddyPlugin.version).toBe("0.9.0");
    expect(evolveSkill).toContain("version: 0.9.0");
  });

  it("fails packaging verification when a required icon disappears", () => {
    const root = createFixture();

    syncOutputs(root);
    unlinkSync(join(root, "rotifer-vscode/icon.png"));

    const result = verifyPluginPackaging(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("rotifer-vscode/package.json: missing icon.png");
  });

  it("detects drift when a generated file is manually edited", () => {
    const root = createFixture();

    syncOutputs(root);
    writeFileSync(join(root, "plugins/rotifer/skills/evolve/SKILL.md"), "drifted\n", "utf8");

    expect(diffOutputs(root)).toContainEqual({
      pathFromRoot: "plugins/rotifer/skills/evolve/SKILL.md",
      reason: "content",
    });
  });

  it("removes obsolete legacy outputs during sync", () => {
    const root = createFixture();

    mkdirSync(join(root, ".cursor-plugin/skills/evolve"), { recursive: true });
    mkdirSync(join(root, ".codebuddy-plugin/plugins/rotifer-evolving-agent/skills"), {
      recursive: true,
    });
    mkdirSync(join(root, "skills/evolve"), { recursive: true });
    mkdirSync(join(root, "rules"), { recursive: true });

    writeFileSync(join(root, ".cursor-plugin/plugin.json"), "{}\n", "utf8");
    writeFileSync(join(root, ".cursor-plugin/skills/evolve/SKILL.md"), "legacy\n", "utf8");
    writeFileSync(
      join(root, ".codebuddy-plugin/plugins/rotifer-evolving-agent/skills/SKILL.md"),
      "legacy\n",
      "utf8",
    );
    writeFileSync(join(root, "skills/evolve/SKILL.md"), "legacy\n", "utf8");
    writeFileSync(join(root, "rules/rotifer-gene-dev.mdc"), "legacy\n", "utf8");

    syncOutputs(root);

    expect(existsSync(join(root, ".cursor-plugin/plugin.json"))).toBe(false);
    expect(existsSync(join(root, ".cursor-plugin/skills"))).toBe(false);
    expect(existsSync(join(root, ".codebuddy-plugin/plugins"))).toBe(false);
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(existsSync(join(root, "rules"))).toBe(false);
  });
});
