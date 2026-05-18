# Deferred Migrations — v0.8.x Schema-Migrations Orphans

**Status**: ⏸️ DEFERRED (do NOT move back without explicit founder authorization)
**Decision date**: 2026-05-18 (S2 strategy in v0.9 F2 push prep)
**Decision authority**: Founder
**Audit reference**: meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)

---

## Context

During the 2026-05-18 v0.9 F2 push prep audit, an MCP query against the
production `supabase_migrations.schema_migrations` table revealed that
**10 local migration files have no corresponding entry in the
production migration history table**, despite their SQL effects being
(almost certainly) already present in the production schema.

**Note**: An initial pass mistakenly included `20260328200000_get_gene_detail_rpc.sql`
and `20260328210000_gene_detail_rpc_v2.sql` here because the
`list_migrations` MCP tool truncated its output at 30 rows and skipped
those two timestamps. A direct `SELECT version FROM supabase_migrations.schema_migrations`
revealed those two ARE in production. They were moved back to
`../migrations/` before this README was finalized.

**Hypothesis**: These 12 SQLs were applied to production via Supabase
Dashboard SQL Editor or direct psql during v0.8.0 / v0.8.1 sprints,
bypassing the `supabase db push` CLI path. The production schema reflects
these changes (e.g., `quality_observatory_tables` are queryable in
production), but `schema_migrations` was never updated.

**Why deferred**: The founder chose strategy S2 — "minimal action, do
not block v0.9" — over strategy S1 — "thorough cleanup with per-file MCP
verification". These 12 files are isolated here so the v0.9 push can
proceed cleanly. A future dedicated sprint will:

1. MCP-verify each migration's schema effects exist in production
2. Use `supabase migration repair --status applied <version>` to
   register each verified file in `schema_migrations`
3. Move files back to `../migrations/` once the table is repaired

---

## File classification

### 🔴 Class O1 — v0.8.x sprint orphans (8 files)

These were authored during v0.8.0 and v0.8.1 sprints. SQL effects
should already be in production schema; only the `schema_migrations`
table entry is missing.

| File | Authored sprint | What it does |
|---|---|---|
| `20260330130000_p1_security_hardening.sql` | v0.8.0 | P1 security audit followup |
| `20260330140000_content_hash_enforcement.sql` | v0.8.0 | Content hash validation |
| `20260331100000_quality_observatory_tables.sql` | v0.8.0 | Quality observatory tables (`release_test_reports`, `security_scan_results`, `dependency_audit_logs`) |
| `20260331120000_protocol_consistency_checks.sql` | v0.8.0 | Protocol consistency check RPCs |
| `20260331130000_rls_tightening_v081.sql` | v0.8.1 | RLS policy hardening |
| `20260331140000_content_hash_server_validation.sql` | v0.8.1 | Server-side content hash validation |
| `20260331150000_audit_fixes.sql` | v0.8.1 | Audit-driven fixes (search_genes etc.) |
| `20260331160000_deduplicate_unique_constraint.sql` | v0.8.1 | Deduplicate unique constraints |

### 🟢 Class O2 — Local dev-only baseline fixes (2 files)

These exist solely to make `supabase reset` succeed in local development.
Production never needed them. **Should NOT be marked as `repair --status
applied`** — should be marked `--status reverted` (i.e., production
correctly skips them).

| File | Why dev-only |
|---|---|
| `20260101000000_enable_pg_cron.sql` | Production `pg_cron` was enabled via Dashboard Extensions panel; this file is local-only to make `supabase reset` work in fresh local replays |
| `20260331145900_drop_search_genes_pre_audit_fixes.sql` | Local-only DROP to enable `supabase reset` cleanly through `audit_fixes` (production was incremental, never needed this DROP) |

---

## Recovery sprint (when authorized)

```bash
cd rotifer-playground

# Step 1: Move 8 Class-O1 files back
mv supabase/migrations-deferred-v08-orphans/20260330130000_p1_security_hardening.sql \
   supabase/migrations-deferred-v08-orphans/20260330140000_content_hash_enforcement.sql \
   supabase/migrations-deferred-v08-orphans/20260331100000_quality_observatory_tables.sql \
   supabase/migrations-deferred-v08-orphans/20260331120000_protocol_consistency_checks.sql \
   supabase/migrations-deferred-v08-orphans/20260331130000_rls_tightening_v081.sql \
   supabase/migrations-deferred-v08-orphans/20260331140000_content_hash_server_validation.sql \
   supabase/migrations-deferred-v08-orphans/20260331150000_audit_fixes.sql \
   supabase/migrations-deferred-v08-orphans/20260331160000_deduplicate_unique_constraint.sql \
   supabase/migrations/

# Step 2: Per-file MCP verification (use plugin-supabase-supabase-execute_sql)
# For each migration, query production for the schema objects it claims to create.
# Examples:
#   - quality_observatory_tables.sql → SELECT tablename FROM pg_tables WHERE tablename IN ('release_test_reports','security_scan_results','dependency_audit_logs');
#   - rls_tightening_v081.sql → SELECT * FROM pg_policies WHERE tablename = 'genes';
#   - audit_fixes.sql → SELECT proname FROM pg_proc WHERE proname = 'search_genes';
# If verification confirms presence → mark applied. Otherwise → push or fix manually.

# Step 3: Mark verified files as applied
supabase migration repair --status applied \
  20260330130000 20260330140000 20260331100000 20260331120000 \
  20260331130000 20260331140000 20260331150000 20260331160000

# Step 4: Mark 2 dev-only baseline fixes as reverted (production correctly skips them)
# Move them back first:
mv supabase/migrations-deferred-v08-orphans/20260101000000_enable_pg_cron.sql \
   supabase/migrations-deferred-v08-orphans/20260331145900_drop_search_genes_pre_audit_fixes.sql \
   supabase/migrations/

supabase migration repair --status reverted 20260101000000 20260331145900

# Step 5: Verify dry-run is clean
supabase db push --dry-run --linked
```

---

## Local dev environment effect

Same as `migrations-deferred-2026-04/` — `supabase reset` (local) does
NOT replay these files. This means local dev environment will lack:

- `get_gene_detail` RPC
- `quality_observatory_tables` (release_test_reports etc.)
- `audit_fixes` search_genes refinements
- pg_cron extension (local only — production has it via Dashboard)
- ... etc.

**Trade-off**: Local-prod parity broken. If local dev needs these
features, restore individual files temporarily, then move them back
to this deferred directory after testing.

**Note**: `get_gene_detail` RPC IS in production (it's not in this
deferred list). The `gene_detail_rpc` tests in CLI / VSCode extension
should still work against production.

---

**Last updated**: 2026-05-18 S2 by AI co-pilot, founder authorization
