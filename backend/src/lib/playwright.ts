import { chromium, type Browser } from 'playwright'

let browser: Browser | null = null
let launching: Promise<Browser> | null = null

export async function getChromiumBrowser(): Promise<Browser> {
  if (browser) return browser
  if (launching) return launching
  launching = (async () => {
    const b = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })
    browser = b
    launching = null
    return b
  })()
  return launching
}

