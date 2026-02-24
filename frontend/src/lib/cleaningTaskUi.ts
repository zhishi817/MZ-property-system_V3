import dayjs from 'dayjs'

export function formatTaskTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = dayjs(String(iso))
  if (!d.isValid()) return ''
  return d.format('HH:mm')
}

export function isTaskLocked(autoSyncEnabled: boolean | null | undefined): boolean {
  return autoSyncEnabled === false
}

