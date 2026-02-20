import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'
import { chromium, firefox, webkit } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const args = new Set(process.argv.slice(2))
const updateBaseline = args.has('--update-baseline')
const browserArg = (() => {
  const v = process.argv.find((x) => x.startsWith('--browsers='))
  if (!v) return null
  return String(v.split('=')[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
})()
const viewportArg = (() => {
  const v = process.argv.find((x) => x.startsWith('--viewports='))
  if (!v) return null
  return String(v.split('=')[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
})()

const root = path.resolve(__dirname, '..', '..')
const staticDir = path.join(root, 'ui', 'cleaning-overview-static')
const staticHtml = path.join(staticDir, 'index.html')

const baselineDir = path.join(root, 'ui', 'cleaning-overview-baseline')
const outDir = path.join(root, 'ui', 'cleaning-overview-report')

const viewports = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1366x768', width: 1366, height: 768 },
]

const browsers = [
  { name: 'chromium', launcher: chromium },
  { name: 'firefox', launcher: firefox },
  { name: 'webkit', launcher: webkit },
]

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function readPng(p) {
  const buf = fs.readFileSync(p)
  return PNG.sync.read(buf)
}

function writePng(p, png) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, PNG.sync.write(png))
}

function fmtPct(v) {
  return `${(v * 100).toFixed(4)}%`
}

async function screenshotOnce(browserName, launcher, vp) {
  const browser = await launcher.launch()
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  await page.goto(`file://${staticHtml}`, { waitUntil: 'load' })
  try {
    await page.waitForFunction(() => (window).__CLEANING_OVERVIEW_READY__ === true, null, { timeout: 5000 })
  } catch {
    await page.waitForTimeout(600)
  }
  const outPath = path.join(outDir, 'screenshots', browserName, `${vp.name}.png`)
  ensureDir(path.dirname(outPath))
  await page.screenshot({ path: outPath, fullPage: false })
  await browser.close()
  return outPath
}

function diffImages(baselinePath, actualPath, diffPath) {
  const a = readPng(baselinePath)
  const b = readPng(actualPath)
  const w = a.width
  const h = a.height
  if (b.width !== w || b.height !== h) {
    return { ok: false, reason: `size_mismatch baseline=${w}x${h} actual=${b.width}x${b.height}` }
  }
  const diff = new PNG({ width: w, height: h })
  const mismatched = pixelmatch(a.data, b.data, diff.data, w, h, {
    threshold: 0.1,
    includeAA: true,
    alpha: 0.65,
    diffColor: [255, 0, 0],
  })
  writePng(diffPath, diff)
  const pct = mismatched / (w * h)
  return { ok: true, mismatched, total: w * h, pct }
}

function writeReportMd(rows, overallOk) {
  const md = [
    '# 清洁总览 1:1 还原度对照报告',
    '',
    `- 基准：${updateBaseline ? '已更新（--update-baseline）' : 'ui/cleaning-overview-baseline 下的 PNG'}`,
    `- 结果：${overallOk ? 'PASS' : 'FAIL'}`,
    '- 判定：差异像素占比 ≤ 0.5%',
    '',
    '| 浏览器 | 分辨率 | 差异像素占比 | 结论 | 输出 |',
    '|---|---:|---:|---|---|',
    ...rows.map((r) => {
      const out = r.diffPath ? path.relative(root, r.diffPath) : '-'
      const actual = r.actualPath ? path.relative(root, r.actualPath) : '-'
      const line = r.kind === 'missing_baseline'
        ? `| ${r.browser} | ${r.vp} | - | NEED_BASELINE | ${actual} |`
        : r.kind === 'error'
          ? `| ${r.browser} | ${r.vp} | - | ERROR | - |`
        : r.kind === 'size_mismatch'
          ? `| ${r.browser} | ${r.vp} | - | FAIL | ${out} |`
          : `| ${r.browser} | ${r.vp} | ${fmtPct(r.pct)} | ${r.pass ? 'PASS' : 'FAIL'} | ${out} |`
      return line
    }),
    '',
  ].join('\n')
  ensureDir(outDir)
  fs.writeFileSync(path.join(outDir, 'report.md'), md)
}

async function main() {
  ensureDir(outDir)
  ensureDir(baselineDir)

  const results = []
  const selectedBrowsers = browserArg ? browsers.filter((b) => browserArg.includes(b.name)) : browsers
  const selectedViewports = viewportArg ? viewports.filter((v) => viewportArg.includes(v.name)) : viewports
  for (const b of selectedBrowsers) {
    for (const vp of selectedViewports) {
      try {
        const actualPath = await screenshotOnce(b.name, b.launcher, vp)
        const baselinePath = path.join(baselineDir, b.name, `${vp.name}.png`)
        if (updateBaseline) {
          ensureDir(path.dirname(baselinePath))
          fs.copyFileSync(actualPath, baselinePath)
          results.push({ kind: 'updated_baseline', browser: b.name, vp: vp.name, actualPath, baselinePath })
          continue
        }
        if (!fs.existsSync(baselinePath)) {
          results.push({ kind: 'missing_baseline', browser: b.name, vp: vp.name, actualPath })
          continue
        }
        const diffPath = path.join(outDir, 'diffs', b.name, `${vp.name}.png`)
        const d = diffImages(baselinePath, actualPath, diffPath)
        if (!d.ok) {
          results.push({ kind: 'size_mismatch', browser: b.name, vp: vp.name, actualPath, diffPath, reason: d.reason })
          continue
        }
        const pass = d.pct <= 0.005
        results.push({ kind: 'diff', browser: b.name, vp: vp.name, actualPath, diffPath, pct: d.pct, pass })
      } catch (e) {
        results.push({ kind: 'error', browser: b.name, vp: vp.name, error: String(e?.message || e) })
      }
    }
  }

  const meaningful = results.filter((r) => r.kind === 'diff')
  const overallOk = meaningful.length > 0 && meaningful.every((r) => r.pass)
  writeReportMd(results, overallOk)

  const jsonOut = results.map((r) => ({ ...r, actualPath: r.actualPath ? path.relative(root, r.actualPath) : r.actualPath, diffPath: r.diffPath ? path.relative(root, r.diffPath) : r.diffPath }))
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ overallOk, results: jsonOut }, null, 2))

  process.exit(overallOk || updateBaseline ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
