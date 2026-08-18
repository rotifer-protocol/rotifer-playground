import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const REPO_ROOT = join(__dirname, "..", "..");
export const PLUGIN_SOURCE_ROOT = join(REPO_ROOT, "plugin-source");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = buildCrcTable();
const OBSOLETE_OUTPUT_PATHS = [
  ".cursor-plugin/plugin.json",
  ".cursor-plugin/skills",
  ".cursor-plugin/rules",
  ".codebuddy-plugin/plugins",
  "skills",
  "rules",
  "assets/icon.png",
];

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(data.length, 0);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

function colorFromHex(hex) {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    255,
  ];
}

function setPixel(buffer, size, x, y, rgba) {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return;
  }

  const offset = (y * size + x) * 4;
  buffer[offset] = rgba[0];
  buffer[offset + 1] = rgba[1];
  buffer[offset + 2] = rgba[2];
  buffer[offset + 3] = rgba[3];
}

function fillCircle(buffer, size, centerX, centerY, radius, rgba) {
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(buffer, size, x, y, rgba);
      }
    }
  }
}

function strokeCircle(buffer, size, centerX, centerY, radius, thickness, rgba) {
  const outer = radius;
  const inner = Math.max(0, radius - thickness);
  const outerSq = outer * outer;
  const innerSq = inner * inner;

  for (let y = Math.floor(centerY - outer); y <= Math.ceil(centerY + outer); y += 1) {
    for (let x = Math.floor(centerX - outer); x <= Math.ceil(centerX + outer); x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq <= outerSq && distanceSq >= innerSq) {
        setPixel(buffer, size, x, y, rgba);
      }
    }
  }
}

function interpolateRgba(start, end, ratio) {
  return [
    Math.round(start[0] + (end[0] - start[0]) * ratio),
    Math.round(start[1] + (end[1] - start[1]) * ratio),
    Math.round(start[2] + (end[2] - start[2]) * ratio),
    255,
  ];
}

function drawDiagonalGradient(size, topLeft, bottomRight) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ratio = (x + y) / ((size - 1) * 2);
      setPixel(rgba, size, x, y, interpolateRgba(topLeft, bottomRight, ratio));
    }
  }
  return rgba;
}

export function createBrandPng(size = 128) {
  void size;
  return readFileSync(join(PLUGIN_SOURCE_ROOT, "assets/brandmark.png"));
}

