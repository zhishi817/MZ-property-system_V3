"use client"

export type AdminNotificationType = 'info' | 'success' | 'warning' | 'error'

export type AdminNotification = {
  id: string
  type: AdminNotificationType
  title: string
  message: string
  source?: string
  created_at: string
  read: boolean
}

const STORAGE_KEY = 'mz-admin-notifications'
export const ADMIN_NOTIFICATIONS_CHANGED = 'mz-admin-notifications-changed'

function canUseStorage() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function notifyChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(ADMIN_NOTIFICATIONS_CHANGED))
}

export function loadAdminNotifications(): AdminNotification[] {
  if (!canUseStorage()) return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : []
  } catch {
    return []
  }
}

function saveAdminNotifications(items: AdminNotification[]) {
  if (!canUseStorage()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 60)))
  } catch {}
  notifyChanged()
}

export function upsertAdminNotification(input: {
  id?: string
  type: AdminNotificationType
  title: string
  message: string
  source?: string
}) {
  const id = input.id || `notice:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const createdAt = new Date().toISOString()
  const existing = loadAdminNotifications().filter((item) => item.id !== id)
  const next: AdminNotification = {
    id,
    type: input.type,
    title: input.title,
    message: input.message,
    source: input.source,
    created_at: createdAt,
    read: false,
  }
  saveAdminNotifications([next, ...existing])
  return next
}

export function markAdminNotificationsRead() {
  const current = loadAdminNotifications()
  if (!current.some((item) => !item.read)) return
  saveAdminNotifications(current.map((item) => ({ ...item, read: true })))
}

export function clearAdminNotifications() {
  saveAdminNotifications([])
}
