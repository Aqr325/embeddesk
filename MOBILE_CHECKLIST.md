# 移动端触控 / 响应式 真机自查清单

> 适用范围：本智能客服 Agent Web 应用（React + Tailwind，SPA）。
> 用法：在手机或 Chrome DevTools 设备模拟（iPhone 12/13/14、Pixel、iPad 竖屏）下逐项确认。
> 已落地项见「代码改动」列，标注「待真机确认」的需人工在真机验证。

## 一、基础视口与系统适配（已构建进产物）
- [x] `viewport` 含 `viewport-fit=cover`，支持刘海/灵动岛安全区
- [x] `theme-color` 随浅/深色切换（地址栏配色）
- [x] `format-detection=telephone=no`，避免号码被误识别为链接
- [x] `apple-mobile-web-app-capable` / `mobile-web-app-capable`，可加到主屏
- [x] 根容器 `h-[100dvh]`（动态视口高度，规避移动浏览器地址栏伸缩导致的 100vh 跳动）
- [x] 顶栏 `min-height: calc(3.5rem + env(safe-area-inset-top))` + `padding-top` 安全区
- [x] 输入栏 `padding-bottom: calc(0.75rem + env(safe-area-inset-bottom))` 安全区

## 二、触控基础体验（CSS 已落地，待真机确认手感）
- [x] 触控设备 `-webkit-tap-highlight-color: transparent`（去掉点击灰块）
- [x] 按钮/链接/输入 `touch-action: manipulation`（去掉 300ms 延迟、禁双击缩放）
- [x] `-webkit-touch-callout: none`（长按不呼出系统菜单）
- [x] 按钮/链接 `user-select: none`（长按不选文字）
- [x] `@media (max-width:768px)` 输入框 `font-size:16px`（规避 iOS 聚焦自动缩放）
- [x] 装饰性 hover 微动效仅 `@media (hover:hover)` 生效；触控设备中和残留 hover 态
- [x] `prefers-reduced-motion` 下关闭动画（无障碍）
- [x] 主滚动容器 `overscroll-contain` + 全局 `overscroll-behavior:none`（防止下拉触发浏览器刷新）

## 三、可点区域尺寸（已统一 ≥44px，待真机确认）
- [x] 顶栏导航图标按钮 `max-sm:min-w/min-h-[44px]`
- [x] 主题切换按钮 `max-sm:w-11 h-11`
- [x] 退出按钮 `max-sm:min-w/min-h-[44px]`
- [x] 客服页「新会话」按钮 `max-sm:min-h-[44px]`
- [x] 快捷问法胶囊（移动端保持易点，无缩到 <40px）
- [x] 满意度星标按钮（点击区放大，新增 `p-1` 内边距）
- [x] 满意度标签 `px-2.5 py-1`、提交按钮 `min-h-[32px]`
- [x] 管理后台 Tab `max-sm:min-h-[44px]`
- [x] 管理后台操作按钮统一 `min-h-[44px]`（原 40/32 提升）
- [x] 会话表分页按钮 `min-w/min-h-[44px]`
- [x] 工单下拉/负责人输入/备注按钮 `min-h-[36~40px]`、备注按钮 `min-h-[44px]`
- [x] FAQ 删除（图标）按钮 `min-w/min-h-[32px]` 并扩大可点区

## 四、响应式布局（待真机逐项确认）
- [ ] 客服工作台：对话气泡在 360px 宽下不溢出、不出现横向滚动
- [ ] 输入栏在键盘弹起时不被遮挡（建议 DevTools 设备模拟 + 软键盘）
- [ ] 管理后台：统计卡（StatCards）在 360px 下正确折行（grid 响应式）
- [ ] 会话表：窄屏下列宽可读，必要时横向滚动而非挤压错位
- [ ] 工单列表：卡片在窄屏下不重叠、备注区可正常展开
- [ ] FAQ 管理：表单在窄屏下可完整填写、保存/取消按钮可见可达
- [ ] 满意度卡片在气泡内宽度自适应，不顶破容器

## 五、已知待人工验证 / 后续可选项
- [ ] 真机 iOS Safari / Android Chrome 各测一轮（灰块、缩放、键盘遮挡）
- [ ] 横屏（landscape）下顶栏/输入栏安全区表现
- [ ] 如未来要做底部 Tab Bar，需再补 `env(safe-area-inset-bottom)` 容器
- [ ] 可选：指标接 Prometheus 导出（当前为进程内内存态，见 README「可观测性」）

---
生成时间：2026-08-02｜关联任务：移动端触控细节再审（选项②）
