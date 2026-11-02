# migrations-deferred-v095-por/

## 用途

v0.9.5 A1「节点证明（PoR）」Cloud 侧的迁移，**主动延期**：参考实现已写完、本地测过，但还不能进生产迁移账本。

`supabase/migrations/` 的文件名就是生产库迁移账本的版本号，放进去就会被下一次 `supabase db push` 一起带上生产（08-19 出过一次 `--include-all` 把未授权迁移推走的事故）。所以这里的文件**不进** `supabase/migrations/`。

---

## 文件清单

| 文件 | 内容 | 解锁条件 |
|---|---|---|
| `20261102200000_node_attestation.sql` | `nodes`、只追加的签发记录 `node_attestation_issuances`、一次性挑战 `node_attestation_challenges`、撤销表 `node_attestation_revocations`；RLS；签发函数专用的数据库角色 `por_issuer`（只能执行发挑战、入账这两个 SECURITY DEFINER 函数，不能直接读写任何表） | v0.9.5 阶段二 B1 拿到用户关键词；部署前置见 `supabase/functions/node-attestation/README.md`「Before deploying」 |

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

没灌这份迁移时，`supabase test db` 里 `node_attestation.sql` 只报一条 skip，不会红。CI 另有一步 `supabase/functions/node-attestation/pgtap-deferred.sh`：把这份迁移灌进 CI 的一次性库再单独跑这份 pgTAP，迁移没灌上、或跑出来是 skip、或少跑了断言，都算失败。

---

## 部署时要多配的一项

签发函数不用 service_role，而是以 `por_issuer` 角色连数据库。迁移只建角色、不给登录权限，B1 部署时由绑定层：

1. 在部署环境里给 `por_issuer` 设密码（`ALTER ROLE por_issuer LOGIN PASSWORD …`）；
2. 把连接串存成签发函数的密钥 `POR_DB_URL`（走 Supabase 连接池时用户名是 `por_issuer.<项目 ref>`，用 transaction 模式）。

本目录和本仓库都不配任何真实连接串。本地测试（`race-check.sh`、`e2e.ts`）用临时生成的密码，经标准输入传给 psql，不落盘，跑完收回登录权限。

---

## 解锁时怎么搬

1. 拿到用户关键词（B1）。
2. `git mv` 到 `supabase/migrations/`，文件名的时间戳改成搬的那天（必须晚于账本里最新一条），本目录的清单表同步删掉这一行。
3. 按项目的迁移推送流程（只加不删不改，`supabase db push --linked`）推送。

**Last updated**: 2026-11-02
