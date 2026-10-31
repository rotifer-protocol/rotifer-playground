-- ============================================================
-- Agent Memory in the Cloud binding (v0.9.4; spec §38.1–38.4)
-- ============================================================
--
-- An agent keeps memory that outlives any one gene (§38.1). The CLI keeps it
-- in SQLite; this is the Cloud copy, so the same agent can keep it across
-- machines and bindings (§38.4).
--
-- What this adds (additive per ADR-295; nothing existing is altered, and the
-- rotifer.ai `agent_memory` table from its own 013 schema is not touched):
--
--   memory_category / memory_access_scope / memory_share_policy
--     Postgres enums with the spec's UPPERCASE values, so a lowercased value
--     is a type error, not a silent mismatch (identifier-boundary rule).
--
--   agent_memory_containers (owner_id, agent_id)
--     The §38.1 AgentMemory container: who owns the agent's memory and its
--     MemoryQuota. The Cloud has no agents table — the CLI makes an agent id
--     with randomUUID() on the user's machine — so an agent id alone proves
--     nothing about who it belongs to. The key is the pair: the same agent id
--     registered by two accounts is two unrelated memories, and nobody can
--     claim someone else's agent id to lock them out of it.
--     quota_bytes counts the UTF-8 bytes of key + value,
--     default 10 MB. The upper bound, 100 MiB per agent, is this
--     deployment's operator limit on shared database storage; a larger CLI
--     quota is refused here with a clear error instead of filling the
--     database. The quotas of all of one account's agents add up to at most
--     200 MiB, checked under a per-account
--     advisory lock by agent_memory_containers_before_write.
--
--   agent_memory_entries
--     §38.1 MemoryEntry, one row per (owner, agent, key); primary key
--     (owner_id, entry_id), because entry_id is derived from agentId and key
--     alone and so collides across accounts that use the same agent id.
--     Columns are the wire names in snake_case; the edge function agent-memory is the
--     single camelCase mapping layer. Two columns are not on the wire:
--     created_by_domain (the creator gene's domain, which SAME_DOMAIN
--     compares, stored internally) and size_bytes
--     (generated: key + value bytes, the quota's unit). retentionPolicy is
--     null or exactly the spec §30.2 RetentionPolicy — maxRetentionDays
--     (positive integer up to 2147483647, or null), autoDeleteOnTermination
--     and anonymizationSupported (booleans) — checked by
--     agent_memory_retention_policy_valid; its
--     schema bounds its size, so it is not counted.
--
--   agent_memory_entries_before_write  BEFORE INSERT OR UPDATE
--     - entry_id is computed here, never taken from the client:
--       lowercase hex SHA-256 of agentId || 0x00 || key, the
--       same function as rotifer-core memory::entry_id.
--     - owner, agent, key, entry id, creator, creator domain and creation time
--       cannot change after insert (an update keeps the entry's identity and
--       provenance — §38.4 keeps createdBy across migration).
--     - quota (§38.1 MUST): with the agent's container row locked, so
--       two writes to one agent cannot both pass, a write that would put the
--       agent over quota evicts, in order, CACHE entries oldest first, then
--       the oldest PATTERN, then the oldest CONTEXT ("oldest" = updated_at
--       ascending, ties by entry_id: an entry rewritten
--       recently counts as fresh); PREFERENCE is never evicted. If even evicting
--       every non-PREFERENCE entry would not make room, the write is refused
--       with MEMORY_QUOTA_EXCEEDED (SQLSTATE 53400) before anything is
--       evicted, and nothing is written. The entry being overwritten is never
--       its own eviction candidate. Evicted entries are reported back in the
--       transaction-local setting rotifer.memory_evicted so the caller can
--       write its audit line.
--     - a retentionPolicy that is not null or exactly §30.2 RetentionPolicy is
--       refused with MEMORY_INVALID_INPUT; a CHECK holds it too.
--     - a value over 1 MiB (1048576 bytes) is refused with
--       MEMORY_INVALID_INPUT (22023), never truncated; a CHECK on the column holds the same limit for any writer.
--     - sharePolicy other than PRIVATE is refused with MEMORY_ACCESS_DENIED
--       (42501): the default DataPolicy has no anonymization support and this
--       version has no field to change it (§38.3 MUST).
--     Because it is a trigger, the rules hold for every writer: the RPC
--     below, a direct PostgREST insert, or a future server job.
--
--   agent_memory_write(...)  SECURITY INVOKER RPC
--     One atomic write: registers the container with the default quota if
--     it is new, upserts the entry, returns the row and what was evicted.
--     An update keeps the entry's access policy unless the caller sends a
--     new one, and keeps its retention policy unless p_set_retention
--     (p_retention_policy NULL then means "reset to inherit the agent's
--     DataPolicy"). Only the creator gene may change an
--     existing entry's accessPolicy or retentionPolicy, including that reset;
--     another gene sending a different
--     policy is refused with MEMORY_ACCESS_DENIED. Overwriting an existing
--     entry is checked against its writeScope here, under the same row lock
--     as the write and a per-key advisory lock (so a key's first write cannot
--     race another), making check and write atomic. Within one
--     agent a gene can still take a key first — a known limitation.
--     (A direct table update by the owner is not gene-checked; see R3.)
--
--   Every RPC that takes a calling gene (agent_memory_write, _delete, _query, _read)
--   first requires its id to be a v2 gene id, v2:<64 lowercase hex>
--   (agent_memory_valid_gene_id); otherwise MEMORY_ACCESS_DENIED and nothing
--   is recorded. agent_memory_write also refuses to set
--   readScope or writeScope DEPLOYER_CONFIGURED.
--
--   agent_memory_delete(...)  SECURITY INVOKER RPC: deleteMemory. Takes the
--     same per-key advisory lock and row lock as agent_memory_write, checks
--     the entry's writeScope (§38.2: deleting needs write permission) and
--     deletes in the same transaction. A
--     missing key is MEMORY_NOT_FOUND.
--
--   agent_memory_query(...)  SECURITY INVOKER: queryMemory.
--     Filters by category, exact key prefix (compared with left(), so '%',
--     '_' and '*' are plain characters), since/until on updated_at AND by
--     the caller gene's readScope, all before LIMIT — so a limit counts only
--     entries the caller may read and nothing readable is skipped. Newest
--     first, ties by entry_id; limit 100 by default, 1000 at most.
--
--   agent_memory_read(agent_id, key, category, caller)  SECURITY INVOKER:
--     readMemory in one transaction — purge, readScope check, lastAccessedBy.
--   agent_memory_purge_expired(agent_id)  SECURITY INVOKER: the purge itself;
--     returns the purged entry ids (no keys). agent_memory_write, _delete,
--     _query and _read each pass them back as "expired" ([] when none) for
--     the caller's audit lines.
--
--   agent_memory_container(agent_id)  SECURITY INVOKER: quota, totalSize
--     (expired entries excluded).
--
--   trg_00_closed_account_write on both tables (20261022110000's guard): a
--     closed account's leftover token cannot write memory.
--
--   agent_memory_forget_closed_account  AFTER UPDATE OF closed_at ON profiles
--     When an account is closed (close_account(), service_role only), its
--     agents' memory is deleted. PREFERENCE and PATTERN are typically the
--     user's data (§38.2, §30); closure removes what identifies the person,
--     and close_account() predates this table.
--
-- ── Rights boundary ─────────────────
--   R1 Who can read an entry: only the account that owns the container
--      (RLS owner_id = auth.uid() on SELECT). anon has no privilege at all.
--      Other accounts, including ones holding the same agent id, see zero
--      rows. service_role bypasses RLS as everywhere in this project.
--   R2 Who can write/delete: the same owner only (INSERT/UPDATE WITH CHECK,
--      DELETE USING). A closed account cannot write at all.
--   R3 Gene-level scopes (§38.2 readScope/writeScope: CREATOR_GENE_ONLY,
--      SAME_DOMAIN, ALL_GENES, DEPLOYER_CONFIGURED) are checked by
--      agent_memory_write / agent_memory_query (agent_memory_scope_allows)
--      and again by the agent-memory edge function, not by RLS. The calling gene runs on the
--      user's machine and its id is declared by the user's own client, so
--      the Cloud cannot verify which gene is calling; the account is the
--      boundary the database can enforce. An owner writing the table
--      directly can bypass gene scopes on their own memory — that is no
--      wider than what they can already do to their local SQLite copy.
--      DEPLOYER_CONFIGURED is always denied in this version (§30.2
--      has no memory-scope field).
--   R4 sharePolicy (§38.1): PRIVATE is the default and the only value
--      accepted; ANONYMIZED_SHARE and KNOWLEDGE_GENE writes are refused.
--      No policy, function or query reads share_policy to
--      widen access; sharing (§38.3) is not in v0.9.4.
--   R7 retentionPolicy is enforced lazily: an entry expires
--      when now >= updated_at + maxRetentionDays days. Every RPC that reads
--      or writes an agent's memory (write, delete, query, get) first deletes
--      that agent's expired entries in the same transaction, and the write
--      trigger does the same before counting quota, so an expired entry is
--      never returned and never counted. An entry with retentionPolicy null
--      inherits the agent's DataPolicy; the Cloud stores no DataPolicy, so
--      such an entry never expires. maxRetentionDays null means unlimited.
--      A direct table SELECT can still see an expired row until the next
--      call purges it. autoDeleteOnTermination is stored, not acted on: there
--      is no agent termination yet.
--   R5 Deletion: the owner deletes entries or the whole container (entries
--      cascade). Account closure deletes the account's memory. Deleting a
--      profile cascades. Nothing else deletes memory — in particular no
--      change to genes does: entries keep the creator gene's id as text
--      with no foreign key to genes.
--   R6 Eviction deletes only the writing agent's own non-PREFERENCE entries,
--      only as far as needed, inside the same transaction as the write.
--
-- Not deployed until the rate limit (see the agent-memory README) is in place.
-- ============================================================

-- ── Enums ─────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_category') THEN
    CREATE TYPE memory_category AS ENUM ('PREFERENCE', 'PATTERN', 'CONTEXT', 'CACHE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_access_scope') THEN
    CREATE TYPE memory_access_scope AS ENUM ('CREATOR_GENE_ONLY', 'SAME_DOMAIN', 'ALL_GENES', 'DEPLOYER_CONFIGURED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_share_policy') THEN
    CREATE TYPE memory_share_policy AS ENUM ('PRIVATE', 'ANONYMIZED_SHARE', 'KNOWLEDGE_GENE');
  END IF;
END;
$$;

-- ── retentionPolicy shape (spec §30.2) ─────────

CREATE OR REPLACE FUNCTION agent_memory_retention_policy_valid(j JSONB)
RETURNS BOOLEAN AS $$
  SELECT CASE
    WHEN j IS NULL THEN true
    WHEN jsonb_typeof(j) <> 'object' THEN false
    ELSE (SELECT count(*) FROM jsonb_object_keys(j)) = 3
         AND j ? 'maxRetentionDays' AND j ? 'autoDeleteOnTermination' AND j ? 'anonymizationSupported'
         AND jsonb_typeof(j -> 'autoDeleteOnTermination') = 'boolean'
         AND jsonb_typeof(j -> 'anonymizationSupported') = 'boolean'
         AND CASE jsonb_typeof(j -> 'maxRetentionDays')
               WHEN 'null' THEN true
               WHEN 'number' THEN CASE WHEN (j ->> 'maxRetentionDays') ~ '^[1-9][0-9]{0,9}$'
                                       THEN (j ->> 'maxRetentionDays')::bigint <= 2147483647
                                       ELSE false END
               ELSE false
             END
  END;
$$ LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_retention_policy_valid(JSONB) IS
  'Null, or exactly spec §30.2 RetentionPolicy {maxRetentionDays: positive integer <= 2147483647 or null, autoDeleteOnTermination: boolean, anonymizationSupported: boolean}. Missing, extra or wrong-typed fields are invalid.';

-- ── Retention clock and expiry ──────────────

-- The clock retention is judged by. Tests and server jobs may inject a time
-- with the transaction-local setting rotifer.memory_now, but it is honoured
-- only when the current role is neither authenticated nor anon: a
-- client able to set it could run the clock forward to expire
-- entries early, or back to keep expired ones. PostgREST requests run as
-- authenticated/anon, so for them this is always now().
CREATE OR REPLACE FUNCTION agent_memory_now()
RETURNS TIMESTAMPTZ AS $$
  SELECT CASE
    WHEN current_user IN ('authenticated', 'anon') THEN now()
    ELSE coalesce(nullif(current_setting('rotifer.memory_now', true), '')::timestamptz, now())
  END;
$$ LANGUAGE sql STABLE
SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION agent_memory_expired(p_policy JSONB, p_updated_at TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS BOOLEAN AS $$
  -- Elapsed seconds against days x 86400, as rotifer-core and the SDK count
  -- it. Not updated_at + days * interval '1 day': that overflows the
  -- timestamp range for large maxRetentionDays (up to 2147483647 is valid),
  -- which would make every call on the agent fail, and a
  -- calendar day is 23 or 25 hours across a DST change in a non-UTC session.
  SELECT p_policy IS NOT NULL
     AND jsonb_typeof(p_policy -> 'maxRetentionDays') = 'number'
     AND extract(epoch FROM (p_now - p_updated_at)) >= (p_policy ->> 'maxRetentionDays')::numeric * 86400;
$$ LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_expired(JSONB, TIMESTAMPTZ, TIMESTAMPTZ) IS
  'An entry with maxRetentionDays expires when now - updated_at >= maxRetentionDays x 86400 seconds. A null policy (inherit; the Cloud has no DataPolicy) or a null maxRetentionDays never expires.';

-- ── Container: owner and quota ────────────────────────

CREATE TABLE IF NOT EXISTS agent_memory_containers (
  owner_id    UUID        NOT NULL DEFAULT auth.uid() REFERENCES profiles(id) ON DELETE CASCADE,
  agent_id    TEXT        NOT NULL CHECK (agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  quota_bytes BIGINT      NOT NULL DEFAULT 10485760
                          CHECK (quota_bytes > 0 AND quota_bytes <= 104857600),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, agent_id)
);

COMMENT ON TABLE agent_memory_containers IS
  '§38.1 AgentMemory container (v0.9.4): the account that owns an agent''s memory and its MemoryQuota in bytes of key + value. Keyed on (owner_id, agent_id) because agent ids are minted client-side.';

-- ── Entries ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_memory_entries (
  entry_id          TEXT                NOT NULL CHECK (entry_id ~ '^[0-9a-f]{64}$'),
  owner_id          UUID                NOT NULL DEFAULT auth.uid(),
  agent_id          TEXT                NOT NULL,
  category          memory_category     NOT NULL,
  key               TEXT                NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1024),
  value             BYTEA               NOT NULL CHECK (octet_length(value) <= 1048576),
  created_by        TEXT                NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 256),
  created_by_domain TEXT                CHECK (created_by_domain IS NULL OR char_length(created_by_domain) BETWEEN 1 AND 256),
  last_accessed_by  TEXT                CHECK (last_accessed_by IS NULL OR char_length(last_accessed_by) BETWEEN 1 AND 256),
  created_at        TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ         NOT NULL DEFAULT now(),
  read_scope        memory_access_scope NOT NULL DEFAULT 'SAME_DOMAIN',
  write_scope       memory_access_scope NOT NULL DEFAULT 'SAME_DOMAIN',
  share_policy      memory_share_policy NOT NULL DEFAULT 'PRIVATE',
  retention_policy  JSONB               CHECK (agent_memory_retention_policy_valid(retention_policy)),
  size_bytes        BIGINT              GENERATED ALWAYS AS (octet_length(key) + octet_length(value)) STORED,
  PRIMARY KEY (owner_id, entry_id),
  UNIQUE (owner_id, agent_id, key),
  FOREIGN KEY (owner_id, agent_id)
    REFERENCES agent_memory_containers (owner_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_entries_eviction
  ON agent_memory_entries (owner_id, agent_id, category, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_memory_entries_updated
  ON agent_memory_entries (owner_id, agent_id, updated_at);

COMMENT ON TABLE agent_memory_entries IS
  '§38.1 MemoryEntry (v0.9.4). Wire names are camelCase via the agent-memory edge function. No foreign key to genes: memory belongs to the agent, and genome changes never delete it.';
COMMENT ON COLUMN agent_memory_entries.created_by_domain IS
  'Domain of the creator gene, compared by SAME_DOMAIN. Internal, not a wire field.';

-- ── entry_id ─────────────────────────────────

CREATE OR REPLACE FUNCTION agent_memory_entry_id(p_agent_id TEXT, p_key TEXT)
RETURNS TEXT AS $$
  SELECT encode(
    sha256(convert_to(p_agent_id, 'UTF8') || '\x00'::bytea || convert_to(p_key, 'UTF8')),
    'hex');
$$ LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_entry_id(TEXT, TEXT) IS
  'Lowercase hex SHA-256 of agentId || 0x00 || key. Matches rotifer-core memory::entry_id.';

-- ── §38.2 scope rule (used by agent_memory_write and agent_memory_query) ──

CREATE OR REPLACE FUNCTION agent_memory_scope_allows(
  p_scope             memory_access_scope,
  p_created_by        TEXT,
  p_created_by_domain TEXT,
  p_caller_gene_id    TEXT,
  p_caller_domain     TEXT
)
RETURNS BOOLEAN AS $$
  SELECT coalesce(CASE p_scope
    WHEN 'ALL_GENES'         THEN true
    WHEN 'CREATOR_GENE_ONLY' THEN p_created_by = p_caller_gene_id
    -- An entry with no recorded domain falls back to its creator only.
    WHEN 'SAME_DOMAIN'       THEN CASE WHEN p_created_by_domain IS NULL
                                       THEN p_created_by = p_caller_gene_id
                                       ELSE p_created_by_domain = p_caller_domain END
    ELSE false  -- DEPLOYER_CONFIGURED: no DataPolicy field in this version
  END, false);
$$ LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_scope_allows(memory_access_scope, TEXT, TEXT, TEXT, TEXT) IS
  'v0.9.4 §38.2: whether a gene (id, domain) passes an entry''s read or write scope. Same rules as the edge function''s access.ts.';

CREATE OR REPLACE FUNCTION agent_memory_valid_gene_id(p_gene_id TEXT)
RETURNS BOOLEAN AS $$
  SELECT coalesce(p_gene_id ~ '^v2:[0-9a-f]{64}$', false);
$$ LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_valid_gene_id(TEXT) IS
  'A calling gene is named by its v2 content-addressed id, v2:<64 lowercase hex>.';

-- ── Identity, provenance and quota ────────────────────

CREATE OR REPLACE FUNCTION agent_memory_entries_before_write()
RETURNS TRIGGER AS $$
DECLARE
  v_new_size  BIGINT := octet_length(NEW.key) + octet_length(NEW.value);
  v_quota     BIGINT;
  v_used      BIGINT;
  v_evictable BIGINT;
  v_need      BIGINT;
  v_freed     BIGINT := 0;
  v_evicted   JSONB;
  r           RECORD;
BEGIN
  IF octet_length(NEW.value) > 1048576 THEN
    RAISE EXCEPTION 'MEMORY_INVALID_INPUT: value is % bytes; the limit is 1048576 (1 MiB)', octet_length(NEW.value)
      USING ERRCODE = '22023';
  END IF;

  IF NOT agent_memory_retention_policy_valid(NEW.retention_policy) THEN
    RAISE EXCEPTION 'MEMORY_INVALID_INPUT: retentionPolicy must be null or exactly {maxRetentionDays: positive integer or null, autoDeleteOnTermination: boolean, anonymizationSupported: boolean}'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.share_policy <> 'PRIVATE' THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: sharePolicy % needs a DataPolicy with anonymization support, which this version does not have; use PRIVATE', NEW.share_policy
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.entry_id   := agent_memory_entry_id(NEW.agent_id, NEW.key);
    -- A migrated entry (§38.4) may carry its original times; none may be in
    -- the future, and an entry cannot be updated before it was created.
    NEW.created_at := least(coalesce(NEW.created_at, now()), now());
    NEW.updated_at := greatest(least(coalesce(NEW.updated_at, now()), now()), NEW.created_at);
  ELSE
    IF NEW.owner_id          IS DISTINCT FROM OLD.owner_id
       OR NEW.agent_id          IS DISTINCT FROM OLD.agent_id
       OR NEW.key               IS DISTINCT FROM OLD.key
       OR NEW.entry_id          IS DISTINCT FROM OLD.entry_id
       OR NEW.created_by        IS DISTINCT FROM OLD.created_by
       OR NEW.created_by_domain IS DISTINCT FROM OLD.created_by_domain
       OR NEW.created_at        IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'MEMORY_INVALID_INPUT: an entry''s owner, agent, key, id, creator and creation time cannot change'
        USING ERRCODE = '22023';
    END IF;

    -- Recording who read an entry is not an update of the entry.
    IF NEW.value IS DISTINCT FROM OLD.value
       OR NEW.category         IS DISTINCT FROM OLD.category
       OR NEW.read_scope       IS DISTINCT FROM OLD.read_scope
       OR NEW.write_scope      IS DISTINCT FROM OLD.write_scope
       OR NEW.share_policy     IS DISTINCT FROM OLD.share_policy
       OR NEW.retention_policy IS DISTINCT FROM OLD.retention_policy THEN
      NEW.updated_at := now();
    ELSE
      NEW.updated_at := OLD.updated_at;
    END IF;

    IF v_new_size <= OLD.size_bytes THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT c.quota_bytes INTO v_quota
    FROM agent_memory_containers c
   WHERE c.owner_id = NEW.owner_id AND c.agent_id = NEW.agent_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMORY_NOT_FOUND: agent % has no memory registered for this account', NEW.agent_id
      USING ERRCODE = '23503';
  END IF;

  -- Expired entries are not counted: delete them first, so
  -- a direct write is held to the same rule as the RPCs.
  DELETE FROM agent_memory_entries e
   WHERE e.owner_id = NEW.owner_id AND e.agent_id = NEW.agent_id AND e.key <> NEW.key
     AND agent_memory_expired(e.retention_policy, e.updated_at, agent_memory_now());

  -- The entry being written (same key) is replaced, not counted.
  SELECT coalesce(sum(e.size_bytes), 0),
         coalesce(sum(e.size_bytes) FILTER (WHERE e.category <> 'PREFERENCE'), 0)
    INTO v_used, v_evictable
    FROM agent_memory_entries e
   WHERE e.owner_id = NEW.owner_id AND e.agent_id = NEW.agent_id AND e.key <> NEW.key;

  v_need := v_used + v_new_size - v_quota;
  IF v_need <= 0 THEN
    RETURN NEW;
  END IF;

  IF v_evictable < v_need THEN
    RAISE EXCEPTION 'MEMORY_QUOTA_EXCEEDED: writing % bytes would put agent % at % of % bytes even after evicting every CACHE, PATTERN and CONTEXT entry',
      v_new_size, NEW.agent_id, v_used - v_evictable + v_new_size, v_quota
      USING ERRCODE = '53400';
  END IF;

  v_evicted := coalesce(nullif(current_setting('rotifer.memory_evicted', true), ''), '[]')::jsonb;
  FOR r IN
    SELECT e.entry_id, e.key, e.category, e.size_bytes
      FROM agent_memory_entries e
     WHERE e.owner_id = NEW.owner_id AND e.agent_id = NEW.agent_id
       AND e.key <> NEW.key AND e.category <> 'PREFERENCE'
     ORDER BY CASE e.category WHEN 'CACHE' THEN 0 WHEN 'PATTERN' THEN 1 ELSE 2 END,
              e.updated_at, e.entry_id
  LOOP
    DELETE FROM agent_memory_entries e
     WHERE e.owner_id = NEW.owner_id AND e.agent_id = NEW.agent_id AND e.key = r.key;
    v_freed := v_freed + r.size_bytes;
    v_evicted := v_evicted || jsonb_build_array(jsonb_build_object(
      'entryId', r.entry_id, 'key', r.key, 'category', r.category, 'sizeBytes', r.size_bytes));
    EXIT WHEN v_freed >= v_need;
  END LOOP;
  PERFORM set_config('rotifer.memory_evicted', v_evicted::text, true);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_entries_before_write() IS
  'Sets entry_id, keeps identity and provenance fixed, and enforces the agent''s quota by evicting CACHE (oldest first), then oldest PATTERN, then oldest CONTEXT (oldest = updated_at, then entry_id); PREFERENCE never. Accepts only sharePolicy PRIVATE. Refuses with MEMORY_QUOTA_EXCEEDED (53400) when even that cannot make room. Runs as the caller, so it only ever sees and evicts the caller''s own rows.';

DROP TRIGGER IF EXISTS trg_agent_memory_entries_before_write ON agent_memory_entries;
CREATE TRIGGER trg_agent_memory_entries_before_write
  BEFORE INSERT OR UPDATE ON agent_memory_entries
  FOR EACH ROW EXECUTE FUNCTION agent_memory_entries_before_write();

-- ── Per-account quota ceiling ──────────

CREATE OR REPLACE FUNCTION agent_memory_containers_before_write()
RETURNS TRIGGER AS $$
DECLARE
  v_others BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- agent_memory_write registers with ON CONFLICT DO NOTHING on every
    -- write; an existing container is not a new claim on the ceiling.
    IF EXISTS (SELECT 1 FROM agent_memory_containers c
                WHERE c.owner_id = NEW.owner_id AND c.agent_id = NEW.agent_id) THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.quota_bytes <= OLD.quota_bytes THEN
    RETURN NEW;
  END IF;

  -- One account's container writes take turns, so two cannot both fit
  -- under the ceiling at once. Advisory: no table privilege needed.
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_memory_containers:' || NEW.owner_id::text, 0));

  SELECT coalesce(sum(c.quota_bytes), 0) INTO v_others
    FROM agent_memory_containers c
   WHERE c.owner_id = NEW.owner_id AND c.agent_id <> NEW.agent_id;

  IF v_others + NEW.quota_bytes > 209715200 THEN
    RAISE EXCEPTION 'MEMORY_QUOTA_EXCEEDED: this account''s agents would hold % bytes of memory quota; the limit is 209715200 (200 MiB) per account',
      v_others + NEW.quota_bytes
      USING ERRCODE = '53400';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_containers_before_write() IS
  'The quotas of one account''s agents add up to at most 200 MiB; refused with MEMORY_QUOTA_EXCEEDED (53400). Runs as the caller, so it sums only the caller''s own containers.';

DROP TRIGGER IF EXISTS trg_agent_memory_containers_before_write ON agent_memory_containers;
CREATE TRIGGER trg_agent_memory_containers_before_write
  BEFORE INSERT OR UPDATE ON agent_memory_containers
  FOR EACH ROW EXECUTE FUNCTION agent_memory_containers_before_write();

-- ── Closed accounts cannot write (20261022110000) ──────────

DROP TRIGGER IF EXISTS trg_00_closed_account_write ON agent_memory_containers;
CREATE TRIGGER trg_00_closed_account_write
  BEFORE INSERT OR UPDATE OR DELETE ON agent_memory_containers
  FOR EACH ROW EXECUTE FUNCTION guard_closed_account_write();

DROP TRIGGER IF EXISTS trg_00_closed_account_write ON agent_memory_entries;
CREATE TRIGGER trg_00_closed_account_write
  BEFORE INSERT OR UPDATE OR DELETE ON agent_memory_entries
  FOR EACH ROW EXECUTE FUNCTION guard_closed_account_write();

-- ── Closing an account deletes its memory ──────────────────

CREATE OR REPLACE FUNCTION agent_memory_forget_closed_account()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM agent_memory_containers c WHERE c.owner_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION agent_memory_forget_closed_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_agent_memory_forget_closed_account ON profiles;
CREATE TRIGGER trg_agent_memory_forget_closed_account
  AFTER UPDATE OF closed_at ON profiles
  FOR EACH ROW
  WHEN (OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL)
  EXECUTE FUNCTION agent_memory_forget_closed_account();

-- ── RLS: the owning account only ───────────────────

ALTER TABLE agent_memory_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory_entries    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON agent_memory_containers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON agent_memory_entries    FROM PUBLIC, anon, authenticated;

GRANT SELECT, DELETE ON agent_memory_containers TO authenticated;
GRANT INSERT (owner_id, agent_id, quota_bytes) ON agent_memory_containers TO authenticated;
GRANT UPDATE (quota_bytes) ON agent_memory_containers TO authenticated;

GRANT SELECT, DELETE ON agent_memory_entries TO authenticated;
GRANT INSERT (owner_id, agent_id, category, key, value, created_by, created_by_domain,
              last_accessed_by, created_at, updated_at, read_scope, write_scope,
              share_policy, retention_policy)
  ON agent_memory_entries TO authenticated;
GRANT UPDATE (value, category, last_accessed_by, read_scope, write_scope,
              share_policy, retention_policy)
  ON agent_memory_entries TO authenticated;

GRANT ALL ON agent_memory_containers TO service_role;
GRANT ALL ON agent_memory_entries    TO service_role;

DROP POLICY IF EXISTS agent_memory_containers_owner_select ON agent_memory_containers;
CREATE POLICY agent_memory_containers_owner_select ON agent_memory_containers
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS agent_memory_containers_owner_insert ON agent_memory_containers;
CREATE POLICY agent_memory_containers_owner_insert ON agent_memory_containers
  FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS agent_memory_containers_owner_update ON agent_memory_containers;
CREATE POLICY agent_memory_containers_owner_update ON agent_memory_containers
  FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS agent_memory_containers_owner_delete ON agent_memory_containers;
CREATE POLICY agent_memory_containers_owner_delete ON agent_memory_containers
  FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS agent_memory_entries_owner_select ON agent_memory_entries;
CREATE POLICY agent_memory_entries_owner_select ON agent_memory_entries
  FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS agent_memory_entries_owner_insert ON agent_memory_entries;
CREATE POLICY agent_memory_entries_owner_insert ON agent_memory_entries
  FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS agent_memory_entries_owner_update ON agent_memory_entries;
CREATE POLICY agent_memory_entries_owner_update ON agent_memory_entries
  FOR UPDATE TO authenticated
  USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS agent_memory_entries_owner_delete ON agent_memory_entries;
CREATE POLICY agent_memory_entries_owner_delete ON agent_memory_entries
  FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));

-- ── RPCs (called by the agent-memory edge function) ─────

CREATE OR REPLACE FUNCTION agent_memory_purge_expired(p_agent_id TEXT)
RETURNS JSONB AS $$
DECLARE
  v_purged JSONB;
BEGIN
  WITH gone AS (
    DELETE FROM agent_memory_entries e
     WHERE e.owner_id = auth.uid() AND e.agent_id = p_agent_id
       AND agent_memory_expired(e.retention_policy, e.updated_at, agent_memory_now())
    RETURNING e.entry_id)
  SELECT coalesce(jsonb_agg(jsonb_build_object('entryId', g.entry_id) ORDER BY g.entry_id), '[]'::jsonb)
    INTO v_purged FROM gone g;
  RETURN v_purged;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_purge_expired(TEXT) IS
  'Deletes the signed-in account''s expired entries of an agent and returns their entry ids (no keys) for the caller''s audit lines. Called first by every memory RPC.';

REVOKE ALL ON FUNCTION agent_memory_purge_expired(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agent_memory_purge_expired(TEXT) TO authenticated, service_role;

-- ── Expected refusals after the purge ──
-- Expiry purging does not depend on the caller's permissions: even when a
-- call is refused, its purge stands and is reported. So after the purge,
-- each RPC runs its action in a block whose expected refusals (access
-- denied, quota exceeded, invalid input, not found) are caught — that rolls
-- back only to the block's start — and returned as
-- {error: {code, message}, expired}. Anything else (a storage failure) is
-- not caught and rolls back the whole call, purge included.
CREATE OR REPLACE FUNCTION agent_memory_refusal(p_state TEXT, p_message TEXT, p_expired JSONB)
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'error', CASE
      WHEN p_message ~ '^MEMORY_[A-Z_]+: ' THEN jsonb_build_object(
        'code', substring(p_message FROM '^(MEMORY_[A-Z_]+): '),
        'message', substring(p_message FROM '^MEMORY_[A-Z_]+: (.*)$'))
      WHEN p_state = '53400' THEN jsonb_build_object('code', 'MEMORY_QUOTA_EXCEEDED', 'message', 'the agent''s memory quota is full')
      WHEN p_state = '42501' THEN jsonb_build_object('code', 'MEMORY_ACCESS_DENIED', 'message',
        CASE WHEN p_message = 'this account is closed and can no longer write' THEN p_message
             ELSE 'not allowed for this account' END)
      WHEN p_state IN ('23503', 'P0002') THEN jsonb_build_object('code', 'MEMORY_NOT_FOUND', 'message', 'not found')
      ELSE jsonb_build_object('code', 'MEMORY_INVALID_INPUT', 'message', 'a value is out of range or malformed')
    END,
    'expired', coalesce(p_expired, '[]'::jsonb));
$$ LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_refusal(TEXT, TEXT, JSONB) IS
  'An expected refusal after the purge as {error: {code, message}, expired}. Only messages written for clients (MEMORY_* and the closed-account guard''s) pass through; other SQLSTATEs get fixed text, like the edge function''s mapDbError.';

-- readMemory: purge, look up, check readScope, record lastAccessedBy — all in
-- one transaction, so a denial rolls the purge back with it and nothing
-- changed goes unreported. Returns {entry: row or null,
-- expired: [{entryId}]}; a missing key or another category is entry null.
CREATE OR REPLACE FUNCTION agent_memory_read(
  p_agent_id       TEXT,
  p_key            TEXT,
  p_category       memory_category,
  p_caller_gene_id TEXT,
  p_caller_domain  TEXT
)
RETURNS JSONB AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_expired JSONB;
  v_row     agent_memory_entries;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: sign in to use Cloud memory' USING ERRCODE = '42501';
  END IF;
  IF NOT agent_memory_valid_gene_id(p_caller_gene_id) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id (v2:<64 lowercase hex>)' USING ERRCODE = '42501';
  END IF;

  v_expired := agent_memory_purge_expired(p_agent_id);

  BEGIN

  SELECT * INTO v_row FROM agent_memory_entries e
   WHERE e.owner_id = v_uid AND e.agent_id = p_agent_id AND e.key = p_key
     FOR UPDATE;
  IF NOT FOUND OR (p_category IS NOT NULL AND v_row.category <> p_category) THEN
    RETURN jsonb_build_object('entry', NULL, 'expired', v_expired);
  END IF;
  IF NOT agent_memory_scope_allows(v_row.read_scope, v_row.created_by, v_row.created_by_domain,
                                   p_caller_gene_id, p_caller_domain) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: read denied: ''%'' is %', p_key, v_row.read_scope
      USING ERRCODE = '42501';
  END IF;
  -- A successful read records the caller.
  IF v_row.last_accessed_by IS DISTINCT FROM p_caller_gene_id THEN
    UPDATE agent_memory_entries e SET last_accessed_by = p_caller_gene_id
     WHERE e.owner_id = v_uid AND e.entry_id = v_row.entry_id
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('entry', to_jsonb(v_row), 'expired', v_expired);
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '53400' OR SQLSTATE '22023' OR SQLSTATE '23514'
      OR SQLSTATE '22P02' OR SQLSTATE '23503' OR SQLSTATE 'P0002' THEN
      RETURN agent_memory_refusal(SQLSTATE, SQLERRM, v_expired);
  END;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION agent_memory_read(TEXT, TEXT, memory_category, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agent_memory_read(TEXT, TEXT, memory_category, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION agent_memory_write(
  p_agent_id          TEXT,
  p_key               TEXT,
  p_value             BYTEA,
  p_category          memory_category,
  p_caller_gene_id    TEXT,
  p_caller_domain     TEXT DEFAULT NULL,
  p_read_scope        memory_access_scope DEFAULT NULL,
  p_write_scope       memory_access_scope DEFAULT NULL,
  p_share_policy      memory_share_policy DEFAULT NULL,
  p_retention_policy  JSONB DEFAULT NULL,
  p_set_retention     BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_row     agent_memory_entries;
  v_old     agent_memory_entries;
  v_expired JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: sign in to use Cloud memory' USING ERRCODE = '42501';
  END IF;
  IF NOT agent_memory_valid_gene_id(p_caller_gene_id) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id (v2:<64 lowercase hex>)' USING ERRCODE = '42501';
  END IF;
  IF p_read_scope = 'DEPLOYER_CONFIGURED' OR p_write_scope = 'DEPLOYER_CONFIGURED' THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: DEPLOYER_CONFIGURED cannot be set: this version has no DataPolicy field to configure it (§30.2)'
      USING ERRCODE = '42501';
  END IF;

  -- FOR UPDATE below locks an existing entry, but a key nobody has written
  -- yet has no row to lock: two genes writing it first at the same time
  -- would both see "not found", and the second would overwrite the first
  -- through ON CONFLICT DO UPDATE without a writeScope check. One lock per
  -- (account, agent, key) makes writes to a key take turns.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'agent_memory_entry:' || v_uid::text || ':' || p_agent_id || ':' || p_key, 0));

  -- A write to an expired key is a fresh create.
  v_expired := agent_memory_purge_expired(p_agent_id);

  BEGIN

  SELECT * INTO v_old FROM agent_memory_entries e
   WHERE e.owner_id = v_uid AND e.agent_id = p_agent_id AND e.key = p_key
     FOR UPDATE;
  IF FOUND AND NOT agent_memory_scope_allows(v_old.write_scope, v_old.created_by, v_old.created_by_domain,
                                             p_caller_gene_id, p_caller_domain) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: write denied: ''%'' is %', p_key, v_old.write_scope
      USING ERRCODE = '42501';
  END IF;
  IF FOUND AND v_old.created_by IS DISTINCT FROM p_caller_gene_id AND (
       (p_read_scope   IS NOT NULL AND p_read_scope   IS DISTINCT FROM v_old.read_scope)
    OR (p_write_scope  IS NOT NULL AND p_write_scope  IS DISTINCT FROM v_old.write_scope)
    OR (p_share_policy IS NOT NULL AND p_share_policy IS DISTINCT FROM v_old.share_policy)
    OR (p_set_retention AND p_retention_policy IS DISTINCT FROM v_old.retention_policy)) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: only the gene that created ''%'' may change its accessPolicy or retentionPolicy', p_key
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO agent_memory_containers (owner_id, agent_id)
  VALUES (v_uid, p_agent_id)
  ON CONFLICT (owner_id, agent_id) DO NOTHING;

  PERFORM set_config('rotifer.memory_evicted', '[]', true);

  INSERT INTO agent_memory_entries AS e (
    owner_id, agent_id, key, value, category, created_by, created_by_domain,
    last_accessed_by, read_scope, write_scope, share_policy, retention_policy)
  VALUES (
    v_uid, p_agent_id, p_key, p_value, p_category, p_caller_gene_id, p_caller_domain,
    p_caller_gene_id,
    coalesce(p_read_scope, 'SAME_DOMAIN'),
    coalesce(p_write_scope, 'SAME_DOMAIN'),
    coalesce(p_share_policy, 'PRIVATE'),
    p_retention_policy)
  ON CONFLICT (owner_id, agent_id, key) DO UPDATE SET
    value            = EXCLUDED.value,
    category         = EXCLUDED.category,
    last_accessed_by = EXCLUDED.last_accessed_by,
    read_scope       = coalesce(p_read_scope, e.read_scope),
    write_scope      = coalesce(p_write_scope, e.write_scope),
    share_policy     = coalesce(p_share_policy, e.share_policy),
    retention_policy = CASE WHEN p_set_retention THEN p_retention_policy ELSE e.retention_policy END
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'entry', to_jsonb(v_row),
    'evicted', coalesce(nullif(current_setting('rotifer.memory_evicted', true), ''), '[]')::jsonb,
    'expired', v_expired);
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '53400' OR SQLSTATE '22023' OR SQLSTATE '23514'
      OR SQLSTATE '22P02' OR SQLSTATE '23503' OR SQLSTATE 'P0002' THEN
      RETURN agent_memory_refusal(SQLSTATE, SQLERRM, v_expired);
  END;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_write(TEXT, TEXT, BYTEA, memory_category, TEXT, TEXT, memory_access_scope, memory_access_scope, memory_share_policy, JSONB, BOOLEAN) IS
  'Atomic writeMemory for the signed-in account. Registers the agent''s container (default quota) if new, upserts the entry, returns {entry, evicted}. Runs as the caller under RLS. Gene-scope checks are the edge function''s job (see migration header R3).';

REVOKE ALL ON FUNCTION agent_memory_write(TEXT, TEXT, BYTEA, memory_category, TEXT, TEXT, memory_access_scope, memory_access_scope, memory_share_policy, JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agent_memory_write(TEXT, TEXT, BYTEA, memory_category, TEXT, TEXT, memory_access_scope, memory_access_scope, memory_share_policy, JSONB, BOOLEAN) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION agent_memory_delete(
  p_agent_id       TEXT,
  p_key            TEXT,
  p_caller_gene_id TEXT,
  p_caller_domain  TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_old     agent_memory_entries;
  v_expired JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: sign in to use Cloud memory' USING ERRCODE = '42501';
  END IF;
  IF NOT agent_memory_valid_gene_id(p_caller_gene_id) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id (v2:<64 lowercase hex>)' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'agent_memory_entry:' || v_uid::text || ':' || p_agent_id || ':' || p_key, 0));

  v_expired := agent_memory_purge_expired(p_agent_id);

  BEGIN

  SELECT * INTO v_old FROM agent_memory_entries e
   WHERE e.owner_id = v_uid AND e.agent_id = p_agent_id AND e.key = p_key
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMORY_NOT_FOUND: no entry ''%'' for agent %', p_key, p_agent_id
      USING ERRCODE = 'P0002';
  END IF;
  IF NOT agent_memory_scope_allows(v_old.write_scope, v_old.created_by, v_old.created_by_domain,
                                   p_caller_gene_id, p_caller_domain) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: delete denied: ''%'' is %', p_key, v_old.write_scope
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM agent_memory_entries e
   WHERE e.owner_id = v_uid AND e.entry_id = v_old.entry_id;

  RETURN jsonb_build_object('entryId', v_old.entry_id, 'key', v_old.key, 'expired', v_expired);
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '53400' OR SQLSTATE '22023' OR SQLSTATE '23514'
      OR SQLSTATE '22P02' OR SQLSTATE '23503' OR SQLSTATE 'P0002' THEN
      RETURN agent_memory_refusal(SQLSTATE, SQLERRM, v_expired);
  END;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_delete(TEXT, TEXT, TEXT, TEXT) IS
  'v0.9.4 deleteMemory: checks the entry''s writeScope and deletes it in one transaction under the same locks as agent_memory_write. Runs as the caller under RLS.';

REVOKE ALL ON FUNCTION agent_memory_delete(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agent_memory_delete(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION agent_memory_query(
  p_agent_id       TEXT,
  p_caller_gene_id TEXT,
  p_caller_domain  TEXT,
  p_category       memory_category DEFAULT NULL,
  p_key_prefix     TEXT DEFAULT NULL,
  p_since          TIMESTAMPTZ DEFAULT NULL,
  p_until          TIMESTAMPTZ DEFAULT NULL,
  p_limit          INT DEFAULT 100
)
RETURNS JSONB AS $$
DECLARE
  v_expired JSONB;
  v_entries JSONB;
BEGIN
  IF NOT agent_memory_valid_gene_id(p_caller_gene_id) THEN
    RAISE EXCEPTION 'MEMORY_ACCESS_DENIED: the caller is not a v2 gene id (v2:<64 lowercase hex>)' USING ERRCODE = '42501';
  END IF;

  v_expired := agent_memory_purge_expired(p_agent_id);

  -- A query is a scan and records no lastAccessedBy.
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.updated_at DESC, q.entry_id), '[]'::jsonb)
    INTO v_entries
    FROM (
  SELECT e.*
    FROM agent_memory_entries e
   WHERE e.owner_id = auth.uid()
     AND e.agent_id = p_agent_id
     AND (p_category   IS NULL OR e.category = p_category)
     AND (p_key_prefix IS NULL OR left(e.key, char_length(p_key_prefix)) = p_key_prefix)
     AND (p_since      IS NULL OR e.updated_at >= p_since)
     AND (p_until      IS NULL OR e.updated_at <  p_until)
     AND agent_memory_scope_allows(e.read_scope, e.created_by, e.created_by_domain,
                                   p_caller_gene_id, p_caller_domain)
   ORDER BY e.updated_at DESC, e.entry_id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)) q;

  RETURN jsonb_build_object('entries', v_entries, 'expired', v_expired);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_query(TEXT, TEXT, TEXT, memory_category, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) IS
  'v0.9.4 queryMemory: {entries, expired} — the signed-in account''s entries for an agent that the calling gene may read, filtered and scope-checked before LIMIT, newest first, after purging expired ones. Runs as the caller under RLS.';

REVOKE ALL ON FUNCTION agent_memory_query(TEXT, TEXT, TEXT, memory_category, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agent_memory_query(TEXT, TEXT, TEXT, memory_category, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION agent_memory_container(p_agent_id TEXT)
RETURNS TABLE (agent_id TEXT, quota_bytes BIGINT, total_size BIGINT, created_at TIMESTAMPTZ) AS $$
  SELECT c.agent_id, c.quota_bytes,
         coalesce((SELECT sum(e.size_bytes) FROM agent_memory_entries e
                    WHERE e.owner_id = c.owner_id AND e.agent_id = c.agent_id
                      AND NOT agent_memory_expired(e.retention_policy, e.updated_at, agent_memory_now())), 0)::bigint,
         c.created_at
    FROM agent_memory_containers c
   WHERE c.owner_id = auth.uid() AND c.agent_id = p_agent_id;
$$ LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION agent_memory_container(TEXT) IS
  'v0.9.4: the signed-in account''s container for an agent — quota and totalSize (bytes of key + value). Empty when the account has not registered that agent.';

REVOKE ALL ON FUNCTION agent_memory_container(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agent_memory_container(TEXT) TO authenticated, service_role;
