/**
 * Shared by the two test-run guards that keep tests out of the developer's
 * real home (T-237): which directories are watched, and a snapshot of them
 * made of names, sizes and modification times only. File contents are never
 * read: `~/.rotifer` holds credentials.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";

/**
 * The account's real home, from the user database rather than HOME, which
 * the guards replace. `ROTIFER_TEST_REAL_HOME` overrides it, only so the
 * guard itself can be tested against a stand-in directory.
 */
export function realHome(): string {
  return process.env.ROTIFER_TEST_REAL_HOME || userInfo().homedir;
}

/** The CLI's state directories under a home. */
export function watchedDirs(home: string): string[] {
  return [join(home, ".rotifer"), join(home, ".config", "rotifer")];
}

/**
 * Path → "kind size mtime" for every entry under `dirs`; a missing dir maps
 * to "absent". A directory's own mtime is left out: adding or removing an
 * entry changes it, and the entry itself already shows.
 */
export function snapshot(dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        out.set(path, "dir");
        walk(path);
      } else {
        out.set(path, `${st.isSymbolicLink() ? "link" : "file"} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  for (const dir of dirs) {
    if (existsSync(dir)) {
      out.set(dir, "dir");
      walk(dir);
    } else {
      out.set(dir, "absent");
    }
  }
  return out;
}

/** What was added, removed or changed between two snapshots, as paths relative to `home`. */
export function changes(before: Map<string, string>, after: Map<string, string>, home: string): string[] {
  const out: string[] = [];
  for (const [path, v] of before) {
    if (!after.has(path)) out.push(`removed ${relative(home, path)}`);
    else if (after.get(path) !== v) out.push(`changed ${relative(home, path)}`);
  }
  for (const path of after.keys()) if (!before.has(path)) out.push(`added ${relative(home, path)}`);
  return out.sort();
}
