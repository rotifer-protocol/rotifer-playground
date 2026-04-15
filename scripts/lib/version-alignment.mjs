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