export function renderTemplate(content, variables) {
  return Object.entries(variables).reduce((text, [key, value]) => {
    return text.replaceAll(`{{${key}}}`, String(value));
  }, content);
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function outputText(pathFromRoot, content) {
  return {
    kind: "text",
    pathFromRoot,
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

function outputJson(pathFromRoot, data) {
  return {
    kind: "json",
    pathFromRoot,
    data,
  };
}

function outputBinary(pathFromRoot, content) {
  return {
    kind: "binary",
    pathFromRoot,
    content,
  };
}

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function injectVersion(object, version) {
  return {
    ...object,
    version,
  };
}

function injectMarketplacePluginVersions(marketplace, version) {
  return {
    ...marketplace,
    plugins: marketplace.plugins.map((plugin) => ({
      ...plugin,
      version,
    })),
  };
}

/**
 * Render the dsh bundle patch.
 *
 * The launch line is NOT a second copy: it is read from the same
 * `openclawPackage.openclaw.mcpServers` object the OpenClaw manifest ships, so
 * the pin and the tool set cannot drift between the two hosts. Only the facts
 * dsh alone needs — its own package name, the measured schema cost — come from
 * `dshBundle`.
 */
function renderDshPatch(template, rootFamily, dshBundle) {
  const server = rootFamily.openclawPackage.openclaw.mcpServers.rotifer;
  const args = toArray(server.args)
    .map((arg) => `          - '${String(arg).replaceAll("'", "''")}'`)
    .join("\n");

  return renderTemplate(template, {
    packageName: rootFamily.openclawPackage.name,
    mcpCommand: server.command,
    mcpArgsYaml: args,
    mcpToolCount: dshBundle.mcpToolCount,
    mcpSchemaBytes: dshBundle.mcpSchemaBytes,
    dshVersion: dshBundle.dshVersion,
  });
}

function syncVscodePackage(currentPackage, packageSync, version) {
  return {
    ...currentPackage,
    ...packageSync,
    version,
  };
}

export function buildOutputs(rootDir = REPO_ROOT) {
  const versions = readJson(join(rootDir, "plugin-source/families.json"));
  const rootFamily = readJson(join(rootDir, "plugin-source/families/root.json"));
  const vscodeFamily = readJson(join(rootDir, "plugin-source/families/vscode.json"));
  const vscodePackage = readJson(join(rootDir, "rotifer-vscode/package.json"));

  const rootVersion = versions.root.version;
  const vscodeVersion = versions.vscode.version;

  const rootEvolve = renderTemplate(
    readText(join(rootDir, "plugin-source/content/root/evolve/SKILL.md")),
    { familyVersion: rootVersion },
  );
  const rootHello = renderTemplate(
    readText(join(rootDir, "plugin-source/content/root/hello/SKILL.md")),
    { familyVersion: rootVersion },
  );
  const rootAssistant = renderTemplate(
    readText(join(rootDir, "plugin-source/content/root/assistant/SKILL.md")),
    { familyVersion: rootVersion },
  );
  const rootDshPatch = renderDshPatch(
    readText(join(rootDir, "plugin-source/content/root/dsh/cordis.patch.yml")),
    rootFamily,
    rootFamily.dshBundle,
  );
  const sharedRule = readText(join(rootDir, "plugin-source/content/shared/rotifer-gene-dev.mdc"));
  const rootRotifer = readText(join(rootDir, "plugin-source/content/root/rotifer.md"));
  const vscodeRotifer = readText(join(rootDir, "plugin-source/content/vscode/rotifer.md"));
  const vscodeRule = readText(
    join(rootDir, "plugin-source/content/vscode/rotifer-conventions.mdc"),
  );
  const brandPng = createBrandPng(128);

  return [
    outputJson(".cursor-plugin/marketplace.json", rootFamily.cursorMarketplace),
    outputJson(
      "plugins/rotifer/.cursor-plugin/plugin.json",
      injectVersion(rootFamily.cursorPlugin, rootVersion),
    ),
    outputJson(
      ".codebuddy-plugin/marketplace.json",
      injectMarketplacePluginVersions(rootFamily.codebuddyMarketplace, rootVersion),
    ),
    outputJson(
      "plugins/rotifer/.codebuddy-plugin/plugin.json",
      injectVersion(rootFamily.codebuddyPlugin, rootVersion),
    ),
    // The same folder serves three more hosts. OpenClaw reads
    // openclaw.plugin.json and ClawHub publishes the folder as a bundle; Claude
    // Code reads the .claude-plugin marker; DeepSeek Harness reads dsh.bundle in
    // package.json and applies cordis.patch.yml. One plugin, one version, four
    // hosts — rather than a second copy of the skills maintained beside this one.
    outputJson(
      "plugins/rotifer/openclaw.plugin.json",
      injectVersion(rootFamily.openclawPlugin, rootVersion),
    ),
    outputJson(
      "plugins/rotifer/.claude-plugin/plugin.json",
      injectVersion(rootFamily.claudePlugin, rootVersion),
    ),
    outputJson(
      "plugins/rotifer/package.json",
      injectVersion(rootFamily.openclawPackage, rootVersion),
    ),
    outputText("plugins/rotifer/cordis.patch.yml", rootDshPatch),
    outputText("plugins/rotifer/skills/evolve/SKILL.md", rootEvolve),
    outputText("plugins/rotifer/skills/hello/SKILL.md", rootHello),
    outputText("plugins/rotifer/skills/assistant/SKILL.md", rootAssistant),
    outputText("plugins/rotifer/rules/rotifer-gene-dev.mdc", sharedRule),
    outputText("plugins/rotifer/skills/rotifer.md", rootRotifer),
    outputBinary("plugins/rotifer/assets/icon.png", brandPng),

    outputJson(
      "rotifer-vscode/package.json",
      syncVscodePackage(vscodePackage, vscodeFamily.packageSync, vscodeVersion),
    ),
    outputJson(
      "rotifer-vscode/.cursor-plugin/plugin.json",
      injectVersion(vscodeFamily.cursor, vscodeVersion),
    ),
    outputJson(
      "rotifer-vscode/.codebuddy-plugin/marketplace.json",
      injectMarketplacePluginVersions(vscodeFamily.codebuddy, vscodeVersion),
    ),
    outputJson(
      "rotifer-vscode/.codebuddy-plugin/plugin.json",
      injectVersion(vscodeFamily.codebuddyPlugin, vscodeVersion),
    ),
    outputText("rotifer-vscode/skills/rotifer.md", vscodeRotifer),
    outputText("rotifer-vscode/rules/rotifer-conventions.mdc", vscodeRule),
    outputBinary("rotifer-vscode/icon.png", brandPng),
    outputBinary("rotifer-vscode/assets/logo.png", brandPng),
  ];
}

export function updateFamilyVersion(rootDir, familyName, version) {
  const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  if (!versionPattern.test(version)) {
    throw new Error(`Invalid family version: ${version}`);
  }

  const familiesPath = join(rootDir, "plugin-source/families.json");
  const families = readJson(familiesPath);
  if (!(familyName in families)) {
    throw new Error(`Unknown plugin family: ${familyName}`);
  }

  families[familyName].version = version;
  writeJson(familiesPath, families);
  return families;
}

function cleanupObsoleteOutputs(rootDir) {
  for (const pathFromRoot of OBSOLETE_OUTPUT_PATHS) {
    const absolutePath = join(rootDir, pathFromRoot);
    if (existsSync(absolutePath)) {
      rmSync(absolutePath, { recursive: true, force: true });
    }
  }
}

function readExistingOutput(rootDir, output) {
  const absolutePath = join(rootDir, output.pathFromRoot);
  if (!existsSync(absolutePath)) {
    return null;
  }

  if (output.kind === "binary") {
    return readFileSync(absolutePath);
  }

  return readFileSync(absolutePath, "utf8");
}

function expectedOutput(output) {
  if (output.kind === "binary") {
    return output.content;
  }

  if (output.kind === "json") {
    return `${JSON.stringify(output.data, null, 2)}\n`;
  }

  return output.content;
}

export function diffOutputs(rootDir = REPO_ROOT) {
  const diffs = [];

  for (const output of buildOutputs(rootDir)) {
    const actual = readExistingOutput(rootDir, output);
    const expected = expectedOutput(output);

    if (actual === null) {
      diffs.push({
        pathFromRoot: output.pathFromRoot,
        reason: "missing",
      });
      continue;
    }

    if (output.kind === "binary") {
      if (!Buffer.isBuffer(actual) || !actual.equals(expected)) {
        diffs.push({
          pathFromRoot: output.pathFromRoot,
          reason: "content",
        });
      }
      continue;
    }

    if (actual !== expected) {
      diffs.push({
        pathFromRoot: output.pathFromRoot,
        reason: "content",
      });
    }
  }

  for (const pathFromRoot of OBSOLETE_OUTPUT_PATHS) {
    if (existsSync(join(rootDir, pathFromRoot))) {
      diffs.push({
        pathFromRoot,
        reason: "obsolete",
      });
    }
  }

  return diffs;
}

export function syncOutputs(rootDir = REPO_ROOT) {
  for (const output of buildOutputs(rootDir)) {
    const absolutePath = join(rootDir, output.pathFromRoot);
    ensureParent(absolutePath);

    if (output.kind === "json") {
      writeJson(absolutePath, output.data);
      continue;
    }

    if (output.kind === "binary") {
      writeFileSync(absolutePath, output.content);
      continue;
    }

    writeFileSync(absolutePath, output.content, "utf8");
  }

  cleanupObsoleteOutputs(rootDir);
}

function isPngFile(filePath) {
  if (!existsSync(filePath)) {
    return false;
  }
  const file = readFileSync(filePath);
  return file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function verifyCursorManifest(rootDir, manifestPath) {
  const manifest = readJson(join(rootDir, manifestPath));
  const pluginRoot = dirname(dirname(join(rootDir, manifestPath)));
  const errors = [];

  if (!existsSync(join(pluginRoot, manifest.logo))) {
    errors.push(`${manifestPath}: missing logo ${manifest.logo}`);
  }

  for (const skillDir of manifest.skills ?? []) {
    if (!existsSync(join(pluginRoot, skillDir))) {
      errors.push(`${manifestPath}: missing skills path ${skillDir}`);
    }
  }

  for (const ruleDir of manifest.rules ?? []) {
    if (!existsSync(join(pluginRoot, ruleDir))) {
      errors.push(`${manifestPath}: missing rules path ${ruleDir}`);
    }
  }

  return errors;
}

function resolveMarketplaceSourcePaths(rootDir, manifestFile, source) {
  if (typeof source !== "string") {
    return [];
  }

  const candidatePaths = [
    join(dirname(dirname(manifestFile)), source),
    join(rootDir, source),
  ];

  return [...new Set(candidatePaths)];
}

function verifyCursorMarketplace(rootDir, manifestPath) {
  const manifestFile = join(rootDir, manifestPath);
  const manifest = readJson(manifestFile);
  const errors = [];

  for (const plugin of manifest.plugins ?? []) {
    const sourcePaths = resolveMarketplaceSourcePaths(rootDir, manifestFile, plugin.source);
    const sourcePath = sourcePaths.find((candidate) => existsSync(candidate));

    if (!sourcePath) {
      errors.push(`${manifestPath}: missing plugin source ${plugin.source}`);
      continue;
    }

    if (!existsSync(join(sourcePath, ".cursor-plugin/plugin.json"))) {
      errors.push(
        `${manifestPath}: missing plugin manifest ${plugin.source}/.cursor-plugin/plugin.json`,
      );
    }
  }

  return errors;
}

function verifyCodeBuddyMarketplace(rootDir, manifestPath) {
  const manifestFile = join(rootDir, manifestPath);
  const manifest = readJson(manifestFile);
  const errors = [];

  for (const plugin of manifest.plugins ?? []) {
    const sourcePaths = resolveMarketplaceSourcePaths(rootDir, manifestFile, plugin.source);
    const sourcePath = sourcePaths.find((candidate) => existsSync(candidate));

    if (!sourcePath) {
      errors.push(`${manifestPath}: missing plugin source ${plugin.source}`);
      continue;
    }

    if (!existsSync(join(sourcePath, ".codebuddy-plugin/plugin.json"))) {
      errors.push(
        `${manifestPath}: missing plugin manifest ${plugin.source}/.codebuddy-plugin/plugin.json`,
      );
    }
  }

  return errors;
}

function verifyCodeBuddyPluginManifest(rootDir, manifestPath) {
  const manifest = readJson(join(rootDir, manifestPath));
  const pluginRoot = dirname(dirname(join(rootDir, manifestPath)));
  const errors = [];

  if (!existsSync(join(pluginRoot, "skills"))) {
    errors.push(`${manifestPath}: missing default skills directory`);
  }

  for (const relPath of toArray(manifest.skills)) {
    if (typeof relPath === "string" && !existsSync(join(pluginRoot, relPath))) {
      errors.push(`${manifestPath}: missing skills path ${relPath}`);
    }
  }

  return errors;
}

function verifyVscodePackage(rootDir) {
  const packagePath = join(rootDir, "rotifer-vscode/package.json");
  const pkg = readJson(packagePath);
  const errors = [];

  const iconPath = join(rootDir, "rotifer-vscode", pkg.icon);
  if (!existsSync(iconPath)) {
    errors.push("rotifer-vscode/package.json: missing icon.png");
  } else if (!isPngFile(iconPath)) {
    errors.push("rotifer-vscode/package.json: icon is not a PNG file");
  }

  const requiredFields = ["main", "contributes", "scripts"];
  for (const field of requiredFields) {
    if (!(field in pkg)) {
      errors.push(`rotifer-vscode/package.json: missing preserved field ${field}`);
    }
  }

  return errors;
}

function verifyFamilyVersions(rootDir) {
  const versions = readJson(join(rootDir, "plugin-source/families.json"));
  const errors = [];

  const rootCursor = readJson(join(rootDir, "plugins/rotifer/.cursor-plugin/plugin.json"));
  if (rootCursor.version !== versions.root.version) {
    errors.push(
      `plugins/rotifer/.cursor-plugin/plugin.json: expected version ${versions.root.version}, got ${rootCursor.version}`,
    );
  }

  const rootCodeBuddy = readJson(join(rootDir, ".codebuddy-plugin/marketplace.json"));
  for (const plugin of rootCodeBuddy.plugins ?? []) {
    if (plugin.version !== versions.root.version) {
      errors.push(
        `.codebuddy-plugin/marketplace.json: expected version ${versions.root.version}, got ${plugin.version}`,
      );
    }
  }

  const rootCodeBuddyPlugin = readJson(join(rootDir, "plugins/rotifer/.codebuddy-plugin/plugin.json"));
  if (rootCodeBuddyPlugin.version !== versions.root.version) {
    errors.push(
      `plugins/rotifer/.codebuddy-plugin/plugin.json: expected version ${versions.root.version}, got ${rootCodeBuddyPlugin.version}`,
    );
  }

  const vscodePackage = readJson(join(rootDir, "rotifer-vscode/package.json"));
  if (vscodePackage.version !== versions.vscode.version) {
    errors.push(
      `rotifer-vscode/package.json: expected version ${versions.vscode.version}, got ${vscodePackage.version}`,
    );
  }

  const vscodeCursor = readJson(join(rootDir, "rotifer-vscode/.cursor-plugin/plugin.json"));
  if (vscodeCursor.version !== versions.vscode.version) {
    errors.push(
      `rotifer-vscode/.cursor-plugin/plugin.json: expected version ${versions.vscode.version}, got ${vscodeCursor.version}`,
    );
  }

  const vscodeCodeBuddy = readJson(join(rootDir, "rotifer-vscode/.codebuddy-plugin/marketplace.json"));
  for (const plugin of vscodeCodeBuddy.plugins ?? []) {
    if (plugin.version !== versions.vscode.version) {
      errors.push(
        `rotifer-vscode/.codebuddy-plugin/marketplace.json: expected version ${versions.vscode.version}, got ${plugin.version}`,
      );
    }
  }

  const vscodeCodeBuddyPlugin = readJson(
    join(rootDir, "rotifer-vscode/.codebuddy-plugin/plugin.json"),
  );
  if (vscodeCodeBuddyPlugin.version !== versions.vscode.version) {
    errors.push(
      `rotifer-vscode/.codebuddy-plugin/plugin.json: expected version ${versions.vscode.version}, got ${vscodeCodeBuddyPlugin.version}`,
    );
  }

  return errors;
}

export function verifyPluginPackaging(rootDir = REPO_ROOT) {
  const errors = [
    ...verifyCursorMarketplace(rootDir, ".cursor-plugin/marketplace.json"),
    ...verifyCursorManifest(rootDir, "plugins/rotifer/.cursor-plugin/plugin.json"),
    ...verifyCursorManifest(rootDir, "rotifer-vscode/.cursor-plugin/plugin.json"),
    ...verifyCodeBuddyMarketplace(rootDir, ".codebuddy-plugin/marketplace.json"),
    ...verifyCodeBuddyPluginManifest(rootDir, "plugins/rotifer/.codebuddy-plugin/plugin.json"),
    ...verifyCodeBuddyMarketplace(rootDir, "rotifer-vscode/.codebuddy-plugin/marketplace.json"),
    ...verifyCodeBuddyPluginManifest(rootDir, "rotifer-vscode/.codebuddy-plugin/plugin.json"),
    ...verifyVscodePackage(rootDir),
    ...verifyFamilyVersions(rootDir),
  ];

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function formatDiffs(diffs, rootDir = REPO_ROOT) {
  return diffs.map((diff) => `- ${relative(rootDir, join(rootDir, diff.pathFromRoot))}: ${diff.reason}`);
}
