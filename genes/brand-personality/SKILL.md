---
name: brand-personality
description: 参数化品牌风格系统，通过6个风格维度（色彩温度/圆角/动效/密度/情感/对比度）生成无限种风格组合。支持预设快捷入口、参数微调、完全自定义、从品牌输入推导。消除"AI味"的核心技能。
---

# Brand Personality (参数化品牌风格系统)

**定位**: 设计决策的第一层，通过风格参数生成品牌专属设计语言。

**核心价值**: 从"5选1"到"无限可能"，让每个品牌都有独特灵魂。

---

## 设计哲学

> **"风格不是选择题，是调色板。"**

### 参数化原则

| 原则 | 说明 |
|------|------|
| 维度独立 | 每个维度可独立调整，不互相依赖 |
| 连续可调 | 0-100连续值，而非离散分类 |
| 预设为起点 | 预设是快捷入口，不是终点 |
| 输入驱动 | 从品牌资产推导风格，而非凭空选择 |

---

## 风格维度体系

### 6个核心维度

```
色彩温度 colorTemperature
冷 [0] ●━━━━━━━━━━━━━━━━━━━━○ [100] 暖
     冰蓝/灰     ←→     珊瑚/暖黄

圆角程度 borderRadius  
锐利 [0] ○━━━━━━━━━━━━━━━━━━━━● [100] 圆润
     0-4px       ←→     24px-full

动效强度 motionIntensity
克制 [0] ○━━━━━━━━━━━━━━━━━━━━● [100] 夸张
     80ms/linear ←→     500ms/spring

信息密度 density
紧凑 [0] ○━━━━━━━━━━━━━━━━━━━━● [100] 宽松
     小间距/高密度 ←→   大留白/低密度

情感浓度 emotionalTone
中性 [0] ○━━━━━━━━━━━━━━━━━━━━● [100] 热情
     "保存成功"  ←→    "太棒了！🎉"

视觉对比 contrast
柔和 [0] ○━━━━━━━━━━━━━━━━━━━━● [100] 强烈
     低饱和/微差异 ←→   高饱和/强反差
```

### 维度详解

#### 1. colorTemperature (色彩温度)

| 值 | 特征 | 适用场景 |
|---|------|---------|
| 0-20 | 冷色调：蓝灰、银白、冰蓝 | 科技、金融、极简工具 |
| 30-50 | 中性：纯灰、平衡色 | 专业SaaS、企业应用 |
| 60-80 | 暖色调：米白、暖灰、奶油 | 社交、教育、生活服务 |
| 80-100 | 热暖：珊瑚、橙黄、暖粉 | 儿童、餐饮、温馨品牌 |

#### 2. borderRadius (圆角程度)

| 值 | CSS值 | 视觉感受 |
|---|-------|---------|
| 0-20 | 0-4px | 锐利、专业、严肃 |
| 30-50 | 6-12px | 现代、平衡、友好 |
| 60-80 | 16-24px | 圆润、温暖、亲切 |
| 80-100 | 28px-full | 软糯、可爱、活泼 |

#### 3. motionIntensity (动效强度)

| 值 | 时长 | 缓动 | 风格 |
|---|------|------|------|
| 0-20 | 80-120ms | linear | 瞬间响应、极简 |
| 30-50 | 150-250ms | ease-out | 标准、稳重 |
| 60-80 | 300-400ms | spring轻弹 | 柔和、温暖 |
| 80-100 | 450-600ms | spring强弹 | 夸张、活泼 |

#### 4. density (信息密度)

| 值 | 间距倍数 | 特征 |
|---|---------|------|
| 0-30 | 0.75x | 紧凑、高效、信息密集 |
| 40-60 | 1x | 标准、平衡 |
| 70-100 | 1.25-1.5x | 宽松、留白多、呼吸感 |

#### 5. emotionalTone (情感浓度)

| 值 | 文案风格 | 示例 |
|---|---------|------|
| 0-20 | 极简中性 | "Saved" / "Error" |
| 30-50 | 清晰友好 | "已保存" / "操作失败" |
| 60-80 | 亲切鼓励 | "保存成功！" / "出了点问题，再试试？" |
| 80-100 | 热情活泼 | "太棒了，搞定！🎉" / "哎呀，出错了 😅" |

