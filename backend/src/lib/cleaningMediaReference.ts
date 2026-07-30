export function isCleaningMediaKey(value: unknown): value is string {
  const text = String(value || '').trim()
  return text.startsWith('cleaning/') && !text.includes('..') && !text.includes('\\') && !/[?#]/.test(text)
}
