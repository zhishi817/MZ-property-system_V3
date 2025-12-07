import { v4 as uuid } from 'uuid'

export type KeySet = {
  id: string
  propertyId?: string
  set_type: 'guest' | 'spare_1' | 'spare_2' | 'other'
  status: 'available' | 'in_transit' | 'lost' | 'replaced' | 'retired'
  code?: string
  items: { item_type: 'key' | 'fob'; code: string; photo_url?: string; status?: string }[]
}

export type Property = {
  id: string
  code?: string
  address: string
  type: string
  capacity: number
  region?: string
  area_sqm?: number
  building_name?: string
  building_facilities?: string[]
  building_contact_name?: string
  building_contact_phone?: string
  building_contact_email?: string
  bed_config?: string
  tv_model?: string
  wifi_ssid?: string
  wifi_password?: string
  router_location?: string
  safety_smoke_alarm?: string
  safety_extinguisher?: string
  safety_first_aid?: string
  notes?: string
  floor?: string
  parking_type?: string
  parking_space?: string
  access_type?: string
  access_guide_link?: string
  keybox_location?: string
  keybox_code?: string
  garage_guide_link?: string
}

export type Order = {
  id: string
  source: string
  external_id?: string
  property_id?: string
  property_code?: string
  guest_name?: string
  guest_phone?: string
  checkin?: string
  checkout?: string
  price?: number
  cleaning_fee?: number
  net_income?: number
  avg_nightly_price?: number
  nights?: number
  currency?: string
  status?: string
  idempotency_key?: string
}

export type Landlord = {
  id: string
  name: string
  phone?: string
  email?: string
  management_fee_rate?: number
  payout_bsb?: string
  payout_account?: string
  property_ids?: string[]
}

export type FinanceTransaction = {
  id: string
  kind: 'income' | 'expense'
  amount: number
  currency: string
  ref_type?: string
  ref_id?: string
  occurred_at: string
  note?: string
  category?: string
  property_id?: string
  invoice_url?: string
  category_detail?: string
}

export type Payout = {
  id: string
  landlord_id: string
  period_from: string
  period_to: string
  amount: number
  invoice_no?: string
  status: 'pending' | 'paid'
}

export type CompanyPayout = {
  id: string
  period_from: string
  period_to: string
  amount: number
  invoice_no?: string
  note?: string
  status: 'pending' | 'paid'
}

export type CleaningTask = {
  id: string
  property_id?: string
  date: string
  status: 'pending' | 'scheduled' | 'done'
  assignee_id?: string
  scheduled_at?: string
  old_code?: string
  new_code?: string
  note?: string
  checkout_time?: string
  checkin_time?: string
}

export const db = {
  keySets: [] as KeySet[],
  keyFlows: [] as { id: string; key_set_id: string; action: 'borrow'|'return'|'lost'|'replace'; handler_id?: string; timestamp: string; note?: string; old_code?: string; new_code?: string }[],
  orders: [] as Order[],
  cleaningTasks: [] as CleaningTask[],
  cleaners: [] as { id: string; name: string; capacity_per_day: number }[],
  properties: [] as Property[],
  inventoryItems: [] as { id: string; name: string; sku: string; unit: string; threshold: number; bin_location?: string; quantity: number }[],
  stockMovements: [] as { id: string; item_id: string; type: 'in'|'out'; quantity: number; handler_id?: string; timestamp: string }[],
  audits: [] as { id: string; actor_id?: string; action: string; entity: string; entity_id: string; before?: any; after?: any; timestamp: string }[],
  landlords: [] as Landlord[],
  financeTransactions: [] as FinanceTransaction[],
  payouts: [] as Payout[],
  companyPayouts: [] as CompanyPayout[],
  users: [] as { id: string; email: string; username?: string; role: string; password_hash?: string }[],
  roles: [] as { id: string; name: string }[],
  permissions: [] as { code: string; name?: string }[],
  rolePermissions: [] as { role_id: string; permission_code: string }[],
}

// seed sample data
if (db.keySets.length === 0) {
  db.keySets.push(
    {
      id: uuid(),
      set_type: 'guest',
      status: 'available',
      code: 'G-1001',
      items: [
        { item_type: 'key', code: 'K-G-1001' },
        { item_type: 'fob', code: 'F-G-1001' },
      ],
    },
    {
      id: uuid(),
      set_type: 'spare_1',
      status: 'available',
      code: 'S1-1001',
      items: [
        { item_type: 'key', code: 'K-S1-1001' },
        { item_type: 'fob', code: 'F-S1-1001' },
      ],
    },
    {
      id: uuid(),
      set_type: 'spare_2',
      status: 'in_transit',
      code: 'S2-1001',
      items: [
        { item_type: 'key', code: 'K-S2-1001' },
        { item_type: 'fob', code: 'F-S2-1001' },
      ],
    },
  )
}

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

if (db.cleaningTasks.length === 0) {
  const today = new Date()
  for (let i = 0; i < 10; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    db.cleaningTasks.push({ id: uuid(), date: formatDate(d), status: i % 3 === 0 ? 'scheduled' : 'pending' })
  }
}

