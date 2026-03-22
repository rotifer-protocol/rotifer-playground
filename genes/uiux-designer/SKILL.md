---
name: uiux-designer
description: 统一 UI/UX 设计入口，通过风格维度参数调度设计令牌、组件、UX模式等子技能。支持预设快捷入口、参数微调、完全自定义、从输入推导。当用户提到"UI 设计""UX 设计""界面设计""组件设计""设计系统"时使用。
---

# UIUX Designer (参数化设计调度中心)

**定位**: UI/UX 设计的统一调度中心，通过风格参数驱动所有子技能。

**核心价值**: 从"5选1"到"无限可能"，让每个品牌都有独特灵魂。

**设计哲学**: 参数化驱动，而非硬编码预设。

---

## 参数化架构

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  uiux-designer (调度中心)                            │
│                                                      │
│  1. 收集/推导风格参数                                 │
│     - 预设快捷入口                                   │
│     - 关键词映射                                     │
│     - 参考网站分析                                   │
│     - 完全自定义                                     │
│                                                      │
│  2. 生成 StyleParams                                 │
│     {                                                │
│       colorTemperature: 65,                          │
│       borderRadius: 55,                              │
│       motionIntensity: 50,                           │
│       density: 60,                                   │
│       emotionalTone: 70,                             │
│       contrast: 45,                                  │
│       colors: { primary: "#E07A5F" }                 │
│     }                                                │
│                                                      │
│  3. 分发参数到子技能                                 │
└─────────────────────────────────────────────────────┘
           │
           ├──────────────────┬──────────────────┐
           ▼                  ▼                  ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │ design-     │    │ ui-         │    │ ux-         │
    │ tokens      │    │ components  │    │ patterns    │
    │             │    │             │    │             │
    │ 生成CSS变量  │    │ 生成组件样式 │    │ 生成文案动效 │
    └─────────────┘    └─────────────┘    └─────────────┘
```

---

## 风格参数收集流程

### 方式一：预设快捷入口

用户可选择预设作为起点：

```
用户: "用温暖风格"

系统加载预设参数:
{
  colorTemperature: 75,
  borderRadius: 70,
  motionIntensity: 55,
  density: 65,
  emotionalTone: 75,
  contrast: 45,
  colors: { primary: "#E07A5F" }
}
```

**5种预设**：
- `minimal` - 极简：冷色、小圆角、快动效、克制文案
- `warm` - 温暖：暖色、大圆角、柔和动效、亲切文案
- `playful` - 活泼：多彩、超大圆角、弹性动效、热情文案
- `professional` - 专业：深蓝灰、小圆角、稳重动效、正式文案
- `bold` - 大胆：高对比、混合圆角、夸张动效、简短有力文案

### 方式二：预设 + 微调

```
用户: "温暖风格，但圆角小一点，动效快一点"

系统:
1. 加载 warm 预设
2. 覆盖指定参数:
   - borderRadius: 70 → 50
   - motionIntensity: 55 → 35
3. 输出调整后的设计
```

### 方式三：关键词推导

```
用户: "现代、专业、有点温度的感觉"

系统:
1. 识别关键词: 现代、专业、温度
2. 基于 professional 预设
3. 叠加"温度"偏移:
   - colorTemperature: +15
   - emotionalTone: +15
4. 生成最终参数
```

### 方式四：完全自定义

```
用户: "主色#2563EB，圆角50，动效强度60，文案友好(70)"

系统直接构建参数:
{
  colorTemperature: 50,  // 默认
  borderRadius: 50,
  motionIntensity: 60,
  density: 50,           // 默认
  emotionalTone: 70,
  contrast: 50,          // 默认
  colors: { primary: "#2563EB" }
}
```

### 方式五：从参考推导

```
用户: "参考 Linear.app 的风格"

系统分析:
- 背景色: 偏冷 → colorTemperature: 25
- 圆角: 中小 → borderRadius: 35
- 动效: 快速流畅 → motionIntensity: 35
- 留白: 适中 → density: 50
- 文案: 简洁 → emotionalTone: 30
- 对比: 清晰 → contrast: 55
```

---

## 参数询问模板

当用户请求需要确定风格参数时：

```markdown
开始设计前，我需要了解一下品牌定位。你可以：

**快速开始**（选择预设）:
- 极简 (minimal) - 适合开发工具、笔记应用
- 温暖 (warm) - 适合教育、健康、社区产品
- 活泼 (playful) - 适合社交、游戏、年轻品牌
- 专业 (professional) - 适合企业SaaS、金融、B2B
- 大胆 (bold) - 适合潮牌、NFT、时尚

**精细调整**（在预设基础上调整）:
- "温暖风格，圆角小一点"
- "专业风格，但动效活泼一些"

**完全自定义**（指定具体参数）:
- "主色#2563EB，圆角60，动效50，文案友好"

**从参考推导**:
- "参考 Linear.app 的风格"
- "类似 Notion，但更温暖"
```

---

## 子技能调度

### 参数分发

```typescript
interface StyleParams {
  colorTemperature: number;
  borderRadius: number;
  motionIntensity: number;
  density: number;
  emotionalTone: number;
  contrast: number;
  colors?: { primary: string; secondary?: string };
}

