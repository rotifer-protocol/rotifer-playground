# migrations-deferred-v095-por/

## 用途

v0.9.5 A1「节点证明（PoR）」Cloud 侧的迁移，**主动延期**：参考实现已写完、本地测过，但还不能进生产迁移账本。

`supabase/migrations/` 的文件名就是生产库迁移账本的版本号，放进去就会被下一次 `supabase db push` 一起带上生产（08-19 出过一次 `--include-all` 把未授权迁移推走的事故）。所以这里的文件**不进** `supabase/migrations/`。

---

## 文件清单

| 文件 | 内容 | 解锁条件 |
|---|---|---|
| `20261102200000_node_attestation.sql` | `nodes`、只追加的签发记录 `node_attestation_issuances`、一次性挑战 `node_attestation_challenges`、撤销表 `node_attestation_revocations`；RLS；签发用的 SECURITY DEFINER 函数（只授权 service_role） | v0.9.5 阶段二 B1 拿到用户关键词；部署前置见 `supabase/functions/node-attestation/README.md`「Before deploying」 |

依据：ADR-300 修订二「锁定契约 v2」的「表」「发证挑战」与 D5。

---

## 本地怎么测

```bash
supabase start
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql
supabase test db                                     # 含 supabase/tests/node_attestation.sql
DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  bash supabase/functions/node-attestation/race-check.sh
```

没灌这份迁移时，`supabase test db` 里 `node_attestation.sql` 只报一条 skip，不会红。

---

## 解锁时怎么搬

1. 拿到用户关键词（B1）。
2. `git mv` 到 `supabase/migrations/`，文件名的时间戳改成搬的那天（必须晚于账本里最新一条），本目录的清单表同步删掉这一行。
3. 按项目的迁移推送流程（只加不删不改，`supabase db push --linked`）推送。

**Last updated**: 2026-11-02
