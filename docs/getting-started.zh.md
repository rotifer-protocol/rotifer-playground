# 快速入门

本指南将带你在约 10 分钟内走完完整的 Rotifer 基因生命周期——从 Agent 工作区初始化到运行多基因 Agent 管道。

## 前提条件

- **Node.js** >= 22.18.0
- **npm** >= 9
- （可选）**Rust 工具链** — 仅在使用 NAPI 桥接进行 Native WASM 编译时需要

> **v0.3 新功能：** `rotifer compile` 现在自动将 TypeScript 基因编译为 Native WASM（通过 [Javy](https://github.com/bytecodealliance/javy)）。无需额外的 Rust/WASM 工具链！

## 1. 初始化 Agent 工作区

```bash
npx -y @rotifer/playground@latest init my-agent
cd my-agent
```

预期输出：

```
  Rotifer Protocol - Agent Workspace Initialization
  ───────────────────────────────────────────
✓ Agent workspace scaffolding created
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

✓ Agent workspace ready: my-agent
```

项目结构：

```
my-agent/
├── rotifer.json
├── genes/
│   ├── genesis-web-search/
│   ├── genesis-web-search-lite/
│   ├── genesis-file-read/
│   ├── genesis-code-format/
│   └── genesis-l0-constraint/
└── .rotifer/
    └── arena.db
```

## 2. 扫描候选函数

将 `rotifer scan` 指向任意包含 TypeScript 或 Rust 源文件的目录，发现可以转化为基因的函数。

```bash
rotifer scan genes/
```

扫描器检测已导出的函数并报告兼容性：

```
  Source Scan Results
  ────────────────────
  File                            Functions Found
  genes/genesis-web-search/index.ts    1 (express)
  genes/genesis-code-format/index.ts   1 (express)
  ...

✓ Scan complete: 5 candidate functions found
```

## 3. 将函数包装为基因

创建一个简单函数并包装它：

```bash
mkdir -p genes/hello-world
```

创建 `genes/hello-world/index.ts`：

```typescript
interface Input {
  name: string;
}

interface Output {
  greeting: string;
}

export async function express(input: Input): Promise<Output> {
  return {
    greeting: `你好，${input.name}！欢迎来到 Rotifer Protocol。`,
  };
}
```

然后包装：

```bash
rotifer wrap hello-world
```

这将生成 `genes/hello-world/phenotype.json` — 基因的元数据，描述其领域、输入/输出模式、保真度和语义要求。

## 4. 在 L2 沙箱中测试

```bash
rotifer test hello-world
```

预期输出：

```
  Gene Test: hello-world
  ────────────────────────
✓ Phenotype loaded
✓ Input schema valid
✓ Output schema valid
✓ express() returned result
✓ Output conforms to schema
✓ Execution time: 2ms

  Result: 6/6 checks passed
```

测试运行器执行基因——已编译基因通过 **WASM 沙箱**运行（带燃料计量、内存隔离和 L0 门控检查）；未编译基因回退到 Node.js `import()` 并提示警告。它从 schema 生成输入、验证输出并验证 IR 完整性。使用 `--compliance` 可运行结构性合规检查（沙箱验证、燃料计量、L0 门控、Phenotype 完整性、F(g) 可计算性、IR 完整性）。

使用 `--verbose` 查看详细输出：

```bash
rotifer test hello-world --verbose
```

## 5. 编译为 Rotifer IR

```bash
rotifer compile hello-world
```

**v0.3：自动 TS→WASM 编译。** 如果基因目录中有 `index.ts` 或 `index.js` 文件且没有预编译的 `gene.wasm`，编译器会自动运行 Javy 管线：

```
index.ts → esbuild（类型剥离）→ Javy（QuickJS→WASM）→ Rotifer IR（自定义段注入）
```

这将生成 Native 保真度的基因，无需手动设置 WASM 工具链。

你也可以直接提供预编译的 WASM：

```bash
rotifer compile hello-world --wasm path/to/hello.wasm
```

IR 编译器会将 Rotifer 自定义段（版本、表型、约束、计量）注入 WASM 二进制，在 `genes/hello-world/gene.ir.wasm` 下生成可移植的 `.wasm` 文件。

## 6. 提交到 Arena

```bash
rotifer arena submit hello-world
```

Arena 运行准入评估：在 L2 沙箱中测试基因，计算适应度分数 F(g) 和安全分数 V(g)，两者都通过阈值后注册基因。

```
  Arena Submission: hello-world
  ──────────────────────────────
✓ Gene loaded
✓ Admission tests passed
✓ Fitness: F(g) = 0.57
✓ Safety:  V(g) = 1.00
✓ Registered in Arena

ℹ Fidelity: Wrapped
ℹ Domain:   general
```

## 7. 查看 Arena 排名

```bash
rotifer arena list
```

所有基因按领域内的适应度排名：

```
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
```

按领域过滤：

```bash
rotifer arena list --domain search
```

## 8. 创建 Agent

Agent 组装一个**基因组** — 从 Arena 中选择基因的组合。

```bash
rotifer agent create greeter-bot --genes hello-world genesis-code-format
```

或从某个领域自动选择排名靠前的基因：

```bash
rotifer agent create search-agent --domain search --top 2
```

```
  Agent Created: search-agent
  ─────────────────────────────
  Genome (Seq):
    1. genesis-web-search
    2. genesis-web-search-lite

✓ Agent saved to .rotifer/agents/search-agent.json
```

## 9. 运行 Agent

执行 Agent 的基因组作为顺序管道。每个基因的输出作为下一个基因的输入。

```bash
rotifer agent run greeter-bot --input '{"name":"World"}'
```

```
  Agent Run: greeter-bot
  ────────────────────────
  Pipeline: hello-world → genesis-code-format

  Step 1/2: hello-world
  ✓ Result: {"greeting":"你好，World！欢迎来到 Rotifer Protocol。"}

  Step 2/2: genesis-code-format
  ✓ Result: {"formatted":"...","changed":true,"language":"json"}

  Final Output:
  {"formatted":"...","changed":true,"language":"json"}

✓ Pipeline complete (2 genes, 15ms)
```

使用 `--verbose` 查看每步的中间输入和输出。

---

## 下一步

- **编写 Native 基因**：用 TypeScript 编写，`rotifer compile` 自动通过 Javy 编译为 WASM——或用 Rust/AssemblyScript 手动优化 WASM
- **探索组合**：使用 `Seq`、`Par`、`Cond`、`Try`、`Transform` 操作符构建复杂基因管道（参见 `templates/composition/`）
- **阅读规范**：[Rotifer Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## 故障排除

### `rotifer: command not found`

全局安装：`npm install -g @rotifer/playground`，或使用 `npx @rotifer/playground` 作为前缀。

### `rotifer test` 报错 "no express() export"

基因的 `index.ts` 必须导出 `express` 函数作为默认入口。检查函数签名是否与模板匹配。

### 适应度分数偏低

Wrapped 基因有固有的保真度惩罚。使用 `rotifer compile` 自动将 TypeScript 编译为 Native WASM 可获得更高的适应度潜力。确保基因的 `express()` 函数执行快速并返回结构良好的输出。

### NAPI 绑定未找到

NAPI 桥接是可选的。没有它，CLI 将回退到纯 TypeScript 模式。要启用 Native IR 编译，请构建 Rust 核心：`cd crates/rotifer-napi && napi build --release`。
