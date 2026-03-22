---
name: tech-lead
description: Enforce code consistency, naming conventions, and hygiene for AI and Web3 projects. Standardize AI SDK usage, Web3 patterns (wagmi/ethers), and TypeScript types. Use when refactoring code, reviewing for consistency, or when the user mentions code quality, standards, or linting.
---

# The Tech Lead (严格的技术负责人)

**Goal**: 确保代码风格统一、干净、可维护，符合团队既定规范。

**专注领域**: AI SDK 一致性 + Web3 代码规范

---

## Pre-Review Checklist

```
Consistency Scan:
- [ ] AI SDK: Vercel AI / OpenAI / LangChain? (不要混用)
- [ ] Web3 SDK: wagmi+viem / ethers? (选定一个)
- [ ] 数据获取: useQuery / useSWR / useEffect?
- [ ] 命名习惯: camelCase / snake_case?
- [ ] 组件复用: 有哪些现成组件?
```

---

## 1. AI Code Consistency

### SDK Selection (选定一个，全项目统一)

```typescript
// ✅ 项目选择: Vercel AI SDK
import { generateText, streamText } from 'ai'
import { openai } from '@ai-sdk/openai'

// ❌ 不要混用
import OpenAI from 'openai'  // 直接用 OpenAI SDK
import { ChatOpenAI } from '@langchain/openai'  // LangChain
```

### AI Type Definitions

```typescript
// types/ai.ts - 统一 AI 类型定义
export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: Date
}

export interface TokenUsage {
  prompt: number
  completion: number
  total: number
}

export interface AIConfig {
  model: string
  temperature?: number
  maxTokens?: number
}

// 响应类型
export type AIResult<T> = 
  | { ok: true; data: T; usage?: TokenUsage }
  | { ok: false; error: AIError }

export type AIError = 
  | { code: 'RATE_LIMITED'; retryAfter: number }
  | { code: 'TOKEN_LIMIT'; used: number; limit: number }
  | { code: 'TIMEOUT' }
  | { code: 'UNKNOWN'; message: string }
```

### Prompt Template Management

```typescript
// ✅ 集中管理 prompts
// lib/prompts/index.ts
export const PROMPTS = {
  SYSTEM: {
    DEFAULT: 'You are a helpful assistant.',
    ANALYST: 'You are a data analyst...',
    CODER: 'You are an expert programmer...',
  },
  TEMPLATES: {
    SUMMARIZE: (text: string) => `Summarize: ${text}`,
    TRANSLATE: (text: string, lang: string) => 
      `Translate to ${lang}: ${text}`,
  }
} as const

// ❌ 禁止硬编码在组件中
const response = await generateText({
  prompt: 'You are a helpful assistant. Please help me...'  // 散落的 prompt
})
```

### AI Hook Pattern

```typescript
// ✅ 统一的 AI Hook 结构
// hooks/useAI.ts
export function useChat(config?: AIConfig) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<AIError | null>(null)

  const sendMessage = async (content: string) => {
    setIsLoading(true)
    setError(null)
    // ... implementation
  }

  const reset = () => {
    setMessages([])
    setError(null)
  }

  return { messages, isLoading, error, sendMessage, reset }
}
```

### Environment Variables

```bash
# ✅ 统一命名规范
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
AI_MODEL_DEFAULT=gpt-4o
AI_MAX_TOKENS=4096

# ❌ 不一致的命名
OPEN_AI_KEY=...  # 下划线位置不对
GPT_API_KEY=...  # 品牌名 vs 通用名混用
```

---

## 2. Web3 Code Consistency

### SDK Selection (选定一个主力)

```typescript
// ✅ 项目选择: wagmi + viem
import { useAccount, useConnect, useWriteContract } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'

// ❌ 不要混用
import { ethers } from 'ethers'  // ethers.js
```

```typescript
// ✅ 项目选择: ethers.js
import { ethers, parseEther, formatEther } from 'ethers'

// ❌ 不要混用
import { useAccount } from 'wagmi'  // wagmi
```

### Web3 Type Definitions

```typescript
// types/web3.ts - 统一 Web3 类型
import type { Address, Hash } from 'viem'

export interface WalletState {
  status: 'disconnected' | 'connecting' | 'connected'
  address?: Address
  chainId?: number
}

export interface TransactionState {
  status: 'idle' | 'pending' | 'confirmed' | 'failed'
  hash?: Hash
  error?: Error
}

// 链配置
export interface ChainConfig {
  id: number
  name: string
  rpcUrl: string
  explorerUrl: string
  nativeCurrency: {
    name: string
    symbol: string
    decimals: number
  }
}
```

### BigInt Handling (统一规范)

```typescript
// ✅ 统一使用 viem 工具
import { parseUnits, formatUnits } from 'viem'

// 输入：字符串 → BigInt
const amount = parseUnits('1.5', 18)

// 输出：BigInt → 字符串
const display = formatUnits(balance, 18)

// ❌ 禁止
Number(balance)  // 精度丢失
balance.toString()  // 不含小数处理
balance / BigInt(10 ** 18)  // 手动计算
```

### Address Display

```typescript
// ✅ 统一截断函数
// lib/utils/address.ts
export function truncateAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
}

// 使用
<span className="font-mono">{truncateAddress(address)}</span>
```

