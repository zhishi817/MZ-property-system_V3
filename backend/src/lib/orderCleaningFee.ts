export type FixedCleaningAmounts = {
  cleaningFeeAud: number
  finalAmountAud: number
  averageNightlyAmountAud: number
}

function normalizePropertyType(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

export function fixedCleaningFeeAudForPropertyType(propertyType: unknown): number | null {
  const type = normalizePropertyType(propertyType)
  if (!type) return null

  if (type === 'studio') return 85

  if (/^(?:一|1)房/.test(type) || /^1b(?:\d+(?:\.\d+)?b)?$/.test(type)) return 90

  if (/^(?:两|二|2)房(?:一|1)卫$/.test(type) || type === '2b1b') return 125
  if (/^(?:两|二|2)房(?:两|二|2)卫$/.test(type) || type === '2b2b') return 135

  if (/^(?:三|3)房/.test(type) || /^3b(?:\d+(?:\.\d+)?b)?$/.test(type)) return 220

  if (type === '4房3.5卫' || type === '四房3.5卫' || type === '4b3.5b') return 280

  return null
}

function roundAud(value: number): number {
  return Number(value.toFixed(2))
}

export function deriveFixedCleaningAmounts(
  originalAmountAud: unknown,
  propertyType: unknown,
  nights: unknown,
): FixedCleaningAmounts | null {
  const cleaningFeeAud = fixedCleaningFeeAudForPropertyType(propertyType)
  const originalAmount = Number(originalAmountAud)
  const stayNights = Number(nights)
  if (cleaningFeeAud == null || !Number.isFinite(originalAmount) || originalAmount <= 0) return null

  const finalAmountAud = roundAud(originalAmount - cleaningFeeAud)
  return {
    cleaningFeeAud,
    finalAmountAud,
    averageNightlyAmountAud: Number.isFinite(stayNights) && stayNights > 0
      ? roundAud(finalAmountAud / stayNights)
      : 0,
  }
}
