import { describe, expect, it } from 'vitest'
import { buildStatementTxs, mapTxForStatement } from './statementTx'

describe('mapTxForStatement', () => {
  it('keeps expense when occurred_at missing but due_date exists', () => {
    const tx = mapTxForStatement({
      id: 'e1',
      kind: 'expense',
      amount: 10,
      currency: 'AUD',
      property_id: 'p1',
      due_date: '2026-03-05',
      category: 'electricity',
    }, { properties: [{ id: 'p1', code: 'A101' }] })
    expect(tx?.id).toBe('e1')
    expect(tx?.occurred_at).toBe('2026-03-05')
  })

  it('falls back occurred_at to month_key when no dates exist', () => {
    const tx = mapTxForStatement({
      id: 'e2',
      kind: 'expense',
      amount: 1,
      currency: 'AUD',
      month_key: '2026-03',
      category: 'water',
    }, { properties: [{ id: 'p1', code: 'A101' }] })
    expect(tx?.occurred_at).toBe('2026-03-01')
  })

  it('matches property_code after normalization', () => {
    const tx = mapTxForStatement({
      id: 'e3',
      kind: 'expense',
      amount: 1,
      currency: 'AUD',
      occurred_at: '2026-03-01',
      property_code: 'a101 (2br)',
      category: 'gas',
    }, { properties: [{ id: 'pA', code: 'A101' }] })
    expect(tx?.property_id).toBe('pA')
  })
})

describe('buildStatementTxs', () => {
  it('includes property expenses even if occurred_at missing', () => {
    const built = buildStatementTxs([], [{
      id: 'pe1',
      amount: 20,
      currency: 'AUD',
      property_id: 'p1',
      due_date: '2026-03-02',
      category: 'water',
    }], { properties: [{ id: 'p1', code: 'A101' }], recurring_payments: [] })
    expect(built.txs.some(t => t.id === 'pe1')).toBe(true)
  })
})

