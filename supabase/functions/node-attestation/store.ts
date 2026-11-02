/**
 * AttestationStore on Supabase: the two SECURITY DEFINER functions of the
 * deferred migration 20261102200000 (supabase/migrations-deferred-v095-por/),
 * which only service_role may execute. This client is used for nothing else.
 */

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { type AttestationStore, type IssueRecord, PorError, storeCode } from "./handler.ts";
import type { Bytes } from "./por.ts";

function hex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: unknown): Bytes {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/.test(text)) throw new PorError("POR_INTERNAL", "unexpected nonce from the database");
  return Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
}

export function supabaseStore(db: SupabaseClient): AttestationStore {
  return {
    async challenge(userId, aud) {
      const { data, error } = await db.rpc("node_attestation_challenge", { p_user_id: userId, p_aud: aud });
      if (error) throw new Error(`node_attestation_challenge: ${error.message}`);
      if (data?.error !== undefined) return { error: storeCode(data.error) };
      if (!Number.isSafeInteger(data?.challenge_exp)) throw new PorError("POR_INTERNAL", "unexpected challenge from the database");
      return { nonce: fromHex(data.nonce), challengeExp: data.challenge_exp };
    },
    async issue(r: IssueRecord) {
      const { data, error } = await db.rpc("node_attestation_issue", {
        p_user_id: r.userId,
        p_aud: r.aud,
        // PostgREST takes bytea as the \x hex text form.
        p_nonce: `\\x${hex(r.nonce)}`,
        p_challenge_exp: r.challengeExp,
        p_peer_id: r.peerId,
        p_sub: r.sub,
        p_iat: r.iat,
        p_exp: r.exp,
        p_kid: r.kid,
      });
      if (error) throw new Error(`node_attestation_issue: ${error.message}`);
      if (data?.error !== undefined) return { error: storeCode(data.error) };
      if (data?.ok !== true) throw new PorError("POR_INTERNAL", "unexpected issue result from the database");
      return { ok: true };
    },
  };
}
