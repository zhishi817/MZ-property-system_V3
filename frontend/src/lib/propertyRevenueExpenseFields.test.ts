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

    expect(page).toContain("setPropertyExpenseLoadError(propertyExpensesResult.ok ? null : '本页支出、总支出和净收入可能不完整，请刷新后重试。')")
    expect(page).toContain('message="房源支出加载失败"')
    expect(page).toContain('description={propertyExpenseLoadError}')
  })

  it('debounces stale resume refreshes without route-triggered or foreground loading churn', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/finance/properties-overview/page.tsx'), 'utf8')

    expect(page).toContain('const scheduleReload = () =>')
    expect(page).toContain('shouldRefreshPropertyRevenueOnResume({')
    expect(page).toContain('void reload({ background: true })')
    expect(page).toContain('if (!background) setPageLoading(true)')
    expect(page).toContain('reloadAllRef.current = () => reload({ forceRentIncome: true })')
    expect(page).toContain('claimPropertyRevenueInitialLoad(reloadLifecycleRef.current)')
    expect(page).toContain('claimPropertyRevenueRangeChange(reloadLifecycleRef.current, rangeKey)')
    expect(page).toContain('const onVis = () => { if (document.visibilityState === \'visible\') scheduleReload() }')
    expect(page).toContain('const onFocus = () => { scheduleReload() }')
    expect(page).not.toContain('usePathname')
  })

  it('caches reference inputs, preserves failed background data, and defers refresh during report work', () => {
    const page = fs.readFileSync(path.join(process.cwd(), 'src/app/finance/properties-overview/page.tsx'), 'utf8')

    expect(page).toContain('shouldRefreshPropertyRevenueReferences({')
    expect(page).toContain("loadOrFallback(getJSON<Property[]>('/properties'), cachedReferences?.properties || [])")
    expect(page).toContain('const keepPreviousDynamic = background && !dynamicSucceeded')
    expect(page).toContain("content: '后台刷新部分失败，已保留当前数据，请稍后重试。'")
    expect(page).toContain('deferredResumeRefreshRef.current = true')
    expect(page).toContain('if (wasPaused && !backgroundRefreshPaused && deferredResumeRefreshRef.current)')
    expect(page).not.toContain('invalidateRentIncomeForRange')
  })
})