// 调度到各子技能
function dispatch(params: StyleParams, task: string) {
  switch (task) {
    case 'tokens':
      // design-tokens 使用全部参数生成 CSS 变量
      return generateDesignTokens(params);
      
    case 'components':
      // ui-components 主要使用 borderRadius, motionIntensity, contrast
      return generateComponentStyles(params);
      
    case 'copy':
      // ux-patterns 主要使用 emotionalTone
      return getCopyStyle(params.emotionalTone);
      
    case 'motion':
      // ux-patterns 主要使用 motionIntensity
      return getMotionParams(params.motionIntensity);
  }
}
```

### 任务调度表

| 任务类型 | 调度流程 | 使用的参数 |
|---------|---------|-----------|
| 新项目 UI 搭建 | 收集参数 → design-tokens → ui-components → ux-patterns | 全部 |
| 单个组件 | 收集参数 → ui-components | borderRadius, motionIntensity, contrast, colors |
| 文案设计 | 收集参数 → ux-patterns | emotionalTone |
| 动效设计 | 收集参数 → ux-patterns | motionIntensity |
| 配色方案 | 收集参数 → design-tokens | colorTemperature, contrast, colors |
| AI 聊天应用 | 收集参数 → design-tokens → ai-components | 全部 |
| Web3 DApp | 收集参数 → design-tokens → web3-components | 全部 |

---

## 输出格式

### 参数确认输出

```markdown
**风格参数已确定**:

| 维度 | 值 | 说明 |
|------|-----|------|
| 色彩温度 | 65 | 偏暖 |
| 圆角程度 | 55 | 中等圆润 |
| 动效强度 | 50 | 标准 |
| 信息密度 | 60 | 略宽松 |
| 情感浓度 | 70 | 友好亲切 |
| 视觉对比 | 45 | 柔和 |
| 主色 | #E07A5F | 珊瑚橙 |

**效果预览**:
- 按钮: 中等圆角(18px)，柔和阴影，轻微悬停缩放
- 文案: "保存成功！" / "哎呀，出了点问题"
- 动效: 310ms，轻微弹性缓动

接下来我将使用这些参数为你设计...
```

### 组件输出

```markdown
**按钮组件**（基于当前参数）:

```html
<button class="px-5 py-2.5 bg-[#E07A5F] text-white text-sm font-medium
               rounded-[18px] shadow-md
               transition-all duration-[310ms]
               hover:shadow-lg hover:scale-[1.02] active:scale-95">
  开始使用
</button>
```

参数说明:
- `rounded-[18px]` ← borderRadius: 55
- `duration-[310ms]` ← motionIntensity: 50
- `shadow-md` ← contrast: 45
- `hover:scale-[1.02]` ← motionIntensity > 40
```

---

## 快速命令

```bash
# 使用预设
"用温暖风格设计登录页面"
"极简风格的后台管理系统"

# 预设 + 调整
"温暖风格，圆角小一点"
"专业风格，动效活泼一些"

# 完全自定义
"主色#2563EB，圆角60，动效50，文案友好"

# 从参考推导
"参考 Linear.app 的风格"
"类似 Notion，但更温暖"

# 指定子技能
"用 brand-personality 生成风格参数"
"用 design-tokens 生成CSS变量"
"用 ui-components 做一个按钮"
```

---

## 子技能详解

### brand-personality (风格参数生成)

**用途**: 收集/推导风格维度参数，是设计决策的第一步。

**输出**: 6个维度参数 + 品牌色

**触发**: "确定风格"、"品牌定位"、"参考XX风格"

### design-tokens (CSS变量生成)

**用途**: 根据风格参数生成CSS变量（圆角、动效、间距、颜色）。

**输入**: StyleParams

**输出**: CSS :root 变量定义

### ui-components (组件样式生成)

**用途**: 根据风格参数生成组件样式。

**输入**: StyleParams

**输出**: 组件HTML/CSS/React代码

### ux-patterns (文案/动效生成)

**用途**: 根据 emotionalTone 和 motionIntensity 生成文案和动效。

**输入**: emotionalTone, motionIntensity

**输出**: 文案库、动效参数、惊喜级别

---

## 参考资源

- **brand-personality**: [SKILL.md](../brand-personality/SKILL.md) - 参数化风格系统
- **design-tokens**: [SKILL.md](../design-tokens/SKILL.md) - 参数到CSS变量映射
- **ui-components**: [SKILL.md](../ui-components/SKILL.md) - 参数化组件生成
- **ux-patterns**: [SKILL.md](../ux-patterns/SKILL.md) - 参数化文案和动效
- **ai-components**: [SKILL.md](../ai-components/SKILL.md) - AI专项组件
- **web3-components**: [SKILL.md](../web3-components/SKILL.md) - Web3专项组件

---

## 参数化优势总结

| 对比 | 旧方案(5选1) | 新方案(参数化) |
|-----|-------------|---------------|
| 灵活度 | 5种选择 | 无限组合 |
| 定制能力 | 只能选，不能改 | 预设 + 微调 + 完全自定义 |
| 品牌匹配 | 凑合用 | 精确匹配 |
| 扩展性 | 加预设 = 改代码 | 调参数 = 配置 |
| 表达力 | "温暖风格" | colorTemperature:75, emotionalTone:75... |
