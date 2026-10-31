/**
 * agent-memory edge function (v0.9.4). See handler.ts for the API and
 * migration 20261030220000 for the table, quota and RLS it runs against.
 *
 * Only signed-in accounts: the gateway verifies the JWT (verify_jwt = true in
 * config.toml), and a token whose role is not "authenticated" — the bare anon
 * key — is turned away here with a clear error before any query. The
 * database checks again: anon has no privilege on the memory tables.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { errorResponse, handle, jwtRole } from "./handler.ts";
import { supabaseStore } from "./store.ts";
import { MemoryError } from "./wire.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve((request) => {
  const authorization = request.headers.get("Authorization");
  if (jwtRole(authorization) !== "authenticated") {
    return errorResponse(new MemoryError("MEMORY_ACCESS_DENIED", "sign in (rotifer login) to use Cloud memory"));
  }
  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization! } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handle(request, supabaseStore(db));
});