#### 6. contrast (视觉对比)

| 值 | 特征 | 表现 |
|---|------|------|
| 0-30 | 柔和 | 低饱和、微妙灰度、轻阴影 |
| 40-60 | 适中 | 标准饱和、清晰边界 |
| 70-100 | 强烈 | 高饱和、撞色、强阴影/发光 |

---

## 风格配置结构

### BrandStyle 数据结构

```typescript
interface BrandStyle {
  // 品牌名称（可选）
  name?: string;
  
  // 6个风格维度（0-100）
  dimensions: {
    colorTemperature: number;  // 色彩温度
    borderRadius: number;      // 圆角程度
    motionIntensity: number;   // 动效强度
    density: number;           // 信息密度
    emotionalTone: number;     // 情感浓度
    contrast: number;          // 视觉对比
  };
  
  // 品牌色（可选，从Logo提取或自定义）
  colors?: {
    primary: string;           // 主色
    secondary?: string;        // 辅助色
    accent?: string;           // 强调色
  };
  
  // 继承预设（可选）
  extends?: 'minimal' | 'warm' | 'playful' | 'professional' | 'bold';
}
```

### 配置示例

```typescript
// 完全自定义
const myBrand: BrandStyle = {
  name: "MyApp",
  dimensions: {
    colorTemperature: 65,
    borderRadius: 55,
    motionIntensity: 45,
    density: 60,
    emotionalTone: 70,
    contrast: 50
  },
  colors: {
    primary: "#2563EB",
    secondary: "#10B981"
  }
}

// 基于预设调整
const myBrand2: BrandStyle = {
  extends: "warm",
  dimensions: {
    borderRadius: 40,      // 覆盖：圆角小一点
    motionIntensity: 30    // 覆盖：动效快一点
    // 其他维度继承 warm 预设
  }
}
```

---

## 预设快捷入口

> 预设是常用风格组合的快捷方式，可直接使用或作为调整基础

### 5种预设参数

```typescript
const PRESETS = {
  minimal: {
    dimensions: {
      colorTemperature: 20,
      borderRadius: 15,
      motionIntensity: 15,
      density: 35,
      emotionalTone: 15,
      contrast: 40
    },
    colors: { primary: "#000000" }
  },
  
  warm: {
    dimensions: {
      colorTemperature: 75,
      borderRadius: 70,
      motionIntensity: 55,
      density: 65,
      emotionalTone: 75,
      contrast: 45
    },
    colors: { primary: "#E07A5F" }
  },
  
  playful: {
    dimensions: {
      colorTemperature: 60,
      borderRadius: 85,
      motionIntensity: 80,
      density: 55,
      emotionalTone: 90,
      contrast: 70
    },
    colors: { primary: "#FF6B6B" }
  },
  
  professional: {
    dimensions: {
      colorTemperature: 35,
      borderRadius: 25,
      motionIntensity: 35,
      density: 45,
      emotionalTone: 30,
      contrast: 55
    },
    colors: { primary: "#1E3A5F" }
  },
  
  bold: {
    dimensions: {
      colorTemperature: 50,
      borderRadius: 50,  // 混合：锐利+药丸
      motionIntensity: 90,
      density: 50,
      emotionalTone: 40,
      contrast: 95
    },
    colors: { primary: "#FF00FF" }
  }
}
```

### 预设速查表

| 预设 | 温度 | 圆角 | 动效 | 密度 | 情感 | 对比 | 适用场景 |
|------|------|------|------|------|------|------|----------|
| minimal | 20 | 15 | 15 | 35 | 15 | 40 | 开发工具、笔记、极简SaaS |
| warm | 75 | 70 | 55 | 65 | 75 | 45 | 健康、教育、社区、生活服务 |
| playful | 60 | 85 | 80 | 55 | 90 | 70 | 社交、游戏、创意、年轻品牌 |
| professional | 35 | 25 | 35 | 45 | 30 | 55 | 企业SaaS、金融、法律、B2B |
| bold | 50 | 50 | 90 | 50 | 40 | 95 | 潮牌、NFT、音乐、时尚 |

---

## 从输入推导风格

### 方式一：关键词映射

用户提供描述词，映射到维度值：

