# Rotifer Playground

[![CI](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rotifer/playground)](https://www.npmjs.com/package/@rotifer/playground)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Protocol-Frozen-orange)](https://github.com/rotifer-protocol/rotifer-spec)
[![Discord](https://img.shields.io/discord/placeholder?label=Discord&logo=discord&color=5865F2)](https://rotifer.dev/discord)

**Rotifer Protocol** 的开发环境——构建基因、运行 Arena 竞争、通过 Cloud 共享、模拟代理进化。

> **状态：** v0.8.1——面向基因开发、Arena 竞争和协议实验的公开 Playground。详细版本历史请参见 [CHANGELOG.md](CHANGELOG.md)。P2P 实现与 L4 集体免疫仍在规划中——详见下方[实现状态](#实现状态)。

---

## 安装

```bash
npm install -g @rotifer/playground
```

或通过 npx 直接使用：

```bash
npx @rotifer/playground init my-project
```

**环境要求：** Node.js >= 20.0.0

---

## 30 秒演示

```bash
$ rotifer init my-project

  Rotifer Protocol - Project Initialization
  ───────────────────────────────────────────
✓ Project scaffolding created
ℹ Installing Genesis genes...
✓ 5 Genesis genes installed

  Arena Rankings
  ────────────────
  #   Name                        Domain        F(g)    Fidelity
  ────────────────────────────────────────────────────────────────
  1   genesis-web-search          search        0.87    Native
  2   genesis-code-format         tooling       0.81    Native
  3   genesis-l0-constraint       safety        0.79    Native
  4   genesis-web-search-lite     search        0.77    Native
  5   genesis-file-read           filesystem    0.74    Native
  6   hello-world                 general       0.57    Wrapped

ℹ 6 genes across 5 domain(s) — Arena is alive!
✓ Project ready: my-project
```

一条命令。五个 Genesis 基因。一个活跃的 Arena。

---

## 三幕体验 (ADR-11)

### 第一幕——Wow（30 秒）

```bash
rotifer init my-project && cd my-project
```

你将看到一个包含 6 个基因的 Arena，按适应度排名。无需任何配置。

### 第二幕——Aha（5 分钟）

```bash
rotifer scan genes/               # 发现候选基因函数
rotifer wrap hello-world           # 包装为基因（生成 Phenotype）
rotifer test hello-world           # 在 L2 沙箱中运行测试（已编译基因走 WASM 沙箱）
rotifer test hello-world --compliance  # 运行结构性合规检查
rotifer arena submit hello-world   # 提交到 Arena（准入评估）
rotifer arena list                 # 查看你的基因排名
```

你的现有代码变成了基因，并在 Arena 中竞争。

### 第三幕——Hooked（30 分钟）

用 TypeScript 编写基因，自动编译为原生 WASM：

```bash
# 用 TypeScript 写基因——同一语言，零学习成本
mkdir genes/my-search && cat > genes/my-search/index.ts << 'EOF'
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
EOF

rotifer wrap my-search --domain search
rotifer compile my-search          # TS → JS → WASM (Javy) → Rotifer IR
rotifer arena submit my-search     # 观察它攀升排名
rotifer arena list --domain search # 与 Genesis 基因对比

# 创建一个拥有基因组的 Agent（支持 Seq, Par, Cond, Try）
rotifer agent create search-bot --genes genesis-web-search my-search
rotifer agent create parallel-bot --genes web-search doc-search --composition Par
rotifer agent list

# 运行 Agent——WASM 沙箱执行优先
rotifer agent run search-bot --input '{"query":"rotifer protocol"}'
rotifer agent run search-bot --no-sandbox  # 强制 Node.js 回退
```

**说明：** `rotifer compile` 自动检测 TypeScript 基因，通过 [Javy](https://github.com/bytecodealliance/javy)（QuickJS→WASM）编译为原生 WASM，无需额外工具链。

---

## 架构

```
playground/
├── crates/
│   ├── rotifer-core/        Rust: 类型、沙箱、Arena、代数、适应度、存储
│   └── rotifer-napi/        napi-rs 桥接: Rust ↔ Node.js FFI
├── src/                     TypeScript CLI 与支撑模块
│   ├── commands/            CLI 命令模块
│   ├── cloud/               Cloud Binding 客户端（auth、API、types）
│   └── utils/               配置、显示、NAPI 绑定、IR 编译器
├── genes/                   随仓库提供的 gene 目录
├── supabase/                Cloud Binding 自托管指南
├── templates/               基因 + 组合脚手架模板
└── tests/                   单元测试 + E2E 测试
```

### 分层

| 层 | 技术栈 | 职责 |
|----|--------|------|
| **CLI** | TypeScript + commander.js | 用户界面、命令路由、显示 |
| **Bridge** | napi-rs (cdylib) | Rust 到 Node.js 的 FFI 绑定 |
| **Core** | Rust + wasmtime | WASM 沙箱（Direct + WASI）、Arena 引擎、Algebra 执行器、Fitness 计算、SQLite 存储 |

---

## CLI 命令

运行 `rotifer --help` 查看按模块分组的命令列表。常用命令如下：

| 命令 | 说明 |
|------|------|
| `rotifer init [gene-name]` | 初始化新的 Rotifer 基因项目 |
| `rotifer scan [path]` | 扫描候选基因和本地技能 |
| `rotifer wrap <gene-name>` | 将函数或 `SKILL.md` 包装为基因 |
| `rotifer test [gene-name]` | 在沙箱中测试基因 |
| `rotifer compile [gene-name]` | 将基因编译为 Rotifer IR（WASM） |
| `rotifer run <gene-name>` | 直接执行单个本地基因 |
| `rotifer list` | 列出当前项目中的本地基因 |
| `rotifer login` | 登录 Rotifer Cloud |
| `rotifer logout` | 从 Rotifer Cloud 登出 |
| `rotifer publish [gene-name]` | 将基因发布到 Rotifer Cloud |
| `rotifer search [query]` | 在 Rotifer Cloud 中搜索基因 |
| `rotifer install <gene-ref>` | 从 Rotifer Cloud 安装基因 |
| `rotifer info <gene-ref>` | 查看基因详情（本地或 Cloud） |
| `rotifer stats <gene-ref>` | 查看基因下载统计 |
| `rotifer compare [gene-refs...]` | 按声誉与下载量对比 2-5 个基因 |
| `rotifer reputation [gene-ref]` | 查看基因与开发者声誉分数 |
| `rotifer versions <owner> <gene-name>` | 查看某个基因的版本链 |
| `rotifer arena submit <gene-name>` | 将基因提交到 Arena 竞争 |
| `rotifer arena list` | 列出 Arena 排名 |
| `rotifer arena watch <domain>` | 实时观察 Arena 排名 |
| `rotifer agent create <agent-name>` | 用基因组创建 Agent |
| `rotifer agent list` | 列出全部 Agent |
| `rotifer agent run <agent-name>` | 执行 Agent 的基因组管线 |
| `rotifer vg [path]` | 对基因代码执行 V(g) 安全扫描 |
| `rotifer network` | P2P 基因网络命令 |
| `rotifer self-update` | 检查并升级 Rotifer 包 |
| `rotifer config` | 管理全局 Rotifer 配置 |
| `rotifer whoami` | 显示当前认证状态 |

---

## Genesis 基因

每个新项目预装五个基因：

| 基因 | 领域 | 保真度 | 说明 |
|------|------|--------|------|
| `genesis-web-search` | search | Native | 完整的网络搜索，返回多个结果 |
| `genesis-web-search-lite` | search | Native | 轻量级单结果搜索 |
| `genesis-file-read` | filesystem | Native | 读取本地文件（L0 沙箱限制） |
| `genesis-code-format` | tooling | Native | 格式化源代码（JSON、TS 等） |
| `genesis-l0-constraint` | safety | Native | L0 沙箱约束检查器 |

---

## 基因组合（Algebra）

基因可以使用 Rotifer Algebra 进行组合：

| 操作符 | 说明 | 示例 |
|--------|------|------|
| **Seq** | 顺序管道 | 搜索 → 格式化 |
| **Par** | 并行执行并合并 | Search + Search-Lite，取先返回者 |
| **Cond** | 条件分支 | 若 query.length > 100 → Lite，否则 → Full |
| **Try** | 容错 | 主基因 + 降级备选 |
| **Transform** | 映射/转换 | 内部基因 → 映射基因 |

JSON 示例参见 `templates/composition/`。

---

## 示例

`examples/` 目录包含参考实现和实验：

| 目录 | 说明 |
|------|------|
| `examples/mcp-migration/` | 如何将 MCP Tool 迁移为 Rotifer Gene |
| `examples/api-apocalypse/` | API 容错实验——基线 Agent 与 Rotifer 域故障转移 Agent 的对比 |

---

## 开发

```bash
git clone https://github.com/rotifer-protocol/rotifer-playground.git
cd rotifer-playground

# TypeScript CLI
npm install
npm run build          # 构建到 dist/
npm test               # 运行 TypeScript 测试套件（Vitest）
npm run lint           # 对 src/ 做类型检查和 lint

# Rust Core（需要 Rust 工具链）
cargo check -p rotifer-core
cargo test -p rotifer-core

# 完整演示
bash demo.sh
```

---

## 实现状态

> 本项目处于 **alpha** 阶段。下表展示了当前各 URAA 层级的真实实现状态。

| URAA 层级 | 规范名称 | 完成度 | 已可用 | 规划中 |
|-----------|---------|--------|--------|--------|
| **L0** | 内核层 | **~35%** | `L0Gate` 预执行检查（域、资源、网络、文件系统）；审计日志 | 伦理边界、状态锚定、信任根 |
| **L1** | 合成层 | **~95%** | WASM 沙箱（wasmtime）、IR 编译器、Javy TS→WASM、NAPI 桥接 | 完整 WASI 能力协商 |
| **L2** | 校准层 | **~40%** | Schema 验证、沙箱测试、`--compliance` 检查 | 静态分析、受控试运行 |
| **L3** | 竞争与交换层 | **~60%** | Arena 排名、F(g) 乘法模型、R(g) 声誉、Cloud Registry | P2P HLT 广播（仅 stub）、热加载、退役 |
| **L4** | 集体免疫层 | **0%** | — | 威胁广播、紧急回滚、跨节点共识 |
| **代数** | 组合代数 | **~90%** | Rust 五算子全实现；CLI 支持 Seq/Par/Cond/Try | DataFlowGraph |

**关键限制：** L4 依赖 L3 的 P2P 网络（当前为 stub）。完整 L4 目标版本为 v0.9+。

---

## 协议合规性

目标规范：**Rotifer Protocol Specification**（Frozen）。详细层级覆盖请参见[实现状态](#实现状态)。

| 深度 | 组件 | 备注 |
|------|------|------|
| **完整** | Phenotype、AlgebraExpr、Fitness F(g)、Arena | 核心基因生命周期 |
| **可用** | WASM Sandbox、L0 Gate、Reputation R(g) | L0 ~35%，持续扩展 |
| **简化** | Agent Lifecycle、Gene Lifecycle、RotiferBinding | MVP 子集 |
| **占位/规划** | P2P HLT、Formal Verification、Cross-Binding Consistency、ZK Proofs、L4 Immunity | 路线图条目 |

基于实现反馈的变更通过 ADR 流程提出。

---

## 路线图

详细发布历史请参见 [CHANGELOG.md](CHANGELOG.md)。接下来的里程碑：

- **v0.9** — P2P 网络（元数据发现）、经济体系设计
- **v1.0** — 稳定版：L0-L3 完整、经济体系上线、安全审计

---

## 社区

- [Discord](https://rotifer.dev/discord) — 加入讨论
- [GitHub Discussions](https://github.com/rotifer-protocol/rotifer-playground/discussions) — 问题与提案

## 参与贡献

开发指南请参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[Apache-2.0](LICENSE) + [Rotifer Safety Clause](LICENSE#rotifer-safety-clause-additional-terms)

本项目使用 Apache License 2.0，附加 **Rotifer Safety Clause**——要求任何部署必须保留 L0 约束层，或明确披露对其的修改。

---

**轮虫协议，生生不息。**
