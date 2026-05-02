import { listPhotoUrls } from '../../src/lib/monthlyStatementPhotoRecords'
import { splitStatementPhotoPackVolumes } from '../../src/lib/monthlyStatementPhotoPack'
import type { PhotoPackTemplateRecord } from '../../src/lib/monthlyStatementPhotoPackTemplate'

function assert(cond: any, message: string) {
  if (!cond) throw new Error(message)
}

function makeRecord(id: string, beforeCount: number, afterCount: number): PhotoPackTemplateRecord {
  return {
    kind: 'deep_cleaning',
    jobNumber: id,
    completionText: '2026-05-01',
    areaText: '厨房',
    beforeImages: Array.from({ length: beforeCount }, (_, i) => ({ dataUrl: `before-${id}-${i + 1}`, mimeType: 'image/jpeg' })),
    afterImages: Array.from({ length: afterCount }, (_, i) => ({ dataUrl: `after-${id}-${i + 1}`, mimeType: 'image/jpeg' })),
    beforeRawCount: beforeCount,
    afterRawCount: afterCount,
  }
}

function run() {
  {
    const urls = listPhotoUrls([
      'a.jpg',
      { url: 'b.jpg' },
      { urls: ['c.jpg', { src: 'd.jpg' }] },
    ])
    assert(urls.length === 4, 'should flatten nested photo url structures')
  }

  {
    const beforeUrls = Array.from({ length: 18 }, (_, i) => `before-${i + 1}.jpg`)
    const afterUrls = Array.from({ length: 8 }, (_, i) => `after-${i + 1}.jpg`)
    assert(beforeUrls.length === 18, 'before photos should stay complete')
    assert(afterUrls.length === 8, 'after photos should stay complete')
    assert(beforeUrls.length + afterUrls.length === 26, 'photo pack should preserve full counts before any hard-limit check')
  }

  {
    const volumes = splitStatementPhotoPackVolumes([
      makeRecord('A', 18, 8),
      makeRecord('B', 40, 30),
      makeRecord('C', 5, 2),
    ], { imagesPerVolume: 60, pagesPerVolume: 20 })
    assert(volumes.length === 3, 'records should split by record boundary when image threshold is exceeded')
    assert(volumes[0].length === 1 && volumes[1].length === 1 && volumes[2].length === 1, 'volume split should keep each record intact')
  }

  {
    const giant = makeRecord('GIANT', 140, 20)
    const volumes = splitStatementPhotoPackVolumes([giant], { imagesPerVolume: 120, pagesPerVolume: 35 })
    assert(volumes.length === 1, 'single oversized record should stay in one volume')
    assert(volumes[0][0].jobNumber === 'GIANT', 'oversized record should not be split internally')
  }

  console.log('test_monthly_statement_photo_pack passed')
}

run()
