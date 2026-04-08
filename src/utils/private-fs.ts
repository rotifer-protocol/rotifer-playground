import { chmodSync, existsSync, mkdirSync } from "node:fs";

export function ensurePrivateDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }

  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort hardening on existing directories.
  }
}

export function tightenPrivateFile(filePath: string, mode: number = 0o600): void {
  try {
    chmodSync(filePath, mode);
  } catch {
    // Best-effort hardening on files that were just created or updated.
  }
}
