import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..', '..')
const staticHtml = path.join(root, 'ui', 'table-header-truncation-static', 'index.html')

const viewports = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '375x812', width: 375, height: 812 },
]

const rowSizes = [0, 50, 200]

async function checkOnce(vp, rows) {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  await page.goto(`file://${staticHtml}?rows=${rows}`, { waitUntil: 'load' })
  await page.waitForFunction(() => (window).__TABLE_HEADER_READY__ === true, null, { timeout: 5000 })

  const failures = await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll('.ant-table-thead > tr > th.ant-table-cell'))
    const bad = []
    for (const th of ths) {
      const title = th.querySelector('.th-title') || th
      const thRect = th.getBoundingClientRect()
      const r = document.createRange()
      r.selectNodeContents(title)
      const rect = r.getBoundingClientRect()
      const clippedX = rect.right > thRect.right + 1 || rect.left < thRect.left - 1
      const clippedY = rect.bottom > thRect.bottom + 1 || rect.top < thRect.top - 1
      const style = window.getComputedStyle(th)
      const ow = style.overflow
      const ws = style.whiteSpace
      const ov = (th.scrollWidth - th.clientWidth) > 1 || (th.scrollHeight - th.clientHeight) > 1
      if (clippedX || clippedY || ov) {
        bad.push({
          text: (title.textContent || '').trim(),
          clippedX,
          clippedY,
          overflow: ov,
          whiteSpace: ws,
          overflowStyle: ow,
          thW: Math.round(thRect.width),
          thH: Math.round(thRect.height),
          textW: Math.round(rect.width),
          textH: Math.round(rect.height),
        })
      }
    }
    return bad
  })

  await browser.close()
  return failures
}

async function main() {
  const all = []
  for (const vp of viewports) {
    for (const rows of rowSizes) {
      const failures = await checkOnce(vp, rows)
      all.push({ vp: vp.name, rows, failures })
    }
  }

  const failed = all.filter((x) => x.failures.length)
  if (failed.length) {
    const lines = []
    lines.push('FAIL: table header truncation detected')
    for (const f of failed) {
      lines.push(`- viewport=${f.vp} rows=${f.rows} failures=${f.failures.length}`)
      for (const item of f.failures.slice(0, 6)) {
        lines.push(`  - ${item.text} (clippedX=${item.clippedX} clippedY=${item.clippedY} overflow=${item.overflow} ws=${item.whiteSpace} ow=${item.overflowStyle})`)
      }
    }
    console.error(lines.join('\n'))
    process.exit(1)
  }

  console.log('PASS: table header text is fully visible across viewports and row sizes')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})

