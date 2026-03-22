---
name: ai-components
description: AI 界面专项组件库，包含 Streaming 文本、聊天气泡、思考指示器、推理展示、Token 用量等。专为 AI 对话应用设计。当用户提到"聊天""Streaming""AI 界面""对话""打字效果""思考中"时使用。
---

# AI Components (AI 界面组件库)

**定位**: AI 对话应用的专项 UI 组件。

**核心目标**: 打造流畅、专业的 AI 交互体验。

**设计规范**: 遵循 [design-tokens](../design-tokens/SKILL.md) 和 [ux-patterns](../ux-patterns/SKILL.md)。

---

## Streaming Text (打字机效果)

### 基础流式文本

```tsx
function StreamingText({ content }: { content: string }) {
  return (
    <p className="whitespace-pre-wrap">
      {content}
      <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
    </p>
  )
}
```

### 带 Markdown 渲染

```tsx
import ReactMarkdown from 'react-markdown'

function AIMessage({ content, isStreaming }: Props) {
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown>{content}</ReactMarkdown>
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse" />
      )}
    </div>
  )
}
```

---

## Chat Bubble Layout (聊天气泡)

```tsx
function ChatMessage({ role, content, isStreaming }: Message) {
  const isUser = role === 'user'
  
  return (
    <div className={cn("flex gap-3 p-4", isUser && "flex-row-reverse")}>
      {/* Avatar */}
      <div className={cn(
        "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
        isUser ? "bg-primary-500" : "bg-gray-100"
      )}>
        {isUser ? <UserIcon /> : <BotIcon />}
      </div>
      
      {/* Content */}
      <div className={cn(
        "max-w-[80%] rounded-2xl px-4 py-2",
        isUser 
          ? "bg-primary-500 text-white rounded-br-md" 
          : "bg-gray-100 text-gray-900 rounded-bl-md"
      )}>
        <AIMessage content={content} isStreaming={isStreaming} />
      </div>
    </div>
  )
}
```

---

## Thinking Indicator (思考指示器)

### 三点跳动

```tsx
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-gray-500 text-sm">
      <div className="flex gap-1">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
      </div>
      <span>思考中...</span>
    </div>
  )
}
```

### 旋转加载

```tsx
function ThinkingSpinner() {
  return (
    <div className="flex items-center gap-2 text-gray-500 text-sm">
      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
      <span>正在分析...</span>
    </div>
  )
}
```

---

## Reasoning Block (推理展示)

```tsx
function ReasoningBlock({ reasoning, isExpanded, onToggle }: Props) {
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button 
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
      >
        <span className="text-sm text-gray-600 flex items-center gap-2">
          <BrainIcon className="w-4 h-4" />
          推理过程
        </span>
        <ChevronIcon className={cn(
          "w-4 h-4 transition-transform duration-200",
          isExpanded && "rotate-180"
        )} />
      </button>
      
      <div className={cn(
        "overflow-hidden transition-all duration-300",
        isExpanded ? "max-h-96" : "max-h-0"
      )}>
        <pre className="p-3 text-xs text-gray-600 bg-gray-50 overflow-auto">
          {reasoning}
        </pre>
      </div>
    </div>
  )
}
```

---

## Token Usage Display (Token 用量)

```tsx
function TokenUsage({ usage }: { usage: { total: number; limit: number } }) {
  const percentage = (usage.total / usage.limit) * 100
  
  return (
    <div className="text-xs text-gray-500 space-y-1">
      <div className="flex justify-between">
        <span>Token 用量</span>
        <span>{usage.total.toLocaleString()} / {usage.limit.toLocaleString()}</span>
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div 
          className={cn(
            "h-full transition-all duration-300",
            percentage > 90 ? "bg-error" : 
            percentage > 70 ? "bg-warning" : "bg-success"
          )}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  )
}
```

---

## AI Error Card (错误提示)

### 错误消息配置

