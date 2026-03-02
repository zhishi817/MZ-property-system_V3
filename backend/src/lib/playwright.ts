import { chromium, type Browser } from 'playwright'
import fs from 'fs'

let browser: Browser | null = null
let launching: Promise<Browser> | null = null

export function getPlaywrightDiagnostics() {
  let pwVersion = 'unknown'
  try {
    pwVersion = String(require('playwright/package.json')?.version || 'unknown')
  } catch {}
  const browsersPath = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '')
  const skip = String(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD || '')
  const executablePath = (() => {
    try { return String((chromium as any)?.executablePath?.() || '') } catch { return '' }
  })()
  const executableExists = executablePath ? fs.existsSync(executablePath) : false
  return { pwVersion, browsersPath, skip, executablePath, executableExists }
}

export async function resetChromiumBrowser() {
  const b = browser
  browser = null
  launching = null
  if (b) {
    try { await b.close() } catch {}
  }
}

export async function getChromiumBrowser(): Promise<Browser> {
  if (browser) {
    try {
      if ((browser as any).isConnected?.() === false) {
        await resetChromiumBrowser()
      } else {
        return browser
      }
    } catch {
      await resetChromiumBrowser()
    }
  }
  if (launching) return launching
  launching = (async () => {
    const prefer = '/ms-playwright'
    try {
      const dir = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '')
      if (dir && !fs.existsSync(dir) && fs.existsSync(prefer)) process.env.PLAYWRIGHT_BROWSERS_PATH = prefer
      if (!dir && fs.existsSync(prefer)) process.env.PLAYWRIGHT_BROWSERS_PATH = prefer
    } catch {}
    try {
      const b = await chromium.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      })
      browser = b
      try {
        b.on('disconnected', () => {
          browser = null
          launching = null
        })
      } catch {}
      launching = null
      return b
    } catch (e: any) {
      const diag = getPlaywrightDiagnostics()
      try {
        console.error(`[playwright] launch_failed version=${diag.pwVersion} browsersPath=${diag.browsersPath} skip=${diag.skip} executableExists=${diag.executableExists} executablePath=${diag.executablePath}`)
      } catch {}
      launching = null
      throw e
    }
  })()
  return launching
}
