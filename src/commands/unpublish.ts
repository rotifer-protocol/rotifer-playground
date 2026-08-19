import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { requireAuth } from "../cloud/auth.js";
import { unpublishGene, listOwnGeneVersions, type OwnedGeneVersion } from "../cloud/client.js";
import { parseGeneRef } from "../cloud/gene-ref.js";

/** Split a trailing `@version` off a gene reference, leaving `@owner/name` alone. */
export function splitVersionSuffix(ref: string): { name: string; version: string | null } {
  const trimmed = ref.trim();
  // Only a version suffix has an `@` that is neither leading nor part of `@owner/name`.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || trimmed.slice(at).includes("/")) return { name: trimmed, version: null };
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) || null };
}

/**
 * Pick the version to take down.
 *
 * With no version given this takes the newest **published** one, because the
 * request "unpublish my gene" is about what people can currently see. Falling
 * back to the newest of any state would let a repeated command report success
 * while the visible version stayed up.
 */
export function chooseVersion(
  versions: OwnedGeneVersion[],
  requested: string | null
): { chosen: OwnedGeneVersion | null; reason: string | null } {
  if (versions.length === 0) {
    return { chosen: null, reason: "no-such-gene" };
  }
  if (requested) {
    const exact = versions.find((v) => v.version === requested);
    if (!exact) return { chosen: null, reason: "no-such-version" };
    if (!exact.published) return { chosen: null, reason: "already-unpublished" };
    return { chosen: exact, reason: null };
  }
  const published = versions.filter((v) => v.published);
  if (published.length === 0) return { chosen: null, reason: "all-unpublished" };
  return { chosen: published[0], reason: null };
}

export const unpublishCommand = new Command("unpublish")
  .description("Take one of your published gene versions off the public registry")
  .argument("<gene>", "gene name, optionally name@version, or a gene UUID")
  .option("--yes", "skip the confirmation prompt", false)
  .action(async (geneRef: string, options: { yes: boolean }) => {
    try {
      await requireAuth();
    } catch {
      display.error("Not logged in. Run 'rotifer login' first.");
      process.exitCode = 1;
      return;
    }

    let targetId: string;
    let label: string;

    const asRef = parseGeneRef(geneRef);
    if (asRef.kind === "uuid") {
      targetId = asRef.raw;
      label = asRef.raw;
    } else {
      const { name, version } = splitVersionSuffix(geneRef);
      let versions: OwnedGeneVersion[];
      try {
        versions = await listOwnGeneVersions(name);
      } catch (err) {
        display.error("Could not look up your genes", (err as Error).message);
        process.exitCode = 1;
        return;
      }

      const { chosen, reason } = chooseVersion(versions, version);
      if (!chosen) {
        reportUnresolved(name, version, versions, reason!);
        process.exitCode = 1;
        return;
      }
      targetId = chosen.id;
      label = `${chosen.name}@${chosen.version}`;
    }

    if (!options.yes) {
      display.warn(`About to unpublish ${c.bold(label)}.`);
      display.hint("It disappears from search and the public registry.");
      display.hint("Its Arena entry, invocation history and published artifact are kept — ");
      display.hint("republishing the same version restores it.");
      display.hint(`Re-run with ${c.bold("--yes")} to confirm.`);
      process.exitCode = 1;
      return;
    }

    try {
      const result = await unpublishGene(targetId);
      display.renderResult(
        { unpublished: true, id: result.id, name: result.name, version: result.version },
        (data) => {
          display.success(`Unpublished ${data.name}@${data.version}`);
          display.hint(`Restore it with: rotifer publish  (same version, ${data.version})`);
        }
      );
    } catch (err) {
      display.error("Unpublish failed", (err as Error).message);
      process.exitCode = 1;
    }
  });

function reportUnresolved(
  name: string,
  version: string | null,
  versions: OwnedGeneVersion[],
  reason: string
): void {
  switch (reason) {
    case "no-such-gene":
      display.error(
        `You have no gene named '${name}'.`,
        "Only the author of a version can take it down, so unpublish looks only at your own genes."
      );
      display.hint("Run 'rotifer publish' first, or check the name with 'rotifer search'.");
      return;
    case "no-such-version":
      display.error(`You have no version '${version}' of '${name}'.`);
      display.hint(`Your versions: ${versions.map((v) => v.version).join(", ")}`);
      return;
    case "already-unpublished":
      display.warn(`${name}@${version} is already unpublished — nothing to do.`);
      return;
    case "all-unpublished":
      display.warn(`Every version of '${name}' is already unpublished.`);
      display.hint(`Versions: ${versions.map((v) => v.version).join(", ")}`);
      return;
    default:
      display.error(`Could not resolve '${name}'.`);
  }
}
