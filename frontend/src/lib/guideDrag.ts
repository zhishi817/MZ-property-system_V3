export function arrayInsertMove<T>(arr: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...arr]
  if (from < to && to === from + 1) return [...arr]
  const next = [...arr]
  const [item] = next.splice(from, 1)
  let insertAt = to
  if (from < to) insertAt = Math.max(0, to - 1)
  next.splice(insertAt, 0, item)
  return next
}

export type GuideBlock = { id: string; type: string; [k: string]: any }
export type GuideSection = { id: string; title?: string; blocks?: GuideBlock[] }

export function moveSectionToIndex(sections: readonly GuideSection[], fromSectionId: string, toIndex: number): GuideSection[] {
  const from = sections.findIndex((s) => String(s?.id) === String(fromSectionId))
  if (from < 0) return [...sections]
  const bounded = Math.max(0, Math.min(toIndex, sections.length))
  return arrayInsertMove(sections, from, bounded)
}

export function moveBlockToIndex(
  sections: readonly GuideSection[],
  fromSectionId: string,
  blockId: string,
  toSectionId: string,
  toIndex: number,
): GuideSection[] {
  const fromSi = sections.findIndex((s) => String(s?.id) === String(fromSectionId))
  const toSi = sections.findIndex((s) => String(s?.id) === String(toSectionId))
  if (fromSi < 0 || toSi < 0) return [...sections]

  const fromBlocks = Array.isArray(sections[fromSi]?.blocks) ? (sections[fromSi]!.blocks as GuideBlock[]) : []
  const bIndex = fromBlocks.findIndex((b) => String(b?.id) === String(blockId))
  if (bIndex < 0) return [...sections]

  const block = fromBlocks[bIndex]

  if (fromSi === toSi) {
    const bounded = Math.max(0, Math.min(toIndex, fromBlocks.length))
    const nextBlocks = arrayInsertMove(fromBlocks, bIndex, bounded)
    return sections.map((s, idx) => (idx === fromSi ? { ...s, blocks: nextBlocks } : s))
  }

  const toBlocks = Array.isArray(sections[toSi]?.blocks) ? (sections[toSi]!.blocks as GuideBlock[]) : []
  const bounded = Math.max(0, Math.min(toIndex, toBlocks.length))

  const nextFrom = fromBlocks.filter((b) => String(b?.id) !== String(blockId))
  const nextTo = [...toBlocks]
  nextTo.splice(bounded, 0, block)

  return sections.map((s, idx) => {
    if (idx === fromSi) return { ...s, blocks: nextFrom }
    if (idx === toSi) return { ...s, blocks: nextTo }
    return s
  })
}

