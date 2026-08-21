import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const REPO_ROOT = join(__dirname, "..", "..");

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTomlSection(text, sectionName) {
  const lines = text.split("\n");
  const header = `[${sectionName}]`;
  const section = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inSection) {
      if (trimmed === header) {
        inSection = true;
      }
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      break;
    }

    section.push(line);
  }

  return section.join("\n");
}

function readQuotedTomlValue(section, key) {
  const match = section.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*$`, "m"));
  return match ? match[1] : null;
}

function readBooleanTomlValue(section, key) {
  const match = section.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*$`, "m"));
  return match ? match[1] === "true" : null;
}

export function readWorkspaceVersion(cargoTomlText) {
  return readQuotedTomlValue(readTomlSection(cargoTomlText, "workspace.package"), "version");
}

export function readPackagePublishFlag(cargoTomlText) {
  return readBooleanTomlValue(readTomlSection(cargoTomlText, "package"), "publish");
}

export function readRotiferCoreDependencyVersion(cargoTomlText) {
  const dependencies = readTomlSection(cargoTomlText, "dependencies");
  const match = dependencies.match(/^rotifer-core\s*=\s*\{[^\n]*version\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/**
 * The README's `Status:` line, and the minor line it claims to describe.
 *
 * It is hand-written prose, and nothing noticed when it went stale: on
 * 2026-08-21 the npm page showed 0.19.2 beside a paragraph describing v0.10.1's
 * P2P Reliability work — nine days and thirty-six changelog entries out of
 * date, while the actual work had moved to Arena integrity. The npm badge is
 * generated from the registry so it was right; the sentence beneath it was the
 * project's public first impression and it was wrong.
 *
 * Deliberately matched at MINOR granularity. Pinning the patch would turn every
 * patch release into a README edit, and nobody re-reads a paragraph they are
 * editing for the ninth time that week — the check would train people to bump
 * the number and move on. A minor bump is the point where the phase genuinely
 * changed, so that is where the red should land and force a re-read.
 *
 * Note what is NOT checked: the roadmap further down cites protocol-line
 * versions (v0.9, v0.9.1, v1.0), which are a separate numbering line from the
 * npm releases and are meant to differ. Only the `Status:` line is compared.
 */
export function readReadmeStatusVersion(readmeText) {
  const match = readmeText.match(/^>\s*\*\*Status:\*\*\s*v(\d+)\.(\d+)/m);
  return match ? { major: Number(match[1]), minor: Number(match[2]), raw: match[0] } : null;
}

/**
 * May the Status line sit one release ahead of package.json?
 *
 * It has to, and the first version of this check said no — which left it with no
 * exit. The released version lives in package.json, and release-please bumps
 * that on its own branch. So on main, all the way through a cycle, package.json
 * still holds the PREVIOUS number. Demanding equality means the paragraph can
 * only ever be rewritten on the bot's branch; rewriting it on main, the one
 * obvious place, turns main red instead. That is what blocked the v0.20.0
 * release PR the day this check shipped.
 *
 * Drift only ever runs backwards. The bug this exists for was a Status line
 * stuck at v0.10.1 while npm served 0.19.2 — nine minors behind, never once
 * ahead. So the rule is "not behind, and not further out than the next
 * release": the paragraph may describe the version being prepared, and may not
 * describe one nobody could install even after that ships.
 *
 * Known residue, accepted rather than papered over: update the Status line for
 * v0.20.x and then cut a 0.19.3 patch, and the patch ships prose naming a
 * version it is not. It is one release wide, it self-corrects at the next
 * minor, and closing it would mean a second strictness mode wired through the
 * release path — more machinery than the hole is deep.
 */
function describesThisOrNextRelease(status, major, minor) {
  if (status.major === major) {
    return status.minor === minor || status.minor === minor + 1;
  }
  return status.major === major + 1 && status.minor === 0;
}

export function verifyReadmeStatusFreshness(rootDir = REPO_ROOT) {
  const errors = [];
  const npmVersion = readJson(join(rootDir, "package.json")).version;
  const [major, minor] = npmVersion.split(".").map(Number);

  const status = readReadmeStatusVersion(readText(join(rootDir, "README.md")));

  if (!status) {
    errors.push(
      "README.md: no `> **Status:** vX.Y` line found. It is the paragraph npm shows " +
        "under the title; if it moved or lost its version, re-point this check at it " +
        "rather than deleting the check.",
    );
    return { ok: false, errors };
  }

  const isBehind =
    status.major < major || (status.major === major && status.minor < minor);

  if (isBehind) {
    errors.push(
      `README.md: the Status line describes v${status.major}.${status.minor}.x but the ` +
        `released version is ${npmVersion}. A minor bump means the phase moved — rewrite ` +
        "the paragraph to say what is true now, then set the version to " +
        `v${major}.${minor}.x (or v${major}.${minor + 1}.x if you are writing it for the ` +
        "release being prepared). Do not bump the number alone: a fresh version on stale " +
        "prose reads as current and is not.",
    );
  } else if (!describesThisOrNextRelease(status, major, minor)) {
    errors.push(
      `README.md: the Status line describes v${status.major}.${status.minor}.x, but the ` +
        `released version is ${npmVersion} and the furthest this repo can be preparing is ` +
        `v${major}.${minor + 1}.x. A Status line beyond the next release describes ` +
        "something nobody can install.",
    );
  }

  return { ok: errors.length === 0, errors };
}

export function verifyRustVersionAlignment(rootDir = REPO_ROOT) {
  const errors = [];

  const workspaceCargo = readText(join(rootDir, "Cargo.toml"));
  const workspaceVersion = readWorkspaceVersion(workspaceCargo);

  if (!workspaceVersion) {
    return {
      ok: false,
      workspaceVersion: null,
      errors: ["Cargo.toml: missing [workspace.package].version"],
    };
  }

  const napiPackage = readJson(join(rootDir, "crates/rotifer-napi/package.json"));
  if (napiPackage.version !== workspaceVersion) {
    errors.push(
      `crates/rotifer-napi/package.json: expected version ${workspaceVersion}, got ${napiPackage.version}`,
    );
  }

  const rootPkg = readJson(join(rootDir, "package.json"));
  const npmVersion = rootPkg.version;

  const platformPkgs = ["darwin-arm64", "darwin-x64", "linux-x64-gnu", "win32-x64-msvc"];
  for (const platform of platformPkgs) {
    try {
      const pkgPath = join(rootDir, "npm", platform, "package.json");
      const pkg = readJson(pkgPath);
      if (pkg.version !== npmVersion) {
        errors.push(
          `npm/${platform}/package.json: expected version ${npmVersion}, got ${pkg.version}`,
        );
      }
    } catch {
      errors.push(`npm/${platform}/package.json: file not found`);
    }
  }

  const optDeps = rootPkg.optionalDependencies || {};
  for (const platform of platformPkgs) {
    const depName = `@rotifer/playground-${platform}`;
    if (optDeps[depName] && optDeps[depName] !== npmVersion) {
      errors.push(
        `package.json optionalDependencies: ${depName} expected ${npmVersion}, got ${optDeps[depName]}`,
      );
    }
  }

  const coreCargo = readText(join(rootDir, "crates/rotifer-core/Cargo.toml"));
  if (readPackagePublishFlag(coreCargo) !== false) {
    errors.push("crates/rotifer-core/Cargo.toml: expected publish = false");
  }

  const napiCargo = readText(join(rootDir, "crates/rotifer-napi/Cargo.toml"));
  const dependencyVersion = readRotiferCoreDependencyVersion(napiCargo);
  if (dependencyVersion !== workspaceVersion) {
    errors.push(
      `crates/rotifer-napi/Cargo.toml: expected rotifer-core version ${workspaceVersion}, got ${dependencyVersion ?? "missing"}`,
    );
  }

  if (readPackagePublishFlag(napiCargo) !== false) {
    errors.push("crates/rotifer-napi/Cargo.toml: expected publish = false");
  }

  return {
    ok: errors.length === 0,
    workspaceVersion,
    errors,
  };
}
