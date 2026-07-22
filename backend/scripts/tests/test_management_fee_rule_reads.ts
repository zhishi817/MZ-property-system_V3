import assert from 'assert'
import path from 'path'

type QueryResult = { rows?: any[] }

async function main() {
  const queries: string[] = []
  let tableExists = false
  const fakePool = {
    async query(sql: string): Promise<QueryResult> {
      queries.push(sql)
      if (!/FROM landlord_management_fee_rules/i.test(sql)) return { rows: [] }
      if (!tableExists) {
        const error: any = new Error('relation does not exist')
        error.code = '42P01'
        throw error
      }
      return {
        rows: [{
          landlord_id: 'l1',
          effective_from_month: '2025-12',
          management_fee_rate: '0.165',
        }],
      }
    },
  }

  const Module = require('module')
  const originalLoad = Module._load
  Module._load = function patchedLoad(request: string, parent: any, isMain: boolean) {
    const parentFile = String(parent?.filename || '')
    const dbAdapterPath = path.resolve(__dirname, '../../src/dbAdapter')
    const resolvedRequest = path.resolve(path.dirname(parentFile), request)
    if (parentFile.includes(`${path.sep}src${path.sep}lib${path.sep}managementFeeRules`) && (resolvedRequest === dbAdapterPath || `${resolvedRequest}.ts` === `${dbAdapterPath}.ts`)) {
      return { hasPg: true, pgPool: fakePool }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const { listManagementFeeRulesByLandlordIds } = await import('../../src/lib/managementFeeRules')

    const missingTableResult = await listManagementFeeRulesByLandlordIds(['l1'])
    assert.deepEqual(missingTableResult, { l1: [] })
    assert.equal(queries.some((sql) => /CREATE TABLE|CREATE INDEX/i.test(sql)), false)

    tableExists = true
    const existingTableResult = await listManagementFeeRulesByLandlordIds(['l1'])
    assert.equal(existingTableResult.l1[0].effective_from_month, '2025-12')
    assert.equal(existingTableResult.l1[0].management_fee_rate, 0.165)
  } finally {
    Module._load = originalLoad
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
