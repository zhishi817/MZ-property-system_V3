import assert from 'assert'
import fs from 'fs'
import path from 'path'

process.env.DATABASE_URL = ''

async function main() {
  const { canViewFormPhotoTaskRows, formPhotoMediaType } = await import('../../src/modules/mzapp')
  const rows = [{
    id: 'form-photo-task-1',
    task_date: '2026-07-24',
    property_id: 'property-1',
    property_code: 'RM-1001',
    inspector_id: 'inspector-1',
    cleaner_id: 'cleaner-1',
    assignee_id: 'executor-1',
  }]

  assert.equal(await canViewFormPhotoTaskRows({ role: 'cleaner' }, rows, 'cleaner-1'), true)
  assert.equal(await canViewFormPhotoTaskRows({ role: 'cleaning_inspector' }, rows, 'inspector-1'), true)
  assert.equal(await canViewFormPhotoTaskRows({ role: 'cleaner' }, rows, 'outsider-1'), false)
  assert.equal(await canViewFormPhotoTaskRows({ role: 'admin' }, rows, 'admin-1'), true)
  assert.deepEqual(formPhotoMediaType('inspection_living'), { source: 'inspection', area: 'living' })
  assert.deepEqual(formPhotoMediaType('inspection_balcony'), { source: 'inspection', area: 'balcony' })
  assert.equal(formPhotoMediaType('inspection_consumables_confirmed'), null)
  assert.deepEqual(formPhotoMediaType('restock_proof:coffee'), { source: 'restock', item_id: 'coffee' })

  const source = fs.readFileSync(path.resolve(__dirname, '../../src/modules/mzapp.ts'), 'utf8')
  const start = source.indexOf("router.get('/work-tasks/:id/form-photos'")
  const end = source.indexOf("router.get('/cleaning-tasks/:id/inspection-photos'", start)
  assert(start >= 0 && end > start, 'form photo read route must exist')
  const routeSource = source.slice(start, end)
  assert(!/ensureCleaning(TaskMedia|ChecklistTables)|CREATE TABLE|ALTER TABLE|CREATE INDEX|INSERT INTO/i.test(routeSource), 'form photo GET must remain pure read')

  for (const moduleName of ['cleaning_app', 'mzapp']) {
    const moduleSource = fs.readFileSync(path.resolve(__dirname, `../../src/modules/${moduleName}.ts`), 'utf8')
    assert.match(moduleSource, /area: z\.enum\(\[[\s\S]*?'bathroom'/, `${moduleName} inspection photo schema must accept bathroom`)
    assert.match(moduleSource, /bathroom:\s*3/, `${moduleName} inspection photo limit must be three`)
    assert.match(moduleSource, /area: z\.enum\(\[[\s\S]*?'balcony'/, `${moduleName} inspection photo schema must accept balcony`)
    assert.match(moduleSource, /balcony:\s*3/, `${moduleName} balcony inspection photo limit must be three`)
  }
  const actionAuditSource = fs.readFileSync(path.resolve(__dirname, '../../src/lib/workTaskActionAudit.ts'), 'utf8')
  assert.match(actionAuditSource, /'inspection_bathroom'/, 'inspection action photo gate must count bathroom media')
  assert.match(actionAuditSource, /'inspection_balcony'/, 'inspection action photo gate must count balcony media')
  process.stdout.write('test_mzapp_form_photo_read: ok\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