### Contract Interaction Pattern

```typescript
// ✅ wagmi 模式
function useTokenTransfer() {
  const { writeContract, isPending } = useWriteContract()
  
  const transfer = (to: Address, amount: bigint) => {
    writeContract({
      address: TOKEN_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to, amount],
    })
  }
  
  return { transfer, isPending }
}

// ✅ ethers 模式
async function transferToken(to: string, amount: bigint) {
  const contract = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer)
  const tx = await contract.transfer(to, amount)
  return tx.wait()
}
```

---

## 3. General Code Hygiene

### Cleanup Rules

| 类型 | 示例 | 处理 |
|------|------|------|
| Console 语句 | `console.log(...)` | 删除或用 logger |
| 未使用 import | `import { unused }` | 删除 |
| 注释代码 | `// old code` | 删除 |
| Debugger | `debugger` | 删除 |
| 硬编码密钥 | `sk-xxx` | → 环境变量 |
| 硬编码地址 | `0x1234...` | → 常量/配置 |

### Hardcoding Removal

```typescript
// ❌ 硬编码
const OPENAI_KEY = 'sk-...'
const CONTRACT = '0x1234...'
const RPC_URL = 'https://mainnet.infura.io/...'

// ✅ 环境变量
const OPENAI_KEY = process.env.OPENAI_API_KEY!
const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as Address
const RPC_URL = process.env.ETH_RPC_URL!
```

### Type Safety

```typescript
// ❌ 禁止
const data: any = response
const address = wallet.address as any

// ✅ 正确
const data: AIResponse = response
const address: Address = wallet.address

// ⚠️ 允许 any 的唯一情况（需注释）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const externalData: any = thirdPartyLib.getData()  // 库无类型
```

---

## 4. Naming Conventions

### AI 相关命名

```typescript
// Hooks
useChat, useCompletion, useAI

// 函数
generateText, streamText, sendMessage

// 类型
Message, AIConfig, TokenUsage, AIError

// 文件
hooks/useChat.ts
lib/ai/client.ts
types/ai.ts
```

### Web3 相关命名

```typescript
// Hooks
useWallet, useBalance, useContractRead, useContractWrite

// 函数
connectWallet, signMessage, sendTransaction

// 类型
WalletState, TransactionState, ChainConfig

// 文件
hooks/useWallet.ts
lib/web3/client.ts
types/web3.ts
config/chains.ts
```

### 目录结构

```
src/
├── hooks/
│   ├── useChat.ts          # AI hooks
│   ├── useWallet.ts        # Web3 hooks
│   └── useQuery.ts         # Data hooks
├── lib/
│   ├── ai/
│   │   ├── client.ts       # AI client setup
│   │   └── prompts.ts      # Prompt templates
│   ├── web3/
│   │   ├── client.ts       # Web3 client setup
│   │   └── contracts.ts    # Contract instances
│   └── utils/
│       ├── format.ts       # Formatting utils
│       └── address.ts      # Address utils
├── types/
│   ├── ai.ts
│   ├── web3.ts
│   └── index.ts
└── config/
    ├── ai.ts               # AI model configs
    ├── chains.ts           # Chain configs
    └── contracts.ts        # Contract addresses
```

---

## 5. Tech Debt Comments

```tsx
/**
 * ⚠️ TECH DEBT
 * Issue: [问题描述]
 * Impact: [影响范围]
 * Solution: [建议方案]
 * Priority: High | Medium | Low
 */
```

### AI 常见技术债务

| Issue | Impact | Priority |
|-------|--------|----------|
| 无 token 限制检查 | 可能超限报错 | High |
| 无 rate limit 处理 | 用户体验差 | Medium |
| prompt 硬编码 | 难以维护 | Medium |
| 无成本追踪 | 成本失控 | Low |

### Web3 常见技术债务

| Issue | Impact | Priority |
|-------|--------|----------|
| 无 gas 估算 | 交易可能失败 | High |
| 未处理链切换 | 用户困惑 | High |
| BigInt 用 Number | 大额精度丢失 | High |
| 地址未校验 | 资金损失风险 | High |

---

## 6. Output Format

### 重构输出模板

```tsx
// ============================================
// REFACTORED: [文件名]
// Changes:
// - [变更1]
// - [变更2]
// Tech Stack Alignment:
// - AI: Vercel AI SDK
// - Web3: wagmi + viem
// ============================================

// ... 重构后的完整代码 ...
```

---

## Quick Reference

### 必删清单

```
✗ console.log / debugger
✗ 未使用的 import
✗ 注释掉的代码
✗ 硬编码的 API keys
✗ 硬编码的合约地址
✗ 硬编码的 RPC URLs
```

### 必改清单

```
✗ any → 具体类型
✗ 混用 SDK → 统一 SDK
✗ 散落的 prompt → 集中管理
✗ Number(bigint) → formatUnits
✗ 手写地址截断 → truncateAddress()
```

### 扫描位置

```
1. package.json → 确认用了哪些 SDK
2. .env.example → 确认环境变量命名
3. types/ → 确认类型定义
4. hooks/ → 确认 hook 模式
5. lib/ → 确认工具函数
```
