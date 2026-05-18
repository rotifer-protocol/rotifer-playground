# migrations-applied-rotifer-quality/

## 用途

存放**已应用到 `rotifer-quality` Supabase 项目**（Quality Observatory）的 migration 文件。

这些文件在编写时被放入 `rotifer-playground/supabase/migrations/`，但它们操作的是
`release_test_reports` / `security_scan_results` / `dependency_audit_logs` 三张表，
这些表属于 **`rotifer-quality` 项目**，而非 CLI 默认链接的 `rotifer-cloud` 项目。

因此这些 migration 通过 Supabase MCP `apply_migration` 直接推送到 `rotifer-quality`，
而非通过 `supabase db push` CLI 推送。

---

## 文件清单

| 文件（原始时间戳） | 功能摘要 | 推送到 rotifer-quality 的日期 | rotifer-quality schema_migrations 记录版本 |
|---|---|---|---|
| `20260331100000_quality_observatory_tables.sql` | 创建 `release_test_reports` / `security_scan_results` / `dependency_audit_logs` 三张表 + 索引 + RLS 策略 | 2026-03-31 (历史，via Dashboard SQL Editor) | `20260331100000`（Sprint C Phase 2 retroactive 账目补录 2026-05-18） |
| `20260410193000_add_admin_to_quality_observatory.sql` | 扩展 `release_test_reports.component` CHECK 约束，加入 `admin` 组件 | 2026-05-18 | `20260518081514` |
| `20260411091500_add_release_line_version_to_quality_observatory.sql` | 为 QO 三张表加 `release_line_version` 列 + 索引 + 历史数据回填 | 2026-05-18 | `20260518081546` |
| `20260411093000_fix_release_line_version_backfill.sql` | 修正回填策略，优先精确版本匹配 | 2026-05-18 | `20260518081601` |

---

## 注意事项

- **不要将这些文件移回 `migrations/`**：CLI 链接的是 `rotifer-cloud`，
  移回会导致 `supabase db push` 尝试在错误的数据库执行 DDL。
- 如需修改 Quality Observatory schema，请在此目录新建文件，
  通过 MCP `apply_migration` 推送到 `rotifer-quality`（project_id: `griwrsekmfeoplstgyrd`）。
- 参考：meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)
