import { hasPerm } from './auth'

export function pickHomeRoute(): string {
  if (hasPerm('menu.dashboard')) return '/dashboard'
  if (hasPerm('menu.cleaning') || hasPerm('cleaning.view') || hasPerm('cleaning.schedule.manage') || hasPerm('cleaning.task.assign')) return '/cleaning/overview'
  if (hasPerm('menu.properties.maintenance.visible')) return '/maintenance/overview'
  if (hasPerm('menu.properties.list.visible') || hasPerm('menu.properties')) return '/properties'
  if (hasPerm('menu.orders')) return '/orders'
  return '/login'
}

