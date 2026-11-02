# migrations-deferred-v095-por/

## 用途

v0.9.5 A1「节点证明（PoR）」Cloud 侧的迁移，**主动延期**：参考实现已写完、本地测过，但还不能进生产迁移账本。

`supabase/migrations/` 的文件名就是生产库迁移账本的版本号，放进去就会被下一次 `supabase db push` 一起带上生产（08-19 出过一次 `--include-all` 把未授权迁移推走的事故）。所以这里的文件**不进** `supabase/migrations/`。

---

## 文件清单

| 文件 | 内容 | 解锁条件 |
|---|---|---|
| `20261102200000_node_attestation.sql` | `nodes`、只追加的签发记录 `node_attestation_issuances`、一次性挑战 `node_attestation_challenges`、撤销表 `node_attestation_revocations`；RLS；签发函数专用的数据库角色 `por_issuer`（只能执行发挑战、入账两个 SECURITY DEFINER 函数，不能直接读写任何表）；运维专用的 `por_operator`（只能执行撤销、导出 JWKS 撤销表两个函数） | v0.9.5 阶段二 B1 拿到用户关键词；部署前置见 `supabase/functions/node-attestation/README.md`「Before deploying」 |

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

签发函数以专用的 `por_issuer` 角色连数据库，这个角色只能执行两个入账用的函数（发挑战、入账），不能直接读写任何表，也不绕过 RLS。撤销证书、为 JWKS 导出撤销表这两个函数，签发函数的代码根本不调，所以不给 `por_issuer`，改给单独的运维角色 `por_operator`：它只供运维手动撤销、导出撤销表时使用，签发函数永远不用它——否则签发函数一旦被攻破，攻击者就能撤销任意证书。迁移只建这两个角色、都不给登录权限，B1 部署时由绑定层：

1. 在部署环境里给 `por_issuer` 设密码（`ALTER ROLE por_issuer LOGIN PASSWORD …`）；
2. 把连接串存成签发函数的密钥 `POR_DB_URL`（走 Supabase 连接池时用户名是 `por_issuer.<项目 ref>`，用 transaction 模式）；
3. 只在运维执行撤销的地方给 `por_operator` 开登录，它的连接串不放进签发函数的环境。

本目录和本仓库都不配任何真实连接串。本地测试（`race-check.sh`、`e2e.ts`）用临时生成的密码，经标准输入传给 psql，不落盘，跑完收回登录权限。在 colima 里跑 `e2e.ts`，签发函数要按网络别名 `db:5432` 连数据库（容器名 `supabase_db_<项目 id>` 解析不到）；脚本默认就用它，栈里别名不同时设 `POR_DB_HOST`。

---

## 解锁时怎么搬

1. 拿到用户关键词（B1）。
2. `git mv` 到 `supabase/migrations/`，文件名的时间戳改成搬的那天（必须晚于账本里最新一条），本目录的清单表同步删掉这一行。
3. 按项目的迁移推送流程（只加不删不改，`supabase db push --linked`）推送。

**Last updated**: 2026-11-02
