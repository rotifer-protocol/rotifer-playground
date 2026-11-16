# migrations-deferred-v095-por/

## 用途

v0.9.5 A1「节点证明（PoR）」Cloud 侧的迁移，**主动延期**：参考实现已写完、本地测过，但还不能进生产迁移账本。

`supabase/migrations/` 的文件名就是生产库迁移账本的版本号，放进去就会被下一次 `supabase db push` 一起带上生产（08-19 出过一次 `--include-all` 把未授权迁移推走的事故）。所以这里的文件**不进** `supabase/migrations/`。

---

## 文件清单

| 文件 | 内容 | 解锁条件 |
|---|---|---|

（空。原来唯一的一份 `20261102200000_node_attestation.sql` 已于 2026-11-16 拿到 B1 关键词后移入 `supabase/migrations/`，版本号不变：它已晚于生产账本最新一条和 `20261030220000`。）

---

## 搬走以后

- 本地：`supabase start` 会连同链上其他迁移一起应用这份迁移，不要再手动用 psql 灌一次，会报重复建表。`supabase test db` 会跑完 `supabase/tests/node_attestation.sql` 的全部断言；CI 另用 `supabase/functions/node-attestation/pgtap-deferred.sh --no-apply` 单独跑一遍，跑出来是 skip 或少跑了断言就算失败。
- 上生产：不用 `supabase db push`，因为本地还有别的迁移不在生产账本里，推送会把它们一起带上（更不能加 `--include-all`）。迁移文件和它的迁移历史行放在同一个事务里应用，做法见 `supabase/functions/node-attestation/README.md`「Before deploying」。
- 迁移文件开头那段「DEFERRED」注释没有改：登记迁移历史的那一行是照这份文件逐字生成的，改一个字两边就对不上。
- 部署时要配的 `por_issuer`、`por_operator` 两个角色、连接串（现在必须是 `sslmode=verify-full`）、请求上限，都以函数 README 为准。

**Last updated**: 2026-11-16
