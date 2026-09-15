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
| `20260706120000_release_manifests.sql` | 创建 `release_manifests` 表 | 2026-09-14（文件写好后一直未被真正推送——rotifer-admin 安全加固 #5/#8 在此表上加 SELECT 策略时以 `42P01 relation does not exist` 当场证实；补建语句并入下一行的迁移一并跑通） | N/A（owner 经 Studio SQL Editor 手动执行，非 CLI/MCP） |
| `20260902210000_ci_reporter_and_quality_reader_roles.sql` | rotifer-admin 安全审计 2026-09-02 #5/#8：新增 `ci_reporter`（INSERT-only 3 表）、`quality_reader`（SELECT-only 4 表）两个最小权限角色 | 2026-09-14 | N/A（owner 经 Studio SQL Editor 手动执行，非 CLI/MCP） |
| `20260915100000_revoke_anon_read_quality_tables.sql` | 撤销四张表的 `anon`/`authenticated` 读策略，闭环 #8——rotifer-admin 已全部切到 `quality_reader` 代理读取（PR #142） | 2026-09-15 | N/A（owner 经 Studio SQL Editor 手动执行，非 CLI/MCP）；实测：匿名 key 对四张表的 SELECT 均从有数据变为 `[]` |

---

## 注意事项

- **不要将这些文件移回 `migrations/`**：CLI 链接的是 `rotifer-cloud`，
  移回会导致 `supabase db push` 尝试在错误的数据库执行 DDL。
- 如需修改 Quality Observatory schema，请在此目录新建文件，
  通过 MCP `apply_migration` 推送到 `rotifer-quality`（project_id: `griwrsekmfeoplstgyrd`）。
- 参考：meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)
