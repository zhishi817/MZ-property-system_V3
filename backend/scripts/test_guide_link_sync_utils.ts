import { buildPublicGuideUrl, pickPublicBaseUrl } from '../src/lib/guideLinkSyncUtils'

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(msg)
}

function run() {
  assert(buildPublicGuideUrl('abc', '') === '/guide/p/abc', 'relative url')
  assert(buildPublicGuideUrl('a b', 'https://example.com') === 'https://example.com/guide/p/a%20b', 'encoded token')
  assert(pickPublicBaseUrl('https://x.test/') === 'https://x.test', 'origin trim slash')
  console.log('[ok] guideLinkSyncUtils')
}

run()

