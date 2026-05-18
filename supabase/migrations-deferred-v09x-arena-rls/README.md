# migrations-deferred-v09x-arena-rls/

## 用途

延迟到 **v0.9.x patch 或 v1.0** 处理的 migration 文件——主要是 `arena_entries` RLS 加固。

与已结案的 v0.8 orphan deferred 目录（`migrations-deferred-v08-orphans/`）不同，这个目录**不是历史债**，而是**主动延期**的工程任务（确认了完整的依赖链后决定）。

---

## 文件清单

| 文件 | 延期理由 | 解锁条件 | 计划处置版本 |
|---|---|---|---|
| `20260331130000_rls_tightening_v081_arena_portion.sql` | 当前 CLI / MCP publish flow 用 user JWT 直接 INSERT `/arena_entries`。文件想要把 INSERT/UPDATE 锁死成 service_role only，会立即断 publish flow | 先把 arena INSERT 包装为 SECURITY DEFINER RPC（`submit_arena_entry`），CLI / MCP 改调 RPC，验证全套客户端路径，再加固 | v0.9.x patch（推荐）或 v1.0 |

---

## 与 Sprint C Phase 6a 的关系

Sprint C Phase 6a 已完成 `downloads` 表的 RLS 加固（`20260518174553_lock_downloads_direct_insert.sql`），关闭了 §3.14 P0#3 download-count 攻击向量。`arena_entries` 加固延期不影响 downloads 加固的安全收益。

`downloads` 比 `arena_entries` 简单是因为：所有客户端**早就用 `track_download()` RPC**（自 v0.8 起），加固只是对齐 RLS 与实际调用路径。`arena_entries` 还需要先做 RPC 化的工程改造。

---

**Last updated**: 2026-05-18 Sprint C Phase 6
**Audit reference**: meta-lesson **S2-L11** (private; 2026-05-18; dev/prod parity sprint)
