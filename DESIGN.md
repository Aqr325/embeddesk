---
name: 智能客服 Agent
description: 智能客服 Agent Web 应用的设计 token 单一事实来源（客服工作台 / 管理后台 / 登录页）
colors:
  primary: "#3b82f6"
  secondary: "#737373"
  tertiary: "#0ea5e9"
  neutral: "#f5f5f5"
  surface: "#ffffff"
  on-surface: "#171717"
  error: "#ef4444"
  success: "#22c55e"
  warning: "#f59e0b"
typography:
  headline-display:
    fontFamily: "PingFang SC"
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.3
  headline-lg:
    fontFamily: "PingFang SC"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
  section:
    fontFamily: "PingFang SC"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: "PingFang SC"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
  body-sm:
    fontFamily: "PingFang SC"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.6
  label-sm:
    fontFamily: "PingFang SC"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  "2xl": 20px
  full: 9999px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.tertiary}"
  input-default:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: 10px
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: 16px
  badge-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.full}"
    padding: 4px
  badge-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.full}"
    padding: 4px
---

# 智能客服 Agent 设计系统

本文件是「智能客服 Agent」Web 应用的设计 token 单一事实来源，由 `designmd` 校验并导出至 Tailwind / CSS 变量。所有界面（客服工作台、管理后台、登录页）必须依据本文档的颜色角色、层级与交互原则实现，确保跨页面视觉与交互一致。深色模式通过 `:root` / `.dark` 的 CSS 变量桥接（见 `src/index.css`），`designmd` 此处以浅色主色为准。

## Overview

专业、可信、克制的 B 端 SaaS 气质。以蓝 `primary #3b82f6` 为品牌主色传达信任感，中性灰阶承载大面积留白，状态色仅用于必要的语义反馈（成功 / 警示 / 危险 / 信息）。整体低密度、强对比、无装饰性渐变。工程中 token 命名映射：`primary↔accent`、`error↔destructive`、`tertiary↔info`、`neutral↔muted`、`surface↔background/card`、`on-surface↔foreground`、`secondary↔muted-foreground`。

## Colors

- **primary / accent（品牌主色）**：按钮、链接、选中态、意图高亮。浅色 `#3b82f6`，深色 `#60a5fa`。
- **error / destructive（危险）**：删除、错误提示、校验失败。浅色 `#ef4444`。
- **success（成功）**：操作成功、已解决。浅色 `#22c55e`。
- **warning（警示）**：转人工、排队、需注意。浅色 `#f59e0b`。
- **tertiary / info（信息）**：中性提示、引擎状态。浅色 `#0ea5e9`。
- **中性**：surface `#ffffff`、on-surface `#171717`、secondary `#737373`、neutral `#f5f5f5` 承载结构与文字层级。

## Typography

系统字体栈（PingFang SC / Microsoft YaHei 优先）。层级：headline-display 22px/700 · headline-lg 18px/600 · section 14px/600 · body-md 14px/400 · body-sm 12px/400 · label-sm 11px/500。行高正文 1.6–1.7，标题 1.3。

## Layout

间距采用 4px 基准刻度（sm=8px, md=16px, lg=24px）。断点 `lg=1024px`：低于 lg 隐藏右侧分析栏。卡片圆角 xl=16px / 2xl=20px，控件圆角 md=8px，胶囊 full=9999px。

## Elevation & Depth

三层阴影（shadow-1/2/3）对应浮起层级；同色系表面通过 surface / neutral 区分嵌套。避免重投影，克制使用。

## Shapes

圆角刻度：sm 4px、md 8px、lg 12px、xl 16px、2xl 20px、full 9999px。按钮与输入控件统一 md，卡片统一 xl。

## Components

- **button-primary**：主操作按钮，primary 底 / surface 字，md 圆角，12px 内边距；hover 转 tertiary。active 提供 `scale(0.97)` 触感反馈。
- **input-default**：输入框，neutral 底 / on-surface 字，md 圆角；focus-visible 显示 2px primary 环（offset 2px）。
- **card**：surface 底、xl 圆角、16px 内边距承载内容块。

## Do's and Don'ts

- Do：状态色只用于语义反馈；留白统一；动效 ≤300ms ease-out；加载/空态有明确指引；触控目标 ≥44×44px。
- Don't：用颜色承载非语义信息；字号随意堆砌；动效过长或闪烁；移动端出现横向滚动；focus 不可见。
