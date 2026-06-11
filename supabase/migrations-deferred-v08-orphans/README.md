# Deferred Migrations — v0.8.x Schema-Migrations Orphans (CLOSED)

**Status**: ✅ **CLOSED** — Sprint C completed 2026-05-18; this directory is preserved for historical reference only
**Original deferral date**: 2026-05-18 (S2 strategy in v0.9 F2 push prep)
**Sprint C closure date**: 2026-05-18
**Decision authority**: Founder
**Audit reference**: meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)

**Sprint C resolution summary**:

| File | Final disposition |
|---|---|
| `20260101000000_enable_pg_cron.sql` | ✅ Phase 1: moved to `../migrations/`; bookkeeping row INSERTed in production schema_migrations |
| `20260331145900_drop_search_genes_pre_audit_fixes.sql` | ✅ Phase 1: same as above |
| `20260331100000_quality_observatory_tables.sql` | ✅ Phase 2: bookkeeping row INSERTed in **rotifer-quality** schema_migrations; file moved to `../migrations-applied-rotifer-quality/` |
| `20260331150000_audit_fixes.sql` | ✅ Phase 3: archived as superseded (Fix 2 absorbed into v0.9 search_genes; Fix 1 merged into Phase 4 rewrite); moved to `../migrations-archived-superseded/` |
| `20260331140000_content_hash_server_validation.sql` | ✅ Phase 4: superseded by `20260518173445_content_hash_validation_with_mismatch_check.sql` (combines #6 design + audit_fixes Fix 1); old file moved to `../migrations-archived-superseded/` |
| `20260331120000_protocol_consistency_checks.sql` | ✅ Phase 5: 3 of 4 sections superseded by current state; only §1 mcp→arena trigger + §4c chk_arena_domain_format extracted to `20260518173918_protocol_consistency_v09_baseline.sql`; old file moved to `../migrations-archived-superseded/` |
| `20260331130000_rls_tightening_v081.sql` | ✅ Phase 6: split — downloads portion superseded by `20260518174553_lock_downloads_direct_insert.sql`; arena_entries portion deferred to v0.9.x patch in `../migrations-deferred-v09x-arena-rls/` (requires arena INSERT RPC-ization first) |

After Sprint C this directory contains only this README — all 7 files have been moved to their appropriate destinations.

---

## Context

During the 2026-05-18 v0.9 F2 push prep audit, an MCP query against the
production `supabase_migrations.schema_migrations` table revealed that
**12 local migration files have no corresponding entry in the
production migration history table**, despite their SQL effects being
**hypothesized** to already be present in the production schema.

**A 2026-05-18 follow-up MCP verification of each migration's schema
effects against `rotifer-cloud` (production) showed that the original
hypothesis was largely WRONG** — most files were in fact NOT applied to
production. See "MCP-verified status" table below.

---

## CC1 conservative-apply outcome (2026-05-18)

After per-file MCP verification, the founder chose strategy **CC1**:
**only mark as `applied` the migrations whose schema effects are
verifiably complete in production**. Files for which production schema
disagrees with the local file are kept in this deferred directory until
a future dedicated sprint resolves them.

### MCP-verified status table

| File | Verified status | Action taken | Now lives in |
|---|---|---|---|
| `20260330130000_p1_security_hardening.sql` | ✅ Complete (functions, constraints, triggers all present) | `repair --status applied` | `../migrations/` |
| `20260330140000_content_hash_enforcement.sql` | ✅ Complete (functions + trigger present) | `repair --status applied` | `../migrations/` |
| `20260331160000_deduplicate_unique_constraint.sql` | ✅ DROP-only operation, idempotent | `repair --status applied` | `../migrations/` |
| `20260331100000_quality_observatory_tables.sql` | ❌ **NOT in rotifer-cloud** (tables only exist in `rotifer-quality` project) | DEFER | this directory |
| `20260331120000_protocol_consistency_checks.sql` | ❌ **NOT applied** (`update_arena_total_calls` / `enforce_version_chain_name` functions absent) | DEFER | this directory |
| `20260331130000_rls_tightening_v081.sql` | ❌ **NOT applied** (`downloads` table still has old "Authenticated users can log downloads" policy) | DEFER | this directory |
| `20260331140000_content_hash_server_validation.sql` | ❌ **NOT applied** (`validate_content_hash_on_publish` function absent) | DEFER | this directory |
| `20260331150000_audit_fixes.sql` | ⚠️ **Inconsistent** (production `search_genes` is a NEWER version with `total_count` field; this migration's effects superseded by later work) | DEFER | this directory |

### Class O2 — Local dev-only baseline fixes (2 files, still deferred)

These exist solely to make `supabase reset` succeed in local development.
Production never needed them.

| File | Why dev-only |
|---|---|
| `20260101000000_enable_pg_cron.sql` | Production `pg_cron` was enabled via Dashboard Extensions panel; this file is local-only to make `supabase reset` work in fresh local replays |
| `20260331145900_drop_search_genes_pre_audit_fixes.sql` | Local-only DROP to enable `supabase reset` cleanly through `audit_fixes` (production was incremental, never needed this DROP) |

These should be marked `--status reverted` (not `applied`) when the
future cleanup sprint runs. They are kept here for now because the
broader v0.8 orphan cleanup is deferred as a single coherent unit.

---

## Why these 5 + 2 = 7 files remain deferred

The original README hypothesis was that all v0.8 orphan files were
already applied to production but missing from `schema_migrations`.
The CC1 verification proved this hypothesis WRONG for at least 5 of
the 8 Class-O1 files. Each of these has a different reason for not
being trivially repairable:

- **#3 quality_observatory_tables** — Schema lives in a different
  Supabase project (`rotifer-quality`), not `rotifer-cloud`. Marking
  it `applied` to `rotifer-cloud` would create a false history entry.

- **#4 protocol_consistency_checks** — SQL effects are genuinely
  absent from production. Pushing it now would create new triggers
  on the `genes` and `arena_entries` tables that may conflict with
  v0.9 logic. Needs careful diff against current production state.

- **#5 rls_tightening_v081** — Production downloads/arena_entries
  RLS is still the OLD permissive policy. Pushing this migration now
  would tighten the policy without coordinated client-side migration
  to use `track_download()` instead of direct INSERT. Could break
  existing CLI/SDK clients.

- **#6 content_hash_server_validation** — Function and CHECK
  constraint absent. Pushing now would add a CHECK constraint that
  requires `content_hash IS NOT NULL` on every published gene; if
  any historical published row lacks `content_hash` the constraint
  validation will fail.

- **#7 audit_fixes** — Production `search_genes` is a NEWER version
  (with `total_count` field, written for v0.9 stage-2 pagination).
  Pushing the v0.8 version would REGRESS the function. Needs to be
  rewritten as a forward-compat patch rather than a re-issue of the
  v0.8 version.

The proper resolution path for each is non-trivial and warrants a
dedicated sprint with cross-team review.

---

## Future cleanup sprint checklist (not yet authorized)

```bash
cd rotifer-playground

# Step 1: For #4 / #5 / #6, diff each migration's intended schema
# against current production state. Adapt the migration to be
# additive-safe given v0.9 baseline. Push each one separately with
# careful review.

# Step 2: For #3 quality_observatory_tables, decide: should the tables
# also exist in rotifer-cloud, or should this migration be retired
# entirely? (rotifer-quality already has the tables, so cross-project
# duplication may not be desired.)

# Step 3: For #7 audit_fixes, rewrite as a forward-compat patch that
# preserves the v0.9 search_genes signature (with total_count) while
# adding any missing audit-fix improvements.

# Step 4: For 2 Class-O2 dev-only files, decide:
#   Option A: repair --status reverted (account-clean, file moves back to migrations/)
#   Option B: keep in deferred (account-implicit, file stays here)
mv supabase/migrations-deferred-v08-orphans/20260101000000_enable_pg_cron.sql \
   supabase/migrations-deferred-v08-orphans/20260331145900_drop_search_genes_pre_audit_fixes.sql \
   supabase/migrations/
supabase migration repair --status reverted 20260101000000 20260331145900 --linked
```

---

## Local dev environment effect

`supabase reset` (local) does NOT replay these files. This means local
dev environment will lack:

- `quality_observatory_tables` (release_test_reports etc.) — but those
  belong to `rotifer-quality` anyway, not `rotifer-cloud`
- `protocol_consistency_checks` triggers
- `rls_tightening_v081` policies — local will have the older
  permissive RLS, which may mask production behavior
- `content_hash_server_validation` trigger
- `audit_fixes` search_genes refinements (production has newer v0.9
  version anyway)
- pg_cron extension (local only — production has it via Dashboard)

**Trade-off**: Local-prod parity broken on these 7 dimensions. If
local dev needs any of these features, restore the relevant file
temporarily, then move it back to this deferred directory after
testing.

---

**Last updated**: 2026-05-18 CC1 conservative apply by AI co-pilot,
founder authorization. Reflects post-MCP-verification reality.
