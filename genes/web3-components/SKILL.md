---
name: web3-components
description: Web3 界面专项组件库，包含钱包连接、网络切换、交易状态、Gas 估算等。专为 DApp 应用设计。当用户提到"钱包""连接钱包""交易""Web3 界面""DApp""区块链"时使用。
---

# Web3 Components (Web3 界面组件库)

**定位**: Web3 DApp 应用的专项 UI 组件。

**核心目标**: 打造专业、安全的 Web3 交互体验。

**设计规范**: 遵循 [design-tokens](../design-tokens/SKILL.md) 和 [ux-patterns](../ux-patterns/SKILL.md)。

---

## Connect Wallet Button (连接钱包)

```tsx
function ConnectButton({ state, onConnect, onDisconnect }: Props) {
  if (state.status === 'disconnected') {
    return (
      <button 
        onClick={onConnect}
        className="px-4 py-2.5 rounded-xl font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
      >
        连接钱包
      </button>
    )
  }

  if (state.status === 'connecting') {
    return (
      <button disabled className="px-4 py-2.5 rounded-xl bg-gray-100 text-gray-500">
        <Spinner className="w-4 h-4 mr-2 inline animate-spin" />
        连接中...
      </button>
    )
  }

  if (state.status === 'connected') {
    return (
      <button 
        onClick={onDisconnect}
        className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 transition-colors flex items-center gap-2"
      >
        <div className="w-2 h-2 bg-success rounded-full" />
        <span className="font-mono text-sm">{truncateAddress(state.address)}</span>
      </button>
    )
  }
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
```

---

## Network Badge (网络标识)

```tsx
const NETWORK_COLORS: Record<number, string> = {
  1: 'bg-blue-500',      // Ethereum
  137: 'bg-purple-500',  // Polygon
  42161: 'bg-sky-500',   // Arbitrum
  10: 'bg-red-500',      // Optimism
  56: 'bg-yellow-500',   // BSC
  43114: 'bg-red-600',   // Avalanche
}

function NetworkBadge({ chainId, name }: Props) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-gray-100 text-xs">
      <div className={cn("w-2 h-2 rounded-full", NETWORK_COLORS[chainId] || 'bg-gray-400')} />
      <span>{name}</span>
    </div>
  )
}
```

---

## Wrong Network Alert (网络错误提示)

```tsx
function WrongNetworkAlert({ expected, onSwitch }: Props) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
      <div className="flex items-start gap-3">
        <AlertIcon className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
        <div>
          <h4 className="font-medium text-warning">网络不匹配</h4>
          <p className="text-sm text-warning/80 mt-1">请切换到 {expected} 网络</p>
          <button 
            onClick={onSwitch}
            className="mt-3 px-3 py-1.5 rounded-lg bg-warning text-white text-sm hover:bg-warning/90 transition-colors"
          >
            切换网络
          </button>
        </div>
      </div>
    </div>
  )
}
```

---

## Transaction Status (交易状态)

