export type GuideMetaLike = { title?: string; address?: string }

export function computeAutoSyncAddress(opts: {
  meta: GuideMetaLike
  propertyAddress?: string
  lastSyncedAddress?: string
}): { patch: Partial<GuideMetaLike>; nextSyncedAddress: string } {
  const metaAddr = String(opts.meta?.address || '').trim()
  const propAddr = String(opts.propertyAddress || '').trim()
  const last = String(opts.lastSyncedAddress || '').trim()

  if (!propAddr) return { patch: {}, nextSyncedAddress: last }
  if (propAddr === metaAddr) return { patch: {}, nextSyncedAddress: propAddr || last }
  if (!metaAddr || (last && metaAddr === last)) return { patch: { address: propAddr }, nextSyncedAddress: propAddr }
  return { patch: {}, nextSyncedAddress: last }
}

