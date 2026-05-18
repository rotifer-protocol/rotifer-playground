# Deferred Migrations — 2026-04 Sprint Accumulation (Class A only)

**Status**: ⏸️ DEFERRED (do NOT move back without explicit founder authorization)
**Decision date**: 2026-05-18
**Decision authority**: Founder (in v0.9 F2 push prep session)
**Audit reference**: meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)

---

## History (2026-05-18 R1 update)

This directory originally held **9 migrations** authored 2026-04-07 to 2026-04-20.

On 2026-05-18 during the v0.9 F2 push prep audit, an MCP query against
production `supabase_migrations.schema_migrations` revealed that **5 of
those 9 had already been applied to production directly via Dashboard
SQL Editor on 2026-04-07 morning** (timestamps `20260407050149` through
`20260407103141`), with the local files being late-afternoon "git
post-commits" of the same SQL using different timestamps.

The 5 duplicates were **deleted from this directory and properly
restored to `../migrations/` with production-aligned timestamps** (R1
strategy — see audit report §"R1 修补 git 历史"). One additional
production-only migration (`20260407074158_backfill_downloads_and_reputation`)
was reverse-restored from `schema_migrations.statements`.

This directory now holds **4 truly-unpushed migrations** — all internal
Quality Observatory / dashboard tooling. None affect product behavior
visible to end-users.

---

## Why these 4 are deferred

These 4 migrations are real dev/prod parity debt, but founder decided
on 2026-05-18 to defer them to a dedicated cleanup sprint after v0.9
release closure (instead of mixing them into the v0.9 F2 push).

**Why split**: Even though all 4 are low-risk (internal dashboard only),
the principle of "history accidents demand caution" applies — push v0.9
stage-2 first (clean release window), then handle these 4 in a dedicated
sprint with focused review.

---

## File classification

### 🟢 Class A — No product impact (4 files, all internal dashboard tooling)

| File | What it does |
|---|---|
| `20260410193000_add_admin_to_quality_observatory.sql` | Extends `release_test_reports.component` CHECK to allow `'admin'` + 4 other component values. Internal dashboard only. |
| `20260411091500_add_release_line_version_to_quality_observatory.sql` | Adds `release_line_version` column + indexes + backfill across 3 quality observatory tables. Internal dashboard only. |
| `20260411093000_fix_release_line_version_backfill.sql` | Fixes #2's backfill for rows that linked to wrong release line. Internal dashboard only. |
| `20260420080000_polyglot_metrics_view.sql` | Creates `v_polyglot_metrics` + `v_polyglot_genes_by_language` VIEWs for polyglot adoption stats. Internal dashboard only. |

---

## When to revisit

After v0.9 release closure (Stage-3 ABM work + F2 monitoring complete),
schedule a dedicated **"v0.9 deferred-4 cleanup sprint"** (~30 min total):

1. Move 4 files back to `../migrations/`
2. `supabase db push --dry-run --linked` to confirm only these 4 are applied
3. `supabase db push --linked`
4. Smoke test: query the 3 affected tables + 2 views
5. Commit + cascade

---

## How to recover (when authorized)

```bash
cd rotifer-playground

# Move all 4 files back:
mv supabase/migrations-deferred-2026-04/20260410193000_add_admin_to_quality_observatory.sql \
   supabase/migrations-deferred-2026-04/20260411091500_add_release_line_version_to_quality_observatory.sql \
   supabase/migrations-deferred-2026-04/20260411093000_fix_release_line_version_backfill.sql \
   supabase/migrations-deferred-2026-04/20260420080000_polyglot_metrics_view.sql \
   supabase/migrations/

# Verify dry-run shows only these 4:
supabase db push --dry-run --linked

# Push when ready:
supabase db push --linked
```

---

## Local dev environment effect

`supabase reset` (local) does NOT replay these 4 files (they live outside
`supabase/migrations/`). This means:

- Local `release_test_reports.component` CHECK stays at the smaller
  set (matches production)
- Local `release_test_reports` / `security_scan_results` /
  `dependency_audit_logs` lack `release_line_version` (matches production)
- Local `v_polyglot_metrics` / `v_polyglot_genes_by_language` views
  absent (matches production)

This is **intentional** — keeps local dev synced with production
until the deferred sprint formally promotes them together.

---

**Last updated**: 2026-05-18 R1 by AI co-pilot, founder authorization
