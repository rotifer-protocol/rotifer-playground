---
name: translator
description: Translate and localize content between languages. Ensure cultural appropriateness and maintain original meaning. Use when translating documents, adapting content for different markets, or creating bilingual content.
---

# Translator (翻译师)

**Goal**: 在语言间准确翻译和本地化内容，保持原意并适应文化语境。

---

## 1. 翻译原则

### 信达雅原则

```markdown
## 信（Faithfulness）
准确传达原文意思，不增不减

## 达（Expressiveness）
通顺流畅，符合目标语言习惯

## 雅（Elegance）
文字优美，有文采（视场景）

## 优先级
技术文档：信 > 达 > 雅
文学作品：信 = 雅 > 达
营销文案：达 > 信 > 雅
```

### 翻译策略

| 策略 | 说明 | 适用 |
|------|------|------|
| 直译 | 保持原文结构 | 技术文档 |
| 意译 | 传达意思为主 | 营销文案 |
| 归化 | 适应目标文化 | 本地化 |
| 异化 | 保留源文化特色 | 文学翻译 |

---

## 2. 中英互译

### 中译英常见问题

```markdown
## 句式转换

中文重意合，英文重形合

❌ 直译：Because weather very cold, so I wear coat.
✅ 转换：I wore a coat because of the cold weather.

## 主语问题

中文可省略主语，英文通常不可

❌ 直译：Is very important.
✅ 补充：It is very important.

## 时态语态

中文时态隐含，英文需明确

❌ 忽略：I go to Beijing yesterday.
✅ 正确：I went to Beijing yesterday.

## 冠词使用

中文无冠词，英文需添加

❌ 遗漏：I saw movie last night.
✅ 正确：I saw a movie last night.
```

### 英译中常见问题

```markdown
## 长句拆分

英文长句需拆成中文短句

原文：
The conference, which was held in Beijing last month and 
attended by over 500 participants from 30 countries, 
focused on the latest developments in AI.

译文：
上月在北京召开了一场会议。来自30个国家的500多名
代表出席。会议聚焦人工智能的最新发展。

## 被动转主动

英文被动句多，中文主动句多

❌ 直译：这个问题被解决了。
✅ 转换：我们解决了这个问题。/ 问题得到解决。

## 专业术语

保留英文缩写，首次出现给出中文

示例：
人工智能（AI，Artificial Intelligence）
```

---

## 3. 专业领域

### 技术翻译

```markdown
## 原则

1. 术语一致
2. 准确无歧义
3. 简洁明了

## 术语表示例

| 英文 | 中文 | 备注 |
|------|------|------|
| API | 应用程序接口 | 可保留英文 |
| machine learning | 机器学习 | |
| deep learning | 深度学习 | |
| neural network | 神经网络 | |
| iteration | 迭代 | |
| refactor | 重构 | |

## 代码注释翻译

// This function calculates the sum
// 此函数计算总和
```

### 商务翻译

```markdown
## 常用表达

| 英文 | 中文 |
|------|------|
| Please find attached | 请查收附件 |
| At your earliest convenience | 请尽快 |
| Looking forward to your reply | 期待您的回复 |
| Best regards | 此致敬礼 |
| For your reference | 供您参考 |

## 正式程度

更正式：
We would like to inform you that...
我们谨此通知您...

一般：
Please note that...
请注意...
```

### 法律翻译

```markdown
## 原则

1. 严格准确
2. 保留法律效力
3. 专业术语统一

## 常用术语

| 英文 | 中文 |
|------|------|
| hereby | 特此 |
| whereas | 鉴于 |
| notwithstanding | 尽管 |
| pursuant to | 根据/依据 |
| indemnify | 赔偿/补偿 |
```

---

## 4. 本地化

### 文化适应

```markdown
## 需要本地化的元素

1. 日期格式
   美国：MM/DD/YYYY → 中国：YYYY年M月D日

2. 货币
   $99.99 → ¥699

3. 度量单位
   miles → 公里
   °F → °C

4. 姓名顺序
   John Smith → 约翰·史密斯

5. 文化引用
   解释或替换不熟悉的文化内容

## 敏感内容

- 政治敏感话题
- 宗教内容
- 文化禁忌
- 颜色象征
```

### 平台本地化

```markdown
## UI 文本

1. 考虑文本长度变化
   德语通常比英语长30%
   中文通常比英语短

2. 按钮文本简洁
   Submit → 提交
   Cancel → 取消

3. 避免文化特定图标
   邮箱图标 ✓
   特定手势 ✗

## 营销本地化

原文：
Get 50% off this Black Friday!

中国本地化：
双十一五折大促！

不是直译，而是用当地购物节
```

---

## 5. 翻译工具

### 机器翻译辅助

```markdown
## 工具

- DeepL
- Google Translate
- 百度翻译
- 有道翻译

## 使用建议

1. 作为参考，不直接使用
2. 始终人工校对
3. 注意术语一致性
4. 检查文化适当性

## 适合机器翻译的内容

✅ 简单句子
✅ 技术文档（配合术语库）
✅ 初稿生成

## 不适合的内容

❌ 文学作品
❌ 营销文案
❌ 法律文件
❌ 有文化隐喻的内容
```

### 翻译记忆

```markdown
## 工具

- SDL Trados
- MemoQ
- OmegaT（免费）

## 价值

1. 保持术语一致
2. 提高效率
3. 降低成本
4. 质量控制
```

---

## 6. 检查清单

```markdown
## Translation Checklist

### 准确性
- [ ] 意思准确传达
- [ ] 无遗漏内容
- [ ] 无增加内容
- [ ] 术语准确

### 流畅性
- [ ] 符合目标语言习惯
- [ ] 语法正确
- [ ] 表达自然
- [ ] 无翻译腔

### 一致性
- [ ] 术语统一
- [ ] 风格统一
- [ ] 格式统一

### 文化适当性
- [ ] 无文化冒犯
- [ ] 本地化到位
- [ ] 日期/货币/单位正确
```

---

## Quick Reference

### 常见翻译错误

| 错误 | 示例 | 修正 |
|------|------|------|
| 翻译腔 | 这是一个非常重要的事情 | 这件事很重要 |
| 词对词 | take a look → 拿一看 | take a look → 看一看 |
| 假朋友 | actual → 实际的（应为"真正的"） | |
| 过度直译 | break a leg → 打断一条腿 | break a leg → 祝你好运 |

### 翻译速查

```markdown
## 数字本地化

英文：1,234.56
中文：1,234.56（保持）

## 日期本地化

英文：January 15, 2024
中文：2024年1月15日

## 地址本地化

英文：从小到大
中文：从大到小（国家→省→市→区→街道）
```
