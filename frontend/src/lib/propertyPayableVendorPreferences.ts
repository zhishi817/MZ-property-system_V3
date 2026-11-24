export type PropertyPayableVendorOption = { value: string; label?: string; usage_count?: number }

export type VendorPreferenceStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY = 'mz.property-payables.hidden-vendors.v1'

export function propertyPayableVendorKey(value: any) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export function normalizeHiddenPropertyPayableVendorKeys(raw: any): string[] {
  const values = Array.isArray(raw) ? raw : []
  return Array.from(new Set(values.map(propertyPayableVendorKey).filter(Boolean))).sort()
}

export function loadHiddenPropertyPayableVendorKeys(storage?: VendorPreferenceStorage | null): string[] {
  if (!storage) return []
  try {
    return normalizeHiddenPropertyPayableVendorKeys(JSON.parse(storage.getItem(PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY) || '[]'))
  } catch {
    return []
  }
}

export function saveHiddenPropertyPayableVendorKeys(storage: VendorPreferenceStorage | null | undefined, keys: string[]) {
  const normalized = normalizeHiddenPropertyPayableVendorKeys(keys)
  try {
    storage?.setItem(PROPERTY_PAYABLE_HIDDEN_VENDOR_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Browser privacy/quota settings must not make the vendor field unusable.
  }
  return normalized
}

export function hidePropertyPayableVendor(keys: string[], value: any) {
  const key = propertyPayableVendorKey(value)
  return key ? normalizeHiddenPropertyPayableVendorKeys([...keys, key]) : normalizeHiddenPropertyPayableVendorKeys(keys)
}

export function restorePropertyPayableVendor(keys: string[], value: any) {
  const key = propertyPayableVendorKey(value)
  if (!key) return normalizeHiddenPropertyPayableVendorKeys(keys)
  return normalizeHiddenPropertyPayableVendorKeys(keys).filter((item) => item !== key)
}

export function visiblePropertyPayableVendorOptions(options: PropertyPayableVendorOption[], hiddenKeys: string[]) {
  const hidden = new Set(normalizeHiddenPropertyPayableVendorKeys(hiddenKeys))
  return options.filter((option) => !hidden.has(propertyPayableVendorKey(option?.value)))
}
