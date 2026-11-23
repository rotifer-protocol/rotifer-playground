/**
 * Setup step for tests that start a P2P node (T-237): write the consent
 * record `network start` and the daemon now require, in the format of
 * `src/utils/p2p-consent.ts`. Written directly rather than through the CLI,
 * so it works with a native module that predates `NodeIdentity` (the
 * published platform package CI's ordinary E2E job uses).
 *
 * `home` is the HOME directory; the record goes to `<home>/.rotifer/p2p/`.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function grantP2pConsent(home: string): void {
  const dir = join(home, ".rotifer", "p2p");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "consent.json");
  const record = { version: 1, noticeVersion: 1, acceptedAt: new Date().toISOString(), source: "command" };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
