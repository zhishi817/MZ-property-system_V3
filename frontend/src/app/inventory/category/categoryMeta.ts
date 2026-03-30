export type InventoryCategory = 'linen' | 'daily' | 'consumable' | 'other'

export function asInventoryCategory(v: any): InventoryCategory | null {
  const s = String(v || '').trim()
  if (s === 'linen' || s === 'daily' || s === 'consumable' || s === 'other') return s
  return null
}

export function categoryLabel(c: InventoryCategory): string {
  if (c === 'linen') return '床品'
  if (c === 'daily') return '日用品'
  if (c === 'consumable') return '消耗品'
  return '其他物品'
}

