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

/**
 * Family versions come from the fixture's own plugin-source/families.json.
 * Hard-coding them means every legitimate version bump breaks these tests —
 * which is exactly what happened at vscode 0.9.1.
 */
function familyVersion(root: string, family: "root" | "vscode"): string {
  const families = JSON.parse(
    readFileSync(join(root, "plugin-source/families.json"), "utf8"),
  );
  return families[family].version;
}

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
      familyVersion: "0.8.5",
    });

    expect(rendered).toBe("version: 0.8.5");
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
    const openclawPlugin = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/openclaw.plugin.json",
    );
    const claudePlugin = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/.claude-plugin/plugin.json",
    );
    const openclawPackage = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/package.json",
    );

    // Read the version rather than hardcoding it. These assertions used to
    // name 0.8.5 literally, so `npm run bump:plugin-family -- root <v>` — the
    // one sanctioned way to change it — turned the suite red for doing its job.
    const rootVersion = familyVersion(root, "root");

    expect(rootCursorMarketplace?.kind).toBe("json");
    expect(rootCursorPlugin?.kind).toBe("json");
    expect(rootCursorPlugin && "data" in rootCursorPlugin ? rootCursorPlugin.data.version : undefined).toBe(
      rootVersion,
    );
    expect(rootCodeBuddyPlugin?.kind).toBe("json");
    expect(
      rootCodeBuddyPlugin && "data" in rootCodeBuddyPlugin
        ? rootCodeBuddyPlugin.data.version
        : undefined,
    ).toBe(rootVersion);
    expect(vscodeCursor?.kind).toBe("json");
    expect(vscodeCursor && "data" in vscodeCursor ? vscodeCursor.data.version : undefined).toBe(
      familyVersion(root, "vscode"),
    );
    expect(codebuddySkill?.kind).toBe("text");
    expect(codebuddySkill && "content" in codebuddySkill ? codebuddySkill.content : "").toContain(
      `version: ${rootVersion}`,
    );

    // The same folder is published to a third marketplace. All three hosts
    // carry one version, which is the point of generating them together.
    for (const entry of [openclawPlugin, claudePlugin, openclawPackage]) {
      expect(entry?.kind).toBe("json");
      expect(entry && "data" in entry ? entry.data.version : undefined).toBe(rootVersion);
    }
  });

  it("carries its display name in the artifact, not in a publish flag", () => {
    const root = createFixture();
    const outputs = buildOutputs(root);
    const manifest = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/openclaw.plugin.json",
    );
    const data = manifest && "data" in manifest ? (manifest.data as Record<string, any>) : {};

    // ClawHub routes on `id` and displays `name`. Passing --display-name works
    // too, but it has to be remembered on every publish — two releases went out
    // without it and reset the listing to the slug. Keeping the display name in
    // the manifest means the artifact carries it.
    expect(data.id).toBe("rotifer");
    expect(data.name).toBe("Rotifer");
  });

  it("launches the MCP server pinned and with a declared tool set", () => {
    const root = createFixture();
    const outputs = buildOutputs(root);

    // An unpinned, unrestricted launch line was shipping every tool the server
    // has to Cursor and CodeBuddy users. Both halves are load-bearing: the pin
    // means what you install is what was reviewed, and the tool set means the
    // assistant cannot publish or sign in through this plugin.
    //
    // The two hosts read the declaration from different files. OpenClaw takes it
    // from package.json#openclaw — Plugin Inspector rejects mcpServers as a
    // top-level field of openclaw.plugin.json, so a declaration written there
    // announces a server nothing registers.
    const launchLines: Array<[string, (data: Record<string, any>) => unknown]> = [
      ["plugins/rotifer/.cursor-plugin/plugin.json", (data) => data.mcpServers?.rotifer?.args],
      ["plugins/rotifer/package.json", (data) => data.openclaw?.mcpServers?.rotifer?.args],
    ];

    for (const [pathFromRoot, read] of launchLines) {
      const entry = outputs.find((candidate) => candidate.pathFromRoot === pathFromRoot);
      expect(entry?.kind).toBe("json");
      const args = entry && "data" in entry ? (read(entry.data as Record<string, any>) as string[]) : undefined;

      expect(args).toBeDefined();
      expect(args?.some((arg) => /^@rotifer\/mcp-server@\d+\.\d+\.\d+$/.test(arg))).toBe(true);
      expect(args).toContain("--tools=evolve");
      expect(args?.some((arg) => arg.startsWith("--allow"))).toBe(false);
    }

    // Putting any of these back at the top level of openclaw.plugin.json is how
    // the declaration stops taking effect while still reading as if it does.
    const manifest = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/openclaw.plugin.json",
    );
    const manifestKeys =
      manifest && "data" in manifest ? Object.keys(manifest.data as Record<string, unknown>) : [];
    for (const unsupported of ["extensions", "compat", "build", "mcpServers", "environment"]) {
      expect(manifestKeys).not.toContain(unsupported);
    }
  });

  it("declares the dsh bundle where dsh reads it, from the same launch line", () => {
    const root = createFixture();
    const outputs = buildOutputs(root);

    // A package without `dsh.bundle` still installs into a profile, but
    // `dsh plugin` activates no layer and only warns — the same "written,
    // shipped, never exercised" shape that put mcpServers at the top level of
    // openclaw.plugin.json where OpenClaw never read it.
    const packageEntry = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/package.json",
    );
    const packageData =
      packageEntry && "data" in packageEntry ? (packageEntry.data as Record<string, any>) : undefined;
    expect(packageData?.dsh?.bundle?.patch).toBe("./cordis.patch.yml");

    const patchEntry = outputs.find(
      (entry) => entry.pathFromRoot === "plugins/rotifer/cordis.patch.yml",
    );
    expect(patchEntry?.kind).toBe("text");
    const patch = patchEntry && "content" in patchEntry ? patchEntry.content : "";

    // Assert against what dsh parses, not what a reader sees: the comments
    // explain why --allow is absent, and matching that prose would be checking
    // the documentation rather than the configuration.
    const rows = patch
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    // The pin and the narrowed tool set have to survive into the fourth host,
    // not just the three that already had them.
    expect(rows).toMatch(/@rotifer\/mcp-server@\d+\.\d+\.\d+/);
    expect(rows).toContain("--tools=evolve");
    expect(rows).not.toContain("--allow");
    expect(rows).toContain("name: '@deepseek-ai/dsh-mcp-client'");

    // Anti-drift: dsh does not get its own copy of the launch line. Every arg
    // OpenClaw declares must appear in the patch, so bumping one host's pin
    // without the other fails here rather than shipping two different products.
    const openclawArgs: string[] = packageData?.openclaw?.mcpServers?.rotifer?.args ?? [];
    expect(openclawArgs.length).toBeGreaterThan(0);
    for (const arg of openclawArgs) {
      expect(rows).toContain(`- '${arg}'`);
    }
    expect(rows).toContain(`command: ${packageData?.openclaw?.mcpServers?.rotifer?.command}`);

    // The skills ride dsh's own filesystem provider, scoped to this package.
    // includeDefaultRoots must stay false: true would make this row rescan the
    // user's project and user skill roots and shadow skills they wrote.
    expect(rows).toContain("name: '@deepseek-ai/dsh-skill-filesystem'");
    expect(rows).toContain("includeDefaultRoots: false");

    // The reason this bundle is safe against Cordis API churn is that it mounts
    // nothing of ours. A row naming our own package would quietly make that
    // claim false — and the claim is what the ADR rests on.
    expect(rows).not.toMatch(/name:\s*'?rotifer'?\s*$/m);

    // Settings -> Plugins lists rows by id, so the ids are the only brand the
    // user sees there — a bundle that mounts DSH's own plugins contributes no
    // entry of its own name. `mcp-rotifer` shipped first and sorted away from
    // `rotifer-skills`, which is how someone with the plugin installed and
    // working still failed to find it in the list.
    const ids = [...rows.matchAll(/^\s*-\s*id:\s*(\S+)/gm)].map((match) => match[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id, `row id "${id}" does not lead with the brand`).toMatch(/^rotifer-/);
    }
  });

  it("ships skills dsh can actually discover", () => {
    const root = createFixture();
    const outputs = buildOutputs(root);

    // dsh takes the skill name from frontmatter, not the directory, and drops a
    // skill with a missing name/description or a non-kebab name with a log line
    // and nothing else. A skill that silently never appears is the failure this
    // asserts against.
    const skillNames = /^name:\s*(\S+)\s*$/m;
    const skills = outputs.filter(
      (entry) =>
        entry.pathFromRoot.startsWith("plugins/rotifer/skills/") &&
        entry.pathFromRoot.endsWith(".md"),
    );
    expect(skills.length).toBeGreaterThan(0);

    for (const skill of skills) {
      const content = "content" in skill ? skill.content : "";
      const name = content.match(skillNames)?.[1];
      expect(name, `${skill.pathFromRoot} has no frontmatter name`).toBeDefined();
      expect(name, `${skill.pathFromRoot} name is not kebab-case`).toMatch(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      );
      expect(content, `${skill.pathFromRoot} has no description`).toMatch(/^description:\s*\S/m);

      // dsh rejects these outright rather than ignoring them, taking the whole
      // skill down with the parse.
      for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"]) {
        expect(content, `${skill.pathFromRoot} uses legacy ${legacy}`).not.toMatch(
          new RegExp(`^${legacy}:`, "m"),
        );
      }
    }
  });

  it("bundles no skill under a name another artifact already publishes", () => {
    const root = createFixture();
    const outputs = buildOutputs(root);

    // A bundled skill and an independently published one carried the same
    // frontmatter name — `rotifer-self-evolving-agent`, shipped here at the
    // family version and from its own repo at 2.4.5, with contents that had
    // already diverged. Installing both got you two different things claiming
    // to be one skill. The bundle is not the source of truth for a name that
    // ships on its own, so it may not spend one.
    const SEPARATELY_PUBLISHED = ["rotifer-self-evolving-agent"];

    const skillNames = /^name:\s*(\S+)\s*$/m;
    const bundled = outputs
      .filter(
        (entry) =>
          entry.pathFromRoot.startsWith("plugins/rotifer/skills/") &&
          entry.pathFromRoot.endsWith(".md"),
      )
      .map((entry) => ("content" in entry ? entry.content : ""))
      .map((content) => content.match(skillNames)?.[1])
      .filter((name): name is string => Boolean(name));

    expect(bundled.length).toBeGreaterThan(0);
    for (const taken of SEPARATELY_PUBLISHED) {
      expect(bundled, `a bundled skill claims ${taken}, which ships on its own`).not.toContain(
        taken,
      );
    }
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

    expect(syncedPackage.data.version).toBe(familyVersion(root, "vscode"));
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
    mkdirSync(join(root, ".codebuddy-plugin/plugins/rotifer-self-evolving-agent/skills"), {
      recursive: true,
    });
    mkdirSync(join(root, "skills/evolve"), { recursive: true });
    mkdirSync(join(root, "rules"), { recursive: true });

    writeFileSync(join(root, ".cursor-plugin/plugin.json"), "{}\n", "utf8");
    writeFileSync(join(root, ".cursor-plugin/skills/evolve/SKILL.md"), "legacy\n", "utf8");
    writeFileSync(
      join(root, ".codebuddy-plugin/plugins/rotifer-self-evolving-agent/skills/SKILL.md"),
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
