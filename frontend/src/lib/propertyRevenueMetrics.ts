import { isOwnerStay } from './orders'

export type RevenueOrderSegmentLike = {
  nights?: number
  stay_type?: 'guest' | 'owner' | string
}

export function computePropertyRevenueMetrics(input: {
  orders: RevenueOrderSegmentLike[]
  daysInMonth: number
  rentIncome: number
}) {
  const orders = Array.isArray(input.orders) ? input.orders : []
  const daysInMonth = Math.max(0, Number(input.daysInMonth || 0))
  const rentIncome = Number(input.rentIncome || 0)
  const ownerNights = orders.reduce((sum, order) => sum + (isOwnerStay(order) ? Number(order?.nights || 0) : 0), 0)
  const guestNights = orders.reduce((sum, order) => sum + (!isOwnerStay(order) ? Number(order?.nights || 0) : 0), 0)
  const availableDays = Math.max(0, daysInMonth - ownerNights)
  const occupancyRate = availableDays ? Math.round(((guestNights / availableDays) * 100 + Number.EPSILON) * 100) / 100 : 0
  const dailyAverage = guestNights ? Math.round(((rentIncome / guestNights) + Number.EPSILON) * 100) / 100 : 0
  return { ownerNights, guestNights, availableDays, occupancyRate, dailyAverage }
}
