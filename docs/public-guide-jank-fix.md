# 公开入住指南：Checkout → Q&A 滑动错位/抖动修复说明

## 问题现象
- 生产环境中，用户从 **Check out** 章节向下滑到 **Q&A** 章节时出现明显错位/抖动。
- 常见发生在移动端 WebKit（iOS Safari、微信内置浏览器）中，且在图片密集章节更明显。

## 根因分析（本次定位结论）
1. **固定悬浮层 + backdrop-filter 在 iOS WebKit 上的合成/重绘缺陷**
   - 页面存在 `position: fixed` 的悬浮目录，并启用了 `backdrop-filter`（模糊玻璃态）。
   - iOS WebKit 对 `fixed + backdrop-filter` 的合成层处理存在已知抖动/闪烁问题，特别是在滚动经过大图区域、重绘压力增大时更明显。
2. **滚动监听中频繁的布局读取与状态更新导致主线程竞争**
   - 之前通过 `scroll` + `requestAnimationFrame` 逐帧遍历章节锚点并读 `getBoundingClientRect()`，在低端机/高压页面（大图、阴影、模糊）会增加掉帧概率。
   - 目录高亮状态频繁更新会触发 React render（虽然多数情况下可被相同值短路，但仍会放大抖动风险）。

## 解决方案
### 1) 降低 WebKit 合成抖动：iOS 环境禁用 backdrop-filter
- 保留桌面与 Android 的玻璃态效果；
- 在 iOS 识别条件下关闭 `backdrop-filter`，使用半透明背景作为稳定降级。

### 2) 降低滚动期间主线程压力：用 IntersectionObserver 驱动章节高亮
- 用 `IntersectionObserver` 观察每个章节 top anchor；
- 回调中选择更接近视口上方偏移点（110px）的章节作为当前章节；
- `scroll` 监听仅用于控制“目录页/悬浮目录可见性”，并用 rAF 节流 + resize 防抖，减少高频 reflow。

### 3) 额外的稳定性措施
- 通过 `overflow-anchor: none` 避免浏览器滚动锚定造成的跳动；
- 对悬浮目录层做 `contain: paint`、`backface-visibility` 与 `will-change`，降低重绘面积与合成层抖动概率。

## 代码改动点
### 前端
- 章节高亮逻辑与滚动/resize 节流：`frontend/src/app/guide/p/[token]/PublicGuideClient.tsx`
- iOS 降级与渲染稳定性样式：`frontend/src/app/guide/p/[token]/PublicGuide.module.css`

## QA 验收建议（手工）
1. 设备与浏览器覆盖：
   - iOS Safari（最新）、iOS 微信内置浏览器、Android Chrome（最新）
   - 桌面端 Chrome / Edge / Firefox / Safari（最新）
2. 场景：
   - 从 **Check out** 快速连续上/下滑到 **Q&A** 多次
   - 在弱网（Fast 3G）与强网下分别测试
3. 期望结果：
   - 页面无明显横向/纵向错位跳动
   - 悬浮目录高亮稳定、不卡顿
   - 目录页（顶部目录区域）悬浮目录不出现；进入正文后自动出现

## 后续维护建议
- 如后续继续增强玻璃态效果，优先在 iOS 下走稳定降级（避免重新引入 `fixed + backdrop-filter` 抖动）。
- 若指南图片来源可控，建议逐步在服务端提供图片尺寸元数据，进一步降低图片加载造成的 layout shift 风险。

