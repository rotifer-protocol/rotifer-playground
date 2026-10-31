/**
 * Spec §30.2 DataPolicy, and what it allows a gene to write into AgentMemory
 * (spec §38.2 "与数据主权的集成").
 *
 * §30.2 has no field that says "may not write memory", so the checks below
 * are what the declared policy implies for a memory entry:
 *   1. an entry may not be kept longer than the agent's data retention;
 *   2. an entry may not be shareable (ANONYMIZED_SHARE / KNOWLEDGE_GENE)
 *      when the agent's data cannot be anonymised — §38.3 makes
 *      de-identification a MUST before anything leaves as a knowledge gene;
 *   3. DEPLOYER_CONFIGURED resolves from the DataPolicy, which defines no
 *      memory scope (always "not configured", so denied; no
 *      field is invented for it).
 * A violation is MEMORY_ACCESS_DENIED.
 */
import type { MemoryAccessPolicy, RetentionPolicy } from "./types.js";

export type DataOwner = "DEPLOYER" | "USER" | "AGENT" | { SHARED: string[] };

export interface DataPolicy {
  inputDataOwnership: DataOwner;
  outputDataOwnership: DataOwner;
  learningDataOwnership: DataOwner;
  metadataOwnership: DataOwner;
  retentionPolicy: RetentionPolicy;
  deletionSupport: boolean;
}

/**
 * What `rotifer agent create` records when the deployer configures nothing
 * (§30.2 says the deployer MUST configure one; this is the explicit
 * default written into the agent record, not an implied one). Learning data
 * — which memory is — belongs to the agent and travels with it (§30.4);
 * retention has no day limit; and nothing claims anonymisation it does not
 * do, so shareable entries are refused until the deployer says otherwise.
 */
export const DEFAULT_DATA_POLICY: Readonly<DataPolicy> = Object.freeze({
  inputDataOwnership: "DEPLOYER",
  outputDataOwnership: "DEPLOYER",
  learningDataOwnership: "AGENT",
  metadataOwnership: "DEPLOYER",
  retentionPolicy: Object.freeze({
    maxRetentionDays: null,
    autoDeleteOnTermination: false,
    anonymizationSupported: false,
  }),
  deletionSupport: true,
}) as DataPolicy;

/** Why a write breaks the agent's DataPolicy, or null if it does not. */
export function dataPolicyViolation(
  policy: DataPolicy,
  accessPolicy: MemoryAccessPolicy,
  retention: RetentionPolicy | null,
): string | null {
  const agentDays = policy.retentionPolicy.maxRetentionDays;
  if (retention && agentDays !== null) {
    if (retention.maxRetentionDays === null || retention.maxRetentionDays > agentDays) {
      return `retentionPolicy keeps the entry ${retention.maxRetentionDays ?? "indefinitely"} day(s); the agent's DataPolicy allows at most ${agentDays}`;
    }
  }
  if (accessPolicy.sharePolicy !== "PRIVATE" && !policy.retentionPolicy.anonymizationSupported) {
    return `sharePolicy ${accessPolicy.sharePolicy} needs a DataPolicy that supports anonymisation (§38.3); this agent's does not`;
  }
  const isDeployerScopeUsed =
    accessPolicy.readScope === "DEPLOYER_CONFIGURED" || accessPolicy.writeScope === "DEPLOYER_CONFIGURED";
  if (isDeployerScopeUsed) {
    return "DEPLOYER_CONFIGURED resolves from the agent's DataPolicy (§30.2), which defines no memory scope yet, so it is treated as not configured";
  }
  return null;
}