```typescript
const KEYWORD_MAP = {
  // 色彩温度
  "冷静": { colorTemperature: -20 },
  "科技": { colorTemperature: -15 },
  "温暖": { colorTemperature: +20 },
  "亲切": { colorTemperature: +15 },
  
  // 圆角
  "锐利": { borderRadius: -25 },
  "专业": { borderRadius: -15 },
  "圆润": { borderRadius: +20 },
  "可爱": { borderRadius: +30 },
  
  // 动效
  "快速": { motionIntensity: -20 },
  "稳重": { motionIntensity: -10 },
  "活泼": { motionIntensity: +25 },
  "弹性": { motionIntensity: +20 },
  
  // 情感
  "克制": { emotionalTone: -25 },
  "中性": { emotionalTone: -15 },
  "友好": { emotionalTone: +15 },
  "热情": { emotionalTone: +25 },
  
  // 对比
  "柔和": { contrast: -20 },
  "清晰": { contrast: +10 },
  "大胆": { contrast: +25 },
  "霓虹": { contrast: +35 }
}

// 使用示例
// 输入："现代、亲切、圆润"
// 从 professional 预设开始，叠加关键词偏移
```

### 方式二：Logo色彩分析

从Logo提取品牌色并推导色彩温度：

```typescript
function analyzeLogoColor(primaryColor: string): Partial<BrandStyle> {
  const hsl = hexToHSL(primaryColor);
  
  // 根据色相推导温度
  // 0-60° (红-黄) = 暖
  // 180-240° (青-蓝) = 冷
  const hue = hsl.h;
  let colorTemperature = 50;
  
  if (hue >= 0 && hue <= 60) colorTemperature = 70 + (60 - hue) / 2;
  else if (hue >= 180 && hue <= 240) colorTemperature = 30 - (hue - 180) / 4;
  
  return {
    colors: { primary: primaryColor },
    dimensions: { colorTemperature }
  };
}
```

### 方式三：参考网站分析

从参考网站提取风格参数：

```
用户："参考 Linear.app 的风格"

分析结果：
- 背景色：偏冷灰 → colorTemperature: 25
- 圆角：小(8px) → borderRadius: 30
- 动效：快速流畅 → motionIntensity: 35
- 留白：适中 → density: 50
- 文案：简洁 → emotionalTone: 25
- 对比：清晰 → contrast: 55

生成参数：{ colorTemperature: 25, borderRadius: 30, motionIntensity: 35, ... }
```

### 方式四：自然语言描述

解析自然语言生成参数：

```
用户："我想要专业但不冷冰冰的感觉，圆角大一点，动效温柔一些"

解析：
- "专业" → 基于 professional 预设
- "不冷冰冰" → colorTemperature +15
- "圆角大一点" → borderRadius +20
- "动效温柔" → motionIntensity +15

最终参数：
{
  colorTemperature: 50,  // 35 + 15
  borderRadius: 45,      // 25 + 20
  motionIntensity: 50,   // 35 + 15
  density: 45,           // 继承
  emotionalTone: 30,     // 继承
  contrast: 55           // 继承
}
```

---

## 维度到设计令牌映射

### 圆角映射

```typescript
function mapBorderRadius(value: number): string {
  // 0-100 映射到 0-32px
  const px = Math.round(value * 0.32);
  return {
    sm: `${Math.max(px - 4, 0)}px`,
    md: `${px}px`,
    lg: `${px + 4}px`,
    xl: `${px + 8}px`,
    full: value > 85 ? '9999px' : `${px + 12}px`
  };
}

// borderRadius: 70 → { sm: '18px', md: '22px', lg: '26px', xl: '30px' }
```

### 动效映射

```typescript
function mapMotion(value: number): { duration: string; easing: string } {
  // 时长：80-500ms
  const duration = 80 + value * 4.2;
  
  // 缓动函数
  let easing: string;
  if (value < 30) easing = 'cubic-bezier(0.2, 0, 0, 1)';        // 快速
  else if (value < 60) easing = 'cubic-bezier(0.16, 1, 0.3, 1)'; // ease-out
  else if (value < 80) easing = 'cubic-bezier(0.34, 1.56, 0.64, 1)'; // 轻弹
  else easing = 'cubic-bezier(0.175, 0.885, 0.32, 1.275)';      // 强弹
  
  return { duration: `${Math.round(duration)}ms`, easing };
}

// motionIntensity: 55 → { duration: '311ms', easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
```

