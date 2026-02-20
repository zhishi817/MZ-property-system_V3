# 清洁总览交付物说明

## 1) 静态页面源码
- 路径：ui/cleaning-overview-static/
- 文件：
  - index.html
  - styles.css
  - app.js

## 2) 还原度对照报告
- 运行命令：
  - npm run ui:cleaning-overview:diff
- 输出目录：
  - ui/cleaning-overview-report/report.md
  - ui/cleaning-overview-report/report.json
  - ui/cleaning-overview-report/screenshots/
  - ui/cleaning-overview-report/diffs/

## 3) 自测清单
- 路径：ui/cleaning-overview-static/SELF_TEST.md

## 4) 基准图放置规范
- 路径：ui/cleaning-overview-baseline/{chromium|firefox|webkit}/{1920x1080|1366x768}.png
- 基准图必须由原稿导出（同分辨率、同缩放、同字体）

## 生成基准图（首次）
- npm run ui:cleaning-overview:update-baseline
