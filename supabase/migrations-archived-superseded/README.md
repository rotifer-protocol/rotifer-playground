# migrations-archived-superseded/

## 用途

**已被后续 migration 取代或吸收**的历史 migration 文件。仅作工程档案保留，对应的 schema effects 已通过其他路径生效或不再需要。

与其他目录的语义区分：

| 目录 | 语义 |
|---|---|
| `migrations/` | 当前 active 的本地 migration（与生产 `schema_migrations` 对齐） |
| `migrations-applied-rotifer-quality/` | 已应用到非默认 Supabase 项目（rotifer-quality）的 migration |
| `migrations-deferred-v08-orphans/` | 历史 v0.8 orphan migration，等待 cleanup sprint 处理 |
| **`migrations-archived-superseded/`** | **已被后续 migration 取代或吸收的 migration，仅作历史档案** |

---

## 文件清单

| 文件 | 取代/吸收路径 | 账目状态 | 归档日期 |
|---|---|---|---|
| `20260331150000_audit_fixes.sql` | Fix 2 (search_genes ESCAPE) 已被 v0.9 stage-2 search_genes 重写吸收（MCP 验证 2026-05-18 当前 search_genes 含 ESCAPE 子句）；Fix 1 (validate_content_hash_on_publish hash mismatch) 待 Phase 4 #6 重写时合并 | **从未在 rotifer-cloud schema_migrations 登记**——本文件历史上从未在生产应用，不需要 retroactive 账目（Phase 3 一度尝试 INSERT 但发现 dry-run 会报"local missing"错误，遂 DELETE 撤回——CLI 仅匹配 `migrations/` 目录，archived 文件应同步从 schema_migrations 删除以保持一致性）| 2026-05-18 (Sprint C Phase 3) |

---

## 重要约束

- **不要**把这些文件移回 `migrations/`——它们的内容已废弃，移回会让 `supabase reset` 在本地尝试重跑废弃 SQL
- **不要**修改这些文件——它们是历史档案
- 维护本目录 README 的"取代/吸收路径"列，确保未来追溯有据
- 如发现某个 archived 文件 schema effects 实际并未被取代（账目错误），应在新 timestamp 下重写后再 archive 旧版

---

**Last updated**: 2026-05-18 Sprint C Phase 3
**Audit reference**: meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)
