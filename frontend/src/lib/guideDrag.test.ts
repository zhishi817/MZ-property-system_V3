import { describe, expect, it } from 'vitest'
import { arrayInsertMove, moveBlockToIndex, moveSectionToIndex } from './guideDrag'

describe('arrayInsertMove', () => {
  it('moves item within array for non-adjacent indices', () => {
    expect(arrayInsertMove(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'a', 'd'])
    expect(arrayInsertMove(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('keeps array same for adjacent forward insert', () => {
    expect(arrayInsertMove(['a', 'b', 'c'], 0, 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('moveSectionToIndex', () => {
  it('reorders sections by id', () => {
    const sections = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
    expect(moveSectionToIndex(sections as any, 's1', 2).map((s) => s.id)).toEqual(['s2', 's1', 's3'])
    expect(moveSectionToIndex(sections as any, 's3', 0).map((s) => s.id)).toEqual(['s3', 's1', 's2'])
  })
})

describe('moveBlockToIndex', () => {
  it('moves block within a section', () => {
    const sections = [
      { id: 's1', blocks: [{ id: 'a', type: 'text' }, { id: 'b', type: 'text' }, { id: 'c', type: 'text' }] },
      { id: 's2', blocks: [] },
    ]
    const next = moveBlockToIndex(sections as any, 's1', 'a', 's1', 2)
    expect(next[0].blocks?.map((b) => b.id)).toEqual(['b', 'a', 'c'])
  })

  it('moves block across sections without duplication', () => {
    const sections = [
      { id: 's1', blocks: [{ id: 'a', type: 'heading' }, { id: 'b', type: 'text' }] },
      { id: 's2', blocks: [{ id: 'c', type: 'image' }] },
    ]
    const next = moveBlockToIndex(sections as any, 's1', 'b', 's2', 1)
    expect(next[0].blocks?.map((b) => b.id)).toEqual(['a'])
    expect(next[1].blocks?.map((b) => b.id)).toEqual(['c', 'b'])
  })

  it('bounds insertion index', () => {
    const sections = [
      { id: 's1', blocks: [{ id: 'a', type: 'heading' }, { id: 'b', type: 'text' }] },
      { id: 's2', blocks: [] },
    ]
    const next = moveBlockToIndex(sections as any, 's1', 'a', 's2', 999)
    expect(next[1].blocks?.map((b) => b.id)).toEqual(['a'])
  })
})

