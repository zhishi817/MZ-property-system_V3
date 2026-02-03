export function nextToggleValue(original: boolean, current: boolean): boolean {
  return current === original ? !original : original
}