### 间距映射

```typescript
function mapDensity(value: number): number {
  // 返回间距倍数：0.7 - 1.4
  return 0.7 + value * 0.007;
}

// density: 65 → 1.155 (间距放大15.5%)
```

### 文案风格映射

```typescript
function mapEmotionalTone(value: number): 'minimal' | 'neutral' | 'friendly' | 'enthusiastic' {
  if (value < 25) return 'minimal';      // "Saved"
  if (value < 50) return 'neutral';      // "已保存"
  if (value < 75) return 'friendly';     // "保存成功！"
  return 'enthusiastic';                  // "太棒了！🎉"
}
```

### 完整CSS变量生成

```typescript
function generateCSSVariables(style: BrandStyle): string {
  const { dimensions, colors } = style;
  const radius = mapBorderRadius(dimensions.borderRadius);
  const motion = mapMotion(dimensions.motionIntensity);
  const spacingMultiplier = mapDensity(dimensions.density);
  
  return `
:root {
  /* 品牌色 */
  --color-primary: ${colors?.primary || '#6366F1'};
  --color-secondary: ${colors?.secondary || 'var(--color-primary)'};
  
  /* 圆角 */
  --radius-sm: ${radius.sm};
  --radius-md: ${radius.md};
  --radius-lg: ${radius.lg};
  --radius-xl: ${radius.xl};
  
  /* 动效 */
  --duration-fast: ${Math.round(parseInt(motion.duration) * 0.6)}ms;
  --duration-normal: ${motion.duration};
  --duration-slow: ${Math.round(parseInt(motion.duration) * 1.5)}ms;
  --easing: ${motion.easing};
  
  /* 间距倍数 */
  --spacing-multiplier: ${spacingMultiplier.toFixed(3)};
  
  /* 间距（基于8px网格，应用倍数）*/
  --space-1: calc(4px * var(--spacing-multiplier));
  --space-2: calc(8px * var(--spacing-multiplier));
  --space-3: calc(12px * var(--spacing-multiplier));
  --space-4: calc(16px * var(--spacing-multiplier));
  --space-6: calc(24px * var(--spacing-multiplier));
  --space-8: calc(32px * var(--spacing-multiplier));
}
  `;
}
```

---

## 使用流程

### 快速开始

```
用户: "用温暖风格"
系统: 加载 warm 预设，输出设计
```

### 预设 + 调整

```
用户: "温暖风格，但圆角小一点，动效快一点"
系统: 
  1. 加载 warm 预设 (borderRadius: 70, motionIntensity: 55)
  2. 应用调整：borderRadius: 50, motionIntensity: 35
  3. 输出调整后的设计
```

### 从描述生成

```
用户: "我想要现代、专业、有点温度的感觉"
系统:
  1. 识别关键词：现代、专业、温度
  2. 基于 professional 预设
  3. 叠加"温度"偏移：colorTemperature +20, emotionalTone +15
  4. 输出生成的设计
```

### 完全自定义

```
用户: "主色 #2563EB，圆角中等(50)，动效中等(50)，文案友好一点(65)"
系统:
  1. 解析参数
  2. 生成完整 BrandStyle
  3. 输出设计
```

---

## 情感化设计指导

### Delight Moments (惊喜时刻)

惊喜程度根据 emotionalTone 调整：

| emotionalTone | 惊喜方式 |
|---------------|---------|
| 0-30 | 无或极轻微（对勾动画） |
| 30-60 | 轻微（弹性动效、柔和高亮） |
| 60-80 | 明显（撒花、徽章、鼓励文案） |
| 80-100 | 热烈（烟花、emoji、庆祝动画） |

### 打破规则的时机

所有风格都可在特定场景打破规则：
- 落地页 Hero：可加大 contrast、motionIntensity
- 空状态/404：可提高 emotionalTone
- 庆祝时刻：临时提高所有"活力"参数
- 品牌展示区：可突破所有约束

---

## 相关技能

- **design-tokens**: 根据风格参数生成具体令牌
- **ui-components**: 根据参数生成组件样式
- **ux-patterns**: 根据 emotionalTone 和 motionIntensity 选择文案和动效
- **uiux-designer**: 统一调度入口
