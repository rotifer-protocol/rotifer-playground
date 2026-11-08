/**
 * node-attestation edge function (v0.9.5 A1, Cloud side). Not deployed: see
 * README.md "Before deploying". API and order of checks: handler.ts.
 *
 * Environment (secrets live only in the deployment environment, never in a
 * repository; ADR-300 locked contract v2 "claims"):
 *   SUPABASE_URL, SUPABASE_ANON_KEY       identify the caller (auth.getUser)
 *   POR_DB_URL                            Postgres connection logged in as
 *                                         por_issuer (store.ts); that role can
 *                                         execute the two issuing database
 *                                         functions and nothing else; no
 *                                         broader key is read.
 *   POR_SIGNING_KEY                       private OKP / Ed25519 JWK with kid; its
 *                                         public half must already be in the JWKS
 *   POR_PSEUDONYM_KEY                     K_pseudo, base64url, >= 32 bytes; a
 *                                         different key from the signing key
 *   NODE_ATTESTATION_AUD                  this function's own address, exactly
 *                                         as nodes sign it into the challenge
 *
 * A missing or malformed variable answers every request with
 * POR_NOT_CONFIGURED (503) and logs which one; it never falls back.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.7";
import { type Deps, errorResponse, handle, PorError } from "./handler.ts";
import { fromB64url, importPseudonymKey, importSigningJwk, parseSigningKey } from "./por.ts";
import { issuerUser, postgresStore } from "./store.ts";

function required(name: string): string {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") throw new Error(`${name} is not set`);
  return v;
}

async function configure(): Promise<Deps> {
  const url = required("SUPABASE_URL");
  const anonKey = required("SUPABASE_ANON_KEY");
  const dbUrl = required("POR_DB_URL");
  issuerUser(dbUrl);
  const aud = required("NODE_ATTESTATION_AUD");
  const signer = await importSigningJwk(parseSigningKey(required("POR_SIGNING_KEY")));
  const rawPseudo = fromB64url(required("POR_PSEUDONYM_KEY"));
  if (rawPseudo === null) throw new Error("POR_PSEUDONYM_KEY is not base64url");
  const pseudonymKey = await importPseudonymKey(rawPseudo);

  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const auth = createClient(url, anonKey, options);
  // One connection per instance is enough: each request is two short
  // statements. prepare: false keeps it usable through the transaction-mode
  // pooler; the database functions take only transaction-scoped locks.
  const sql = postgres(dbUrl, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 10 });
  return {
    async authenticate(authorization) {
      const jwt = authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!jwt) return null;
      const { data, error } = await auth.auth.getUser(jwt);
      return error || !data.user ? null : data.user.id;
    },
    store: postgresStore((text, params) => sql.unsafe(text, params as never[])),
    signer,
    pseudonymKey,
    aud,
    nowSeconds: () => Math.floor(Date.now() / 1000),
  };
}

const ready = configure().catch((e: Error) => {
  console.error(`node-attestation: not configured: ${e.message}`);
  return null;
});

Deno.serve(async (request) => {
  const deps = await ready;
  if (deps === null) return errorResponse(new PorError("POR_NOT_CONFIGURED"));
  return handle(request, deps);
});