if (db.cleaners.length === 0) {
  db.cleaners.push(
    { id: uuid(), name: 'Alice', capacity_per_day: 4 },
    { id: uuid(), name: 'Bob', capacity_per_day: 3 },
    { id: uuid(), name: 'Charlie', capacity_per_day: 5 },
  )
}

if (db.properties.length === 0) {
  db.properties.push(
    { id: uuid(), code: 'RM-1001', address: '123 Collins St, Melbourne', type: '2b2b', capacity: 4, region: 'Melbourne City', area_sqm: 65, building_name: 'Collins Tower', building_facilities: ['gym','pool'], bed_config: 'Queen×1, Single×2', wifi_ssid: 'Collins123', wifi_password: 'pass123', safety_smoke_alarm: 'ok', safety_extinguisher: 'ok', floor: '23', parking_type: 'garage', parking_space: 'B2-17', access_type: 'keybox', keybox_location: 'Lobby left wall', keybox_code: '4321', garage_guide_link: 'https://example.com/garage' },
    { id: uuid(), code: 'RM-1002', address: '88 Southbank Blvd, Melbourne', type: '1b1b', capacity: 2, region: 'Southbank', area_sqm: 45, building_name: 'Southbank One', building_facilities: ['gym'], bed_config: 'Queen×1', wifi_ssid: 'SB88', wifi_password: 'pwd88', floor: '12', parking_type: 'visitor', access_type: 'smartlock' }
  )
}

if (db.inventoryItems.length === 0) {
  const id1 = uuid()
  const id2 = uuid()
  db.inventoryItems.push(
    { id: id1, name: '纸巾', sku: 'TP-001', unit: '包', threshold: 10, bin_location: 'A1', quantity: 8 },
    { id: id2, name: '洗涤液', sku: 'DL-002', unit: '瓶', threshold: 5, bin_location: 'B2', quantity: 12 },
  )
}

export function addAudit(entity: string, entity_id: string, action: string, before: any, after: any, actor_id?: string) {
  db.audits.push({ id: uuid(), actor_id, action, entity, entity_id, before, after, timestamp: new Date().toISOString() })
}

if (db.landlords.length === 0) {
  const p1 = db.properties[0]?.id
  const p2 = db.properties[1]?.id
  db.landlords.push(
    { id: uuid(), name: 'MZ Holdings', phone: '0400 000 000', email: 'owner@mz.com', management_fee_rate: 0.1, payout_bsb: '062000', payout_account: '123456', property_ids: p1 ? [p1] : [] },
    { id: uuid(), name: 'John Doe', phone: '0411 111 111', email: 'john@example.com', management_fee_rate: 0.08, payout_bsb: '063000', payout_account: '654321', property_ids: p2 ? [p2] : [] }
  )
}

if (db.financeTransactions.length === 0) {
  db.financeTransactions.push(
    { id: uuid(), kind: 'income', amount: 220.0, currency: 'AUD', ref_type: 'order', ref_id: 'o-1', occurred_at: new Date().toISOString(), note: '房费' },
    { id: uuid(), kind: 'expense', amount: 60.0, currency: 'AUD', ref_type: 'cleaning', ref_id: 'w-1', occurred_at: new Date().toISOString(), note: '清洁费' }
  )
}

if (db.payouts.length === 0 && db.landlords.length) {
  const l = db.landlords[0]
  db.payouts.push({ id: uuid(), landlord_id: l.id, period_from: '2025-11-01', period_to: '2025-11-30', amount: 1200, invoice_no: 'INV-001', status: 'pending' })
}