```tsx
function TransactionStatus({ status, hash }: Props) {
  const explorerUrl = `https://etherscan.io/tx/${hash}`
  
  return (
    <div className="rounded-xl border border-gray-100 p-4 space-y-3">
      <div className="flex items-center gap-2">
        {status === 'pending' && (
          <>
            <Spinner className="w-4 h-4 animate-spin text-primary-500" />
            <span className="text-primary-500 font-medium">交易处理中...</span>
          </>
        )}
        {status === 'confirmed' && (
          <>
            <CheckIcon className="w-4 h-4 text-success" />
            <span className="text-success font-medium">交易已确认</span>
          </>
        )}
        {status === 'failed' && (
          <>
            <XIcon className="w-4 h-4 text-error" />
            <span className="text-error font-medium">交易失败</span>
          </>
        )}
      </div>
      
      {hash && (
        <a 
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
        >
          <span className="font-mono">{truncateAddress(hash)}</span>
          <ExternalLinkIcon className="w-3 h-3" />
        </a>
      )}
    </div>
  )
}
```

---

## Gas Estimation (Gas 估算)

```tsx
function GasEstimate({ gasLimit, gasPrice, ethPrice }: Props) {
  const gasCostWei = gasLimit * gasPrice
  const gasCostEth = formatUnits(gasCostWei, 18)
  const gasCostUsd = (parseFloat(gasCostEth) * ethPrice).toFixed(2)
  
  return (
    <div className="flex items-center justify-between text-sm text-gray-500">
      <span>预估 Gas 费</span>
      <span>
        ~{parseFloat(gasCostEth).toFixed(6)} ETH 
        <span className="text-gray-400 ml-1">(${gasCostUsd})</span>
      </span>
    </div>
  )
}
```

---

## Balance Display (余额展示)

```tsx
function BalanceDisplay({ balance, symbol, decimals = 18 }: Props) {
  const formatted = formatUnits(balance, decimals)
  const display = parseFloat(formatted).toFixed(4)
  
  return (
    <div className="flex items-center gap-2">
      <span className="text-lg font-bold text-gray-900 tabular-nums">{display}</span>
      <span className="text-sm text-gray-500">{symbol}</span>
    </div>
  )
}
```

---

## Token Selector (代币选择器)

```tsx
function TokenSelector({ tokens, selected, onSelect }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  
  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors"
      >
        <img src={selected.icon} alt={selected.symbol} className="w-6 h-6 rounded-full" />
        <span className="font-medium">{selected.symbol}</span>
        <ChevronDownIcon className={cn("w-4 h-4 transition-transform", isOpen && "rotate-180")} />
      </button>
      
      {isOpen && (
        <div className="absolute top-full mt-2 w-48 bg-white border border-gray-100 rounded-xl shadow-lg overflow-hidden z-50">
          {tokens.map((token) => (
            <button
              key={token.address}
              onClick={() => { onSelect(token); setIsOpen(false) }}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors",
                selected.address === token.address && "bg-primary-50"
              )}
            >
              <img src={token.icon} alt={token.symbol} className="w-6 h-6 rounded-full" />
              <div className="flex-1 text-left">
                <p className="font-medium text-gray-900">{token.symbol}</p>
                <p className="text-xs text-gray-500">{token.name}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

---

## Signature Request Modal (签名请求)

```tsx
function SignatureModal({ message, onSign, onCancel }: Props) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <PenIcon className="w-5 h-5 text-primary-500" />
            签名请求
          </h2>
        </div>
        
        <div className="px-6 py-4">
          <p className="text-sm text-gray-500 mb-3">应用请求您签名以下消息：</p>
          <div className="bg-gray-50 rounded-xl p-4">
            <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all font-mono">
              {message}
            </pre>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            签名不会花费 Gas 费用
          </p>
        </div>
        
        <div className="px-6 py-4 bg-gray-50 flex gap-3">
          <button 
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 text-sm font-medium"
          >
            取消
          </button>
          <button 
            onClick={onSign}
            className="flex-1 px-4 py-2.5 bg-primary-500 text-white rounded-xl hover:bg-primary-600 text-sm font-medium"
          >
            签名
          </button>
        </div>
      </div>
    </div>
  )
}
```

---

## Transaction Confirmation (交易确认)

```tsx
function TransactionConfirmation({ tx, onConfirm, onCancel }: Props) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">确认交易</h2>
        </div>
        
        <div className="px-6 py-4 space-y-4">
          {/* 交易详情 */}
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">发送至</span>
              <span className="font-mono text-gray-900">{truncateAddress(tx.to)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">金额</span>
              <span className="font-medium text-gray-900">{tx.value} {tx.symbol}</span>
            </div>
          </div>
          
          {/* Gas 估算 */}
          <div className="pt-3 border-t border-gray-100">
            <GasEstimate 
              gasLimit={tx.gasLimit} 
              gasPrice={tx.gasPrice} 
              ethPrice={tx.ethPrice} 
            />
          </div>
        </div>
        
        <div className="px-6 py-4 bg-gray-50 flex gap-3">
          <button 
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 text-sm font-medium"
          >
            取消
          </button>
          <button 
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 bg-primary-500 text-white rounded-xl hover:bg-primary-600 text-sm font-medium"
          >
            确认发送
          </button>
        </div>
      </div>
    </div>
  )
}
```

---

## Web3 场景文案规范

| 场景 | 文案 |
|------|------|
| 未连接 | "连接钱包" |
| 连接中 | "连接中..." |
| 签名请求 | "请在钱包中确认" |
| 交易发送 | "交易已提交" |
| 交易确认 | "交易已确认" |
| 交易失败 | "交易失败" |
| 余额不足 | "余额不足" |
| 网络错误 | "请切换到 [网络名] 网络" |
| Gas 过低 | "Gas 费用过低，交易可能失败" |
| 授权 | "授权 [代币名]" |

---

## 推荐库

| 用途 | 推荐库 |
|------|--------|
| 钱包连接 | `wagmi` + `viem` |
| UI 套件 | `connectkit` / `rainbowkit` |
| 动画 | `framer-motion` |
| Toast | `sonner` |
| 数字格式化 | `ethers` formatUnits |

---

## 必加 Classes

```tsx
"font-mono"        // 地址、哈希
"tabular-nums"     // 数字对齐
"truncate"         // 长文本截断
"transition-all duration-200"  // 所有交互
```

---

## 相关技能

- **design-tokens**: 设计令牌规范
- **ux-patterns**: 交互模式和文案规范
- **ai-components**: AI 专项组件
- **uiux-designer**: 统一调度入口