```tsx
const AI_ERROR_MESSAGES = {
  RATE_LIMITED: { 
    title: "请求过于频繁", 
    description: "请稍后再试", 
    action: "等待后重试" 
  },
  TOKEN_LIMIT: { 
    title: "对话过长", 
    description: "请开始新对话或清理历史记录", 
    action: "开始新对话" 
  },
  TIMEOUT: { 
    title: "响应超时", 
    description: "AI 正在思考复杂问题，请重试", 
    action: "重新发送" 
  },
  NETWORK: {
    title: "网络连接失败",
    description: "请检查网络后重试",
    action: "重试"
  }
}
```

### 错误卡片组件

```tsx
function AIErrorCard({ error, onRetry }: Props) {
  const msg = AI_ERROR_MESSAGES[error.code]
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 p-4">
      <h4 className="font-medium text-warning">{msg.title}</h4>
      <p className="text-sm text-warning/80 mt-1">{msg.description}</p>
      <button onClick={onRetry} className="mt-3 text-sm text-warning hover:underline">
        {msg.action}
      </button>
    </div>
  )
}
```

---

## Chat Input (聊天输入框)

```tsx
function ChatInput({ onSend, isLoading }: Props) {
  const [message, setMessage] = useState('')
  
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (message.trim() && !isLoading) {
      onSend(message)
      setMessage('')
    }
  }
  
  return (
    <form onSubmit={handleSubmit} className="relative">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="输入消息..."
        className="w-full px-4 py-3 pr-12 bg-gray-50 border border-gray-200 rounded-2xl
                   text-sm resize-none
                   focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500
                   transition-all duration-200"
        rows={1}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit(e)
          }
        }}
      />
      <button
        type="submit"
        disabled={!message.trim() || isLoading}
        className="absolute right-2 bottom-2 p-2 rounded-xl
                   bg-primary-500 text-white
                   hover:bg-primary-600
                   disabled:opacity-50 disabled:cursor-not-allowed
                   transition-all duration-200"
      >
        {isLoading ? (
          <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        )}
      </button>
    </form>
  )
}
```

---

## Stop Generation Button (停止生成)

```tsx
function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button
      onClick={onStop}
      className="px-4 py-2 flex items-center gap-2
                 bg-gray-100 text-gray-700 rounded-xl
                 hover:bg-gray-200 transition-colors"
    >
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
      <span className="text-sm font-medium">停止生成</span>
    </button>
  )
}
```

---

## AI 场景文案规范

| 场景 | 文案 |
|------|------|
| AI 思考中 | "思考中..." / "正在分析..." |
| 生成完成 | "回复已生成" |
| Token 超限 | "对话过长，请开始新对话" |
| Rate limit | "请求过于频繁，请稍后再试" |
| 停止生成 | "停止生成" |
| 重新生成 | "重新生成" |
| 复制回复 | "复制" / "已复制" |
| 点赞/踩 | "有帮助" / "没帮助" |

---

## 推荐库

| 用途 | 推荐库 |
|------|--------|
| Markdown 渲染 | `react-markdown` |
| AI SDK | `ai` (Vercel AI SDK) |
| 代码高亮 | `react-syntax-highlighter` |
| 动画 | `framer-motion` |
| Toast | `sonner` |

---

## 完整聊天界面示例

```tsx
function ChatInterface() {
  const { messages, isLoading, send, stop } = useChat()
  
  return (
    <div className="flex flex-col h-screen">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <ChatMessage 
            key={msg.id} 
            role={msg.role} 
            content={msg.content}
            isStreaming={msg.isStreaming}
          />
        ))}
        
        {isLoading && !messages[messages.length - 1]?.isStreaming && (
          <ThinkingIndicator />
        )}
      </div>
      
      {/* 输入区 */}
      <div className="p-4 border-t border-gray-100">
        {isLoading ? (
          <StopButton onStop={stop} />
        ) : (
          <ChatInput onSend={send} isLoading={isLoading} />
        )}
      </div>
    </div>
  )
}
```

---

## 相关技能

- **design-tokens**: 设计令牌规范
- **ux-patterns**: 交互模式和文案规范
- **web3-components**: Web3 专项组件
- **uiux-designer**: 统一调度入口