// RBAC seed
if (db.roles.length === 0) {
  const adminId = uuid()
  const csId = uuid() // 客服
  const cleanMgrId = uuid() // 清洁/检查管理员人员
  const cleanerId = uuid() // 清洁和检查人员
  const financeId = uuid() // 财务人员
  const inventoryId = uuid() // 仓库管理员
  const maintenanceId = uuid() // 维修人员
  db.roles.push(
    { id: adminId, name: 'admin' },
    { id: csId, name: 'customer_service' },
    { id: cleanMgrId, name: 'cleaning_manager' },
    { id: cleanerId, name: 'cleaner_inspector' },
    { id: financeId, name: 'finance_staff' },
    { id: inventoryId, name: 'inventory_manager' },
    { id: maintenanceId, name: 'maintenance_staff' },
  )
  db.permissions = [
    { code: 'property.write' },
    { code: 'order.view' },
    { code: 'order.create' },
    { code: 'order.write' },
    { code: 'order.sync' },
    { code: 'keyset.manage' },
    { code: 'key.flow' },
    { code: 'cleaning.view' },
    { code: 'cleaning.schedule.manage' },
    { code: 'cleaning.task.assign' },
    { code: 'finance.payout' },
    { code: 'finance.tx.write' },
    { code: 'inventory.move' },
    { code: 'landlord.manage' },
    { code: 'rbac.manage' },
    // menu visibility controls
    { code: 'menu.dashboard' },
    { code: 'menu.landlords' },
    { code: 'menu.properties' },
    { code: 'menu.keys' },
    { code: 'menu.inventory' },
    { code: 'menu.finance' },
    { code: 'menu.cleaning' },
    { code: 'menu.rbac' },
    { code: 'menu.cms' },
    // submenu visibles
    { code: 'menu.properties.list.visible' },
    { code: 'menu.properties.keys.visible' },
    { code: 'menu.properties.maintenance.visible' },
    { code: 'menu.finance.expenses.visible' },
    { code: 'menu.finance.recurring.visible' },
    { code: 'menu.finance.orders.visible' },
    { code: 'menu.finance.company_overview.visible' },
    { code: 'menu.finance.company_revenue.visible' },
  ]
  function grant(roleId: string, codes: string[]) {
    codes.forEach(c => db.rolePermissions.push({ role_id: roleId, permission_code: c }))
  }
  // 管理员：所有权限
  grant(adminId, db.permissions.map(p => p.code))
  // 客服：房源可写、订单查看/编辑、查看清洁安排、可管理订单（允许创建）、允许录入公司/房源支出
  grant(csId, ['property.write','order.view','order.write','order.manage','cleaning.view','finance.tx.write','menu.dashboard','menu.properties','menu.finance','menu.cleaning','menu.cms'])
  // 清洁/检查管理员：清洁排班与任务分配（仅查看房源，无写权限）
  grant(cleanMgrId, ['cleaning.schedule.manage','cleaning.task.assign','menu.cleaning','menu.dashboard'])
  // 清洁/检查人员：无写权限，仅查看（后端接口默认允许 GET）
  grant(cleanerId, ['menu.cleaning','menu.dashboard'])
  // 财务人员：财务结算与交易录入、房东/房源管理
  grant(financeId, ['finance.payout','finance.tx.write','landlord.manage','property.write','menu.finance','menu.landlords','menu.properties','menu.dashboard'])
  // 仓库管理员：仓库与钥匙管理
  grant(inventoryId, ['inventory.move','keyset.manage','key.flow','menu.inventory','menu.keys','menu.dashboard'])
  // 维修人员：暂无写接口，预留
  grant(maintenanceId, ['menu.dashboard'])
}

const defaultPerms = [
  'property.view','property.write',
  'order.view','order.create','order.write','order.sync','order.manage',
  'keyset.manage','key.flow',
  'cleaning.view','cleaning.schedule.manage','cleaning.task.assign',
  'finance.payout','finance.tx.write',
  'inventory.move','landlord.manage',
  'rbac.manage',
  'menu.dashboard','menu.landlords','menu.properties','menu.keys','menu.inventory','menu.finance','menu.cleaning','menu.rbac','menu.cms'
]
defaultPerms.forEach((code) => { if (!db.permissions.find(p => p.code === code)) db.permissions.push({ code }) })
const adminRole = db.roles.find(r => r.name === 'admin')
if (adminRole) {
  defaultPerms.forEach((code) => {
    if (!db.rolePermissions.find(rp => rp.role_id === adminRole.id && rp.permission_code === code)) {
      db.rolePermissions.push({ role_id: adminRole.id, permission_code: code })
    }
  })
}

// granular CRUD resource permissions
const resources = [
  'properties','landlords','orders','cleaning_tasks','finance_transactions','company_expenses','property_expenses','fixed_expenses','company_incomes','property_incomes','recurring_payments','cms_pages','payouts','company_payouts','users','property_maintenance'
]
resources.forEach(r => {
  const viewCode = `${r}.view`
  const writeCode = `${r}.write`
  const delCode = `${r}.delete`
  if (!db.permissions.find(p => p.code === viewCode)) db.permissions.push({ code: viewCode })
  if (!db.permissions.find(p => p.code === writeCode)) db.permissions.push({ code: writeCode })
  if (!db.permissions.find(p => p.code === delCode)) db.permissions.push({ code: delCode })
  if (adminRole) {
    if (!db.rolePermissions.find(rp => rp.role_id === adminRole.id && rp.permission_code === viewCode)) db.rolePermissions.push({ role_id: adminRole.id, permission_code: viewCode })
    if (!db.rolePermissions.find(rp => rp.role_id === adminRole.id && rp.permission_code === writeCode)) db.rolePermissions.push({ role_id: adminRole.id, permission_code: writeCode })
    if (!db.rolePermissions.find(rp => rp.role_id === adminRole.id && rp.permission_code === delCode)) db.rolePermissions.push({ role_id: adminRole.id, permission_code: delCode })
  }
})

export function getRoleIdByName(name: string): string | undefined {
  return db.roles.find(r => r.name === name)?.id
}

export function roleHasPermission(roleName: string, perm: string): boolean {
  if (roleName === 'admin') return true
  const rid = getRoleIdByName(roleName)
  if (!rid) return false
  return db.rolePermissions.some(rp => rp.role_id === rid && rp.permission_code === perm)
}
