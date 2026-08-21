import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { requireAuth } from "../cloud/auth.js";
import {
  unpublishGene,
  republishGene,
  listOwnGeneVersions,
  type OwnedGeneVersion,
} from "../cloud/client.js";
import { parseGeneRef } from "../cloud/gene-ref.js";

/** Split a trailing `@version` off a gene reference, leaving `@owner/name` alone. */
export function splitVersionSuffix(ref: string): { name: string; version: string | null } {
  const trimmed = ref.trim();
  // Only a version suffix has an `@` that is neither leading nor part of `@owner/name`.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || trimmed.slice(at).includes("/")) return { name: trimmed, version: null };
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) || null };
}

/** Which side of the flag a command acts on. */
export type Direction = "down" | "up";

export type ChooseReason =
  | "no-such-gene"
  | "no-such-version"
  | "already-in-state"
  | "nothing-to-do";

/**
 * Pick the version to act on.
 *
 * With no version given this takes the newest one that is actually in the
 * state the command can change — the newest published version to take down,
 * the newest unpublished one to put back. Falling back to the newest of any
 * state would let a repeated command report success while the visible version
 * stayed exactly as it was.
 */
export function chooseVersion(
  versions: OwnedGeneVersion[],
  requested: string | null,
  direction: Direction
): { chosen: OwnedGeneVersion | null; reason: ChooseReason | null } {
  const shouldTargetPublished = direction === "down";

  if (versions.length === 0) return { chosen: null, reason: "no-such-gene" };

  if (requested) {
    const exact = versions.find((v) => v.version === requested);
    if (!exact) return { chosen: null, reason: "no-such-version" };
    if (exact.published !== shouldTargetPublished) return { chosen: null, reason: "already-in-state" };
    return { chosen: exact, reason: null };
  }

  const candidates = versions.filter((v) => v.published === shouldTargetPublished);
  if (candidates.length === 0) return { chosen: null, reason: "nothing-to-do" };
  return { chosen: candidates[0], reason: null };
}

interface Wording {
  verb: string;
  pastTense: string;
  alreadyState: string;
  nothingToDo: string;
  notYours: string;
}

const WORDING: Record<Direction, Wording> = {
  down: {
    verb: "unpublish",
    pastTense: "Unpublished",
    alreadyState: "already unpublished",
    nothingToDo: "Every version is already unpublished.",
    notYours: "Only the author of a version can take it down",
  },
  up: {
    verb: "republish",
    pastTense: "Republished",
    alreadyState: "already published",
    nothingToDo: "Every version is already published.",
    notYours: "Only the author of a version can put it back",
  },
};

async function run(
  geneRef: string, direction: Direction, shouldSkipConfirm: boolean,
  reason?: string
): Promise<void> {
  const w = WORDING[direction];

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

    const { chosen, reason } = chooseVersion(versions, version, direction);
    if (!chosen) {
      reportUnresolved(name, version, versions, reason!, w);
      process.exitCode = 1;
      return;
    }
    targetId = chosen.id;
    label = `${chosen.name}@${chosen.version}`;
  }

  if (!shouldSkipConfirm && direction === "down") {
    display.warn(`About to unpublish ${c.bold(label)}.`);
    display.hint("It disappears from search and the public registry.");
    display.hint("Its Arena entry, invocation history and published artifact are kept.");
    display.hint(`Put it back with: rotifer republish ${label}`);
    display.hint(`Re-run with ${c.bold("--yes")} to confirm.`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = direction === "down"
      ? await unpublishGene(targetId, reason)
      : await republishGene(targetId, reason);
    display.renderResult(
      { ok: true, direction, id: result.id, name: result.name, version: result.version },
      (data) => {
        display.success(`${w.pastTense} ${data.name}@${data.version}`);
        if (direction === "down") {
          display.hint(`Undo with: rotifer republish ${data.name}@${data.version}`);
        }
      }
    );
  } catch (err) {
    display.error(`Could not ${w.verb} the gene`, (err as Error).message);
    process.exitCode = 1;
  }
}

// `--reason` is optional and goes into gene_visibility_log beside the actor and
// the timestamp. A version disappearing from the registry is worth explaining,
// and the field is useless if the only client cannot fill it.
export const unpublishCommand = new Command("unpublish")
  .description("Take one of your published gene versions off the public registry")
  .argument("<gene>", "gene name, optionally name@version, or a gene UUID")
  .option("--yes", "skip the confirmation prompt", false)
  .option("--reason <text>", "why it is coming down, recorded with the takedown")
  .action(async (geneRef: string, options: { yes: boolean; reason?: string }) => {
    await run(geneRef, "down", options.yes, options.reason);
  });

export const republishCommand = new Command("republish")
  .description("Put one of your unpublished gene versions back on the public registry")
  .argument("<gene>", "gene name, optionally name@version, or a gene UUID")
  .option("--reason <text>", "why it is going back up, recorded with the restore")
  .action(async (geneRef: string, options: { reason?: string }) => {
    await run(geneRef, "up", true, options.reason);
  });

function reportUnresolved(
  name: string,
  version: string | null,
  versions: OwnedGeneVersion[],
  reason: ChooseReason,
  w: Wording
): void {
  switch (reason) {
    case "no-such-gene":
      display.error(
        `You have no gene named '${name}'.`,
        `${w.notYours}, so ${w.verb} looks only at your own genes.`
      );
      display.hint("Check the name with 'rotifer search', or publish it first.");
      return;
    case "no-such-version":
      display.error(`You have no version '${version}' of '${name}'.`);
      display.hint(`Your versions: ${versions.map((v) => v.version).join(", ")}`);
      return;
    case "already-in-state":
      display.warn(`${name}@${version} is ${w.alreadyState} — nothing to do.`);
      return;
    case "nothing-to-do":
      display.warn(`${w.nothingToDo} ('${name}')`);
      display.hint(`Versions: ${versions.map((v) => v.version).join(", ")}`);
      return;
  }
}
