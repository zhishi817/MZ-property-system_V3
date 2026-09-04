import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { propertyRevenueExpenseFields, propertyRevenueExpenseFieldsParam } from './propertyRevenueExpenseFields'

describe('propertyRevenueExpenseFields', () => {
  it('only requests fields available to the property revenue expense projection', () => {
    expect(propertyRevenueExpenseFields).toEqual(expect.arrayContaining([
      'property_id',
      'month_key',
      'amount',
      'category',
      'pay_method',
      'status',
      'created_at',
    ]))
    expect(propertyRevenueExpenseFields).not.toContain('updated_at')
    expect(propertyRevenueExpenseFieldsParam).not.toContain('updated_at')
  })

  it('keeps a property-expense load failure visible instead of silently rendering zero expenses', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/finance/properties-overview/page.tsx'), 'utf8')

    expect(page).toContain('setPropertyExpenseLoadError(nextPropertyExpenseLoadError)')
    expect(page).toContain('message="房源支出加载失败"')
    expect(page).toContain('description={propertyExpenseLoadError}')
  })

  it('fully reloads property expenses after focus, visibility, or route return', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/finance/properties-overview/page.tsx'), 'utf8')

    expect(page).toContain('const scheduleReload = () =>')
    expect(page).toContain('setTimeout(() => { reload() }, 350)')
    expect(page).not.toContain('reload({ ordersOnly: true })')
    expect(page).toContain('const onVis = () => { if (document.visibilityState === \'visible\') scheduleReload() }')
    expect(page).toContain('const onFocus = () => { scheduleReload() }')
    expect(page).toContain('scheduleReloadRef.current?.()')
  })
})
