import { Router } from 'express'
import { db, addAudit } from '../store'
import { z } from 'zod'
import { requireAnyPerm, requirePerm } from '../auth'
import { hasPg, pgPool, pgRunInTransaction } from '../dbAdapter'
import { v4 as uuidv4 } from 'uuid'
import multer from 'multer'
import path from 'path'
import { resizeUploadImage } from '../lib/uploadImageResize'
import { hasR2, r2Upload } from '../r2'

export const router = Router()

const upload = multer({ storage: multer.memoryStorage() })

function actorId(req: any) {
  const u = req?.user || {}
  return u?.sub || u?.username || null
}

function httpError(statusCode: number, message: string) {
  const err: any = new Error(message)
  err.statusCode = statusCode
  return err
}

function remapInventoryPgError(error: any) {
  const code = String(error?.code || '')
  if (code === '55P03' || code === '57014') return httpError(409, '库存正在被其他操作占用，请稍后重试')
  return error
}

function requestTraceId(req: any) {
  return String(req?.traceId || req?.headers?.['x-trace-id'] || req?.headers?.['x-request-id'] || '').trim()
}

function withTracePayload(req: any, payload: Record<string, any>) {
  const traceId = requestTraceId(req)
  return traceId ? { ...payload, trace_id: traceId } : payload
}

function inventoryLog(req: any, level: 'log' | 'warn' | 'error', event: string, payload?: Record<string, any>) {
  const traceId = requestTraceId(req)
  const body = {
    trace_id: traceId || undefined,
    event,
    ...(payload || {}),
  }
  try {
    console[level](`[inventory] ${JSON.stringify(body)}`)
  } catch {
    console[level](`[inventory] event=${event} trace_id=${traceId}`)
  }
}

function sendInventoryError(req: any, res: any, error: any) {
  const remapped = remapInventoryPgError(error)
  const statusCode = Number(remapped?.statusCode || remapped?.status || 500)
  const code = Number.isFinite(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500
  const message = String(remapped?.message || 'failed')
  inventoryLog(req, code >= 500 ? 'error' : 'warn', 'request_failed', { status: code, message })
  return res.status(code).json(withTracePayload(req, { message }))
}

function randomSuffix(len: number) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function isSmWarehouseRow(row: any) {
  const id = String(row?.id || '').trim().toLowerCase()
  const code = String(row?.code || '').trim().toLowerCase()
  const name = String(row?.name || '').trim().toLowerCase()
  return id === 'wh.south_melbourne' || code === 'sou' || name.includes('south melbourne')
}

function toDayStartIsoMelbourne(daysFromToday = 0) {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const mel = new Date(utc + 10 * 60 * 60000)
  mel.setHours(0, 0, 0, 0)
  mel.setDate(mel.getDate() + Number(daysFromToday || 0))
  return mel.toISOString()
}

function buildDailyItemSku(id: string) {
  const raw = String(id || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase()
  return `DY-${(raw || 'ITEM').slice(0, 8)}`
}

function toDailyInventoryItemId(priceId: string) {
  return `item.daily_price.${String(priceId || '').trim()}`
}

function buildConsumableItemSku(id: string) {
  const raw = String(id || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase()
  return `CO-${(raw || 'ITEM').slice(0, 8)}`
}

function toConsumableInventoryItemId(priceId: string) {
  return `item.consumable_price.${String(priceId || '').trim()}`
}

function buildOtherItemSku(id: string) {
  const raw = String(id || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase()
  return `OT-${(raw || 'ITEM').slice(0, 8)}`
}

function toOtherInventoryItemId(priceId: string) {
  return `item.other_price.${String(priceId || '').trim()}`
}

async function ensureDailyPriceListSchema(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await client.query(`CREATE TABLE IF NOT EXISTS daily_items_price_list (
    id text PRIMARY KEY,
    category text,
    item_name text NOT NULL,
    sku text,
    cost_unit_price numeric NOT NULL DEFAULT 0,
    unit_price numeric NOT NULL,
    currency text DEFAULT 'AUD',
    unit text,
    default_quantity integer,
    is_active boolean DEFAULT true,
    updated_at timestamptz,
    updated_by text
  );`)
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);')
  await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS sku text;')
  await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS cost_unit_price numeric NOT NULL DEFAULT 0;')
  await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS unit text;')
  await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;')
}

async function backfillDailyPriceSkus(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  const rows = await client.query(`SELECT id FROM daily_items_price_list WHERE COALESCE(NULLIF(TRIM(sku), ''), '') = ''`)
  for (const row of rows.rows || []) {
    const id = String(row?.id || '')
    if (!id) continue
    await client.query(`UPDATE daily_items_price_list SET sku = $1 WHERE id = $2`, [buildDailyItemSku(id), id])
  }
}

async function syncDailyInventoryItemFromPriceRow(row: any, executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureInventorySchema()
  const priceId = String(row?.id || '').trim()
  if (!priceId) return
  const sku = String(row?.sku || '').trim() || buildDailyItemSku(priceId)
  await client.query(
    `INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item, updated_at)
     VALUES ($1,$2,$3,'daily','daily_price',NULL,$4,0,NULL,$5,false,now())
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         sub_type = EXCLUDED.sub_type,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         updated_at = now()`,
    [toDailyInventoryItemId(priceId), String(row?.item_name || '').trim(), sku, String(row?.unit || '').trim() || 'pcs', row?.is_active !== false],
  )
}

async function syncAllDailyInventoryItems(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureDailyPriceListSchema(client)
  await backfillDailyPriceSkus(client)
  const rows = await client.query(`SELECT * FROM daily_items_price_list`)
  for (const row of rows.rows || []) await syncDailyInventoryItemFromPriceRow(row, client)
}

async function ensureConsumableChecklistSeed(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await client.query(`CREATE TABLE IF NOT EXISTS cleaning_checklist_items (
    id text PRIMARY KEY,
    label text NOT NULL,
    kind text NOT NULL DEFAULT 'consumable',
    required boolean NOT NULL DEFAULT true,
    requires_photo_when_low boolean NOT NULL DEFAULT true,
    active boolean NOT NULL DEFAULT true,
    sort_order integer,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_checklist_active_sort ON cleaning_checklist_items (active, sort_order, created_at);`)
  await client.query(
    `INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order)
     VALUES
      ('toilet_paper','卷纸','consumable',true,true,true,10),
      ('facial_tissue','抽纸','consumable',true,true,true,20),
      ('shampoo','洗发水','consumable',true,true,true,30),
      ('conditioner','护发素','consumable',true,true,true,40),
      ('body_wash','沐浴露','consumable',true,true,true,50),
      ('hand_soap','洗手液','consumable',true,true,true,60),
      ('dish_sponge','洗碗海绵','consumable',true,true,true,70),
      ('dish_soap','洗碗皂','consumable',true,true,true,80),
      ('tea_bags','茶包','consumable',true,true,true,90),
      ('coffee','咖啡','consumable',true,true,true,100),
      ('sugar_sticks','条装糖','consumable',true,true,true,110),
      ('bin_bags_large','大垃圾袋（有大垃圾桶才需要）','consumable',true,true,true,120),
      ('bin_bags_small','小垃圾袋','consumable',true,true,true,130),
      ('dish_detergent','洗洁精','consumable',true,true,true,140),
      ('laundry_powder','洗衣粉','consumable',true,true,true,150),
      ('cooking_oil','食用油','consumable',true,true,true,160),
      ('salt_sugar','盐糖','consumable',true,true,true,170),
      ('pepper','花椒（替换旧的花椒瓶带走）','consumable',true,true,true,180),
      ('toilet_cleaner','洁厕灵','consumable',true,true,true,190),
      ('bleach','漂白水（房间里用空的瓶子不要扔掉）','consumable',true,true,true,200),
      ('spare_pillowcase','备用枕套','consumable',true,true,true,210),
      ('other','其他','consumable',false,true,true,900)
     ON CONFLICT (id) DO NOTHING`,
  )
}

async function ensureOtherPriceListSchema(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await client.query(`CREATE TABLE IF NOT EXISTS other_items_price_list (
    id text PRIMARY KEY,
    item_name text NOT NULL,
    sku text,
    cost_unit_price numeric NOT NULL DEFAULT 0,
    unit_price numeric NOT NULL DEFAULT 0,
    currency text DEFAULT 'AUD',
    unit text,
    default_quantity integer,
    sort_order integer,
    is_active boolean DEFAULT true,
    updated_at timestamptz,
    updated_by text
  );`)
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_other_items_price_name ON other_items_price_list(item_name);')
  await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS sku text;')
  await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS cost_unit_price numeric NOT NULL DEFAULT 0;')
  await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS unit_price numeric NOT NULL DEFAULT 0;')
  await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS unit text;')
  await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;')
  await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS sort_order integer;')
}

async function backfillOtherSkus(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  const rows = await client.query(`SELECT id FROM other_items_price_list WHERE COALESCE(NULLIF(TRIM(sku), ''), '') = ''`)
  for (const row of rows.rows || []) {
    const id = String(row?.id || '')
    if (!id) continue
    await client.query(`UPDATE other_items_price_list SET sku = $1 WHERE id = $2`, [buildOtherItemSku(id), id])
  }
}

async function syncOtherInventoryItemFromPriceRow(row: any, executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureInventorySchema()
  const priceId = String(row?.id || '').trim()
  if (!priceId) return
  const sku = String(row?.sku || '').trim() || buildOtherItemSku(priceId)
  await client.query(
    `INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item, updated_at)
     VALUES ($1,$2,$3,'other','other_price',NULL,$4,0,NULL,$5,false,now())
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         sub_type = EXCLUDED.sub_type,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         updated_at = now()`,
    [toOtherInventoryItemId(priceId), String(row?.item_name || '').trim(), sku, String(row?.unit || '').trim() || 'pcs', row?.is_active !== false],
  )
}

async function syncAllOtherInventoryItems(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureOtherPriceListSchema(client)
  await backfillOtherSkus(client)
  const rows = await client.query(`SELECT * FROM other_items_price_list`)
  for (const row of rows.rows || []) await syncOtherInventoryItemFromPriceRow(row, client)
}

async function ensureConsumablePriceListSchema(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureConsumableChecklistSeed(client)
  const tableExists = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'consumable_items_price_list'
      LIMIT 1`,
  )
  if (!tableExists.rowCount) {
    const orphanType = await client.query(
      `SELECT 1
         FROM pg_type
        WHERE typname = 'consumable_items_price_list'
        LIMIT 1`,
    )
    if (orphanType.rowCount) {
      await client.query(`DROP TYPE IF EXISTS consumable_items_price_list`)
    }
    await client.query(`CREATE TABLE consumable_items_price_list (
      id text PRIMARY KEY,
      item_name text NOT NULL,
      sku text,
      cost_unit_price numeric NOT NULL DEFAULT 0,
      unit_price numeric NOT NULL DEFAULT 0,
      currency text DEFAULT 'AUD',
      unit text,
      default_quantity integer,
      sort_order integer,
      is_active boolean DEFAULT true,
      updated_at timestamptz,
      updated_by text
    );`)
  }
  await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS sku text;')
  await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS cost_unit_price numeric NOT NULL DEFAULT 0;')
  await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS unit_price numeric NOT NULL DEFAULT 0;')
  await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS unit text;')
  await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;')
  await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS sort_order integer;')
}

async function backfillConsumableSkus(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  const rows = await client.query(`SELECT id FROM consumable_items_price_list WHERE COALESCE(NULLIF(TRIM(sku), ''), '') = ''`)
  for (const row of rows.rows || []) {
    const id = String(row?.id || '')
    if (!id) continue
    await client.query(`UPDATE consumable_items_price_list SET sku = $1 WHERE id = $2`, [buildConsumableItemSku(id), id])
  }
}

async function syncConsumablePriceListFromChecklist(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureConsumablePriceListSchema(client)
  const checklistRows = await client.query(
    `SELECT id, label, active, sort_order
     FROM cleaning_checklist_items
     WHERE kind = 'consumable' AND id NOT IN ('spare_pillowcase', 'other')
     ORDER BY sort_order ASC NULLS LAST, label ASC`,
  )
  for (const row of checklistRows.rows || []) {
    const id = String(row?.id || '').trim()
    if (!id) continue
    await client.query(
      `INSERT INTO consumable_items_price_list (id, item_name, sku, cost_unit_price, unit_price, currency, unit, default_quantity, sort_order, is_active)
       VALUES ($1,$2,$3,0,0,'AUD','pcs',1,$4,$5)
       ON CONFLICT (id) DO UPDATE
       SET item_name = EXCLUDED.item_name,
           sort_order = EXCLUDED.sort_order,
           is_active = EXCLUDED.is_active`,
      [id, String(row?.label || '').trim(), buildConsumableItemSku(id), row?.sort_order ?? null, row?.active !== false],
    )
  }
  await client.query(`DELETE FROM consumable_items_price_list WHERE id IN ('spare_pillowcase', 'other')`)
  await backfillConsumableSkus(client)
}

async function syncConsumableInventoryItemFromPriceRow(row: any, executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await ensureInventorySchema()
  const priceId = String(row?.id || '').trim()
  if (!priceId) return
  const sku = String(row?.sku || '').trim() || buildConsumableItemSku(priceId)
  await client.query(
    `INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item, updated_at)
     VALUES ($1,$2,$3,'consumable','consumable_price',NULL,$4,0,NULL,$5,false,now())
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         sub_type = EXCLUDED.sub_type,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         updated_at = now()`,
    [toConsumableInventoryItemId(priceId), String(row?.item_name || '').trim(), sku, String(row?.unit || '').trim() || 'pcs', row?.is_active !== false],
  )
}

async function syncAllConsumableInventoryItems(executor?: any) {
  const client = executor || pgPool
  if (!client) return
  await syncConsumablePriceListFromChecklist(client)
  const rows = await client.query(`SELECT * FROM consumable_items_price_list`)
  for (const row of rows.rows || []) await syncConsumableInventoryItemFromPriceRow(row, client)
}

let inventorySchemaEnsured = false
let inventorySchemaEnsurePromise: Promise<void> | null = null
let dailyInventorySyncEnsured = false
let consumableInventorySyncEnsured = false
let consumablePriceListSeedEnsured = false
let otherInventorySyncEnsured = false
let inventoryWarehousesFirstRequestLogged = false

async function ensureDailyInventoryItemsSynced() {
  if (dailyInventorySyncEnsured) return
  if (!pgPool) return
  dailyInventorySyncEnsured = true
  try {
    await syncAllDailyInventoryItems()
  } catch (e) {
    dailyInventorySyncEnsured = false
    throw e
  }
}

async function ensureConsumableInventoryItemsSynced() {
  if (consumableInventorySyncEnsured) return
  if (!pgPool) return
  consumableInventorySyncEnsured = true
  try {
    await syncAllConsumableInventoryItems()
  } catch (e) {
    consumableInventorySyncEnsured = false
    throw e
  }
}

async function ensureConsumablePriceListSeeded() {
  if (consumablePriceListSeedEnsured) return
  if (!pgPool) return
  consumablePriceListSeedEnsured = true
  try {
    await syncConsumablePriceListFromChecklist()
  } catch (e) {
    consumablePriceListSeedEnsured = false
    throw e
  }
}

async function ensureOtherInventoryItemsSynced() {
  if (otherInventorySyncEnsured) return
  if (!(hasPg && pgPool)) return
  otherInventorySyncEnsured = true
  try {
    await syncAllOtherInventoryItems()
  } catch (error) {
    otherInventorySyncEnsured = false
    throw error
  }
}

async function ensureInventorySchema() {
  if (!pgPool) return
  if (inventorySchemaEnsured) return
  if (inventorySchemaEnsurePromise) {
    await inventorySchemaEnsurePromise
    return
  }
  inventorySchemaEnsurePromise = (async () => {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS warehouses (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL,
      linen_capacity_sets integer,
      stocktake_enabled boolean NOT NULL DEFAULT true,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS stocktake_enabled boolean NOT NULL DEFAULT true;')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouses_code') THEN
        ALTER TABLE warehouses ADD CONSTRAINT unique_warehouses_code UNIQUE (code);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_items (
      id text PRIMARY KEY,
      name text NOT NULL,
      sku text NOT NULL,
      category text NOT NULL DEFAULT 'consumable',
      unit text NOT NULL,
      default_threshold integer NOT NULL DEFAULT 0,
      bin_location text,
      active boolean NOT NULL DEFAULT true,
      is_key_item boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_items_sku') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT unique_inventory_items_sku UNIQUE (sku);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_active ON inventory_items(active);')
    await pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sub_type text;')
    await pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS linen_type_code text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category_sub_type ON inventory_items(category, sub_type);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_linen_type ON inventory_items(linen_type_code);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_linen_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      psl_code text,
      in_set boolean NOT NULL DEFAULT true,
      set_divisor integer NOT NULL DEFAULT 1,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('ALTER TABLE inventory_linen_types ADD COLUMN IF NOT EXISTS psl_code text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_types_active_sort ON inventory_linen_types(active, sort_order, code);')
    await pgPool.query(`INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active) VALUES
      ('bedsheet','床单',true,1,10,true),
      ('duvet_cover','被套',true,1,20,true),
      ('pillowcase','枕套',true,2,30,true),
      ('hand_towel','手巾',true,1,35,true),
      ('bath_mat','地巾',true,1,36,true),
      ('tea_towel','茶巾',true,1,37,true),
      ('bath_towel','浴巾',true,1,40,true)
    ON CONFLICT (code) DO NOTHING;`)

    await pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
      VALUES
        ('item.linen_type.bedsheet','床单','LT:bedsheet','linen','bedsheet','pcs',0,NULL,true,false),
        ('item.linen_type.duvet_cover','被套','LT:duvet_cover','linen','duvet_cover','pcs',0,NULL,true,false),
        ('item.linen_type.pillowcase','枕套','LT:pillowcase','linen','pillowcase','pcs',0,NULL,true,false),
        ('item.linen_type.hand_towel','手巾','LT:hand_towel','linen','hand_towel','pcs',0,NULL,true,false),
        ('item.linen_type.bath_mat','地巾','LT:bath_mat','linen','bath_mat','pcs',0,NULL,true,false),
        ('item.linen_type.tea_towel','茶巾','LT:tea_towel','linen','tea_towel','pcs',0,NULL,true,false),
        ('item.linen_type.bath_towel','浴巾','LT:bath_towel','linen','bath_towel','pcs',0,NULL,true,false)
      ON CONFLICT (id) DO NOTHING;`)
    await pgPool.query(`
      INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
      SELECT
        'item.linen_type.' || lt.code AS id,
        lt.name,
        'LT:' || lt.code AS sku,
        'linen' AS category,
        lt.code AS linen_type_code,
        'pcs' AS unit,
        0 AS default_threshold,
        NULL AS bin_location,
        lt.active,
        false AS is_key_item
      FROM inventory_linen_types lt
      WHERE NOT EXISTS (
        SELECT 1
        FROM inventory_items i
        WHERE i.category = 'linen' AND i.linen_type_code = lt.code
      )
      ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          active = EXCLUDED.active,
          linen_type_code = EXCLUDED.linen_type_code
    `)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      bedrooms integer,
      bathrooms integer,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_types_active_sort ON inventory_room_types(active, sort_order, code);')
    await pgPool.query(`INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active) VALUES
      ('1b1b','一房一卫',1,1,10,true),
      ('2b1b','两房一卫',2,1,20,true),
      ('2b2b','两房两卫',2,2,30,true),
      ('3b2b','三房两卫',3,2,40,true),
      ('3b3b','三房三卫',3,3,50,true)
    ON CONFLICT (code) DO NOTHING;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_type_requirements (
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE CASCADE,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      PRIMARY KEY (room_type_code, linen_type_code)
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_type_req_room ON inventory_room_type_requirements(room_type_code);')

    await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text;')
    await pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS linen_service_warehouse_id text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_properties_room_type_code ON properties(room_type_code);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS warehouse_stocks (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity integer NOT NULL DEFAULT 0,
      threshold integer,
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouse_item') THEN
        ALTER TABLE warehouse_stocks ADD CONSTRAINT unique_warehouse_item UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_wh ON warehouse_stocks(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_item ON warehouse_stocks(item_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stock_policies (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      reserve_qty integer NOT NULL DEFAULT 0,
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_stock_policy') THEN
        ALTER TABLE inventory_stock_policies ADD CONSTRAINT unique_inventory_stock_policy UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_wh ON inventory_stock_policies(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_item ON inventory_stock_policies(item_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS suppliers (
      id text PRIMARY KEY,
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'linen',
      supply_items_note text,
      login_url text,
      login_username text,
      login_password text,
      login_note text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supply_items_note text;')
    await pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_url text;')
    await pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_username text;')
    await pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_password text;')
    await pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_note text;')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS supplier_item_prices (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      purchase_unit_price numeric NOT NULL DEFAULT 0,
      refund_unit_price numeric NOT NULL DEFAULT 0,
      effective_from date,
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_supplier_item_price') THEN
        ALTER TABLE supplier_item_prices ADD CONSTRAINT unique_supplier_item_price UNIQUE (supplier_id, item_id);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_supplier ON supplier_item_prices(supplier_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_item ON supplier_item_prices(item_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS region_supplier_rules (
      id text PRIMARY KEY,
      region_key text NOT NULL,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      priority integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_region ON region_supplier_rules(region_key);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_active ON region_supplier_rules(active);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
      id text PRIMARY KEY,
      po_no text,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'draft',
      ordered_date date,
      requested_delivery_date date,
      region text,
      property_id text,
      note text,
      subtotal_amount numeric NOT NULL DEFAULT 0,
      gst_amount numeric NOT NULL DEFAULT 0,
      total_amount_inc_gst numeric NOT NULL DEFAULT 0,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_region ON purchase_orders(region);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_property ON purchase_orders(property_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_ordered_date ON purchase_orders(ordered_date);')
    await pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_no text;')
    await pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS subtotal_amount numeric NOT NULL DEFAULT 0;')
    await pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS gst_amount numeric NOT NULL DEFAULT 0;')
    await pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS total_amount_inc_gst numeric NOT NULL DEFAULT 0;')
    await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_po_no_unique ON purchase_orders(po_no) WHERE po_no IS NOT NULL;')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      unit text NOT NULL,
      unit_price numeric,
      note text
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines(po_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item ON purchase_order_lines(item_id);')
    await pgPool.query('ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS amount_total numeric;')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_deliveries (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      received_at timestamptz NOT NULL DEFAULT now(),
      received_by text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_po ON purchase_deliveries(po_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_received_at ON purchase_deliveries(received_at);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_delivery_lines (
      id text PRIMARY KEY,
      delivery_id text NOT NULL REFERENCES purchase_deliveries(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity_received integer NOT NULL,
      note text
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_delivery_lines_delivery ON purchase_delivery_lines(delivery_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS stock_movements (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      type text NOT NULL,
      reason text,
      quantity integer NOT NULL,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      ref_type text,
      ref_id text,
      actor_id text,
      note text,
      photo_url text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_wh ON stock_movements(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_property ON stock_movements(property_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_type_check') THEN
        ALTER TABLE stock_movements
          ADD CONSTRAINT stock_movements_type_check
          CHECK (type IN ('in','out','adjust'));
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_linen_usage_records (
      id text PRIMARY KEY,
      usage_key text NOT NULL,
      usage_date date NOT NULL,
      source_type text NOT NULL,
      source_ref text NOT NULL,
      cleaning_task_id text,
      property_id text REFERENCES properties(id) ON DELETE SET NULL,
      property_code text,
      room_type_code text REFERENCES inventory_room_types(code) ON DELETE SET NULL,
      warehouse_id text REFERENCES warehouses(id) ON DELETE SET NULL,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      quantity integer NOT NULL DEFAULT 0,
      actor_id text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_linen_usage_records_usage_key_unique') THEN
        ALTER TABLE inventory_linen_usage_records
          ADD CONSTRAINT inventory_linen_usage_records_usage_key_unique
          UNIQUE (usage_key);
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_date ON inventory_linen_usage_records(usage_date DESC, created_at DESC);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_source ON inventory_linen_usage_records(source_type, source_ref);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_property ON inventory_linen_usage_records(property_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_wh ON inventory_linen_usage_records(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_linen_type ON inventory_linen_usage_records(linen_type_code);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_transfer_records (
      id text PRIMARY KEY,
      from_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      to_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'completed',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz,
      cancelled_by text,
      cancelled_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfer_records_status_check') THEN
        ALTER TABLE inventory_transfer_records
          ADD CONSTRAINT inventory_transfer_records_status_check
          CHECK (status IN ('completed','cancelled'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_created_at ON inventory_transfer_records(created_at DESC);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_from_wh ON inventory_transfer_records(from_warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_to_wh ON inventory_transfer_records(to_warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_status ON inventory_transfer_records(status);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_transfer_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES inventory_transfer_records(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL DEFAULT 0
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_record_lines_record ON inventory_transfer_record_lines(record_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfer_record_lines_unique_item') THEN
        ALTER TABLE inventory_transfer_record_lines
          ADD CONSTRAINT inventory_transfer_record_lines_unique_item
          UNIQUE (record_id, item_id);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS stock_change_requests (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      type text NOT NULL DEFAULT 'out',
      quantity integer NOT NULL,
      reason text NOT NULL,
      note text,
      photo_url text,
      status text NOT NULL DEFAULT 'pending',
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      handled_by text,
      handled_at timestamptz,
      movement_id text
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_type_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_type_check
          CHECK (type IN ('out'));
      END IF;
    END $$;`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_status_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_status_check
          CHECK (status IN ('pending','approved','rejected'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_status ON stock_change_requests(status);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_reason ON stock_change_requests(reason);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_wh ON stock_change_requests(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_item ON stock_change_requests(item_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_created_at ON stock_change_requests(created_at);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stocktake_records (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      category text NOT NULL,
      stocktake_type text NOT NULL DEFAULT 'routine',
      stocktake_date date NOT NULL,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_stocktake_records_type_check') THEN
        ALTER TABLE inventory_stocktake_records
          ADD CONSTRAINT inventory_stocktake_records_type_check
          CHECK (stocktake_type IN ('initial','routine'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_records_wh ON inventory_stocktake_records(warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_records_category ON inventory_stocktake_records(category);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_records_date ON inventory_stocktake_records(stocktake_date DESC, created_at DESC);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stocktake_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES inventory_stocktake_records(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      previous_quantity integer NOT NULL DEFAULT 0,
      counted_quantity integer NOT NULL DEFAULT 0,
      delta_quantity integer NOT NULL DEFAULT 0
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_record_lines_record ON inventory_stocktake_record_lines(record_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_stocktake_record_lines_unique_item') THEN
        ALTER TABLE inventory_stocktake_record_lines
          ADD CONSTRAINT inventory_stocktake_record_lines_unique_item
          UNIQUE (record_id, item_id);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_plans (
      id text PRIMARY KEY,
      plan_date date NOT NULL,
      from_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      date_from date,
      date_to date,
      vehicle_capacity_sets integer,
      status text NOT NULL DEFAULT 'draft',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_plans_status_check') THEN
        ALTER TABLE linen_delivery_plans
          ADD CONSTRAINT linen_delivery_plans_status_check
          CHECK (status IN ('draft','planned','dispatched','cancelled'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_plans_plan_date ON linen_delivery_plans(plan_date DESC);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_plan_lines (
      id text PRIMARY KEY,
      plan_id text NOT NULL REFERENCES linen_delivery_plans(id) ON DELETE CASCADE,
      to_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      room_type_code text REFERENCES inventory_room_types(code) ON DELETE SET NULL,
      current_sets integer NOT NULL DEFAULT 0,
      demand_sets integer NOT NULL DEFAULT 0,
      target_sets integer NOT NULL DEFAULT 0,
      suggested_sets integer NOT NULL DEFAULT 0,
      actual_sets integer NOT NULL DEFAULT 0,
      warehouse_capacity_sets integer,
      vehicle_load_sets integer NOT NULL DEFAULT 0,
      note text
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_plan_lines_plan ON linen_delivery_plan_lines(plan_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_records (
      id text PRIMARY KEY,
      delivery_date date NOT NULL,
      from_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      to_warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'completed',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz,
      cancelled_by text,
      cancelled_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_records_status_check') THEN
        ALTER TABLE linen_delivery_records
          ADD CONSTRAINT linen_delivery_records_status_check
          CHECK (status IN ('completed','cancelled'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_delivery_date ON linen_delivery_records(delivery_date DESC);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_from_wh ON linen_delivery_records(from_warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_to_wh ON linen_delivery_records(to_warehouse_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_status ON linen_delivery_records(status);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES linen_delivery_records(id) ON DELETE CASCADE,
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE RESTRICT,
      room_type_name text,
      sets integer NOT NULL DEFAULT 0
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_record_lines_record ON linen_delivery_record_lines(record_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_record_lines_unique_room_type') THEN
        ALTER TABLE linen_delivery_record_lines
          ADD CONSTRAINT linen_delivery_record_lines_unique_room_type
          UNIQUE (record_id, room_type_code);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_record_extra_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES linen_delivery_records(id) ON DELETE CASCADE,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      linen_type_name text,
      quantity integer NOT NULL DEFAULT 0
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_record_extra_lines_record ON linen_delivery_record_extra_lines(record_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_record_extra_lines_unique_type') THEN
        ALTER TABLE linen_delivery_record_extra_lines
          ADD CONSTRAINT linen_delivery_record_extra_lines_unique_type
          UNIQUE (record_id, linen_type_code);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_stocktake_records (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      delivery_record_id text REFERENCES linen_delivery_records(id) ON DELETE SET NULL,
      stocktake_date date NOT NULL,
      dirty_bag_note text,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_stocktake_records_wh_date ON linen_stocktake_records(warehouse_id, stocktake_date DESC, created_at DESC);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_stocktake_records_delivery_record ON linen_stocktake_records(delivery_record_id);')
    await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_linen_stocktake_records_delivery_record_unique
      ON linen_stocktake_records(delivery_record_id)
      WHERE delivery_record_id IS NOT NULL;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_stocktake_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES linen_stocktake_records(id) ON DELETE CASCADE,
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE RESTRICT,
      remaining_sets integer NOT NULL DEFAULT 0
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_stocktake_record_lines_record ON linen_stocktake_record_lines(record_id);')
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_stocktake_record_lines_unique_room_type') THEN
        ALTER TABLE linen_stocktake_record_lines
          ADD CONSTRAINT linen_stocktake_record_lines_unique_room_type
          UNIQUE (record_id, room_type_code);
      END IF;
    END $$;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_return_batches (
      id text PRIMARY KEY,
      return_no text,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'draft',
      returned_at timestamptz,
      note text,
      photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_return_batches_status_check') THEN
        ALTER TABLE linen_supplier_return_batches
          ADD CONSTRAINT linen_supplier_return_batches_status_check
          CHECK (status IN ('draft','returned','settled'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_supplier ON linen_supplier_return_batches(supplier_id);')
    await pgPool.query('ALTER TABLE linen_supplier_return_batches ADD COLUMN IF NOT EXISTS return_no text;')
    await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_return_no_unique ON linen_supplier_return_batches(return_no) WHERE return_no IS NOT NULL;')
    await pgPool.query(`ALTER TABLE linen_supplier_return_batches ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;`)

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_return_batch_lines (
      id text PRIMARY KEY,
      batch_id text NOT NULL REFERENCES linen_supplier_return_batches(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      refund_unit_price numeric NOT NULL DEFAULT 0,
      amount_total numeric NOT NULL DEFAULT 0,
      note text
    );`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batch_lines_batch ON linen_supplier_return_batch_lines(batch_id);')

    await pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_refunds (
      id text PRIMARY KEY,
      batch_id text NOT NULL REFERENCES linen_supplier_return_batches(id) ON DELETE CASCADE,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      expected_amount numeric NOT NULL DEFAULT 0,
      received_amount numeric NOT NULL DEFAULT 0,
      variance_amount numeric NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      received_at timestamptz,
      note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`)
    await pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_refunds_status_check') THEN
        ALTER TABLE linen_supplier_refunds
          ADD CONSTRAINT linen_supplier_refunds_status_check
          CHECK (status IN ('pending','partial','settled','disputed'));
      END IF;
    END $$;`)
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_supplier ON linen_supplier_refunds(supplier_id);')
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_status ON linen_supplier_refunds(status);')

    await pgPool.query(`INSERT INTO warehouses (id, code, name) VALUES
      ('wh.south_melbourne', 'SOU', 'South Melbourne'),
      ('wh.msq', 'MSQ', 'MSQ'),
      ('wh.wsp', 'WSP', 'WSP'),
      ('wh.my80', 'MY80', 'My80')
    ON CONFLICT (id) DO NOTHING;`)

    await pgPool.query(`INSERT INTO suppliers (id, name, kind) VALUES
      ('sup.linen.1', '床品供应商1', 'linen'),
      ('sup.linen.2', '床品供应商2', 'linen')
    ON CONFLICT (id) DO NOTHING;`)

    await pgPool.query(`INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority) VALUES
      ('rsr.southbank', 'Southbank', 'sup.linen.1', 100),
      ('rsr.default', '*', 'sup.linen.2', 0)
    ON CONFLICT (id) DO NOTHING;`)

    await pgPool.query(`UPDATE warehouses
      SET linen_capacity_sets = CASE
        WHEN id = 'wh.south_melbourne' THEN COALESCE(linen_capacity_sets, 500)
        WHEN id = 'wh.msq' THEN COALESCE(linen_capacity_sets, 120)
        WHEN id = 'wh.wsp' THEN COALESCE(linen_capacity_sets, 120)
        WHEN id = 'wh.my80' THEN COALESCE(linen_capacity_sets, 100)
        ELSE linen_capacity_sets
      END;`)
    inventorySchemaEnsured = true
  })().catch((e) => {
    inventorySchemaEnsured = false
    inventorySchemaEnsurePromise = null
    throw e
  })
  try {
    await inventorySchemaEnsurePromise
  } finally {
    if (inventorySchemaEnsured) inventorySchemaEnsurePromise = null
  }
}

export async function warmupInventoryModule() {
  if (!(hasPg && pgPool)) return
  await ensureInventorySchema()
}

async function pickSupplierIdForRegion(region: string | null) {
  if (!pgPool) return null
  await ensureInventorySchema()
  const r = String(region || '').trim()
  const rows = await pgPool.query(
    `SELECT supplier_id
     FROM region_supplier_rules
     WHERE active = true
       AND (region_key = $1 OR region_key = '*')
     ORDER BY (CASE WHEN region_key = $1 THEN 1 ELSE 0 END) DESC, priority DESC
     LIMIT 1`,
    [r || '__none__'],
  )
  return rows.rows?.[0]?.supplier_id || null
}

async function ensureWarehouseStockRow(client: any, warehouse_id: string, item_id: string) {
  const id = `ws.${warehouse_id}.${item_id}`
  await client.query(
    `INSERT INTO warehouse_stocks (id, warehouse_id, item_id, quantity)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (warehouse_id, item_id) DO NOTHING`,
    [id, warehouse_id, item_id],
  )
}

async function ensurePurchaseOrderNo(client: any, rowOrId: any) {
  const id = typeof rowOrId === 'string' ? String(rowOrId) : String(rowOrId?.id || '')
  if (!id) return null
  const current = typeof rowOrId === 'object' ? String(rowOrId?.po_no || '').trim() : ''
  if (current) return current
  let date = typeof rowOrId === 'object'
    ? String(rowOrId?.ordered_date || rowOrId?.created_at || '').slice(0, 10)
    : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = new Date().toISOString().slice(0, 10)
  const base = date.replace(/-/g, '').slice(2)
  const prefix = `PO-${base}-`
  let candidate = `${prefix}${randomSuffix(4)}`
  for (let i = 0; i < 8; i++) {
    const chk = await client.query('SELECT 1 FROM purchase_orders WHERE po_no = $1 LIMIT 1', [candidate])
    if (!chk.rowCount) break
    candidate = `${prefix}${randomSuffix(4 + Math.min(i, 2))}`
  }
  await client.query(`UPDATE purchase_orders SET po_no = $1 WHERE id = $2 AND COALESCE(po_no, '') = ''`, [candidate, id])
  return candidate
}

async function ensureSupplierReturnNo(client: any, rowOrId: any) {
  const id = typeof rowOrId === 'string' ? String(rowOrId) : String(rowOrId?.id || '')
  if (!id) return null
  const current = typeof rowOrId === 'object' ? String(rowOrId?.return_no || '').trim() : ''
  if (current) return current
  let date = typeof rowOrId === 'object'
    ? String(rowOrId?.returned_at || rowOrId?.created_at || '').slice(0, 10)
    : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = new Date().toISOString().slice(0, 10)
  const base = date.replace(/-/g, '').slice(2)
  const prefix = `RT-${base}-`
  let candidate = `${prefix}${randomSuffix(4)}`
  for (let i = 0; i < 8; i++) {
    const chk = await client.query('SELECT 1 FROM linen_supplier_return_batches WHERE return_no = $1 LIMIT 1', [candidate])
    if (!chk.rowCount) break
    candidate = `${prefix}${randomSuffix(4 + Math.min(i, 2))}`
  }
  await client.query(`UPDATE linen_supplier_return_batches SET return_no = $1 WHERE id = $2 AND COALESCE(return_no, '') = ''`, [candidate, id])
  return candidate
}

async function ensureLinenInventoryItem(client: any, linenTypeCode: string) {
  const code = String(linenTypeCode || '').trim()
  if (!code) return null
  const existing = await client.query(
    `SELECT id, name, sku, linen_type_code
     FROM inventory_items
     WHERE category = 'linen' AND linen_type_code = $1
     ORDER BY active DESC, name ASC, id ASC
     LIMIT 1`,
    [code],
  )
  if (existing.rows?.[0]?.id) return existing.rows[0]
  const linenType = await client.query(
    `SELECT code, name, active
     FROM inventory_linen_types
     WHERE code = $1
     LIMIT 1`,
    [code],
  )
  const row = linenType.rows?.[0]
  if (!row) return null
  const itemId = `item.linen_type.${code}`
  const inserted = await client.query(
    `INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
     VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code
     RETURNING id, name, sku, linen_type_code`,
    [itemId, row.name, `LT:${code}`, code, row.active],
  )
  return inserted.rows?.[0] || null
}

async function getSmWarehouse() {
  if (!pgPool) return null
  const rows = await pgPool.query(`SELECT id, code, name, linen_capacity_sets FROM warehouses ORDER BY code ASC`)
  const list = rows.rows || []
  return list.find((r: any) => isSmWarehouseRow(r)) || list[0] || null
}

async function getActiveLinenTypes(client: any) {
  const rows = await client.query(
    `SELECT code, name, in_set, set_divisor, sort_order
     FROM inventory_linen_types
     WHERE active = true
     ORDER BY sort_order ASC, code ASC`,
  )
  return rows.rows || []
}

async function getRoomTypeRequirementMaps(client: any) {
  const [roomTypesRows, reqRows] = await Promise.all([
    client.query(
      `SELECT code, name, sort_order
       FROM inventory_room_types
       WHERE active = true
       ORDER BY sort_order ASC, code ASC`,
    ),
    client.query(`SELECT room_type_code, linen_type_code, quantity FROM inventory_room_type_requirements`),
  ])
  const roomTypes = roomTypesRows.rows || []
  const reqMap = new Map<string, Map<string, number>>()
  for (const r of reqRows.rows || []) {
    const roomTypeCode = String(r.room_type_code || '')
    const linenTypeCode = String(r.linen_type_code || '')
    const quantity = Number(r.quantity || 0)
    if (!roomTypeCode || !linenTypeCode || quantity <= 0) continue
    if (!reqMap.has(roomTypeCode)) reqMap.set(roomTypeCode, new Map())
    reqMap.get(roomTypeCode)!.set(linenTypeCode, quantity)
  }
  return { roomTypes, reqMap }
}

function buildLinenUsageSourceLabel(sourceType: string) {
  const source = String(sourceType || '').trim()
  if (source === 'cleaning_task_standard') return '清洁完成自动记录'
  if (source === 'day_end_reject_usage') return '备用床品补记'
  return source || '床品使用'
}

async function syncLinenUsageEntriesInTx(client: any, input: {
  source_type: string
  source_ref: string
  desired: Array<{
    usage_key: string
    usage_date: string
    cleaning_task_id?: string | null
    property_id?: string | null
    property_code?: string | null
    room_type_code?: string | null
    warehouse_id?: string | null
    linen_type_code: string
    quantity: number
    actor_id?: string | null
    note?: string | null
  }>
}) {
  const sourceType = String(input.source_type || '').trim()
  const sourceRef = String(input.source_ref || '').trim()
  if (!sourceType || !sourceRef) throw new Error('linen usage source is required')

  const normalized = (input.desired || [])
    .map((item) => ({
      usage_key: String(item.usage_key || '').trim(),
      usage_date: String(item.usage_date || '').trim().slice(0, 10),
      cleaning_task_id: String(item.cleaning_task_id || '').trim() || null,
      property_id: String(item.property_id || '').trim() || null,
      property_code: String(item.property_code || '').trim() || null,
      room_type_code: String(item.room_type_code || '').trim() || null,
      warehouse_id: String(item.warehouse_id || '').trim() || null,
      linen_type_code: String(item.linen_type_code || '').trim(),
      quantity: Math.max(0, Number(item.quantity || 0)),
      actor_id: String(item.actor_id || '').trim() || null,
      note: String(item.note || '').trim() || null,
    }))
    .filter((item) => item.usage_key && item.usage_date && item.linen_type_code)

  const desiredMap = new Map<string, (typeof normalized)[number]>()
  for (const item of normalized) desiredMap.set(item.usage_key, item)

  const existingRes = await client.query(
    `SELECT id, usage_key
     FROM inventory_linen_usage_records
     WHERE source_type = $1 AND source_ref = $2`,
    [sourceType, sourceRef],
  )
  const existingRows = existingRes.rows || []
  const existingMap = new Map<string, any>(existingRows.map((row: any) => [String(row.usage_key || ''), row]))

  for (const row of existingRows) {
    const usageKey = String(row.usage_key || '')
    if (!usageKey || desiredMap.has(usageKey)) continue
    await client.query(`DELETE FROM inventory_linen_usage_records WHERE id = $1`, [String(row.id || '')])
  }

  for (const item of desiredMap.values()) {
    const existing = existingMap.get(item.usage_key) || null
    if (existing?.id) {
      await client.query(
        `UPDATE inventory_linen_usage_records
         SET usage_date = $2::date,
             cleaning_task_id = $3,
             property_id = $4,
             property_code = $5,
             room_type_code = $6,
             warehouse_id = $7,
             linen_type_code = $8,
             quantity = $9,
             actor_id = $10,
             note = $11,
             updated_at = now()
         WHERE id = $1`,
        [
          String(existing.id),
          item.usage_date,
          item.cleaning_task_id,
          item.property_id,
          item.property_code,
          item.room_type_code,
          item.warehouse_id,
          item.linen_type_code,
          item.quantity,
          item.actor_id,
          item.note,
        ],
      )
    } else {
      await client.query(
        `INSERT INTO inventory_linen_usage_records (
           id, usage_key, usage_date, source_type, source_ref, cleaning_task_id,
           property_id, property_code, room_type_code, warehouse_id, linen_type_code,
           quantity, actor_id, note, created_at, updated_at
         )
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())`,
        [
          uuidv4(),
          item.usage_key,
          item.usage_date,
          sourceType,
          sourceRef,
          item.cleaning_task_id,
          item.property_id,
          item.property_code,
          item.room_type_code,
          item.warehouse_id,
          item.linen_type_code,
          item.quantity,
          item.actor_id,
          item.note,
        ],
      )
    }
  }
}

export async function recordCleaningTaskStandardLinenUsage(params: { cleaningTaskId: string; actorId?: string | null }) {
  if (!(hasPg && pgPool)) return { ok: false as const, reason: 'pg_unavailable' as const }
  await ensureInventorySchema()
  const taskId = String(params.cleaningTaskId || '').trim()
  if (!taskId) return { ok: false as const, reason: 'missing_task_id' as const }
  const actor = String(params.actorId || '').trim() || null

  return pgRunInTransaction(async (client) => {
    const taskRes = await client.query(
      `SELECT
         t.id::text AS task_id,
         COALESCE(t.task_date, t.date)::date AS usage_date,
         COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
         COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code,
         COALESCE(p_id.room_type_code, p_code.room_type_code) AS room_type_code,
         COALESCE(p_id.type, p_code.type) AS property_type,
         COALESCE(p_id.linen_service_warehouse_id, p_code.linen_service_warehouse_id) AS linen_service_warehouse_id,
         COALESCE(p_id.region, p_code.region) AS region
       FROM cleaning_tasks t
       LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
       LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
       WHERE t.id::text = $1
       LIMIT 1`,
      [taskId],
    )
    const task = taskRes.rows?.[0] || null
    if (!task?.task_id || !task?.usage_date || !task?.property_code) return { ok: false as const, reason: 'task_not_ready' as const }

    const { roomTypes, reqMap } = await getRoomTypeRequirementMaps(client)
    const resolvedRoomType = resolveRoomTypeCode(String(task.room_type_code || task.property_type || '').trim(), roomTypes, reqMap)
    const roomTypeCode = String(resolvedRoomType.code || '').trim()
    if (!roomTypeCode) return { ok: false as const, reason: 'missing_room_type' as const }
    const reqs = reqMap.get(roomTypeCode)
    if (!reqs || !reqs.size) return { ok: false as const, reason: 'room_type_requirements_missing' as const }

    const whRes = await client.query(`SELECT id, code, name FROM warehouses WHERE active = true ORDER BY code ASC`)
    const warehouseId = resolveWarehouseForProperty(task, whRes.rows || [])
    const desired = Array.from(reqs.entries()).map(([linenTypeCode, quantity]) => ({
      usage_key: `cleaning_task_standard:${taskId}:${linenTypeCode}`,
      usage_date: String(task.usage_date || '').slice(0, 10),
      cleaning_task_id: taskId,
      property_id: String(task.property_id || '').trim() || null,
      property_code: String(task.property_code || '').trim() || null,
      room_type_code: roomTypeCode,
      warehouse_id: String(warehouseId || '').trim() || null,
      linen_type_code: String(linenTypeCode || '').trim(),
      quantity: Number(quantity || 0),
      actor_id: actor,
      note: `按房型 ${resolvedRoomType.name || roomTypeCode} 自动登记`,
    })).filter((item) => item.linen_type_code && item.quantity > 0)

    await syncLinenUsageEntriesInTx(client, {
      source_type: 'cleaning_task_standard',
      source_ref: taskId,
      desired,
    })
    return { ok: true as const, count: desired.length }
  })
}

export async function syncDayEndRejectLinenUsage(params: {
  userId: string
  date: string
  actorId?: string | null
  rejectItems: Array<{ linen_type: string; quantity: number; used_room: string }>
}) {
  if (!(hasPg && pgPool)) return { ok: false as const, reason: 'pg_unavailable' as const }
  await ensureInventorySchema()
  const userId = String(params.userId || '').trim()
  const date = String(params.date || '').trim().slice(0, 10)
  const actor = String(params.actorId || '').trim() || null
  if (!userId || !date) return { ok: false as const, reason: 'missing_source' as const }

  return pgRunInTransaction(async (client) => {
    const sourceRef = `${userId}:${date}`
    const rows = (Array.isArray(params.rejectItems) ? params.rejectItems : [])
      .map((item) => ({
        linen_type: String(item?.linen_type || '').trim(),
        quantity: Math.max(0, Number(item?.quantity || 0)),
        used_room: String(item?.used_room || '').trim(),
      }))
      .filter((item) => item.linen_type && item.quantity > 0 && item.used_room)

    if (!rows.length) {
      await syncLinenUsageEntriesInTx(client, {
        source_type: 'day_end_reject_usage',
        source_ref: sourceRef,
        desired: [],
      })
      return { ok: true as const, count: 0 }
    }

    const roomCodes = Array.from(new Set(rows.map((item) => item.used_room.toUpperCase())))
    const propertiesRes = await client.query(
      `SELECT id::text AS id, code, room_type_code, type, linen_service_warehouse_id, region
       FROM properties
       WHERE upper(code) = ANY($1::text[]) OR id::text = ANY($2::text[])`,
      [roomCodes, rows.map((item) => item.used_room)],
    )
    const whRes = await client.query(`SELECT id, code, name FROM warehouses WHERE active = true ORDER BY code ASC`)
    const propertyByCode = new Map<string, any>()
    for (const property of propertiesRes.rows || []) {
      const code = String(property.code || '').trim().toUpperCase()
      const id = String(property.id || '').trim()
      if (code) propertyByCode.set(code, property)
      if (id) propertyByCode.set(id, property)
    }

    const aggregate = new Map<string, {
      property_id: string | null
      property_code: string | null
      room_type_code: string | null
      warehouse_id: string | null
      linen_type_code: string
      quantity: number
    }>()

    for (const row of rows) {
      const property = propertyByCode.get(row.used_room.toUpperCase()) || propertyByCode.get(row.used_room) || null
      const warehouseId = property ? resolveWarehouseForProperty(property, whRes.rows || []) : null
      const propertyId = property ? String(property.id || '').trim() || null : null
      const propertyCode = property ? String(property.code || '').trim() || row.used_room : row.used_room
      const roomTypeCode = property ? String(property.room_type_code || property.type || '').trim() || null : null
      const key = `${propertyCode}:${row.linen_type}`
      const current = aggregate.get(key)
      if (current) current.quantity += row.quantity
      else {
        aggregate.set(key, {
          property_id: propertyId,
          property_code: propertyCode,
          room_type_code: roomTypeCode,
          warehouse_id: String(warehouseId || '').trim() || null,
          linen_type_code: row.linen_type,
          quantity: row.quantity,
        })
      }
    }

    const desired = Array.from(aggregate.values()).map((item) => ({
      usage_key: `day_end_reject_usage:${sourceRef}:${item.property_code || 'unknown'}:${item.linen_type_code}`,
      usage_date: date,
      property_id: item.property_id,
      property_code: item.property_code,
      room_type_code: item.room_type_code,
      warehouse_id: item.warehouse_id,
      linen_type_code: item.linen_type_code,
      quantity: item.quantity,
      actor_id: actor,
      note: '日终 Reject 备用床品补记',
    }))

    await syncLinenUsageEntriesInTx(client, {
      source_type: 'day_end_reject_usage',
      source_ref: sourceRef,
      desired,
    })
    return { ok: true as const, count: desired.length }
  })
}

function computeSetsForRoomType(countsByLinenType: Record<string, number>, requirements: Map<string, number> | undefined | null) {
  if (!requirements || !requirements.size) return 0
  const candidates: number[] = []
  for (const [linenTypeCode, quantity] of requirements.entries()) {
    const stockQty = Number(countsByLinenType[linenTypeCode] || 0)
    candidates.push(Math.floor(stockQty / Math.max(1, quantity)))
  }
  return candidates.length ? Math.max(0, Math.min(...candidates)) : 0
}

function resolveWarehouseForProperty(property: any, warehouses: any[]) {
  const explicit = String(property?.linen_service_warehouse_id || '').trim()
  if (explicit) return explicit
  const region = String(property?.region || '').trim().toLowerCase()
  if (!region) return null
  const found = (warehouses || []).find((w: any) => {
    const code = String(w.code || '').trim().toLowerCase()
    const name = String(w.name || '').trim().toLowerCase()
    return code === region || name === region || name.includes(region) || region.includes(code)
  })
  return found ? String(found.id) : null
}

async function getLinenReserveMap(client: any, warehouseId: string) {
  const rows = await client.query(
    `SELECT item_id, reserve_qty
     FROM inventory_stock_policies
     WHERE warehouse_id = $1`,
    [warehouseId],
  )
  return new Map<string, number>((rows.rows || []).map((r: any) => [String(r.item_id), Number(r.reserve_qty || 0)]))
}

async function assertWarehouseAllowsStocktake(client: any, warehouseId: string) {
  const row = await client.query(`SELECT id, code, name, stocktake_enabled, active FROM warehouses WHERE id = $1 LIMIT 1`, [warehouseId])
  const warehouse = row.rows?.[0] || null
  if (!warehouse) throw httpError(400, '盘点分仓不存在')
  if (!Boolean(warehouse.active)) throw httpError(400, '盘点分仓未启用')
  if (warehouse.stocktake_enabled === false) throw httpError(400, '该仓库未开启盘点')
  return warehouse
}

async function getLatestSupplierItemPrice(client: any, supplierId: string) {
  const rows = await client.query(
    `SELECT sip.id, sip.supplier_id, sip.item_id, sip.purchase_unit_price, sip.refund_unit_price, sip.effective_from, sip.active,
            i.name AS item_name, i.sku AS item_sku, i.linen_type_code
     FROM supplier_item_prices sip
     JOIN inventory_items i ON i.id = sip.item_id
     WHERE sip.supplier_id = $1
       AND sip.active = true
     ORDER BY COALESCE(sip.effective_from, DATE '1970-01-01') DESC, sip.updated_at DESC NULLS LAST, sip.id DESC`,
    [supplierId],
  )
  const out = new Map<string, any>()
  for (const row of rows.rows || []) {
    const itemId = String(row.item_id || '')
    if (!itemId || out.has(itemId)) continue
    out.set(itemId, row)
  }
  return out
}

async function applyStockDeltaInTx(client: any, input: {
  warehouse_id: string
  item_id: string
  type: 'in' | 'out' | 'adjust'
  quantity: number
  reason?: string | null
  property_id?: string | null
  ref_type?: string | null
  ref_id?: string | null
  actor_id?: string | null
  note?: string | null
  photo_url?: string | null
  return_stock_row?: boolean
}) {
  await ensureWarehouseStockRow(client, input.warehouse_id, input.item_id)
  const lock = await client.query(
    `SELECT id, quantity
     FROM warehouse_stocks
     WHERE warehouse_id = $1 AND item_id = $2
     FOR UPDATE`,
    [input.warehouse_id, input.item_id],
  )
  const row = lock.rows?.[0]
  if (!row) throw new Error('warehouse stock missing')

  const delta = input.type === 'in' ? input.quantity : input.type === 'out' ? -input.quantity : input.quantity
  const nextQty = Number(row.quantity || 0) + Number(delta || 0)
  if (nextQty < 0) return { ok: false as const, code: 409 as const, message: 'insufficient stock' }

  const shouldReturnStockRow = input.return_stock_row !== false
  const updated = shouldReturnStockRow
    ? await client.query(
      `UPDATE warehouse_stocks
       SET quantity = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [nextQty, row.id],
    )
    : await client.query(
      `UPDATE warehouse_stocks
       SET quantity = $1, updated_at = now()
       WHERE id = $2`,
      [nextQty, row.id],
    )

  const moveId = uuidv4()
  await client.query(
    `INSERT INTO stock_movements (id, warehouse_id, item_id, type, reason, quantity, property_id, ref_type, ref_id, actor_id, note, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      moveId,
      input.warehouse_id,
      input.item_id,
      input.type,
      input.reason || null,
      input.quantity,
      input.property_id || null,
      input.ref_type || null,
      input.ref_id || null,
      input.actor_id || null,
      input.note || null,
      input.photo_url || null,
    ],
  )

  return { ok: true as const, stock: shouldReturnStockRow ? (updated.rows?.[0] || null) : null, movement_id: moveId }
}

type LinenDeliveryInputLine = {
  room_type_code: string
  sets: number
}

type LinenStocktakeInputLine = {
  room_type_code: string
  remaining_sets: number
}

type LinenDeliveryExtraInputLine = {
  linen_type_code: string
  quantity: number
}

type ExpandedLinenDeliveryLine = {
  room_type_code: string
  room_type_name: string
  sets: number
  breakdown: Array<{
    linen_type_code: string
    item_id: string
    item_name: string
    item_sku: string
    quantity_per_set: number
    quantity_total: number
  }>
}

type ExpandedLinenExtraLine = {
  linen_type_code: string
  linen_type_name: string
  quantity: number
  breakdown: Array<{
    linen_type_code: string
    item_id: string
    item_name: string
    item_sku: string
    quantity_per_set: number
    quantity_total: number
  }>
}

function normalizeRoomTypeLookupKey(value?: string | null) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^房型[:：\s-]*/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s_-]+/g, '')
}

function buildRoomTypeAliasKeys(row: { code?: string | null; name?: string | null; bedrooms?: number | null; bathrooms?: number | null }) {
  const keys = new Set<string>()
  const code = String(row.code || '').trim()
  const name = String(row.name || '').trim()
  const bedrooms = Number(row.bedrooms ?? 0)
  const bathrooms = Number(row.bathrooms ?? 0)

  for (const value of [code, name]) {
    const normalized = normalizeRoomTypeLookupKey(value)
    if (normalized) keys.add(normalized)
  }
  if (bedrooms > 0 || bathrooms > 0) {
    keys.add(normalizeRoomTypeLookupKey(`${bedrooms}b${bathrooms}b`))
    keys.add(normalizeRoomTypeLookupKey(`${bedrooms}房${bathrooms}卫`))
    keys.add(normalizeRoomTypeLookupKey(`房型${bedrooms}房${bathrooms}卫`))
  }
  if (name) {
    keys.add(normalizeRoomTypeLookupKey(name.replace(/^房型/, '')))
    keys.add(normalizeRoomTypeLookupKey(`房型${name}`))
  }
  return Array.from(keys).filter(Boolean)
}

function resolveRoomTypeCode(
  inputCode: string,
  roomTypeRows: Array<{ code?: string | null; name?: string | null; bedrooms?: number | null; bathrooms?: number | null }>,
  reqMap?: Map<string, Map<string, number>>,
) {
  const rows = roomTypeRows || []
  const exact = rows.find((row) => String(row.code || '') === inputCode) || null
  const lookupKeys = new Set<string>(
    [inputCode, exact?.name].map((value) => normalizeRoomTypeLookupKey(value)).filter(Boolean),
  )
  const aliasCandidates = new Set<string>()
  for (const row of rows) {
    const aliases = buildRoomTypeAliasKeys(row)
    if (aliases.some((alias) => lookupKeys.has(alias))) aliasCandidates.add(String(row.code || '').trim())
  }
  const inputCodeExists = rows.some((row) => String(row.code || '').trim() === String(inputCode || '').trim())
  const candidateCodes = Array.from(
    new Set([
      ...Array.from(aliasCandidates),
      ...(inputCodeExists ? [String(inputCode || '').trim()] : []),
      ...(exact ? [String(exact.code || '').trim()] : []),
      String(inputCode || '').trim(),
    ]),
  ).filter(Boolean)
  const preferredCode = candidateCodes.find((code) => {
    if (!reqMap) return false
    const reqs = reqMap.get(code)
    return !!reqs && reqs.size > 0
  })
  const resolvedCode = preferredCode || candidateCodes[0] || ''
  const resolvedRow =
    rows.find((row) => String(row.code || '').trim() === resolvedCode)
    || exact
    || rows.find((row) => buildRoomTypeAliasKeys(row).some((alias) => lookupKeys.has(alias)))
    || null
  return {
    code: resolvedCode,
    name: String(resolvedRow?.name || exact?.name || inputCode || ''),
  }
}

async function expandLinenDeliveryInputLines(client: any, lines: LinenDeliveryInputLine[]): Promise<ExpandedLinenDeliveryLine[]> {
  const normalized = (lines || []).map((line) => ({
    room_type_code: String(line?.room_type_code || '').trim(),
    sets: Number(line?.sets || 0),
  }))
  if (!normalized.length) throw new Error('至少需要一条配送明细')

  const seen = new Set<string>()
  for (const line of normalized) {
    if (!line.room_type_code) throw new Error('配送明细缺少房型')
    if (!Number.isInteger(line.sets) || line.sets < 1) throw new Error('配送套数必须大于 0')
    if (seen.has(line.room_type_code)) throw new Error('同一配送单内房型不能重复')
    seen.add(line.room_type_code)
  }

  const [roomTypesRes, reqRows, itemsRes] = await Promise.all([
    client.query(
      `SELECT code, name, bedrooms, bathrooms
       FROM inventory_room_types`,
    ),
    client.query(`SELECT room_type_code, linen_type_code, quantity FROM inventory_room_type_requirements`),
    client.query(
      `SELECT id, name, sku, linen_type_code
       FROM inventory_items
       WHERE category = 'linen' AND active = true`,
    ),
  ])

  const roomTypeRows = (roomTypesRes.rows || []).map((row: any) => ({
    code: String(row.code || ''),
    name: String(row.name || row.code || ''),
    bedrooms: row.bedrooms == null ? null : Number(row.bedrooms),
    bathrooms: row.bathrooms == null ? null : Number(row.bathrooms),
  }))
  const reqMap = new Map<string, Map<string, number>>()
  for (const row of reqRows.rows || []) {
    const roomTypeCode = String(row.room_type_code || '')
    const linenTypeCode = String(row.linen_type_code || '')
    const quantity = Number(row.quantity || 0)
    if (!roomTypeCode || !linenTypeCode || quantity <= 0) continue
    if (!reqMap.has(roomTypeCode)) reqMap.set(roomTypeCode, new Map())
    reqMap.get(roomTypeCode)!.set(linenTypeCode, quantity)
  }
  const itemByLinenType = new Map<string, any>()
  for (const row of itemsRes.rows || []) {
    const code = String(row.linen_type_code || '')
    if (!code || itemByLinenType.has(code)) continue
    itemByLinenType.set(code, row)
  }

  return normalized.map((line) => {
    const resolvedRoomType = resolveRoomTypeCode(line.room_type_code, roomTypeRows, reqMap)
    const roomTypeCode = String(resolvedRoomType.code || '').trim()
    const roomTypeName = String(resolvedRoomType.name || '')
    if (!roomTypeName) throw new Error(`未知房型：${line.room_type_code}`)
    const reqs = reqMap.get(roomTypeCode)
    if (!reqs || !reqs.size) throw new Error(`房型 ${roomTypeName} 未配置床品占用清单`)
    const breakdown = Array.from(reqs.entries()).map(([linenTypeCode, quantity]) => {
      const item = itemByLinenType.get(String(linenTypeCode))
      if (!item?.id) throw new Error(`床品类型 ${linenTypeCode} 未配置库存物料`)
      return {
        linen_type_code: String(linenTypeCode),
        item_id: String(item.id),
        item_name: String(item.name || linenTypeCode),
        item_sku: String(item.sku || ''),
        quantity_per_set: Number(quantity || 0),
        quantity_total: Number(quantity || 0) * line.sets,
      }
    }).filter((row) => row.quantity_per_set > 0 && row.quantity_total > 0)
    if (!breakdown.length) throw new Error(`房型 ${roomTypeName} 未配置有效床品占用清单`)
    return {
      room_type_code: roomTypeCode,
      room_type_name: roomTypeName,
      sets: line.sets,
      breakdown,
    }
  })
}

async function normalizeLinenStocktakeLines(client: any, lines: LinenStocktakeInputLine[]) {
  const normalized = (lines || []).map((line) => ({
    room_type_code: String(line?.room_type_code || '').trim(),
    remaining_sets: Number(line?.remaining_sets ?? 0),
  }))
  if (!normalized.length) throw new Error('至少需要填写一条盘点明细')

  const roomTypesRes = await client.query(
    `SELECT code, name, bedrooms, bathrooms
     FROM inventory_room_types
     WHERE active = true
     ORDER BY sort_order ASC, code ASC`,
  )
  const roomTypeRows = (roomTypesRes.rows || []).map((row: any) => ({
    code: String(row.code || ''),
    name: String(row.name || row.code || ''),
    bedrooms: row.bedrooms == null ? null : Number(row.bedrooms),
    bathrooms: row.bathrooms == null ? null : Number(row.bathrooms),
  }))
  const seen = new Set<string>()
  for (const line of normalized) {
    if (!line.room_type_code) throw new Error('盘点明细缺少房型')
    const resolvedRoomType = resolveRoomTypeCode(line.room_type_code, roomTypeRows)
    if (!resolvedRoomType.code) throw new Error(`未知房型：${line.room_type_code}`)
    if (!Number.isInteger(line.remaining_sets) || line.remaining_sets < 0) throw new Error('盘点剩余套数不能小于 0')
    if (seen.has(resolvedRoomType.code)) throw new Error('同一盘点单内房型不能重复')
    seen.add(resolvedRoomType.code)
    line.room_type_code = resolvedRoomType.code
  }
  return normalized.map((line) => ({
    room_type_code: line.room_type_code,
    room_type_name: String(resolveRoomTypeCode(line.room_type_code, roomTypeRows).name || line.room_type_code),
    remaining_sets: line.remaining_sets,
  }))
}

async function expandLinenDeliveryExtraInputLines(client: any, lines: LinenDeliveryExtraInputLine[]): Promise<ExpandedLinenExtraLine[]> {
  const normalized = (lines || []).map((line) => ({
    linen_type_code: String(line?.linen_type_code || '').trim(),
    quantity: Number(line?.quantity || 0),
  })).filter((line) => line.linen_type_code || line.quantity)

  if (!normalized.length) return []

  const seen = new Set<string>()
  for (const line of normalized) {
    if (!line.linen_type_code) throw new Error('备用床品类型不能为空')
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('备用床品数量必须大于 0')
    if (seen.has(line.linen_type_code)) throw new Error('同一配送单内备用床品类型不能重复')
    seen.add(line.linen_type_code)
  }

  const [linenTypeRowsRes, itemsRes] = await Promise.all([
    client.query(
      `SELECT code, name
       FROM inventory_linen_types
       WHERE active = true
       ORDER BY sort_order ASC, code ASC`,
    ),
    client.query(
      `SELECT id, name, sku, linen_type_code
       FROM inventory_items
       WHERE category = 'linen' AND active = true`,
    ),
  ])

  const linenTypeMap = new Map<string, { code: string; name: string }>()
  for (const row of linenTypeRowsRes.rows || []) linenTypeMap.set(String(row.code || ''), { code: String(row.code || ''), name: String(row.name || row.code || '') })
  const itemByLinenType = new Map<string, any>()
  for (const row of itemsRes.rows || []) {
    const code = String(row.linen_type_code || '')
    if (!code || itemByLinenType.has(code)) continue
    itemByLinenType.set(code, row)
  }

  return normalized.map((line) => {
    const linenType = linenTypeMap.get(line.linen_type_code)
    if (!linenType) throw new Error(`未知床品类型：${line.linen_type_code}`)
    const item = itemByLinenType.get(line.linen_type_code)
    if (!item?.id) throw new Error(`床品类型 ${line.linen_type_code} 未配置库存物料`)
    return {
      linen_type_code: line.linen_type_code,
      linen_type_name: linenType.name,
      quantity: line.quantity,
      breakdown: [{
        linen_type_code: line.linen_type_code,
        item_id: String(item.id),
        item_name: String(item.name || linenType.name),
        item_sku: String(item.sku || ''),
        quantity_per_set: 1,
        quantity_total: line.quantity,
      }],
    }
  })
}

async function applyLinenDeliveryBreakdownsInTx(client: any, input: {
  record_id: string
  from_warehouse_id: string
  to_warehouse_id: string
  note?: string | null
  actor_id?: string | null
  breakdowns: Array<Array<{
    item_id: string
    quantity_total: number
  }>>
  direction: 'apply' | 'revert'
}) {
  for (const breakdown of input.breakdowns || []) {
    for (const item of breakdown || []) {
      const fromType = input.direction === 'apply' ? 'out' : 'in'
      const toType = input.direction === 'apply' ? 'in' : 'out'
      const out = await applyStockDeltaInTx(client, {
        warehouse_id: input.from_warehouse_id,
        item_id: item.item_id,
        type: fromType,
        quantity: item.quantity_total,
        reason: 'linen_delivery_record',
        ref_type: 'linen_delivery_record',
        ref_id: input.record_id,
        actor_id: input.actor_id || null,
        note: input.note || null,
        return_stock_row: false,
      })
      if (!out.ok) return out
      const inn = await applyStockDeltaInTx(client, {
        warehouse_id: input.to_warehouse_id,
        item_id: item.item_id,
        type: toType,
        quantity: item.quantity_total,
        reason: 'linen_delivery_record',
        ref_type: 'linen_delivery_record',
        ref_id: input.record_id,
        actor_id: input.actor_id || null,
        note: input.note || null,
        return_stock_row: false,
      })
      if (!inn.ok) return inn
    }
  }
  return { ok: true as const }
}

async function applyLinenDeliveryRecordStockInTx(client: any, input: {
  record_id: string
  from_warehouse_id: string
  to_warehouse_id: string
  note?: string | null
  actor_id?: string | null
  lines: ExpandedLinenDeliveryLine[]
  direction: 'apply' | 'revert'
}) {
  return applyLinenDeliveryBreakdownsInTx(client, {
    ...input,
    breakdowns: (input.lines || []).map((line) => line.breakdown || []),
  })
}

async function revertLinenDeliveryRecordStockByRefInTx(client: any, input: {
  record_id: string
  actor_id?: string | null
  note?: string | null
}) {
  const effectsRes = await client.query(
    `SELECT warehouse_id,
            item_id,
            SUM(
              CASE
                WHEN type = 'in' THEN quantity
                WHEN type = 'out' THEN -quantity
                ELSE quantity
              END
            )::int AS net_quantity
     FROM stock_movements
     WHERE ref_type = 'linen_delivery_record'
       AND ref_id = $1
     GROUP BY warehouse_id, item_id
     HAVING SUM(
       CASE
         WHEN type = 'in' THEN quantity
         WHEN type = 'out' THEN -quantity
         ELSE quantity
       END
     ) <> 0`,
    [input.record_id],
  )

  for (const row of effectsRes.rows || []) {
    const netQuantity = Number(row.net_quantity || 0)
    if (!netQuantity) continue
    const reversed = await applyStockDeltaInTx(client, {
      warehouse_id: String(row.warehouse_id || ''),
      item_id: String(row.item_id || ''),
      type: netQuantity > 0 ? 'out' : 'in',
      quantity: Math.abs(netQuantity),
      reason: 'linen_delivery_record',
      ref_type: 'linen_delivery_record',
      ref_id: input.record_id,
      actor_id: input.actor_id || null,
      note: input.note || null,
      return_stock_row: false,
    })
    if (!reversed.ok) return reversed
  }

  return { ok: true as const }
}

function assertStockTxnOk(result: any) {
  if (result?.ok) return
  throw httpError(Number(result?.code || 500), String(result?.message || 'failed'))
}

async function loadLinenDeliveryRecordDetail(client: any, id: string) {
  const recordRes = await client.query(
    `SELECT r.*,
            fw.code AS from_warehouse_code,
            fw.name AS from_warehouse_name,
            tw.code AS to_warehouse_code,
            tw.name AS to_warehouse_name,
            COALESCE(SUM(l.sets),0)::int AS total_sets,
            COUNT(l.id)::int AS room_type_count
     FROM linen_delivery_records r
     JOIN warehouses fw ON fw.id = r.from_warehouse_id
     JOIN warehouses tw ON tw.id = r.to_warehouse_id
     LEFT JOIN linen_delivery_record_lines l ON l.record_id = r.id
     WHERE r.id = $1
     GROUP BY r.id, fw.code, fw.name, tw.code, tw.name`,
    [id],
  )
  const record = recordRes.rows?.[0] || null
  if (!record) return null
  const linesRes = await client.query(
    `SELECT l.id,
            l.record_id,
            l.room_type_code,
            COALESCE(l.room_type_name, rt.name, l.room_type_code) AS room_type_name,
            l.sets
     FROM linen_delivery_record_lines l
     LEFT JOIN inventory_room_types rt ON rt.code = l.room_type_code
     WHERE l.record_id = $1
     ORDER BY COALESCE(rt.sort_order, 9999) ASC, l.room_type_code ASC`,
    [id],
  )
  const stocktakeRes = await client.query(
    `SELECT sr.id,
            sr.warehouse_id,
            sr.delivery_record_id,
            sr.stocktake_date,
            sr.dirty_bag_note,
            sr.note,
            sr.created_by,
            sr.created_at,
            sr.updated_at,
            w.code AS warehouse_code,
            w.name AS warehouse_name
     FROM linen_stocktake_records sr
     JOIN warehouses w ON w.id = sr.warehouse_id
     WHERE sr.delivery_record_id = $1
     ORDER BY sr.created_at DESC
     LIMIT 1`,
    [id],
  )
  const stocktake = stocktakeRes.rows?.[0] || null
  const extraLinesRes = await client.query(
    `SELECT el.id,
            el.record_id,
            el.linen_type_code,
            COALESCE(el.linen_type_name, lt.name, el.linen_type_code) AS linen_type_name,
            el.quantity
     FROM linen_delivery_record_extra_lines el
     LEFT JOIN inventory_linen_types lt ON lt.code = el.linen_type_code
     WHERE el.record_id = $1
     ORDER BY COALESCE(lt.sort_order, 9999) ASC, el.linen_type_code ASC`,
    [id],
  )
  const stocktakeLinesRes = stocktake?.id
    ? await client.query(
      `SELECT sl.id,
              sl.record_id,
              sl.room_type_code,
              COALESCE(rt.name, sl.room_type_code) AS room_type_name,
              sl.remaining_sets
       FROM linen_stocktake_record_lines sl
       LEFT JOIN inventory_room_types rt ON rt.code = sl.room_type_code
       WHERE sl.record_id = $1
       ORDER BY COALESCE(rt.sort_order, 9999) ASC, sl.room_type_code ASC`,
      [stocktake.id],
    )
    : { rows: [] }
  let expanded: ExpandedLinenDeliveryLine[] = []
  try {
    expanded = await expandLinenDeliveryInputLines(
      client,
      (linesRes.rows || []).map((line: any) => ({
        room_type_code: String(line.room_type_code || ''),
        sets: Number(line.sets || 0),
      })),
    )
  } catch {
    expanded = []
  }
  const breakdownTotals = new Map<string, { linen_type_code: string; item_id: string; item_name: string; item_sku: string; quantity_total: number }>()
  const lines = (linesRes.rows || []).map((line: any) => {
    const details = expanded.find((row) => row.room_type_code === String(line.room_type_code || ''))
    const breakdown = details?.breakdown || []
    for (const item of breakdown) {
      const key = `${item.item_id}`
      const current = breakdownTotals.get(key)
      if (current) current.quantity_total += item.quantity_total
      else breakdownTotals.set(key, {
        linen_type_code: item.linen_type_code,
        item_id: item.item_id,
        item_name: item.item_name,
        item_sku: item.item_sku,
        quantity_total: item.quantity_total,
      })
    }
    return {
      id: String(line.id || ''),
      record_id: String(line.record_id || ''),
      room_type_code: String(line.room_type_code || ''),
      room_type_name: String(line.room_type_name || line.room_type_code || ''),
      sets: Number(line.sets || 0),
      breakdown,
    }
  })
  const extra_lines = (extraLinesRes.rows || []).map((line: any) => {
    const breakdown = [{
      linen_type_code: String(line.linen_type_code || ''),
      item_id: `item.linen_type.${String(line.linen_type_code || '')}`,
      item_name: String(line.linen_type_name || line.linen_type_code || ''),
      item_sku: '',
      quantity_per_set: 1,
      quantity_total: Number(line.quantity || 0),
    }]
    const key = String(line.linen_type_code || '')
    const current = breakdownTotals.get(key)
    if (current) current.quantity_total += Number(line.quantity || 0)
    else breakdownTotals.set(key, {
      linen_type_code: key,
      item_id: `item.linen_type.${key}`,
      item_name: String(line.linen_type_name || line.linen_type_code || ''),
      item_sku: '',
      quantity_total: Number(line.quantity || 0),
    })
    return {
      id: String(line.id || ''),
      record_id: String(line.record_id || ''),
      linen_type_code: key,
      linen_type_name: String(line.linen_type_name || line.linen_type_code || ''),
      quantity: Number(line.quantity || 0),
      breakdown,
    }
  })
  return {
    ...record,
    total_sets: Number(record.total_sets || 0),
    room_type_count: Number(record.room_type_count || 0),
    dirty_bag_note: String(stocktake?.dirty_bag_note || ''),
    lines,
    extra_lines,
    stocktake: stocktake ? {
      ...stocktake,
      lines: (stocktakeLinesRes.rows || []).map((line: any) => ({
        id: String(line.id || ''),
        record_id: String(line.record_id || ''),
        room_type_code: String(line.room_type_code || ''),
        room_type_name: String(line.room_type_name || line.room_type_code || ''),
        remaining_sets: Number(line.remaining_sets || 0),
      })),
    } : null,
    breakdown_summary: Array.from(breakdownTotals.values()).sort((a, b) => a.item_name.localeCompare(b.item_name, 'zh-Hans-CN')),
  }
}

async function loadLinenDeliveryRecordSummary(client: any, id: string) {
  const res = await client.query(
    `SELECT id, delivery_date, status, created_at, updated_at
     FROM linen_delivery_records
     WHERE id = $1
     LIMIT 1`,
    [id],
  )
  const row = res.rows?.[0] || null
  if (!row) return null
  return {
    id: String(row.id || ''),
    delivery_date: String(row.delivery_date || ''),
    status: String(row.status || ''),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

function buildDeliverySuccessResponse(row: any, extra?: Record<string, any>) {
  return {
    id: String(row?.id || ''),
    delivery_date: String(row?.delivery_date || ''),
    status: String(row?.status || ''),
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null,
    ...(extra || {}),
  }
}

async function upsertLinenStocktakeRecordInTx(client: any, input: {
  delivery_record_id?: string | null
  warehouse_id: string
  stocktake_date: string
  dirty_bag_note?: string | null
  note?: string | null
  actor_id?: string | null
  lines: LinenStocktakeInputLine[]
}) {
  const normalizedLines = await normalizeLinenStocktakeLines(client, input.lines)
  let recordId = ''
  if (input.delivery_record_id) {
    const existingRes = await client.query(
      `SELECT id
       FROM linen_stocktake_records
       WHERE delivery_record_id = $1
       LIMIT 1`,
      [input.delivery_record_id],
    )
    recordId = String(existingRes.rows?.[0]?.id || '')
  }
  if (recordId) {
    await client.query(
      `UPDATE linen_stocktake_records
       SET warehouse_id = $1,
           stocktake_date = $2::date,
           dirty_bag_note = $3,
           note = $4,
           updated_at = now()
       WHERE id = $5`,
      [input.warehouse_id, input.stocktake_date, input.dirty_bag_note || null, input.note || null, recordId],
    )
    await client.query(`DELETE FROM linen_stocktake_record_lines WHERE record_id = $1`, [recordId])
  } else {
    recordId = uuidv4()
    await client.query(
      `INSERT INTO linen_stocktake_records (id, warehouse_id, delivery_record_id, stocktake_date, dirty_bag_note, note, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7)`,
      [recordId, input.warehouse_id, input.delivery_record_id || null, input.stocktake_date, input.dirty_bag_note || null, input.note || null, input.actor_id || null],
    )
  }
  for (const line of normalizedLines) {
    await client.query(
      `INSERT INTO linen_stocktake_record_lines (id, record_id, room_type_code, remaining_sets)
       VALUES ($1,$2,$3,$4)`,
      [uuidv4(), recordId, line.room_type_code, line.remaining_sets],
    )
  }
  return recordId
}

async function loadLinenStocktakeDetail(client: any, id: string) {
  const recordRes = await client.query(
    `SELECT sr.*,
            w.code AS warehouse_code,
            w.name AS warehouse_name,
            dr.delivery_date,
            dr.status AS delivery_record_status
     FROM linen_stocktake_records sr
     JOIN warehouses w ON w.id = sr.warehouse_id
     LEFT JOIN linen_delivery_records dr ON dr.id = sr.delivery_record_id
     WHERE sr.id = $1`,
    [id],
  )
  const record = recordRes.rows?.[0] || null
  if (!record) return null
  const linesRes = await client.query(
    `SELECT sl.id,
            sl.record_id,
            sl.room_type_code,
            COALESCE(rt.name, sl.room_type_code) AS room_type_name,
            sl.remaining_sets
     FROM linen_stocktake_record_lines sl
     LEFT JOIN inventory_room_types rt ON rt.code = sl.room_type_code
     WHERE sl.record_id = $1
     ORDER BY COALESCE(rt.sort_order, 9999) ASC, sl.room_type_code ASC`,
    [id],
  )
  return {
    ...record,
    lines: (linesRes.rows || []).map((line: any) => ({
      id: String(line.id || ''),
      record_id: String(line.record_id || ''),
      room_type_code: String(line.room_type_code || ''),
      room_type_name: String(line.room_type_name || line.room_type_code || ''),
      remaining_sets: Number(line.remaining_sets || 0),
    })),
  }
}

async function getEditableLinenDeliveryRecordForUpdate(client: any, id: string) {
  const recordRes = await client.query(
    `SELECT *
     FROM linen_delivery_records
     WHERE id = $1
     FOR UPDATE`,
    [id],
  )
  const record = recordRes.rows?.[0] || null
  if (!record) return null
  const linesRes = await client.query(
    `SELECT room_type_code, sets
     FROM linen_delivery_record_lines
     WHERE record_id = $1
     ORDER BY room_type_code ASC`,
    [id],
  )
  return {
    record,
    lines: (linesRes.rows || []).map((line: any) => ({
      room_type_code: String(line.room_type_code || ''),
      sets: Number(line.sets || 0),
    })),
  }
}

function buildLinenDeliveryRecordFingerprint(input: {
  actor_id?: string | null
  delivery_date: string
  from_warehouse_id: string
  to_warehouse_id: string
  note?: string | null
  lines: Array<{ room_type_code: string; sets: number }>
  extra_linen_lines?: Array<{ linen_type_code: string; quantity: number }>
}) {
  const lines = [...(input.lines || [])]
    .map((line) => ({
      room_type_code: String(line.room_type_code || '').trim(),
      sets: Number(line.sets || 0),
    }))
    .sort((a, b) => {
      const byCode = a.room_type_code.localeCompare(b.room_type_code)
      if (byCode !== 0) return byCode
      return a.sets - b.sets
    })
  const extra_linen_lines = [...(input.extra_linen_lines || [])]
    .map((line) => ({
      linen_type_code: String(line.linen_type_code || '').trim(),
      quantity: Number(line.quantity || 0),
    }))
    .sort((a, b) => {
      const byCode = a.linen_type_code.localeCompare(b.linen_type_code)
      if (byCode !== 0) return byCode
      return a.quantity - b.quantity
    })
  return JSON.stringify({
    actor_id: String(input.actor_id || ''),
    delivery_date: String(input.delivery_date || ''),
    from_warehouse_id: String(input.from_warehouse_id || ''),
    to_warehouse_id: String(input.to_warehouse_id || ''),
    note: String(input.note || '').trim(),
    lines,
    extra_linen_lines,
  })
}

router.get('/warehouses', requirePerm('inventory.view'), async (req, res) => {
  const startedAt = Date.now()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT id, code, name, linen_capacity_sets, stocktake_enabled, active FROM warehouses ORDER BY code ASC`)
      const durationMs = Date.now() - startedAt
      if (!inventoryWarehousesFirstRequestLogged) {
        inventoryWarehousesFirstRequestLogged = true
        inventoryLog(req, durationMs > 500 ? 'error' : 'log', 'warehouses_first_request', { duration_ms: durationMs, target_ms: 500 })
      }
      return res.json(rows.rows || [])
    }
    return res.json([
      { id: 'wh.south_melbourne', code: 'SOU', name: 'South Melbourne', linen_capacity_sets: 500, stocktake_enabled: false, active: true },
      { id: 'wh.msq', code: 'MSQ', name: 'MSQ', linen_capacity_sets: 120, stocktake_enabled: true, active: true },
      { id: 'wh.wsp', code: 'WSP', name: 'WSP', linen_capacity_sets: 120, stocktake_enabled: true, active: true },
      { id: 'wh.my80', code: 'MY80', name: 'My80', linen_capacity_sets: 100, stocktake_enabled: true, active: true },
    ])
  } catch (e: any) {
    return sendInventoryError(req, res, e)
  }
})

const warehouseUpsertSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  linen_capacity_sets: z.number().int().min(0).optional(),
  stocktake_enabled: z.boolean().optional(),
  active: z.boolean().optional(),
})

router.post('/warehouses', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = warehouseUpsertSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const body = parsed.data
    const id = `wh.${String(body.code || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || randomSuffix(6).toLowerCase()}`
    const row = await pgPool.query(
      `INSERT INTO warehouses (id, code, name, linen_capacity_sets, stocktake_enabled, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [id, body.code, body.name, body.linen_capacity_sets ?? null, body.stocktake_enabled ?? true, body.active ?? true],
    )
    return res.status(201).json(row.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/warehouses/:id', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = warehouseUpsertSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter((k) => payload[k] !== undefined)
    if (!keys.length) return res.json(null)
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const row = await pgPool.query(
      `UPDATE warehouses
       SET ${sets}
       WHERE id = $${keys.length + 1}
       RETURNING *`,
      [...keys.map((k) => payload[k]), String(req.params.id || '')],
    )
    if (!row.rows?.[0]) return res.status(404).json({ message: 'not found' })
    return res.json(row.rows[0])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const dailyPriceUpsertSchema = z.object({
  category: z.string().optional().nullable(),
  item_name: z.string().min(1),
  cost_unit_price: z.coerce.number().min(0).optional(),
  unit_price: z.coerce.number().min(0),
  currency: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  default_quantity: z.coerce.number().int().min(1).optional().nullable(),
  is_active: z.boolean().optional(),
})

const consumablePriceUpdateSchema = z.object({
  item_name: z.string().min(1).optional(),
  cost_unit_price: z.coerce.number().min(0).optional(),
  unit_price: z.coerce.number().min(0).optional(),
  currency: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  default_quantity: z.coerce.number().int().min(1).optional().nullable(),
  is_active: z.boolean().optional(),
})

const consumableUsageQuerySchema = z.object({
  property_id: z.string().optional(),
  item_id: z.string().optional(),
  keyword: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

router.get('/daily-items-prices', requireAnyPerm(['inventory.view', 'inventory.po.manage']), async (req, res) => {
  const category = String((req.query as any)?.category || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureDailyPriceListSchema()
    await backfillDailyPriceSkus()
    await ensureDailyInventoryItemsSynced()
    const values: any[] = []
    const where: string[] = []
    if (category) {
      values.push(category)
      where.push(`category = $${values.length}`)
    }
    const sql = `SELECT * FROM daily_items_price_list${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(category, ''), item_name ASC`
    const rows = await pgPool.query(sql, values)
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/daily-items-prices', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = dailyPriceUpsertSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureDailyPriceListSchema()
    const id = uuidv4()
    const row: any = {
      id,
      sku: buildDailyItemSku(id),
      category: parsed.data.category || null,
      item_name: String(parsed.data.item_name || '').trim(),
      cost_unit_price: Number(parsed.data.cost_unit_price || 0),
      unit_price: Number(parsed.data.unit_price || 0),
      currency: parsed.data.currency || 'AUD',
      unit: parsed.data.unit || null,
      default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null,
      is_active: parsed.data.is_active != null ? !!parsed.data.is_active : true,
      updated_at: new Date().toISOString(),
      updated_by: actorId(req),
    }
    const created = await pgRunInTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO daily_items_price_list (id, sku, category, item_name, cost_unit_price, unit_price, currency, unit, default_quantity, is_active, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [row.id, row.sku, row.category, row.item_name, row.cost_unit_price, row.unit_price, row.currency, row.unit, row.default_quantity, row.is_active, row.updated_at, row.updated_by],
      )
      await syncDailyInventoryItemFromPriceRow(inserted.rows?.[0] || row, client)
      return inserted.rows?.[0] || row
    })
    return res.status(201).json(created || row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/daily-items-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = dailyPriceUpsertSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureDailyPriceListSchema()
    const updated = await pgRunInTransaction(async (client) => {
      await backfillDailyPriceSkus(client)
      const current = await client.query(`SELECT * FROM daily_items_price_list WHERE id = $1`, [id])
      const existing = current.rows?.[0]
      if (!existing) throw httpError(404, 'not found')
      const nextPayload: any = {
        ...(parsed.data.category !== undefined ? { category: parsed.data.category || null } : {}),
        ...(parsed.data.item_name !== undefined ? { item_name: String(parsed.data.item_name || '').trim() } : {}),
        ...(parsed.data.cost_unit_price !== undefined ? { cost_unit_price: Number(parsed.data.cost_unit_price || 0) } : {}),
        ...(parsed.data.unit_price !== undefined ? { unit_price: Number(parsed.data.unit_price || 0) } : {}),
        ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency || 'AUD' } : {}),
        ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit || null } : {}),
        ...(parsed.data.default_quantity !== undefined ? { default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null } : {}),
        ...(parsed.data.is_active !== undefined ? { is_active: !!parsed.data.is_active } : {}),
        updated_at: new Date().toISOString(),
        updated_by: actorId(req),
      }
      const keys = Object.keys(nextPayload)
      const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ')
      const values = keys.map((key) => nextPayload[key])
      const result = await client.query(`UPDATE daily_items_price_list SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...values, id])
      const row = result.rows?.[0] || { ...existing, ...nextPayload }
      await syncDailyInventoryItemFromPriceRow(row, client)
      return row
    })
    return res.json(updated || null)
  } catch (e: any) {
    const status = Number((e as any)?.statusCode || 500)
    return res.status(status).json({ message: (e as any)?.message || 'failed' })
  }
})

router.delete('/daily-items-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureDailyPriceListSchema()
    await pgRunInTransaction(async (client) => {
      await client.query(`DELETE FROM daily_items_price_list WHERE id = $1`, [id])
      await ensureInventorySchema()
      await client.query(`UPDATE inventory_items SET active = false, updated_at = now() WHERE id = $1`, [toDailyInventoryItemId(id)])
    })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/daily-stock-overview', requirePerm('inventory.view'), async (_req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json({ warehouses: [], items: [] })
    await ensureDailyPriceListSchema()
    await backfillDailyPriceSkus()
    await ensureDailyInventoryItemsSynced()
    await ensureInventorySchema()
    const [warehouseRows, priceRows] = await Promise.all([
      pgPool.query(`SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY code ASC`),
      pgPool.query(`SELECT * FROM daily_items_price_list WHERE is_active = true ORDER BY COALESCE(category, ''), item_name ASC`),
    ])
    const warehouses = warehouseRows.rows || []
    const items = priceRows.rows || []
    const itemIds = items.map((row: any) => toDailyInventoryItemId(String(row.id)))
    const warehouseIds = warehouses.map((row: any) => String(row.id))
    const stockMap = new Map<string, number>()
    if (itemIds.length && warehouseIds.length) {
      const stockRows = await pgPool.query(
        `SELECT warehouse_id, item_id, quantity
         FROM warehouse_stocks
         WHERE warehouse_id = ANY($1::text[]) AND item_id = ANY($2::text[])`,
        [warehouseIds, itemIds],
      )
      for (const row of stockRows.rows || []) {
        stockMap.set(`${String(row.warehouse_id)}::${String(row.item_id)}`, Number(row.quantity || 0))
      }
    }
    return res.json({
      warehouses,
      items: items.map((row: any) => {
        const itemId = toDailyInventoryItemId(String(row.id))
        const stock_by_warehouse = warehouses.map((warehouse: any) => ({
          warehouse_id: String(warehouse.id),
          quantity: Number(stockMap.get(`${String(warehouse.id)}::${itemId}`) || 0),
        }))
        return {
          id: String(row.id),
          item_id: itemId,
          category: row.category,
          item_name: row.item_name,
          sku: row.sku,
          unit: row.unit,
          default_quantity: row.default_quantity,
          unit_price: Number(row.unit_price || 0),
          currency: row.currency || 'AUD',
          stock_by_warehouse,
          total_quantity: stock_by_warehouse.reduce((sum: number, stock: any) => sum + Number(stock.quantity || 0), 0),
        }
      }),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/consumable-items-prices', requireAnyPerm(['inventory.view', 'inventory.po.manage']), async (_req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureConsumablePriceListSeeded()
    await ensureConsumableInventoryItemsSynced()
    const rows = await pgPool.query(`SELECT * FROM consumable_items_price_list ORDER BY sort_order ASC NULLS LAST, item_name ASC`)
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/consumable-items-prices', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = consumablePriceUpdateSchema.extend({
    item_name: z.string().min(1),
  }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureConsumablePriceListSeeded()
    const id = uuidv4()
    const row: any = {
      id,
      sku: buildConsumableItemSku(id),
      item_name: String(parsed.data.item_name || '').trim(),
      cost_unit_price: Number(parsed.data.cost_unit_price || 0),
      unit_price: Number(parsed.data.unit_price || 0),
      currency: parsed.data.currency || 'AUD',
      unit: parsed.data.unit || null,
      default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null,
      sort_order: null,
      is_active: parsed.data.is_active != null ? !!parsed.data.is_active : true,
      updated_at: new Date().toISOString(),
      updated_by: actorId(req),
    }
    const created = await pgRunInTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO consumable_items_price_list (id, sku, item_name, cost_unit_price, unit_price, currency, unit, default_quantity, sort_order, is_active, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [row.id, row.sku, row.item_name, row.cost_unit_price, row.unit_price, row.currency, row.unit, row.default_quantity, row.sort_order, row.is_active, row.updated_at, row.updated_by],
      )
      await syncConsumableInventoryItemFromPriceRow(inserted.rows?.[0] || row, client)
      return inserted.rows?.[0] || row
    })
    return res.status(201).json(created || row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/consumable-items-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = consumablePriceUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureConsumablePriceListSeeded()
    const updated = await pgRunInTransaction(async (client) => {
      const current = await client.query(`SELECT * FROM consumable_items_price_list WHERE id = $1`, [id])
      const existing = current.rows?.[0]
      if (!existing) throw httpError(404, 'not found')
      const nextPayload: any = {
        ...(parsed.data.item_name !== undefined ? { item_name: String(parsed.data.item_name || '').trim() } : {}),
        ...(parsed.data.cost_unit_price !== undefined ? { cost_unit_price: Number(parsed.data.cost_unit_price || 0) } : {}),
        ...(parsed.data.unit_price !== undefined ? { unit_price: Number(parsed.data.unit_price || 0) } : {}),
        ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency || 'AUD' } : {}),
        ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit || null } : {}),
        ...(parsed.data.default_quantity !== undefined ? { default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null } : {}),
        ...(parsed.data.is_active !== undefined ? { is_active: !!parsed.data.is_active } : {}),
        updated_at: new Date().toISOString(),
        updated_by: actorId(req),
      }
      const keys = Object.keys(nextPayload)
      if (!keys.length) return existing
      const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ')
      const values = keys.map((key) => nextPayload[key])
      const result = await client.query(`UPDATE consumable_items_price_list SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...values, id])
      const row = result.rows?.[0] || { ...existing, ...nextPayload }
      await syncConsumableInventoryItemFromPriceRow(row, client)
      return row
    })
    return res.json(updated || null)
  } catch (e: any) {
    const status = Number((e as any)?.statusCode || 500)
    return res.status(status).json({ message: (e as any)?.message || 'failed' })
  }
})

router.delete('/consumable-items-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureConsumablePriceListSeeded()
    await ensureInventorySchema()
    await pgRunInTransaction(async (client) => {
      await client.query(`DELETE FROM consumable_items_price_list WHERE id = $1`, [id])
      await client.query(`DELETE FROM inventory_items WHERE id = $1`, [toConsumableInventoryItemId(id)])
      await client.query(`DELETE FROM warehouse_stocks WHERE item_id = $1`, [toConsumableInventoryItemId(id)])
    })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/consumable-stock-overview', requirePerm('inventory.view'), async (_req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json({ warehouses: [], items: [] })
    await ensureConsumablePriceListSeeded()
    await ensureConsumableInventoryItemsSynced()
    await ensureInventorySchema()
    const [warehouseRows, priceRows] = await Promise.all([
      pgPool.query(`SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY code ASC`),
      pgPool.query(`SELECT * FROM consumable_items_price_list WHERE is_active = true ORDER BY sort_order ASC NULLS LAST, item_name ASC`),
    ])
    const warehouses = warehouseRows.rows || []
    const items = priceRows.rows || []
    const itemIds = items.map((row: any) => toConsumableInventoryItemId(String(row.id)))
    const warehouseIds = warehouses.map((row: any) => String(row.id))
    const stockMap = new Map<string, number>()
    if (itemIds.length && warehouseIds.length) {
      const stockRows = await pgPool.query(
        `SELECT warehouse_id, item_id, quantity
         FROM warehouse_stocks
         WHERE warehouse_id = ANY($1::text[]) AND item_id = ANY($2::text[])`,
        [warehouseIds, itemIds],
      )
      for (const row of stockRows.rows || []) {
        stockMap.set(`${String(row.warehouse_id)}::${String(row.item_id)}`, Number(row.quantity || 0))
      }
    }
    return res.json({
      warehouses,
      items: items.map((row: any) => {
        const itemId = toConsumableInventoryItemId(String(row.id))
        const stock_by_warehouse = warehouses.map((warehouse: any) => ({
          warehouse_id: String(warehouse.id),
          quantity: Number(stockMap.get(`${String(warehouse.id)}::${itemId}`) || 0),
        }))
        return {
          id: String(row.id),
          item_id: itemId,
          item_name: row.item_name,
          sku: row.sku,
          unit: row.unit,
          default_quantity: row.default_quantity,
          unit_price: Number(row.unit_price || 0),
          currency: row.currency || 'AUD',
          stock_by_warehouse,
          total_quantity: stock_by_warehouse.reduce((sum: number, stock: any) => sum + Number(stock.quantity || 0), 0),
        }
      }),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/other-items-prices', requireAnyPerm(['inventory.view', 'inventory.po.manage']), async (_req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureOtherPriceListSchema()
    await backfillOtherSkus()
    await ensureOtherInventoryItemsSynced()
    const rows = await pgPool.query(`SELECT * FROM other_items_price_list ORDER BY sort_order ASC NULLS LAST, item_name ASC`)
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/other-items-prices', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = consumablePriceUpdateSchema.extend({
    item_name: z.string().min(1),
  }).safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureOtherPriceListSchema()
    const id = uuidv4()
    const row: any = {
      id,
      sku: buildOtherItemSku(id),
      item_name: String(parsed.data.item_name || '').trim(),
      cost_unit_price: Number(parsed.data.cost_unit_price || 0),
      unit_price: Number(parsed.data.unit_price || 0),
      currency: parsed.data.currency || 'AUD',
      unit: parsed.data.unit || null,
      default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null,
      sort_order: null,
      is_active: parsed.data.is_active != null ? !!parsed.data.is_active : true,
      updated_at: new Date().toISOString(),
      updated_by: actorId(req),
    }
    const created = await pgRunInTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO other_items_price_list (id, sku, item_name, cost_unit_price, unit_price, currency, unit, default_quantity, sort_order, is_active, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [row.id, row.sku, row.item_name, row.cost_unit_price, row.unit_price, row.currency, row.unit, row.default_quantity, row.sort_order, row.is_active, row.updated_at, row.updated_by],
      )
      await syncOtherInventoryItemFromPriceRow(inserted.rows?.[0] || row, client)
      return inserted.rows?.[0] || row
    })
    return res.status(201).json(created || row)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/other-items-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = consumablePriceUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureOtherPriceListSchema()
    const updated = await pgRunInTransaction(async (client) => {
      const current = await client.query(`SELECT * FROM other_items_price_list WHERE id = $1`, [id])
      const existing = current.rows?.[0]
      if (!existing) throw httpError(404, 'not found')
      const nextPayload: any = {
        ...(parsed.data.item_name !== undefined ? { item_name: String(parsed.data.item_name || '').trim() } : {}),
        ...(parsed.data.cost_unit_price !== undefined ? { cost_unit_price: Number(parsed.data.cost_unit_price || 0) } : {}),
        ...(parsed.data.unit_price !== undefined ? { unit_price: Number(parsed.data.unit_price || 0) } : {}),
        ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency || 'AUD' } : {}),
        ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit || null } : {}),
        ...(parsed.data.default_quantity !== undefined ? { default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null } : {}),
        ...(parsed.data.is_active !== undefined ? { is_active: !!parsed.data.is_active } : {}),
        updated_at: new Date().toISOString(),
        updated_by: actorId(req),
      }
      const keys = Object.keys(nextPayload)
      if (!keys.length) return existing
      const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ')
      const values = keys.map((key) => nextPayload[key])
      const result = await client.query(`UPDATE other_items_price_list SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...values, id])
      const row = result.rows?.[0] || { ...existing, ...nextPayload }
      await syncOtherInventoryItemFromPriceRow(row, client)
      return row
    })
    return res.json(updated || null)
  } catch (e: any) {
    const status = Number((e as any)?.statusCode || 500)
    return res.status(status).json({ message: (e as any)?.message || 'failed' })
  }
})

router.delete('/other-items-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureOtherPriceListSchema()
    await ensureInventorySchema()
    await pgRunInTransaction(async (client) => {
      await client.query(`DELETE FROM other_items_price_list WHERE id = $1`, [id])
      await client.query(`DELETE FROM inventory_items WHERE id = $1`, [toOtherInventoryItemId(id)])
      await client.query(`DELETE FROM warehouse_stocks WHERE item_id = $1`, [toOtherInventoryItemId(id)])
    })
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/other-stock-overview', requirePerm('inventory.view'), async (_req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json({ warehouses: [], items: [] })
    await ensureOtherPriceListSchema()
    await ensureOtherInventoryItemsSynced()
    await ensureInventorySchema()
    const [warehouseRows, priceRows] = await Promise.all([
      pgPool.query(`SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY code ASC`),
      pgPool.query(`SELECT * FROM other_items_price_list WHERE is_active = true ORDER BY sort_order ASC NULLS LAST, item_name ASC`),
    ])
    const warehouses = warehouseRows.rows || []
    const items = priceRows.rows || []
    const itemIds = items.map((row: any) => toOtherInventoryItemId(String(row.id)))
    const warehouseIds = warehouses.map((row: any) => String(row.id))
    const stockMap = new Map<string, number>()
    if (itemIds.length && warehouseIds.length) {
      const stockRows = await pgPool.query(
        `SELECT warehouse_id, item_id, quantity
         FROM warehouse_stocks
         WHERE warehouse_id = ANY($1::text[]) AND item_id = ANY($2::text[])`,
        [warehouseIds, itemIds],
      )
      for (const row of stockRows.rows || []) {
        stockMap.set(`${String(row.warehouse_id)}::${String(row.item_id)}`, Number(row.quantity || 0))
      }
    }
    return res.json({
      warehouses,
      items: items.map((row: any) => {
        const itemId = toOtherInventoryItemId(String(row.id))
        const stock_by_warehouse = warehouses.map((warehouse: any) => ({
          warehouse_id: String(warehouse.id),
          quantity: Number(stockMap.get(`${String(warehouse.id)}::${itemId}`) || 0),
        }))
        return {
          id: String(row.id || ''),
          item_id: itemId,
          item_name: String(row.item_name || ''),
          sku: String(row.sku || ''),
          unit: row.unit || null,
          default_quantity: row.default_quantity == null ? null : Number(row.default_quantity || 0),
          unit_price: Number(row.unit_price || 0),
          currency: row.currency || 'AUD',
          stock_by_warehouse,
          total_quantity: stock_by_warehouse.reduce((sum: number, stock: any) => sum + Number(stock.quantity || 0), 0),
        }
      }),
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/consumable-usage-records', requirePerm('inventory.view'), async (req, res) => {
  const parsed = consumableUsageQuerySchema.safeParse(req.query || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.json([])

    const where: string[] = [`(COALESCE(u.status,'') = 'low' OR u.need_restock = true)`]
    const values: any[] = []

    const propertyId = String(parsed.data.property_id || '').trim()
    const itemId = String(parsed.data.item_id || '').trim()
    const keyword = String(parsed.data.keyword || '').trim()
    const from = String(parsed.data.from || '').trim()
    const to = String(parsed.data.to || '').trim()

    if (propertyId) {
      values.push(propertyId)
      where.push(`COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $${values.length}`)
    }
    if (itemId) {
      values.push(itemId)
      where.push(`u.item_id::text = $${values.length}`)
    }
    if (from) {
      values.push(from)
      where.push(`COALESCE(t.task_date, t.date, u.created_at)::date >= $${values.length}::date`)
    }
    if (to) {
      values.push(to)
      where.push(`COALESCE(t.task_date, t.date, u.created_at)::date <= $${values.length}::date`)
    }
    if (keyword) {
      values.push(`%${keyword}%`)
      where.push(`(
        COALESCE(p_id.code::text, p_code.code::text, '') ILIKE $${values.length}
        OR COALESCE(p_id.address::text, p_code.address::text, '') ILIKE $${values.length}
        OR COALESCE(u.item_label::text, c.label::text, u.item_id::text, '') ILIKE $${values.length}
        OR COALESCE(u.note::text, '') ILIKE $${values.length}
      )`)
    }

    const sql = `
      SELECT
        u.id::text AS id,
        u.task_id::text AS task_id,
        u.item_id::text AS item_id,
        COALESCE(u.item_label, c.label, u.item_id::text) AS item_name,
        COALESCE(u.status, '') AS status,
        COALESCE(u.qty, 0) AS quantity,
        u.note,
        u.photo_url,
        u.created_at,
        COALESCE(t.task_date, t.date, u.created_at::date) AS occurred_on,
        COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
        COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code,
        COALESCE(p_id.address, p_code.address, '') AS property_address,
        COALESCE(ua.display_name, ua.username, ua.email, t.assignee_id::text, '') AS submitter_name
      FROM cleaning_consumable_usages u
      LEFT JOIN cleaning_tasks t ON t.id::text = u.task_id::text
      LEFT JOIN cleaning_checklist_items c ON c.id::text = u.item_id::text
      LEFT JOIN properties p_id ON p_id.id::text = t.property_id::text
      LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
      LEFT JOIN users ua ON ua.id::text = t.assignee_id::text
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(t.task_date, t.date, u.created_at::date) DESC, u.created_at DESC
      LIMIT 500
    `
    const result = await pgPool.query(sql, values)
    return res.json((result.rows || []).map((row: any) => ({
      id: String(row.id || ''),
      task_id: String(row.task_id || ''),
      item_id: String(row.item_id || ''),
      item_name: String(row.item_name || ''),
      status: String(row.status || ''),
      quantity: Number(row.quantity || 0),
      note: row.note == null ? null : String(row.note || ''),
      photo_url: row.photo_url == null ? null : String(row.photo_url || ''),
      created_at: row.created_at,
      occurred_on: row.occurred_on,
      property_id: row.property_id == null ? null : String(row.property_id || ''),
      property_code: row.property_code == null ? null : String(row.property_code || ''),
      property_address: row.property_address == null ? null : String(row.property_address || ''),
      submitter_name: row.submitter_name == null ? null : String(row.submitter_name || ''),
    })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const linenTypeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  psl_code: z.string().optional(),
  in_set: z.boolean().optional(),
  set_divisor: z.number().int().min(1).optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
})

router.get('/linen-types', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`
        SELECT lt.code,
               lt.name,
               lt.psl_code,
               lt.in_set,
               lt.set_divisor,
               lt.sort_order,
               lt.active,
               (
                 SELECT i.id
                 FROM inventory_items i
                 WHERE i.category = 'linen' AND i.linen_type_code = lt.code
                 ORDER BY i.active DESC, i.name ASC, i.id ASC
                 LIMIT 1
               ) AS item_id
        FROM inventory_linen_types lt
        ORDER BY lt.active DESC, lt.sort_order ASC, lt.code ASC
      `)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/linen-types', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = linenTypeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const v = parsed.data
    const row = await pgPool.query(
      `INSERT INTO inventory_linen_types (code, name, psl_code, in_set, set_divisor, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING code, name, psl_code, in_set, set_divisor, sort_order, active`,
      [v.code, v.name, v.psl_code ?? null, v.in_set ?? true, v.set_divisor ?? 1, v.sort_order ?? 0, v.active ?? true],
    )
    const itemId = `item.linen_type.${v.code}`
    await pgPool.query(
      `INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
       VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`,
      [itemId, v.name, `LT:${v.code}`, v.code, v.active ?? true],
    )
    addAudit('InventoryLinenType', v.code, 'create', null, row.rows?.[0] || null, actorId(req))
    return res.status(201).json(row.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/linen-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  const parsed = linenTypeSchema.partial().safeParse({ ...req.body, code })
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code])
    const b = before.rows?.[0]
    if (!b) return res.status(404).json({ message: 'not found' })
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code')
    if (!keys.length) return res.json(b)
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map(k => (payload as any)[k])
    const sql = `UPDATE inventory_linen_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, psl_code, in_set, set_divisor, sort_order, active`
    const after = await pgPool.query(sql, [...values, code])
    const a = after.rows?.[0]
    if (a) {
      const itemId = `item.linen_type.${code}`
      await pgPool.query(
        `INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`,
        [itemId, a.name, `LT:${code}`, code, a.active],
      )
    }
    addAudit('InventoryLinenType', code, 'update', b, after.rows?.[0] || null, actorId(req))
    return res.json(after.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/linen-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const itemId = `item.linen_type.${code}`
    const used1 = await pgPool.query(`SELECT 1 FROM warehouse_stocks WHERE item_id = $1 LIMIT 1`, [itemId])
    if ((used1.rows || []).length) return res.status(409).json({ message: '该类型已有库存记录，无法删除' })
    const used2 = await pgPool.query(`SELECT 1 FROM stock_movements WHERE item_id = $1 LIMIT 1`, [itemId])
    if ((used2.rows || []).length) return res.status(409).json({ message: '该类型已有流水记录，无法删除' })
    const used3 = await pgPool.query(`SELECT 1 FROM purchase_order_lines WHERE item_id = $1 LIMIT 1`, [itemId])
    if ((used3.rows || []).length) return res.status(409).json({ message: '该类型已有采购记录，无法删除' })

    const before = await pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code])
    const b = before.rows?.[0] || null
    await pgRunInTransaction(async (client) => {
      await client.query(`DELETE FROM inventory_linen_types WHERE code = $1`, [code])
      await client.query(`DELETE FROM inventory_items WHERE id = $1`, [itemId])
      return { ok: true as const }
    })
    addAudit('InventoryLinenType', code, 'delete', b, null, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const roomTypeSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  bedrooms: z.number().int().min(0).optional(),
  bathrooms: z.number().int().min(0).optional(),
  sort_order: z.number().int().optional(),
  active: z.boolean().optional(),
})

router.get('/room-types', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types ORDER BY active DESC, sort_order ASC, code ASC`)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/room-types', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = roomTypeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const v = parsed.data
    const row = await pgPool.query(
      `INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING code, name, bedrooms, bathrooms, sort_order, active`,
      [v.code, v.name, v.bedrooms ?? null, v.bathrooms ?? null, v.sort_order ?? 0, v.active ?? true],
    )
    addAudit('InventoryRoomType', v.code, 'create', null, row.rows?.[0] || null, actorId(req))
    return res.status(201).json(row.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/room-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  const parsed = roomTypeSchema.partial().safeParse({ ...req.body, code })
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code])
    const b = before.rows?.[0]
    if (!b) return res.status(404).json({ message: 'not found' })
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code')
    if (!keys.length) return res.json(b)
    const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map(k => (payload as any)[k])
    const sql = `UPDATE inventory_room_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, bedrooms, bathrooms, sort_order, active`
    const after = await pgPool.query(sql, [...values, code])
    addAudit('InventoryRoomType', code, 'update', b, after.rows?.[0] || null, actorId(req))
    return res.json(after.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/room-types/:code', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const used1 = await pgPool.query(`SELECT 1 FROM inventory_room_type_requirements WHERE room_type_code = $1 LIMIT 1`, [code])
    if ((used1.rows || []).length) return res.status(409).json({ message: '该房型已有占用配置，无法删除' })
    const used2 = await pgPool.query(`SELECT 1 FROM properties WHERE room_type_code = $1 LIMIT 1`, [code])
    if ((used2.rows || []).length) return res.status(409).json({ message: '该房型已被房源使用，无法删除' })
    const before = await pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code])
    const b = before.rows?.[0] || null
    await pgPool.query(`DELETE FROM inventory_room_types WHERE code = $1`, [code])
    addAudit('InventoryRoomType', code, 'delete', b, null, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/room-types/:code/requirements', requirePerm('inventory.view'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const [rt, reqs, types] = await Promise.all([
        pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types WHERE code = $1`, [code]),
        pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code]),
        pgPool.query(`SELECT code, name, sort_order, active FROM inventory_linen_types WHERE active = true ORDER BY sort_order ASC, code ASC`),
      ])
      const roomType = rt.rows?.[0] || null
      if (!roomType) return res.status(404).json({ message: 'not found' })
      const map = new Map<string, number>((reqs.rows || []).map((r: any) => [String(r.linen_type_code), Number(r.quantity || 0)]))
      const out = (types.rows || []).map((t: any) => ({
        linen_type_code: String(t.code),
        linen_type_name: String(t.name),
        quantity: Number(map.get(String(t.code)) || 0),
      }))
      return res.json({ room_type: roomType, requirements: out })
    }
    return res.json({ room_type: null, requirements: [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const roomTypeRequirementsSchema = z.object({
  requirements: z.array(z.object({
    linen_type_code: z.string().min(1),
    quantity: z.number().int().min(0),
  })),
})

router.put('/room-types/:code/requirements', requirePerm('inventory.item.manage'), async (req, res) => {
  const code = String(req.params.code || '').trim()
  const parsed = roomTypeRequirementsSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const rt = await pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code])
    const roomType = rt.rows?.[0]
    if (!roomType) return res.status(404).json({ message: 'not found' })

    const next = (parsed.data.requirements || []).map((r) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }))
    const nextMap = new Map<string, number>(next.map((r) => [r.linen_type_code, r.quantity]))
    const old = await pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code])
    const oldRows = old.rows || []
    const oldMap = new Map<string, number>(oldRows.map((r: any) => [String(r.linen_type_code), Number(r.quantity || 0)]))

    await pgRunInTransaction(async (client) => {
      for (const [k] of oldMap.entries()) {
        if (!nextMap.has(k)) await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k])
      }
      for (const [k, qty] of nextMap.entries()) {
        if (qty <= 0) {
          await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k])
        } else {
          await client.query(
            `INSERT INTO inventory_room_type_requirements (room_type_code, linen_type_code, quantity)
             VALUES ($1,$2,$3)
             ON CONFLICT (room_type_code, linen_type_code)
             DO UPDATE SET quantity = EXCLUDED.quantity`,
            [code, k, qty],
          )
        }
      }
      return { ok: true as const }
    })
    addAudit('InventoryRoomType', code, 'update_requirements', { requirements: oldRows }, { requirements: next }, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/items', requirePerm('inventory.view'), async (req, res) => {
  try {
    const q = String((req.query as any)?.q || '').trim()
    const category = String((req.query as any)?.category || '').trim()
    const active = String((req.query as any)?.active || '').trim().toLowerCase()
    const linenTypeCode = String((req.query as any)?.linen_type_code || '').trim()
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const where: string[] = []
      const values: any[] = []
      const linenAlias = category === 'linen' ? 'i' : ''
      const col = (name: string) => linenAlias ? `${linenAlias}.${name}` : name
      if (q) {
        values.push(`%${q}%`)
        values.push(`%${q}%`)
        where.push(`(${col('name')} ILIKE $${values.length - 1} OR ${col('sku')} ILIKE $${values.length})`)
      }
      if (category) {
        values.push(category)
        where.push(`${col('category')} = $${values.length}`)
      }
      if (active === 'true' || active === 'false') {
        values.push(active === 'true')
        where.push(`${col('active')} = $${values.length}`)
      }
      if (linenTypeCode) {
        values.push(linenTypeCode)
        where.push(`${col('linen_type_code')} = $${values.length}`)
      }
      const sql = category === 'linen'
        ? `SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item
             FROM inventory_items i
             LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`
        : `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
             FROM inventory_items
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY name ASC`
      const rows = await pgPool.query(sql, values)
      return res.json(rows.rows || [])
    }
    return res.json(db.inventoryItems || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const createItemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1),
  category: z.enum(['linen','consumable','daily']).optional(),
  sub_type: z.string().optional(),
  linen_type_code: z.string().optional(),
  unit: z.string().min(1),
  default_threshold: z.number().int().min(0).optional(),
  bin_location: z.string().optional(),
  active: z.boolean().optional(),
  is_key_item: z.boolean().optional(),
})

router.post('/items', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = createItemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const item: any = {
        id: uuidv4(),
        name: parsed.data.name,
        sku: parsed.data.sku,
        category: parsed.data.category || 'consumable',
        sub_type: parsed.data.sub_type || null,
        linen_type_code: parsed.data.linen_type_code || null,
        unit: parsed.data.unit,
        default_threshold: parsed.data.default_threshold ?? 0,
        bin_location: parsed.data.bin_location || null,
        active: parsed.data.active ?? true,
        is_key_item: parsed.data.is_key_item ?? false,
      }
      const row = await pgPool.query(
        `INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [item.id, item.name, item.sku, item.category, item.sub_type, item.linen_type_code, item.unit, item.default_threshold, item.bin_location, item.active, item.is_key_item],
      )
      addAudit('InventoryItem', item.id, 'create', null, row.rows?.[0] || item, actorId(req))
      return res.status(201).json(row.rows?.[0] || item)
    }
    const item = { id: uuidv4(), threshold: parsed.data.default_threshold ?? 0, quantity: 0, ...parsed.data, category: parsed.data.category || 'consumable' }
    db.inventoryItems.push(item as any)
    addAudit('InventoryItem', item.id, 'create', null, item, actorId(req))
    return res.status(201).json(item)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg)) return res.status(400).json({ message: 'SKU 已存在' })
    return res.status(500).json({ message: msg || 'failed' })
  }
})

const patchItemSchema = createItemSchema.partial()

router.patch('/items/:id', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = patchItemSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const before = await pgPool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'item not found' })
      const payload = parsed.data as any
      const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
      if (!keys.length) return res.json(b)
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map(k => (payload as any)[k])
      const sql = `UPDATE inventory_items SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
      const after = await pgPool.query(sql, [...values, id])
      addAudit('InventoryItem', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }
    const it: any = db.inventoryItems.find((x: any) => x.id === id)
    if (!it) return res.status(404).json({ message: 'item not found' })
    const before = { ...it }
    Object.assign(it, parsed.data)
    addAudit('InventoryItem', id, 'update', before, it, actorId(req))
    return res.json(it)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg)) return res.status(400).json({ message: 'SKU 已存在' })
    return res.status(500).json({ message: msg || 'failed' })
  }
})

router.get('/stocks', requirePerm('inventory.view'), async (req, res) => {
  const warehouse_id = String((req.query as any)?.warehouse_id || '').trim()
  if (!warehouse_id) return res.status(400).json({ message: 'warehouse_id required' })
  const warningsOnly = String((req.query as any)?.warnings_only || '').toLowerCase() === 'true'
  const keyOnly = String((req.query as any)?.key_only || '').toLowerCase() === 'true'
  const category = String((req.query as any)?.category || '').trim()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      if (category) {
        const itemVals: any[] = [category]
        let itemSql = category === 'linen'
        ? `SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item, lt.sort_order
               FROM inventory_items i
               LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
               WHERE i.category = $1`
          : `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
               FROM inventory_items
               WHERE category = $1`
        if (keyOnly) itemSql += ` AND is_key_item = true`
        itemSql += category === 'linen'
          ? ` ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`
          : ` ORDER BY name ASC`
        const items = await pgPool.query(itemSql, itemVals)
        const itemRows = items.rows || []
        if (!itemRows.length) return res.json([])
        const itemMap = new Map<string, any>(itemRows.map((r: any) => [String(r.id), r]))
        const ids = itemRows.map((r: any) => String(r.id))
        const stocks = await pgPool.query(
          `SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE warehouse_id = $1 AND item_id = ANY($2::text[])
           ORDER BY item_id ASC`,
          [warehouse_id, ids],
        )
        let out = (stocks.rows || []).map((s: any) => {
          const it = itemMap.get(String(s.item_id)) || {}
          const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0)
          return {
            ...s,
            name: it.name,
            sku: it.sku,
            category: it.category,
            sub_type: it.sub_type,
            sort_order: it.sort_order,
            unit: it.unit,
            default_threshold: it.default_threshold,
            bin_location: it.bin_location,
            active: it.active,
            is_key_item: it.is_key_item,
            threshold_effective: eff,
          }
        }).sort((a: any, b: any) => {
          if (category === 'linen') {
            const sortA = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 9999
            const sortB = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 9999
            if (sortA !== sortB) return sortA - sortB
          }
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
        })
        if (warningsOnly) out = out.filter((x: any) => Number(x.quantity || 0) < Number(x.threshold_effective || 0))
        return res.json(out)
      }
      const values: any[] = [warehouse_id]
      const where: string[] = [`s.warehouse_id = $1`]
      if (keyOnly) where.push(`i.is_key_item = true`)
      const sql = `
        SELECT
          s.id,
          s.warehouse_id,
          s.item_id,
          s.quantity,
          s.threshold,
          i.name,
          i.sku,
          i.category,
          i.sub_type,
          i.unit,
          i.default_threshold,
          i.bin_location,
          i.active,
          i.is_key_item
        FROM warehouse_stocks s
        JOIN inventory_items i ON i.id = s.item_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.name ASC
      `
      const rows = await pgPool.query(sql, values)
      let out = (rows.rows || []).map((r: any) => ({
        ...r,
        threshold_effective: r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0),
      }))
      if (warningsOnly) out = out.filter((x: any) => Number(x.quantity || 0) < Number(x.threshold_effective || 0))
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/warnings', requirePerm('inventory.view'), async (req, res) => {
  const warehouse_id = String((req.query as any)?.warehouse_id || '').trim()
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const values: any[] = []
      const where: string[] = []
      if (warehouse_id) {
        values.push(warehouse_id)
        where.push(`s.warehouse_id = $${values.length}`)
      }
      const sql = `
        SELECT
          s.id,
          s.warehouse_id,
          s.item_id,
          s.quantity,
          s.threshold,
          i.name,
          i.sku,
          i.category,
          i.unit,
          i.default_threshold
        FROM warehouse_stocks s
        JOIN inventory_items i ON i.id = s.item_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `
      const rows = await pgPool.query(sql, values)
      const out = (rows.rows || []).map((r: any) => {
        const eff = r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0)
        return { ...r, threshold_effective: eff }
      }).filter((x: any) => Number(x.quantity || 0) < Number(x.threshold_effective || 0))
      return res.json(out)
    }
    return res.json((db.inventoryItems || []).filter((i: any) => i.quantity < i.threshold))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const movementSchema = z.object({
  warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  type: z.enum(['in','out','adjust']),
  quantity: z.number().int(),
  reason: z.string().optional(),
  property_id: z.string().optional(),
  ref_type: z.string().optional(),
  ref_id: z.string().optional(),
  note: z.string().optional(),
}).superRefine((v, ctx) => {
  if (v.type === 'in' || v.type === 'out') {
    if (v.quantity <= 0) ctx.addIssue({ code: 'custom', message: 'quantity must be >= 1', path: ['quantity'] })
  } else {
    if (v.quantity === 0) ctx.addIssue({ code: 'custom', message: 'quantity must not be 0', path: ['quantity'] })
  }
})

router.post('/movements', requirePerm('inventory.move'), async (req, res) => {
  const parsed = movementSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const result = await pgRunInTransaction(async (client) => {
        const r = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.warehouse_id,
          item_id: parsed.data.item_id,
          type: parsed.data.type,
          quantity: parsed.data.quantity,
          reason: parsed.data.reason || null,
          property_id: parsed.data.property_id || null,
          ref_type: parsed.data.ref_type || null,
          ref_id: parsed.data.ref_id || null,
          actor_id: actorId(req),
          note: parsed.data.note || null,
        })
        if (!r.ok) return r
        const stockRow = r.stock
        addAudit('WarehouseStock', stockRow?.id || `${parsed.data.warehouse_id}.${parsed.data.item_id}`, 'movement', null, { movement_id: r.movement_id, stock: stockRow }, actorId(req))
        return r
      })
      if (!result) return res.status(500).json({ message: 'db not ready' })
      if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
      return res.json((result as any).stock || null)
    }
    const item = db.inventoryItems.find((i: any) => i.id === parsed.data.item_id)
    if (!item) return res.status(404).json({ message: 'item not found' })
    const before = { ...item }
    if (parsed.data.type === 'in') item.quantity += parsed.data.quantity
    else if (parsed.data.type === 'out') {
      if (item.quantity < parsed.data.quantity) return res.status(409).json({ message: 'insufficient stock' })
      item.quantity -= parsed.data.quantity
    } else item.quantity += parsed.data.quantity
    db.stockMovements.push({ id: uuidv4(), item_id: item.id, type: parsed.data.type, quantity: parsed.data.quantity, timestamp: new Date().toISOString() } as any)
    addAudit('InventoryItem', item.id, 'movement', before, item, actorId(req))
    return res.json(item)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const transferSchema = z.object({
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  quantity: z.number().int().min(1),
  note: z.string().optional(),
  photo_url: z.string().optional(),
})

const transferRecordCreateSchema = z.object({
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  note: z.string().optional(),
  lines: z.array(z.object({
    item_id: z.string().min(1),
    quantity: z.number().int().min(1),
  })).min(1),
})

const transferRecordUpdateSchema = transferRecordCreateSchema

function normalizeTransferRecordLines(lines: Array<{ item_id: string; quantity: number }>) {
  const normalized = Array.from(
    (lines || []).reduce((map, line) => {
      const itemId = String(line?.item_id || '').trim()
      const quantity = Number(line?.quantity || 0)
      if (!itemId || quantity < 1) return map
      map.set(itemId, (map.get(itemId) || 0) + quantity)
      return map
    }, new Map<string, number>()),
  ).map(([item_id, quantity]) => ({ item_id, quantity }))
  return normalized
}

async function loadLegacyTransferRecordDetail(client: any, id: string) {
  const rs = await client.query(
    `SELECT
       m.ref_id,
       m.warehouse_id,
       m.item_id,
       m.type,
       m.quantity,
       m.note,
       m.created_at,
       i.name AS item_name,
       i.sku AS item_sku,
       i.category AS item_category,
       w.code AS warehouse_code,
       w.name AS warehouse_name
     FROM stock_movements m
     JOIN inventory_items i ON i.id = m.item_id
     JOIN warehouses w ON w.id = m.warehouse_id
     WHERE m.ref_type = 'transfer'
       AND m.ref_id = $1
       AND COALESCE(m.reason, 'transfer') = 'transfer'
     ORDER BY m.created_at DESC, m.item_id ASC`,
    [id],
  )
  if (!rs.rows?.length) return null
  const detail: any = {
    id,
    status: 'completed',
    created_at: rs.rows[0]?.created_at || null,
    updated_at: null,
    cancelled_at: null,
    cancelled_by: null,
    note: rs.rows.find((row: any) => row.note)?.note || null,
    from_warehouse_id: '',
    from_warehouse_code: '',
    from_warehouse_name: '',
    to_warehouse_id: '',
    to_warehouse_code: '',
    to_warehouse_name: '',
    lines: [],
  }
  for (const row of rs.rows || []) {
    if (!detail.created_at || String(detail.created_at) < String(row.created_at || '')) detail.created_at = row.created_at
    if (row.type === 'out') {
      detail.from_warehouse_id = String(row.warehouse_id || '')
      detail.from_warehouse_code = String(row.warehouse_code || '')
      detail.from_warehouse_name = String(row.warehouse_name || '')
    }
    if (row.type === 'in') {
      detail.to_warehouse_id = String(row.warehouse_id || '')
      detail.to_warehouse_code = String(row.warehouse_code || '')
      detail.to_warehouse_name = String(row.warehouse_name || '')
    }
    let line = detail.lines.find((item: any) => String(item.item_id) === String(row.item_id || ''))
    if (!line) {
      line = {
        item_id: String(row.item_id || ''),
        item_name: String(row.item_name || ''),
        item_sku: String(row.item_sku || ''),
        item_category: String(row.item_category || ''),
        quantity: 0,
      }
      detail.lines.push(line)
    }
    if (row.type === 'out') line.quantity = Number(row.quantity || 0)
  }
  detail.item_count = Number(detail.lines.length)
  detail.quantity_total = Number(detail.lines.reduce((sum: number, line: any) => sum + Number(line.quantity || 0), 0))
  return detail
}

async function materializeLegacyTransferRecordInTx(client: any, id: string) {
  const existing = await client.query(`SELECT id FROM inventory_transfer_records WHERE id = $1 LIMIT 1`, [id])
  if (existing.rows?.[0]?.id) return
  const legacy = await loadLegacyTransferRecordDetail(client, id)
  if (!legacy) return
  await client.query(
    `INSERT INTO inventory_transfer_records (id, from_warehouse_id, to_warehouse_id, status, note, created_at)
     VALUES ($1,$2,$3,'completed',$4,$5)
     ON CONFLICT (id) DO NOTHING`,
    [id, legacy.from_warehouse_id, legacy.to_warehouse_id, legacy.note || null, legacy.created_at || new Date().toISOString()],
  )
  for (const line of legacy.lines || []) {
    await client.query(
      `INSERT INTO inventory_transfer_record_lines (id, record_id, item_id, quantity)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (record_id, item_id) DO NOTHING`,
      [uuidv4(), id, String(line.item_id || ''), Number(line.quantity || 0)],
    )
  }
}

async function loadTransferRecordDetail(client: any, id: string) {
  const metaRes = await client.query(
    `SELECT tr.*,
            fw.code AS from_warehouse_code,
            fw.name AS from_warehouse_name,
            tw.code AS to_warehouse_code,
            tw.name AS to_warehouse_name
     FROM inventory_transfer_records tr
     JOIN warehouses fw ON fw.id = tr.from_warehouse_id
     JOIN warehouses tw ON tw.id = tr.to_warehouse_id
     WHERE tr.id = $1
     LIMIT 1`,
    [id],
  )
  const meta = metaRes.rows?.[0] || null
  if (!meta) return loadLegacyTransferRecordDetail(client, id)

  const linesRes = await client.query(
    `SELECT l.item_id, l.quantity, i.name AS item_name, i.sku AS item_sku, i.category AS item_category
     FROM inventory_transfer_record_lines l
     JOIN inventory_items i ON i.id = l.item_id
     WHERE l.record_id = $1
     ORDER BY i.name ASC, l.item_id ASC`,
    [id],
  )
  const lines = (linesRes.rows || []).map((row: any) => ({
    item_id: String(row.item_id || ''),
    item_name: String(row.item_name || ''),
    item_sku: String(row.item_sku || ''),
    item_category: String(row.item_category || ''),
    quantity: Number(row.quantity || 0),
  }))
  return {
    id: String(meta.id || ''),
    created_at: meta.created_at || null,
    updated_at: meta.updated_at || null,
    status: String(meta.status || 'completed'),
    note: meta.note || null,
    cancelled_by: meta.cancelled_by || null,
    cancelled_at: meta.cancelled_at || null,
    from_warehouse_id: String(meta.from_warehouse_id || ''),
    from_warehouse_code: String(meta.from_warehouse_code || ''),
    from_warehouse_name: String(meta.from_warehouse_name || ''),
    to_warehouse_id: String(meta.to_warehouse_id || ''),
    to_warehouse_code: String(meta.to_warehouse_code || ''),
    to_warehouse_name: String(meta.to_warehouse_name || ''),
    item_count: Number(lines.length),
    quantity_total: Number(lines.reduce((sum: number, line: any) => sum + Number(line.quantity || 0), 0)),
    lines,
  }
}

async function applyTransferRecordStockInTx(client: any, input: {
  record_id: string
  from_warehouse_id: string
  to_warehouse_id: string
  note?: string | null
  actor_id?: string | null
  lines: Array<{ item_id: string; quantity: number }>
  direction: 'apply' | 'revert'
  reason: string
}) {
  for (const line of input.lines || []) {
    const fromType = input.direction === 'apply' ? 'out' : 'in'
    const toType = input.direction === 'apply' ? 'in' : 'out'
    const out = await applyStockDeltaInTx(client, {
      warehouse_id: input.from_warehouse_id,
      item_id: line.item_id,
      type: fromType,
      quantity: line.quantity,
      reason: input.reason,
      ref_type: 'transfer',
      ref_id: input.record_id,
      actor_id: input.actor_id || null,
      note: input.note || null,
      photo_url: null,
      return_stock_row: false,
    })
    if (!out.ok) return out
    const inn = await applyStockDeltaInTx(client, {
      warehouse_id: input.to_warehouse_id,
      item_id: line.item_id,
      type: toType,
      quantity: line.quantity,
      reason: input.reason,
      ref_type: 'transfer',
      ref_id: input.record_id,
      actor_id: input.actor_id || null,
      note: input.note || null,
      photo_url: null,
      return_stock_row: false,
    })
    if (!inn.ok) return inn
  }
  return { ok: true as const }
}

router.get('/transfers', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const fromWh = String(q.from_warehouse_id || '').trim()
      const toWh = String(q.to_warehouse_id || '').trim()
      const itemId = String(q.item_id || '').trim()
      const category = String(q.category || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 200)))

      let itemIdsByCategory: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        itemIdsByCategory = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIdsByCategory.length) return res.json([])
      }

      const where: string[] = [`m.ref_type = 'transfer'`]
      const values: any[] = []
      if (fromWh) { values.push(fromWh); where.push(`(m.type = 'out' AND m.warehouse_id = $${values.length})`) }
      if (toWh) { values.push(toWh); where.push(`(m.type = 'in' AND m.warehouse_id = $${values.length})`) }
      if (itemId) { values.push(itemId); where.push(`m.item_id = $${values.length}`) }
      if (itemIdsByCategory) { values.push(itemIdsByCategory); where.push(`m.item_id = ANY($${values.length}::text[])`) }
      if (from) { values.push(from); where.push(`m.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`m.created_at <= $${values.length}::timestamptz`) }
      values.push(limit)

      const moves = await pgPool.query(
        `SELECT
           m.id,
           m.warehouse_id,
           m.item_id,
           m.type,
           m.quantity,
           m.ref_id,
           m.note,
           m.photo_url,
           m.created_at
         FROM stock_movements m
         WHERE ${where.join(' AND ')}
         ORDER BY m.created_at DESC
         LIMIT $${values.length}`,
        values,
      )
      const rows = moves.rows || []
      if (!rows.length) return res.json([])

      const byRef = new Map<string, any>()
      for (const r of rows) {
        const ref = String(r.ref_id || '')
        if (!ref) continue
        const key = `${ref}:${String(r.item_id)}`
        const cur = byRef.get(key) || { transfer_id: ref, item_id: String(r.item_id) }
        if (r.type === 'out') cur.from_warehouse_id = String(r.warehouse_id)
        if (r.type === 'in') cur.to_warehouse_id = String(r.warehouse_id)
        cur.quantity = Number(r.quantity || 0)
        cur.created_at = cur.created_at ? (String(cur.created_at) > String(r.created_at) ? cur.created_at : r.created_at) : r.created_at
        if (r.note && !cur.note) cur.note = r.note
        if (r.photo_url && !cur.photo_url) cur.photo_url = r.photo_url
        byRef.set(key, cur)
      }
      const list = Array.from(byRef.values())

      const warehouseIds = Array.from(new Set(list.flatMap((x: any) => [x.from_warehouse_id, x.to_warehouse_id]).filter(Boolean)))
      const itemIds = Array.from(new Set(list.map((x: any) => x.item_id).filter(Boolean)))

      const [whRows, itRows] = await Promise.all([
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        itemIds.length ? pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] as any[] }),
      ])
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const itMap = new Map<string, any>((itRows as any).rows.map((r: any) => [String(r.id), r]))

      const out = list.map((x: any) => {
        const fw = whMap.get(String(x.from_warehouse_id)) || {}
        const tw = whMap.get(String(x.to_warehouse_id)) || {}
        const it = itMap.get(String(x.item_id)) || {}
        return {
          ...x,
          from_warehouse_code: fw.code,
          from_warehouse_name: fw.name,
          to_warehouse_code: tw.code,
          to_warehouse_name: tw.name,
          item_name: it.name,
          item_sku: it.sku,
          item_category: it.category,
          item_sub_type: it.sub_type,
        }
      }).sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const transferRoomTypeSchema = z.object({
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  room_type_code: z.string().min(1),
  sets: z.number().int().min(1),
  delivery_plan_id: z.string().optional(),
  note: z.string().optional(),
  photo_url: z.string().optional(),
})

router.post('/transfers/room-type', requirePerm('inventory.move'), async (req, res) => {
  const parsed = transferRoomTypeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json({ message: 'same warehouse' })
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'transfer not available without PG' })
    await ensureInventorySchema()
    const transferId = uuidv4()
    const result = await pgRunInTransaction(async (client) => {
      const reqs = await client.query(
        `SELECT linen_type_code, quantity
         FROM inventory_room_type_requirements
         WHERE room_type_code = $1`,
        [parsed.data.room_type_code],
      )
      const lines = (reqs.rows || [])
        .map((r: any) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }))
        .filter((r: any) => r.linen_type_code && r.quantity > 0)
      if (!lines.length) return { ok: false as const, code: 400 as const, message: '该房型未配置占用清单' }

      for (const ln of lines) {
        const item_id = `item.linen_type.${ln.linen_type_code}`
        const qty = parsed.data.sets * ln.quantity
        const out = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.from_warehouse_id,
          item_id,
          type: 'out',
          quantity: qty,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
          photo_url: parsed.data.photo_url || null,
        })
        if (!out.ok) return out
        const inn = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.to_warehouse_id,
          item_id,
          type: 'in',
          quantity: qty,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
          photo_url: parsed.data.photo_url || null,
        })
        if (!inn.ok) return inn
      }
      if (parsed.data.delivery_plan_id) {
        await client.query(
          `UPDATE linen_delivery_plan_lines
           SET actual_sets = $1, vehicle_load_sets = $1
           WHERE plan_id = $2
             AND to_warehouse_id = $3
             AND room_type_code = $4`,
          [parsed.data.sets, parsed.data.delivery_plan_id, parsed.data.to_warehouse_id, parsed.data.room_type_code],
        )
        await client.query(
          `UPDATE linen_delivery_plans
           SET status = 'dispatched', updated_at = now()
           WHERE id = $1`,
          [parsed.data.delivery_plan_id],
        )
      }
      return { ok: true as const, transfer_id: transferId }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/transfers', requirePerm('inventory.move'), async (req, res) => {
  const parsed = transferSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json({ message: 'same warehouse' })
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const transferId = uuidv4()
      const result = await pgRunInTransaction(async (client) => {
        const out = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.from_warehouse_id,
          item_id: parsed.data.item_id,
          type: 'out',
          quantity: parsed.data.quantity,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
          photo_url: parsed.data.photo_url || null,
        })
        if (!out.ok) return out
        const inn = await applyStockDeltaInTx(client, {
          warehouse_id: parsed.data.to_warehouse_id,
          item_id: parsed.data.item_id,
          type: 'in',
          quantity: parsed.data.quantity,
          reason: 'transfer',
          ref_type: 'transfer',
          ref_id: transferId,
          actor_id: actorId(req),
          note: parsed.data.note || null,
          photo_url: parsed.data.photo_url || null,
        })
        if (!inn.ok) return inn
        return { ok: true as const, transfer_id: transferId, from_stock: out.stock, to_stock: inn.stock }
      })
      if (!result) return res.status(500).json({ message: 'db not ready' })
      if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
      return res.json(result)
    }
    return res.status(501).json({ message: 'transfer not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/transfer-records', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const q: any = req.query || {}
    const fromWh = String(q.from_warehouse_id || '').trim()
    const toWh = String(q.to_warehouse_id || '').trim()
    const category = String(q.category || '').trim()
    const from = String(q.from || '').trim()
    const to = String(q.to || '').trim()
    const status = String(q.status || '').trim()
    const limit = Math.min(500, Math.max(1, Number(q.limit || 200)))

    const values: any[] = []
    const where: string[] = ['1=1']
    if (fromWh) { values.push(fromWh); where.push(`tr.from_warehouse_id = $${values.length}`) }
    if (toWh) { values.push(toWh); where.push(`tr.to_warehouse_id = $${values.length}`) }
    if (from) { values.push(from); where.push(`tr.created_at >= $${values.length}::timestamptz`) }
    if (to) { values.push(to); where.push(`tr.created_at <= $${values.length}::timestamptz`) }
    if (status) { values.push(status); where.push(`tr.status = $${values.length}`) }
    if (category) {
      values.push(category)
      where.push(`EXISTS (
        SELECT 1
        FROM inventory_transfer_record_lines l
        JOIN inventory_items i ON i.id = l.item_id
        WHERE l.record_id = tr.id AND i.category = $${values.length}
      )`)
    }
    values.push(limit)
    const metaRows = await pgPool.query(
      `SELECT tr.id,
              tr.created_at,
              tr.updated_at,
              tr.status,
              tr.note,
              tr.cancelled_by,
              tr.cancelled_at,
              tr.from_warehouse_id,
              tr.to_warehouse_id,
              fw.code AS from_warehouse_code,
              fw.name AS from_warehouse_name,
              tw.code AS to_warehouse_code,
              tw.name AS to_warehouse_name
       FROM inventory_transfer_records tr
       JOIN warehouses fw ON fw.id = tr.from_warehouse_id
       JOIN warehouses tw ON tw.id = tr.to_warehouse_id
       WHERE ${where.join(' AND ')}
       ORDER BY tr.created_at DESC
       LIMIT $${values.length}`,
      values,
    )

    const legacyRows = status && status !== 'completed'
      ? { rows: [] as any[] }
      : await (async () => {
        const legacyValues: any[] = []
        const legacyWhere: string[] = [`m.ref_type = 'transfer'`, `COALESCE(m.reason, 'transfer') = 'transfer'`, `tr.id IS NULL`]
        if (fromWh) { legacyValues.push(fromWh); legacyWhere.push(`(m.type = 'out' AND m.warehouse_id = $${legacyValues.length})`) }
        if (toWh) { legacyValues.push(toWh); legacyWhere.push(`(m.type = 'in' AND m.warehouse_id = $${legacyValues.length})`) }
        if (from) { legacyValues.push(from); legacyWhere.push(`m.created_at >= $${legacyValues.length}::timestamptz`) }
        if (to) { legacyValues.push(to); legacyWhere.push(`m.created_at <= $${legacyValues.length}::timestamptz`) }
        if (category) { legacyValues.push(category); legacyWhere.push(`i.category = $${legacyValues.length}`) }
        legacyValues.push(limit)
        return pgPool.query(
          `SELECT
             m.ref_id,
             m.warehouse_id,
             m.item_id,
             m.type,
             m.quantity,
             m.note,
             m.created_at,
             i.name AS item_name,
             i.sku AS item_sku,
             fw.code AS warehouse_code,
             fw.name AS warehouse_name
           FROM stock_movements m
           JOIN inventory_items i ON i.id = m.item_id
           JOIN warehouses fw ON fw.id = m.warehouse_id
           LEFT JOIN inventory_transfer_records tr ON tr.id = m.ref_id
           WHERE ${legacyWhere.join(' AND ')}
           ORDER BY m.created_at DESC
           LIMIT $${legacyValues.length}`,
          legacyValues,
        )
      })()

    const byId = new Map<string, any>()
    for (const row of metaRows.rows || []) {
      byId.set(String(row.id || ''), { ...row, lines: [] as any[] })
    }
    if (byId.size) {
      const ids = Array.from(byId.keys())
      const linesRes = await pgPool.query(
        `SELECT l.record_id, l.item_id, l.quantity, i.name AS item_name, i.sku AS item_sku, i.category AS item_category
         FROM inventory_transfer_record_lines l
         JOIN inventory_items i ON i.id = l.item_id
         WHERE l.record_id = ANY($1::text[])
         ORDER BY i.name ASC, l.item_id ASC`,
        [ids],
      )
      for (const line of linesRes.rows || []) {
        const current = byId.get(String(line.record_id || ''))
        if (!current) continue
        current.lines.push({
          item_id: String(line.item_id || ''),
          item_name: String(line.item_name || ''),
          item_sku: String(line.item_sku || ''),
          quantity: Number(line.quantity || 0),
        })
      }
    }

    for (const row of legacyRows.rows || []) {
      const refId = String(row.ref_id || '')
      if (!refId || byId.has(refId)) continue
      const current = byId.get(refId) || {
        id: refId,
        created_at: row.created_at,
        updated_at: null,
        status: 'completed',
        note: row.note || null,
        cancelled_by: null,
        cancelled_at: null,
        from_warehouse_id: '',
        from_warehouse_code: '',
        from_warehouse_name: '',
        to_warehouse_id: '',
        to_warehouse_code: '',
        to_warehouse_name: '',
        lines: [],
      }
      if (row.type === 'out') {
        current.from_warehouse_id = String(row.warehouse_id || '')
        current.from_warehouse_code = String(row.warehouse_code || '')
        current.from_warehouse_name = String(row.warehouse_name || '')
      }
      if (row.type === 'in') {
        current.to_warehouse_id = String(row.warehouse_id || '')
        current.to_warehouse_code = String(row.warehouse_code || '')
        current.to_warehouse_name = String(row.warehouse_name || '')
      }
      let line = current.lines.find((item: any) => String(item.item_id) === String(row.item_id || ''))
      if (!line) {
        line = { item_id: String(row.item_id || ''), item_name: String(row.item_name || ''), item_sku: String(row.item_sku || ''), quantity: 0 }
        current.lines.push(line)
      }
      if (row.type === 'out') line.quantity = Number(row.quantity || 0)
      byId.set(refId, current)
    }

    const out = Array.from(byId.values())
      .map((row: any) => ({
        ...row,
        item_count: Number((row.lines || []).length),
        quantity_total: Number((row.lines || []).reduce((sum: number, line: any) => sum + Number(line.quantity || 0), 0)),
      }))
      .sort((a: any, b: any) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, limit)
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/transfer-records/:id', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'transfer records not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ message: 'id required' })
    const detail = await loadTransferRecordDetail(pgPool, id)
    if (!detail) return res.status(404).json({ message: 'not found' })
    return res.json(detail)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/transfer-records', requirePerm('inventory.move'), async (req, res) => {
  const parsed = transferRecordCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json({ message: 'same warehouse' })
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'transfer not available without PG' })
    await ensureInventorySchema()
    const transferId = uuidv4()
    const uniqueLines = normalizeTransferRecordLines(parsed.data.lines)
    if (!uniqueLines.length) return res.status(400).json({ message: '请至少填写一条调配明细' })

    const result = await pgRunInTransaction(async (client) => {
      await client.query(
        `INSERT INTO inventory_transfer_records (id, from_warehouse_id, to_warehouse_id, status, note, created_by)
         VALUES ($1,$2,$3,'completed',$4,$5)`,
        [transferId, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null, actorId(req)],
      )
      for (const line of uniqueLines) {
        await client.query(
          `INSERT INTO inventory_transfer_record_lines (id, record_id, item_id, quantity)
           VALUES ($1,$2,$3,$4)`,
          [uuidv4(), transferId, line.item_id, line.quantity],
        )
      }
      const applied = await applyTransferRecordStockInTx(client, {
        record_id: transferId,
        from_warehouse_id: parsed.data.from_warehouse_id,
        to_warehouse_id: parsed.data.to_warehouse_id,
        note: parsed.data.note || null,
        actor_id: actorId(req),
        lines: uniqueLines,
        direction: 'apply',
        reason: 'transfer',
      })
      if (!applied.ok) return applied
      const detail = await loadTransferRecordDetail(client, transferId)
      return { ok: true as const, transfer_id: transferId, detail }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    return res.json((result as any).detail || result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/transfer-records/:id', requirePerm('inventory.move'), async (req, res) => {
  const parsed = transferRecordUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json({ message: 'same warehouse' })
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'transfer not available without PG' })
    await ensureInventorySchema()
    const transferId = String(req.params.id || '').trim()
    const uniqueLines = normalizeTransferRecordLines(parsed.data.lines)
    if (!uniqueLines.length) return res.status(400).json({ message: '请至少填写一条调配明细' })
    const result = await pgRunInTransaction(async (client) => {
      await materializeLegacyTransferRecordInTx(client, transferId)
      const current = await loadTransferRecordDetail(client, transferId)
      if (!current) return { ok: false as const, code: 404 as const, message: 'not found' }
      if (String(current.status || '') !== 'completed') return { ok: false as const, code: 400 as const, message: '仅已完成配送单可编辑' }
      const reverted = await applyTransferRecordStockInTx(client, {
        record_id: transferId,
        from_warehouse_id: current.from_warehouse_id,
        to_warehouse_id: current.to_warehouse_id,
        note: current.note || null,
        actor_id: actorId(req),
        lines: normalizeTransferRecordLines(current.lines || []),
        direction: 'revert',
        reason: 'transfer_edit_revert',
      })
      if (!reverted.ok) return reverted
      await client.query(
        `UPDATE inventory_transfer_records
         SET from_warehouse_id = $2,
             to_warehouse_id = $3,
             note = $4,
             updated_at = now()
         WHERE id = $1`,
        [transferId, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null],
      )
      await client.query(`DELETE FROM inventory_transfer_record_lines WHERE record_id = $1`, [transferId])
      for (const line of uniqueLines) {
        await client.query(
          `INSERT INTO inventory_transfer_record_lines (id, record_id, item_id, quantity)
           VALUES ($1,$2,$3,$4)`,
          [uuidv4(), transferId, line.item_id, line.quantity],
        )
      }
      const applied = await applyTransferRecordStockInTx(client, {
        record_id: transferId,
        from_warehouse_id: parsed.data.from_warehouse_id,
        to_warehouse_id: parsed.data.to_warehouse_id,
        note: parsed.data.note || null,
        actor_id: actorId(req),
        lines: uniqueLines,
        direction: 'apply',
        reason: 'transfer',
      })
      if (!applied.ok) return applied
      const detail = await loadTransferRecordDetail(client, transferId)
      return { ok: true as const, detail }
    })
    if (!(result as any)?.ok) return res.status(Number((result as any)?.code || 400)).json({ message: String((result as any)?.message || 'failed') })
    return res.json((result as any).detail)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/transfer-records/:id/cancel', requirePerm('inventory.move'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'transfer not available without PG' })
    await ensureInventorySchema()
    const transferId = String(req.params.id || '').trim()
    const result = await pgRunInTransaction(async (client) => {
      await materializeLegacyTransferRecordInTx(client, transferId)
      const current = await loadTransferRecordDetail(client, transferId)
      if (!current) return { ok: false as const, code: 404 as const, message: 'not found' }
      if (String(current.status || '') === 'cancelled') return { ok: false as const, code: 400 as const, message: '该配送单已作废' }
      const reverted = await applyTransferRecordStockInTx(client, {
        record_id: transferId,
        from_warehouse_id: current.from_warehouse_id,
        to_warehouse_id: current.to_warehouse_id,
        note: current.note || null,
        actor_id: actorId(req),
        lines: normalizeTransferRecordLines(current.lines || []),
        direction: 'revert',
        reason: 'transfer_cancel',
      })
      if (!reverted.ok) return reverted
      await client.query(
        `UPDATE inventory_transfer_records
         SET status = 'cancelled',
             updated_at = now(),
             cancelled_by = $2,
             cancelled_at = now()
         WHERE id = $1`,
        [transferId, actorId(req)],
      )
      const detail = await loadTransferRecordDetail(client, transferId)
      return { ok: true as const, detail }
    })
    if (!(result as any)?.ok) return res.status(Number((result as any)?.code || 400)).json({ message: String((result as any)?.message || 'failed') })
    return res.json((result as any).detail)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/upload', requirePerm('inventory.move'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'missing file' })
  try {
    if (!hasR2 || !(req.file as any).buffer) return res.status(500).json({ message: 'R2 not configured' })
    const img = await resizeUploadImage({ buffer: (req.file as any).buffer, contentType: req.file.mimetype, originalName: req.file.originalname })
    const ext = img.ext || path.extname(req.file.originalname) || ''
    const key = `inventory/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
    const url = await r2Upload(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer)
    return res.status(201).json({ url })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'upload failed' })
  }
})

router.get('/category-dashboard', requirePerm('inventory.view'), async (req, res) => {
  const category = String((req.query as any)?.category || '').trim()
  if (!category) return res.status(400).json({ message: 'category required' })
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const ws = await pgPool.query(`SELECT id, code, name, active FROM warehouses ORDER BY code ASC`)
      const warehouses = (ws.rows || []).filter((w: any) => w.active)

      const linenTypes = category === 'linen'
        ? await pgPool.query(
          `SELECT code, name, in_set, set_divisor, sort_order
           FROM inventory_linen_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`,
        )
        : { rows: [] as any[] }

      const roomTypes = category === 'linen'
        ? await pgPool.query(
          `SELECT code, name, bedrooms, bathrooms, sort_order
           FROM inventory_room_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`,
        )
        : { rows: [] as any[] }

      const roomTypeReqs = category === 'linen'
        ? await pgPool.query(
          `SELECT room_type_code, linen_type_code, quantity
           FROM inventory_room_type_requirements`,
        )
        : { rows: [] as any[] }

      const its = category === 'linen'
        ? await pgPool.query(
          `SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item, lt.sort_order
           FROM inventory_items i
           LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
           WHERE i.category = $1
           ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`,
          [category],
        )
        : await pgPool.query(
          `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
           FROM inventory_items
           WHERE category = $1`,
          [category],
        )
      const items = its.rows || []
      const itemIds = items.map((r: any) => String(r.id))
      const itemMap = new Map<string, any>(items.map((r: any) => [String(r.id), r]))

      const stocksRaw = itemIds.length
        ? await pgPool.query(
          `SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE item_id = ANY($1::text[])`,
          [itemIds],
        )
        : { rows: [] as any[] }

      const stocks = (stocksRaw.rows || []).map((s: any) => {
        const it = itemMap.get(String(s.item_id)) || {}
        const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0)
        const qty = Number(s.quantity || 0)
        const status =
          qty <= 0 ? 'out_of_stock' :
            qty < eff ? 'warning' :
              'normal'
        return {
          id: s.id,
          warehouse_id: s.warehouse_id,
          item_id: s.item_id,
          item_name: it.name,
          item_sku: it.sku,
          category: it.category,
          sub_type: it.sub_type,
          linen_type_code: it.linen_type_code,
          unit: it.unit,
          bin_location: it.bin_location,
          active: it.active,
          is_key_item: it.is_key_item,
          quantity: qty,
          threshold_effective: eff,
          status,
        }
      })

      const totalQty = stocks.reduce((sum: number, r: any) => sum + Number(r.quantity || 0), 0)
      const lowSkuCount = stocks.filter((r: any) => Number(r.quantity || 0) < Number(r.threshold_effective || 0)).length

      const byWarehouse = new Map<string, any>()
      for (const w of warehouses) {
        byWarehouse.set(String(w.id), {
          warehouse_id: String(w.id),
          warehouse_code: String(w.code),
          warehouse_name: String(w.name),
          counts_by_sub_type: {},
          available_sets: 0,
          low_stock: false,
        })
      }
      for (const r of stocks) {
        const wh = byWarehouse.get(String(r.warehouse_id))
        if (!wh) continue
        const st = category === 'linen'
          ? String(r.linen_type_code || r.sub_type || 'other')
          : String(r.sub_type || 'other')
        wh.counts_by_sub_type[st] = Number(wh.counts_by_sub_type[st] || 0) + Number(r.quantity || 0)
        if (Number(r.quantity || 0) < Number(r.threshold_effective || 0)) wh.low_stock = true
      }

      const roomTypeMap = new Map<string, any>(((roomTypes as any).rows || []).map((r: any) => [String(r.code), r]))
      const reqMap = new Map<string, Map<string, number>>()
      for (const r of (roomTypeReqs as any).rows || []) {
        const rt = String(r.room_type_code || '')
        const lt = String(r.linen_type_code || '')
        const qty = Number(r.quantity || 0)
        if (!rt || !lt || qty <= 0) continue
        if (!reqMap.has(rt)) reqMap.set(rt, new Map())
        reqMap.get(rt)!.set(lt, qty)
      }

      const roomTypesArr = (roomTypes as any).rows || []
      const defaultRoomType = category === 'linen' && roomTypesArr.length ? roomTypesArr[0] : null
      const defaultRoomTypeCode = defaultRoomType ? String(defaultRoomType.code) : null
      const defaultRoomTypeName = defaultRoomType ? String(defaultRoomType.name) : null

      let availableSetsTotal = 0
      for (const wh of byWarehouse.values()) {
        const c = wh.counts_by_sub_type || {}

        if (category === 'linen') {
          wh.available_sets_by_room_type = {}
          for (const [rtCode] of roomTypeMap.entries()) {
            const reqs = reqMap.get(rtCode)
            if (!reqs || reqs.size === 0) { wh.available_sets_by_room_type[rtCode] = 0; continue }
            const candidates: number[] = []
            for (const [lt, qty] of reqs.entries()) {
              const stockQty = Number(c[lt] || 0)
              candidates.push(Math.floor(stockQty / Math.max(1, qty)))
            }
            const sets = candidates.length ? Math.min(...candidates) : 0
            wh.available_sets_by_room_type[rtCode] = isFinite(sets) ? Math.max(0, sets) : 0
          }
          wh.available_sets = defaultRoomTypeCode ? Number(wh.available_sets_by_room_type[defaultRoomTypeCode] || 0) : 0
        } else {
          wh.available_sets = 0
        }

        availableSetsTotal += Number(wh.available_sets || 0)
      }

      const damagePending = itemIds.length
        ? await pgPool.query(
          `SELECT COUNT(*)::int AS c
           FROM stock_change_requests
           WHERE status = 'pending'
             AND reason = 'damage'
             AND item_id = ANY($1::text[])`,
          [itemIds],
        )
        : { rows: [{ c: 0 }] }
      const damagePendingCount = Number((damagePending as any).rows?.[0]?.c || 0)

      const todayMoves = itemIds.length
        ? await pgPool.query(
          `SELECT type, COALESCE(SUM(quantity),0)::int AS qty
           FROM stock_movements
           WHERE item_id = ANY($1::text[])
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AT TIME ZONE 'Australia/Melbourne')
           GROUP BY type`,
          [itemIds],
        )
        : { rows: [] as any[] }
      const todayMap = new Map<string, number>((todayMoves as any).rows.map((r: any) => [String(r.type), Number(r.qty || 0)]))
      const todayIn = Number(todayMap.get('in') || 0)
      const todayOut = Number(todayMap.get('out') || 0)

      const cards = {
        total_qty: totalQty,
        available_sets_total: availableSetsTotal,
        available_sets_total_room_type_code: defaultRoomTypeCode,
        available_sets_total_room_type_name: defaultRoomTypeName,
        low_sku_count: lowSkuCount,
        damage_pending_count: damagePendingCount,
        today_in_qty: todayIn,
        today_out_qty: todayOut,
      }

      let unboundPropertyCount = 0
      if (category === 'linen') {
        try {
          const c = await pgPool.query(`SELECT COUNT(*)::int AS c FROM properties WHERE room_type_code IS NULL`)
          unboundPropertyCount = Number(c.rows?.[0]?.c || 0)
        } catch {}
      }

      return res.json({
        category,
        linen_types: (linenTypes as any).rows || [],
        room_types: (roomTypes as any).rows || [],
        unbound_property_count: unboundPropertyCount,
        cards,
        warehouses: Array.from(byWarehouse.values()).sort((a: any, b: any) => String(a.warehouse_code).localeCompare(String(b.warehouse_code))),
        stocks,
      })
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/unbound-properties', requirePerm('inventory.view'), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number((req.query as any)?.limit || 200)))
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(
        `SELECT id, code, address, type, region
         FROM properties
         WHERE room_type_code IS NULL
         ORDER BY code NULLS LAST, address ASC
         LIMIT $1`,
        [limit],
      )
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const changeRequestCreateSchema = z.object({
  warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  quantity: z.number().int().min(1),
  reason: z.enum(['damage', 'return_to_supplier']),
  note: z.string().optional(),
  photo_url: z.string().optional(),
})

const stocktakeCreateSchema = z.object({
  warehouse_id: z.string().min(1),
  category: z.string().min(1),
  stocktake_type: z.enum(['initial', 'routine']),
  stocktake_date: z.string().min(1),
  note: z.string().optional(),
  lines: z.array(z.object({
    item_id: z.string().min(1),
    counted_quantity: z.number().int().min(0),
  })).min(1),
})

router.post('/stock-change-requests', requirePerm('inventory.move'), async (req, res) => {
  const parsed = changeRequestCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = uuidv4()
    const created_by = actorId(req)
    const r = await pgPool.query(
      `INSERT INTO stock_change_requests (id, warehouse_id, item_id, type, quantity, reason, note, photo_url, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        parsed.data.warehouse_id,
        parsed.data.item_id,
        'out',
        parsed.data.quantity,
        parsed.data.reason,
        parsed.data.note || null,
        parsed.data.photo_url || null,
        'pending',
        created_by,
      ],
    )
    addAudit('StockChangeRequest', id, 'create', null, r.rows?.[0] || null, actorId(req))
    return res.status(201).json(r.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/stock-change-requests', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const reason = String(q.reason || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const item_id = String(q.item_id || '').trim()
      const category = String(q.category || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 200)))

      let itemIdsByCategory: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        itemIdsByCategory = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIdsByCategory.length) return res.json([])
      }

      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`r.status = $${values.length}`) }
      if (reason) { values.push(reason); where.push(`r.reason = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`r.warehouse_id = $${values.length}`) }
      if (item_id) { values.push(item_id); where.push(`r.item_id = $${values.length}`) }
      if (itemIdsByCategory) { values.push(itemIdsByCategory); where.push(`r.item_id = ANY($${values.length}::text[])`) }
      if (from) { values.push(from); where.push(`r.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`r.created_at <= $${values.length}::timestamptz`) }
      values.push(limit)

      const sql = `
        SELECT r.*
        FROM stock_change_requests r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC
        LIMIT $${values.length}
      `
      const rr = await pgPool.query(sql, values)
      const rows = rr.rows || []
      if (!rows.length) return res.json([])

      const warehouseIds = Array.from(new Set(rows.map((x: any) => String(x.warehouse_id || '')).filter(Boolean)))
      const itemIds = Array.from(new Set(rows.map((x: any) => String(x.item_id || '')).filter(Boolean)))

      const [whRows, itRows] = await Promise.all([
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        itemIds.length ? pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] as any[] }),
      ])
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const itMap = new Map<string, any>((itRows as any).rows.map((r: any) => [String(r.id), r]))

      const out = rows.map((r: any) => {
        const w = whMap.get(String(r.warehouse_id)) || {}
        const it = itMap.get(String(r.item_id)) || {}
        return {
          ...r,
          warehouse_code: w.code,
          warehouse_name: w.name,
          item_name: it.name,
          item_sku: it.sku,
          item_category: it.category,
          item_sub_type: it.sub_type,
        }
      })
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const changeRequestPatchSchema = z.object({
  status: z.enum(['approved', 'rejected']),
})

router.patch('/stock-change-requests/:id', requirePerm('inventory.move'), async (req, res) => {
  const id = String(req.params.id || '')
  const parsed = changeRequestPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const handled_by = actorId(req)
    const handled_at = new Date().toISOString()
    if (parsed.data.status === 'rejected') {
      const before = await pgPool.query(`SELECT * FROM stock_change_requests WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'not found' })
      if (String(b.status) !== 'pending') return res.status(409).json({ message: 'already handled' })
      const after = await pgPool.query(
        `UPDATE stock_change_requests
         SET status = 'rejected', handled_by = $1, handled_at = $2
         WHERE id = $3
         RETURNING *`,
        [handled_by, handled_at, id],
      )
      addAudit('StockChangeRequest', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }

    const result = await pgRunInTransaction(async (client) => {
      const r0 = await client.query(`SELECT * FROM stock_change_requests WHERE id = $1 FOR UPDATE`, [id])
      const row = r0.rows?.[0]
      if (!row) return { ok: false as const, code: 404 as const, message: 'not found' }
      if (String(row.status) !== 'pending') return { ok: false as const, code: 409 as const, message: 'already handled' }

      const move = await applyStockDeltaInTx(client, {
        warehouse_id: String(row.warehouse_id),
        item_id: String(row.item_id),
        type: 'out',
        quantity: Number(row.quantity || 0),
        reason: String(row.reason || ''),
        actor_id: handled_by,
        note: row.note || null,
        photo_url: row.photo_url || null,
        ref_type: 'stock_change_request',
        ref_id: String(row.id),
      })
      if (!move.ok) return move as any

      const after = await client.query(
        `UPDATE stock_change_requests
         SET status = 'approved', handled_by = $1, handled_at = $2, movement_id = $3
         WHERE id = $4
         RETURNING *`,
        [handled_by, handled_at, move.movement_id, id],
      )
      return { ok: true as const, row: after.rows?.[0] || null }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    addAudit('StockChangeRequest', id, 'approve', null, (result as any).row || null, actorId(req))
    return res.json((result as any).row || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/stocktakes', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const q: any = req.query || {}
    const warehouseId = String(q.warehouse_id || '').trim()
    const category = String(q.category || '').trim()
    const limit = Math.min(200, Math.max(1, Number(q.limit || 50)))
    const values: any[] = []
    const where: string[] = []
    if (warehouseId) { values.push(warehouseId); where.push(`r.warehouse_id = $${values.length}`) }
    if (category) { values.push(category); where.push(`r.category = $${values.length}`) }
    values.push(limit)

    let rs
    try {
      rs = await pgPool.query(
        `SELECT
           r.*,
           w.code AS warehouse_code,
           w.name AS warehouse_name,
           COUNT(rl.id)::int AS line_count,
           COALESCE(SUM(rl.counted_quantity),0)::int AS counted_total
         FROM inventory_stocktake_records r
         JOIN warehouses w ON w.id = r.warehouse_id
         LEFT JOIN inventory_stocktake_record_lines rl ON rl.record_id = r.id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         GROUP BY r.id, w.code, w.name
         ORDER BY r.stocktake_date DESC, r.created_at DESC
         LIMIT $${values.length}`,
        values,
      )
    } catch (error: any) {
      if (category === 'consumable') {
        console.error('[inventory] consumable stocktakes fallback to empty list:', error?.message || error)
        return res.json([])
      }
      throw error
    }
    return res.json(rs.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/stocktakes/:id', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '').trim()
    const head = await pgPool.query(
      `SELECT r.*, w.code AS warehouse_code, w.name AS warehouse_name
       FROM inventory_stocktake_records r
       JOIN warehouses w ON w.id = r.warehouse_id
       WHERE r.id = $1
       LIMIT 1`,
      [id],
    )
    const record = head.rows?.[0]
    if (!record) return res.status(404).json({ message: 'not found' })
    const lines = await pgPool.query(
      `SELECT
         rl.*,
         i.name AS item_name,
         i.sku AS item_sku,
         i.unit AS item_unit
       FROM inventory_stocktake_record_lines rl
       JOIN inventory_items i ON i.id = rl.item_id
       WHERE rl.record_id = $1
       ORDER BY i.name ASC`,
      [id],
    )
    return res.json({ ...record, lines: lines.rows || [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/stocktakes', requirePerm('inventory.move'), async (req, res) => {
  const parsed = stocktakeCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const recordId = uuidv4()
    const normalizedLines = Array.from(
      parsed.data.lines.reduce((map, line) => {
        const itemId = String(line.item_id || '').trim()
        const countedQuantity = Number(line.counted_quantity ?? 0)
        if (!itemId) return map
        map.set(itemId, countedQuantity)
        return map
      }, new Map<string, number>()),
    ).map(([item_id, counted_quantity]) => ({ item_id, counted_quantity }))
    if (!normalizedLines.length) return res.status(400).json({ message: '请至少填写一条盘点明细' })

    const actor = actorId(req)
    const result = await pgRunInTransaction(async (client) => {
      const itemIds = normalizedLines.map((line) => line.item_id)
      const itemRows = await client.query(
        `SELECT id, category FROM inventory_items WHERE id = ANY($1::text[])`,
        [itemIds],
      )
      const itemMap = new Map<string, any>((itemRows.rows || []).map((row: any) => [String(row.id), row]))
      for (const line of normalizedLines) {
        const item = itemMap.get(String(line.item_id))
        if (!item) return { ok: false as const, code: 400 as const, message: '存在无效物品，无法盘点' }
        if (String(item.category || '') !== parsed.data.category) return { ok: false as const, code: 400 as const, message: '盘点物品分类不一致' }
      }

      await client.query(
        `INSERT INTO inventory_stocktake_records (id, warehouse_id, category, stocktake_type, stocktake_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7)`,
        [recordId, parsed.data.warehouse_id, parsed.data.category, parsed.data.stocktake_type, parsed.data.stocktake_date, parsed.data.note || null, actor],
      )

      for (const line of normalizedLines) {
        await ensureWarehouseStockRow(client, parsed.data.warehouse_id, line.item_id)
        const current = await client.query(
          `SELECT id, quantity
           FROM warehouse_stocks
           WHERE warehouse_id = $1 AND item_id = $2
           FOR UPDATE`,
          [parsed.data.warehouse_id, line.item_id],
        )
        const stock = current.rows?.[0]
        const previousQuantity = Number(stock?.quantity || 0)
        const countedQuantity = Number(line.counted_quantity || 0)
        const delta = countedQuantity - previousQuantity

        if (delta !== 0) {
          const move = await applyStockDeltaInTx(client, {
            warehouse_id: parsed.data.warehouse_id,
            item_id: line.item_id,
            type: delta > 0 ? 'in' : 'out',
            quantity: Math.abs(delta),
            reason: 'stocktake',
            actor_id: actor,
            note: parsed.data.note || null,
            ref_type: 'stocktake',
            ref_id: recordId,
            photo_url: null,
          })
          if (!move.ok) return move
        }

        await client.query(
          `INSERT INTO inventory_stocktake_record_lines (id, record_id, item_id, previous_quantity, counted_quantity, delta_quantity)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [uuidv4(), recordId, line.item_id, previousQuantity, countedQuantity, delta],
        )
      }

      const saved = await client.query(
        `SELECT r.*, w.code AS warehouse_code, w.name AS warehouse_name
         FROM inventory_stocktake_records r
         JOIN warehouses w ON w.id = r.warehouse_id
         WHERE r.id = $1
         LIMIT 1`,
        [recordId],
      )
      return { ok: true as const, record: saved.rows?.[0] || null }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    addAudit('InventoryStocktake', recordId, 'create', null, (result as any).record || null, actor)
    return res.status(201).json((result as any).record || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/movements', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const wh = String(q.warehouse_id || '').trim()
      const item = String(q.item_id || '').trim()
      const prop = String(q.property_id || '').trim()
      const type = String(q.type || '').trim()
      const category = String(q.category || '').trim()
      const reason = String(q.reason || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 100)))

      const where: string[] = []
      const values: any[] = []
      if (wh) { values.push(wh); where.push(`m.warehouse_id = $${values.length}`) }
      if (item) { values.push(item); where.push(`m.item_id = $${values.length}`) }
      if (prop) { values.push(prop); where.push(`m.property_id = $${values.length}`) }
      if (type) { values.push(type); where.push(`m.type = $${values.length}`) }
      if (category) { values.push(category); where.push(`i.category = $${values.length}`) }
      if (reason) { values.push(reason); where.push(`m.reason = $${values.length}`) }
      if (from) { values.push(from); where.push(`m.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`m.created_at <= $${values.length}::timestamptz`) }
      values.push(limit)

      const sql = `
        SELECT
          m.*,
          i.name AS item_name,
          i.sku AS item_sku,
          w.code AS warehouse_code,
          w.name AS warehouse_name,
          p.code AS property_code,
          p.address AS property_address
        FROM stock_movements m
        JOIN inventory_items i ON i.id = m.item_id
        JOIN warehouses w ON w.id = m.warehouse_id
        LEFT JOIN properties p ON p.id = m.property_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.created_at DESC
        LIMIT $${values.length}
      `
      const rows = await pgPool.query(sql, values)
      return res.json(rows.rows || [])
    }
    return res.json(db.stockMovements || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen-usage-records', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const q: any = req.query || {}
    const wh = String(q.warehouse_id || '').trim()
    const prop = String(q.property_id || '').trim()
    const roomType = String(q.room_type_code || '').trim()
    const linenType = String(q.linen_type_code || '').trim()
    const sourceType = String(q.source_type || '').trim()
    const from = String(q.from || '').trim()
    const to = String(q.to || '').trim()
    const limit = Math.min(500, Math.max(1, Number(q.limit || 200)))

    const where: string[] = []
    const values: any[] = []
    if (wh) { values.push(wh); where.push(`r.warehouse_id = $${values.length}`) }
    if (prop) { values.push(prop); where.push(`r.property_id = $${values.length}`) }
    if (roomType) { values.push(roomType); where.push(`r.room_type_code = $${values.length}`) }
    if (linenType) { values.push(linenType); where.push(`r.linen_type_code = $${values.length}`) }
    if (sourceType) { values.push(sourceType); where.push(`r.source_type = $${values.length}`) }
    if (from) { values.push(from); where.push(`r.usage_date >= $${values.length}::date`) }
    if (to) { values.push(to); where.push(`r.usage_date <= $${values.length}::date`) }
    values.push(limit)

    const rows = await pgPool.query(
      `SELECT
         r.id,
         r.usage_key,
         r.usage_date,
         r.source_type,
         r.source_ref,
         r.cleaning_task_id,
         r.property_id,
         COALESCE(p.code, r.property_code) AS property_code,
         p.address AS property_address,
         r.room_type_code,
         COALESCE(rt.name, r.room_type_code) AS room_type_name,
         r.warehouse_id,
         w.code AS warehouse_code,
         w.name AS warehouse_name,
         r.linen_type_code,
         lt.name AS linen_type_name,
         r.quantity,
         r.actor_id,
         r.note,
         r.created_at,
         r.updated_at
       FROM inventory_linen_usage_records r
       LEFT JOIN properties p ON p.id = r.property_id
       LEFT JOIN inventory_room_types rt ON rt.code = r.room_type_code
       LEFT JOIN warehouses w ON w.id = r.warehouse_id
       LEFT JOIN inventory_linen_types lt ON lt.code = r.linen_type_code
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.usage_date DESC, r.created_at DESC, r.id DESC
       LIMIT $${values.length}`,
      values,
    )
    const out = (rows.rows || []).map((row: any) => ({
      ...row,
      source_label: buildLinenUsageSourceLabel(String(row.source_type || '')),
    }))
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

async function ensureDailyNecessitiesSchema() {
  if (!pgPool) return
  await pgPool.query(`CREATE TABLE IF NOT EXISTS property_daily_necessities (
    id text PRIMARY KEY,
    property_id text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`)
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS before_photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS after_photo_urls jsonb;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_id text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS replacement_at timestamptz;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS replacer_name text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS pay_method text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS invoice_description_en text;')
  await pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_pay_method ON property_daily_necessities(pay_method);')
  await pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);')
}

async function getActorDisplayName(client: any, userId: string) {
  const id = String(userId || '').trim()
  if (!id) return ''
  try {
    const row = await client.query(`SELECT display_name, username, email FROM users WHERE id = $1 LIMIT 1`, [id])
    const user = row.rows?.[0] || null
    return String(user?.display_name || user?.username || user?.email || id)
  } catch {
    return id
  }
}

const dailyReplacementCreateSchema = z.object({
  property_id: z.string().min(1),
  occurred_at: z.string().min(1),
  item_id: z.string().optional().nullable(),
  item_name: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
  note: z.string().optional(),
  invoice_description_en: z.string().optional(),
  before_photo_urls: z.array(z.string()).optional(),
  after_photo_urls: z.array(z.string()).optional(),
  replacement_at: z.string().optional().nullable(),
  replacer_name: z.string().optional(),
  pay_method: z.enum(['rent_deduction', 'tenant_pay', 'company_pay', 'landlord_pay', 'other_pay']).optional().nullable(),
  status: z.enum(['need_replace', 'replaced', 'no_action']).optional(),
})

const dailyReplacementPatchSchema = z.object({
  occurred_at: z.string().optional(),
  item_id: z.string().optional().nullable(),
  item_name: z.string().min(1).optional(),
  quantity: z.number().int().min(1).optional(),
  note: z.string().optional(),
  invoice_description_en: z.string().optional(),
  before_photo_urls: z.array(z.string()).optional(),
  after_photo_urls: z.array(z.string()).optional(),
  replacement_at: z.string().optional().nullable(),
  replacer_name: z.string().optional(),
  pay_method: z.enum(['rent_deduction', 'tenant_pay', 'company_pay', 'landlord_pay', 'other_pay']).optional().nullable(),
  status: z.enum(['need_replace', 'replaced', 'no_action']).optional(),
})

router.get('/daily-replacements', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      await ensureDailyNecessitiesSchema()
      const q: any = req.query || {}
      const statusRaw = String(q.status || '').trim()
      const statuses = statusRaw
        ? statusRaw
            .split(',')
            .map((s) => String(s || '').trim())
            .filter(Boolean)
        : []
      const prop = String(q.property_id || '').trim()
      const code = String(q.property_code || '').trim()
      const payMethod = String(q.pay_method || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()
      const limit = Math.min(500, Math.max(1, Number(q.limit || 100)))

      const where: string[] = []
      const values: any[] = []
      if (prop) { values.push(prop); where.push(`n.property_id = $${values.length}`) }
      if (code) { values.push(code); where.push(`COALESCE(n.property_code, p.code) = $${values.length}`) }
      if (statuses.length) { values.push(statuses); where.push(`COALESCE(n.status,'') = ANY($${values.length}::text[])`) }
      if (payMethod) { values.push(payMethod); where.push(`COALESCE(n.pay_method,'') = $${values.length}`) }
      if (from) { values.push(from); where.push(`COALESCE(n.submitted_at, n.created_at) >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`COALESCE(n.submitted_at, n.created_at) <= $${values.length}::timestamptz`) }
      values.push(limit)

      const sql = `
        SELECT
          n.id,
          n.property_id,
          COALESCE(n.property_code, p.code) AS property_code,
          p.address AS property_address,
          n.status,
          n.item_id,
          n.item_name,
          n.quantity,
          n.note,
          n.invoice_description_en,
          n.photo_urls,
          n.before_photo_urls,
          n.after_photo_urls,
          n.submitter_name,
          n.submitted_at,
          n.replacement_at,
          n.replacer_name,
          n.pay_method,
          n.created_at,
          n.updated_at
        FROM property_daily_necessities n
        LEFT JOIN properties p ON p.id = n.property_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(n.submitted_at, n.created_at) DESC
        LIMIT $${values.length}
      `
      const r = await pgPool.query(sql, values)
      return res.json(r.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/daily-replacements', requirePerm('inventory.move'), async (req, res) => {
  const parsed = dailyReplacementCreateSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    await ensureDailyNecessitiesSchema()
    const id = uuidv4()
    const actor = actorId(req)
    const result = await pgRunInTransaction(async (client) => {
      const prop = await client.query(`SELECT id, code FROM properties WHERE id = $1 LIMIT 1`, [parsed.data.property_id])
      const property = prop.rows?.[0]
      if (!property) return { ok: false as const, code: 400 as const, message: '房号不存在' }
      const submitterName = await getActorDisplayName(client, actor)
      const nextStatus = String(parsed.data.status || 'need_replace').trim()
      const nextPayMethod = parsed.data.pay_method ? String(parsed.data.pay_method).trim() : null
      const created = await client.query(
        `INSERT INTO property_daily_necessities (
           id, property_id, property_code, status, item_id, item_name, quantity, note,
           invoice_description_en, photo_urls, before_photo_urls, after_photo_urls, submitted_at, replacement_at,
           submitter_name, replacer_name, pay_method, created_by, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::timestamptz,$14::timestamptz,$15,$16,$17,$18,now())
         RETURNING *`,
        [
          id,
          parsed.data.property_id,
          String(property.code || ''),
          nextStatus,
          parsed.data.item_id || null,
          parsed.data.item_name,
          parsed.data.quantity,
          parsed.data.note || null,
          parsed.data.invoice_description_en || null,
          JSON.stringify(parsed.data.before_photo_urls || []),
          JSON.stringify(parsed.data.before_photo_urls || []),
          JSON.stringify(parsed.data.after_photo_urls || []),
          parsed.data.occurred_at,
          parsed.data.replacement_at || null,
          submitterName || null,
          parsed.data.replacer_name || null,
          nextPayMethod,
          actor || null,
        ],
      )
      return { ok: true as const, row: created.rows?.[0] || null }
    })
    if (!result) return res.status(500).json({ message: 'db not ready' })
    if (!(result as any).ok) return res.status((result as any).code).json({ message: (result as any).message })
    addAudit('DailyReplacement', id, 'create', null, (result as any).row || null, actor)
    return res.status(201).json((result as any).row || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/daily-replacements/:id', requirePerm('inventory.move'), async (req, res) => {
  const id = String(req.params.id || '').trim()
  const parsed = dailyReplacementPatchSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    await ensureDailyNecessitiesSchema()
    const before = await pgPool.query(`SELECT * FROM property_daily_necessities WHERE id = $1 LIMIT 1`, [id])
    const prev = before.rows?.[0]
    if (!prev) return res.status(404).json({ message: 'not found' })

    const patch: Record<string, any> = {}
    if (parsed.data.occurred_at !== undefined) patch.submitted_at = parsed.data.occurred_at
    if (parsed.data.item_id !== undefined) patch.item_id = parsed.data.item_id || null
    if (parsed.data.item_name !== undefined) patch.item_name = parsed.data.item_name
    if (parsed.data.quantity !== undefined) patch.quantity = parsed.data.quantity
    if (parsed.data.note !== undefined) patch.note = parsed.data.note || null
    if (parsed.data.invoice_description_en !== undefined) patch.invoice_description_en = parsed.data.invoice_description_en || null
    if (parsed.data.before_photo_urls !== undefined) {
      patch.before_photo_urls = JSON.stringify(parsed.data.before_photo_urls || [])
      patch.photo_urls = JSON.stringify(parsed.data.before_photo_urls || [])
    }
    if (parsed.data.after_photo_urls !== undefined) patch.after_photo_urls = JSON.stringify(parsed.data.after_photo_urls || [])
    if (parsed.data.replacement_at !== undefined) patch.replacement_at = parsed.data.replacement_at || null
    if (parsed.data.replacer_name !== undefined) patch.replacer_name = parsed.data.replacer_name || null
    if (parsed.data.pay_method !== undefined) patch.pay_method = parsed.data.pay_method ? String(parsed.data.pay_method).trim() : null
    if (parsed.data.status !== undefined) patch.status = parsed.data.status
    patch.updated_at = new Date().toISOString()

    const keys = Object.keys(patch)
    if (!keys.length) return res.json(prev)
    const setSql = keys.map((key, idx) => `${key} = $${idx + 1}${key === 'before_photo_urls' || key === 'after_photo_urls' || key === 'photo_urls' ? '::jsonb' : key === 'submitted_at' || key === 'replacement_at' || key === 'updated_at' ? '::timestamptz' : ''}`).join(', ')
    const values = keys.map((key) => patch[key])
    const updated = await pgPool.query(
      `UPDATE property_daily_necessities
       SET ${setSql}
       WHERE id = $${keys.length + 1}
       RETURNING *`,
      [...values, id],
    )
    addAudit('DailyReplacement', id, 'update', prev, updated.rows?.[0] || null, actorId(req))
    return res.json(updated.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/suppliers', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(`SELECT id, name, kind, supply_items_note, login_url, login_username, login_password, login_note, active FROM suppliers ORDER BY name ASC`)
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const supplierSchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  supply_items_note: z.string().optional().nullable(),
  login_url: z.string().optional().nullable(),
  login_username: z.string().optional().nullable(),
  login_password: z.string().optional().nullable(),
  login_note: z.string().optional().nullable(),
  active: z.boolean().optional(),
})

router.post('/suppliers', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const id = uuidv4()
      const row = await pgPool.query(
        `INSERT INTO suppliers (id, name, kind, supply_items_note, login_url, login_username, login_password, login_note, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, parsed.data.name, parsed.data.kind || 'linen', parsed.data.supply_items_note || null, parsed.data.login_url || null, parsed.data.login_username || null, parsed.data.login_password || null, parsed.data.login_note || null, parsed.data.active ?? true],
      )
      addAudit('Supplier', id, 'create', null, row.rows?.[0] || null, actorId(req))
      return res.status(201).json(row.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/suppliers/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const before = await pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'supplier not found' })
      const payload = parsed.data as any
      const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
      if (!keys.length) return res.json(b)
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map(k => (payload as any)[k])
      const sql = `UPDATE suppliers SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`
      const after = await pgPool.query(sql, [...values, id])
      addAudit('Supplier', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/suppliers/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id])
    const row = before.rows?.[0]
    if (!row) return res.status(404).json({ message: 'supplier not found' })

    const refs = await Promise.all([
      pgPool.query(`SELECT 1 FROM purchase_orders WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM region_supplier_rules WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM supplier_item_prices WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM linen_supplier_return_batches WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM linen_supplier_refunds WHERE supplier_id = $1 LIMIT 1`, [id]),
    ])
    if (refs.some((r) => (r.rows || []).length > 0)) {
      return res.status(409).json({ message: '该供应商已有采购、价格、规则或返厂退款记录，无法删除' })
    }

    await pgPool.query(`DELETE FROM suppliers WHERE id = $1`, [id])
    addAudit('Supplier', id, 'delete', row, null, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/suppliers/:id/delete', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id])
    const row = before.rows?.[0]
    if (!row) return res.status(404).json({ message: 'supplier not found' })

    const refs = await Promise.all([
      pgPool.query(`SELECT 1 FROM purchase_orders WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM region_supplier_rules WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM supplier_item_prices WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM linen_supplier_return_batches WHERE supplier_id = $1 LIMIT 1`, [id]),
      pgPool.query(`SELECT 1 FROM linen_supplier_refunds WHERE supplier_id = $1 LIMIT 1`, [id]),
    ])
    if (refs.some((r) => (r.rows || []).length > 0)) {
      return res.status(409).json({ message: '该供应商已有采购、价格、规则或返厂退款记录，无法删除' })
    }

    await pgPool.query(`DELETE FROM suppliers WHERE id = $1`, [id])
    addAudit('Supplier', id, 'delete', row, null, actorId(req))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/region-supplier-rules', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const rows = await pgPool.query(
        `SELECT r.*, s.name AS supplier_name
         FROM region_supplier_rules r
         JOIN suppliers s ON s.id = r.supplier_id
         ORDER BY r.region_key ASC, r.priority DESC`,
      )
      return res.json(rows.rows || [])
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const regionRuleSchema = z.object({
  region_key: z.string().min(1),
  supplier_id: z.string().min(1),
  priority: z.number().int().optional(),
  active: z.boolean().optional(),
})

router.post('/region-supplier-rules', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = regionRuleSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const id = uuidv4()
      const row = await pgPool.query(
        `INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority, active)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [id, parsed.data.region_key, parsed.data.supplier_id, parsed.data.priority ?? 0, parsed.data.active ?? true],
      )
      addAudit('RegionSupplierRule', id, 'create', null, row.rows?.[0] || null, actorId(req))
      return res.status(201).json(row.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/region-supplier-rules/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = regionRuleSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const before = await pgPool.query(`SELECT * FROM region_supplier_rules WHERE id = $1`, [id])
      const b = before.rows?.[0]
      if (!b) return res.status(404).json({ message: 'rule not found' })
      const payload = parsed.data as any
      const keys = Object.keys(payload).filter(k => payload[k] !== undefined)
      if (!keys.length) return res.json(b)
      const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
      const values = keys.map(k => (payload as any)[k])
      const sql = `UPDATE region_supplier_rules SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`
      const after = await pgPool.query(sql, [...values, id])
      addAudit('RegionSupplierRule', id, 'update', b, after.rows?.[0] || null, actorId(req))
      return res.json(after.rows?.[0] || null)
    }
    return res.status(501).json({ message: 'not available without PG' })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const poCreateSchema = z.object({
  supplier_id: z.string().optional(),
  warehouse_id: z.string().min(1),
  property_id: z.string().optional(),
  region: z.string().optional(),
  ordered_date: z.string().optional(),
  requested_delivery_date: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.union([
    z.object({
      item_id: z.string().min(1),
      quantity: z.number().int().min(1),
      unit: z.string().optional(),
      unit_price: z.number().optional(),
      note: z.string().optional(),
    }),
    z.object({
      room_type_code: z.string().min(1),
      sets: z.number().int().min(1),
    }),
  ])).min(1),
})

router.get('/purchase-orders', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const supplier_id = String(q.supplier_id || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const category = String(q.category || '').trim()
      let poIds: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        const itemIds = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIds.length) return res.json([])
        const prs = await pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIds])
        poIds = (prs.rows || []).map((r: any) => String(r.po_id))
        if (!poIds.length) return res.json([])
      }

      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`po.status = $${values.length}`) }
      if (supplier_id) { values.push(supplier_id); where.push(`po.supplier_id = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`po.warehouse_id = $${values.length}`) }
      if (poIds) { values.push(poIds); where.push(`po.id = ANY($${values.length}::text[])`) }

      const sql = `
        SELECT po.*
        FROM purchase_orders po
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(po.ordered_date, (po.created_at AT TIME ZONE 'Australia/Melbourne')::date) DESC, po.created_at DESC
        LIMIT 200
      `
      const poRows = await pgPool.query(sql, values)
      const rows = poRows.rows || []
      for (const row of rows) {
        if (!String((row as any)?.po_no || '').trim()) {
          ;(row as any).po_no = await ensurePurchaseOrderNo(pgPool, row)
        }
      }
      if (!rows.length) return res.json([])

      const supplierIds = Array.from(new Set(rows.map((r: any) => String(r.supplier_id || '')).filter(Boolean)))
      const warehouseIds = Array.from(new Set(rows.map((r: any) => String(r.warehouse_id || '')).filter(Boolean)))

      const [supRows, whRows, aggRows] = await Promise.all([
        supplierIds.length ? pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] as any[] }),
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        pgPool.query(
          `SELECT po_id,
                  COUNT(*)::int AS line_count,
                  COALESCE(SUM(quantity),0)::int AS quantity_total,
                  COALESCE(SUM(COALESCE(unit_price,0) * quantity),0) AS amount_total
           FROM purchase_order_lines
           WHERE po_id = ANY($1::text[])
           GROUP BY po_id`,
          [rows.map((r: any) => String(r.id))],
        ),
      ])

      const supMap = new Map<string, any>((supRows as any).rows.map((r: any) => [String(r.id), r]))
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const aggMap = new Map<string, any>((aggRows as any).rows.map((r: any) => [String(r.po_id), r]))

      const out = rows.map((r: any) => {
        const s = supMap.get(String(r.supplier_id)) || {}
        const w = whMap.get(String(r.warehouse_id)) || {}
        const a = aggMap.get(String(r.id)) || {}
        return {
          ...r,
          supplier_name: s.name,
          warehouse_name: w.name,
          warehouse_code: w.code,
          line_count: Number(a.line_count || 0),
          quantity_total: Number(a.quantity_total || 0),
          amount_total: a.amount_total !== undefined && a.amount_total !== null ? String(a.amount_total) : '0',
          subtotal_amount: r.subtotal_amount !== undefined && r.subtotal_amount !== null ? String(r.subtotal_amount) : '0',
          gst_amount: r.gst_amount !== undefined && r.gst_amount !== null ? String(r.gst_amount) : '0',
          total_amount_inc_gst: r.total_amount_inc_gst !== undefined && r.total_amount_inc_gst !== null ? String(r.total_amount_inc_gst) : '0',
        }
      })
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/purchase-order-lines', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (hasPg && pgPool) {
      await ensureInventorySchema()
      const q: any = req.query || {}
      const status = String(q.status || '').trim()
      const supplier_id = String(q.supplier_id || '').trim()
      const warehouse_id = String(q.warehouse_id || '').trim()
      const category = String(q.category || '').trim()
      const from = String(q.from || '').trim()
      const to = String(q.to || '').trim()

      let itemIdsByCategory: string[] | null = null
      let poIdsByCategory: string[] | null = null
      if (category) {
        const its = await pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category])
        itemIdsByCategory = (its.rows || []).map((r: any) => String(r.id))
        if (!itemIdsByCategory.length) return res.json([])
        const prs = await pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIdsByCategory])
        poIdsByCategory = (prs.rows || []).map((r: any) => String(r.po_id))
        if (!poIdsByCategory.length) return res.json([])
      }

      const where: string[] = []
      const values: any[] = []
      if (status) { values.push(status); where.push(`po.status = $${values.length}`) }
      if (supplier_id) { values.push(supplier_id); where.push(`po.supplier_id = $${values.length}`) }
      if (warehouse_id) { values.push(warehouse_id); where.push(`po.warehouse_id = $${values.length}`) }
      if (from) { values.push(from); where.push(`po.created_at >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); where.push(`po.created_at <= $${values.length}::timestamptz`) }
      if (poIdsByCategory) { values.push(poIdsByCategory); where.push(`po.id = ANY($${values.length}::text[])`) }

      const pos = await pgPool.query(
        `SELECT po.*
         FROM purchase_orders po
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY po.created_at DESC
         LIMIT 200`,
        values,
      )
      const poRows = pos.rows || []
      if (!poRows.length) return res.json([])
      const poIds = poRows.map((r: any) => String(r.id))

      const lineWhere: string[] = [`po_id = ANY($1::text[])`]
      const lineVals: any[] = [poIds]
      if (itemIdsByCategory) { lineVals.push(itemIdsByCategory); lineWhere.push(`item_id = ANY($${lineVals.length}::text[])`) }
      const lines = await pgPool.query(
        `SELECT l.*, i.name AS item_name, i.sku AS item_sku, lt.sort_order
         FROM purchase_order_lines l
         JOIN inventory_items i ON i.id = l.item_id
         LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
         WHERE ${lineWhere.join(' AND ')}
         ORDER BY l.po_id ASC, COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`,
        lineVals,
      )
      const lineRows = lines.rows || []
      if (!lineRows.length) return res.json([])

      const supplierIds = Array.from(new Set(poRows.map((r: any) => String(r.supplier_id || '')).filter(Boolean)))
      const warehouseIds = Array.from(new Set(poRows.map((r: any) => String(r.warehouse_id || '')).filter(Boolean)))
      const itemIds = Array.from(new Set(lineRows.map((r: any) => String(r.item_id || '')).filter(Boolean)))

      const [supRows, whRows, itRows] = await Promise.all([
        supplierIds.length ? pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] as any[] }),
        warehouseIds.length ? pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] as any[] }),
        itemIds.length ? pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] as any[] }),
      ])
      const poMap = new Map<string, any>(poRows.map((r: any) => [String(r.id), r]))
      const supMap = new Map<string, any>((supRows as any).rows.map((r: any) => [String(r.id), r]))
      const whMap = new Map<string, any>((whRows as any).rows.map((r: any) => [String(r.id), r]))
      const itMap = new Map<string, any>((itRows as any).rows.map((r: any) => [String(r.id), r]))

      const out = lineRows.map((l: any) => {
        const po = poMap.get(String(l.po_id)) || {}
        const s = supMap.get(String(po.supplier_id)) || {}
        const w = whMap.get(String(po.warehouse_id)) || {}
        const it = itMap.get(String(l.item_id)) || {}
        const qty = Number(l.quantity || 0)
        const unitPrice = l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price)
        const amount = unitPrice === null ? null : unitPrice * qty
        return {
          ...l,
          po_id: String(l.po_id),
          po_status: po.status,
          po_ordered_date: po.ordered_date,
          po_created_at: po.created_at,
          po_requested_delivery_date: po.requested_delivery_date,
          po_region: po.region,
          po_property_id: po.property_id,
          supplier_id: po.supplier_id,
          supplier_name: s.name,
          warehouse_id: po.warehouse_id,
          warehouse_code: w.code,
          warehouse_name: w.name,
          item_name: it.name,
          item_sku: it.sku,
          item_category: it.category,
          item_sub_type: it.sub_type,
          amount,
        }
      }).sort((a: any, b: any) => String(b.po_created_at || '').localeCompare(String(a.po_created_at || '')))
      return res.json(out)
    }
    return res.json([])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/purchase-orders', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = poCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()

    const supplierIdExplicit = String(parsed.data.supplier_id || '').trim()
    const pool = pgPool
    if (!pool) throw new Error('db not ready')
    let regionExplicit = String(parsed.data.region || '').trim()
    const propertyIdExplicit = String(parsed.data.property_id || '').trim()
    let propertyRow: any = null
    if (propertyIdExplicit) {
      const propRes = await pool.query(`SELECT id, region FROM properties WHERE id = $1`, [propertyIdExplicit])
      propertyRow = propRes.rows?.[0] || null
      if (!regionExplicit && propertyRow?.region) regionExplicit = String(propertyRow.region || '').trim()
    }
    let regionFinal = regionExplicit
    const supplier_id = supplierIdExplicit || (regionFinal ? await pickSupplierIdForRegion(regionFinal) : null)
    if (!supplier_id) return res.status(400).json({ message: '无法确定供应商，请手动选择 supplier_id' })

    const poId = uuidv4()
    const created_by = actorId(req)
    const smWarehouse = await getSmWarehouse()
    const warehouseDefault = smWarehouse?.id ? String(smWarehouse.id) : 'wh.south_melbourne'
    const warehouseFinal = String(parsed.data.warehouse_id || '').trim() || warehouseDefault
    const orderedDate = String(parsed.data.ordered_date || '').trim()

    const result = await pgRunInTransaction(async (client) => {
      const poRow = await client.query(
        `INSERT INTO purchase_orders (id, supplier_id, warehouse_id, status, ordered_date, requested_delivery_date, region, property_id, note, created_by)
         VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,'')::date, (now() AT TIME ZONE 'Australia/Melbourne')::date),$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          poId,
          supplier_id,
          warehouseFinal,
          'draft',
          orderedDate,
          parsed.data.requested_delivery_date ? parsed.data.requested_delivery_date : null,
          regionFinal || null,
          propertyIdExplicit || null,
          parsed.data.note || null,
          created_by,
        ],
      )
      await ensurePurchaseOrderNo(client, poRow.rows?.[0] || { id: poId, ordered_date: orderedDate })
      const poRowWithNo = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId])

      const priceMap = await getLatestSupplierItemPrice(client, supplier_id)
      const qtyByItem = new Map<string, number>()
      const metaByItem = new Map<string, { unit_price: number | null; note: string | null; unit: string | null }>()

      for (const ln of parsed.data.lines as any[]) {
        if (ln.item_id) {
          const item_id = String(ln.item_id)
          const qty = Number(ln.quantity || 0)
          qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty)
          const priceRow = priceMap.get(item_id)
          metaByItem.set(item_id, {
            unit_price: ln.unit_price ?? (priceRow ? Number(priceRow.purchase_unit_price || 0) : null),
            note: ln.note || null,
            unit: ln.unit || null,
          })
          continue
        }
        if (ln.room_type_code) {
          const roomTypeCode = String(ln.room_type_code)
          const sets = Number(ln.sets || 0)
          const reqs = await client.query(
            `SELECT linen_type_code, quantity
             FROM inventory_room_type_requirements
             WHERE room_type_code = $1`,
            [roomTypeCode],
          )
          for (const r of reqs.rows || []) {
            const linenTypeCode = String(r.linen_type_code)
            const perSet = Number(r.quantity || 0)
            if (perSet <= 0) continue
            const item_id = `item.linen_type.${linenTypeCode}`
            const qty = sets * perSet
            qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty)
            if (!metaByItem.has(item_id)) metaByItem.set(item_id, { unit_price: null, note: null, unit: null })
          }
        }
      }

      const linesOut: any[] = []
      for (const [item_id, quantity] of qtyByItem.entries()) {
        const item = await client.query(`SELECT id, unit FROM inventory_items WHERE id = $1`, [item_id])
        const meta = metaByItem.get(item_id) || { unit_price: null, note: null, unit: null }
        const unit = meta.unit || item.rows?.[0]?.unit
        if (!unit) throw new Error('unit missing')
        const lineId = uuidv4()
        const row = await client.query(
          `INSERT INTO purchase_order_lines (id, po_id, item_id, quantity, unit, unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`,
          [
            lineId,
            poId,
            item_id,
            quantity,
            unit,
            meta.unit_price,
            meta.unit_price === null || meta.unit_price === undefined ? null : Number(meta.unit_price) * Number(quantity || 0),
            meta.note,
          ],
        )
        linesOut.push(row.rows?.[0] || null)
      }

      await refreshPurchaseOrderTotals(client, poId)
      const poFinal = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId])
      return { po: poFinal.rows?.[0] || poRowWithNo.rows?.[0] || poRow.rows?.[0] || null, lines: linesOut }
    })

    addAudit('PurchaseOrder', poId, 'create', null, result, actorId(req))
    return res.status(201).json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/purchase-orders/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const po = await pgPool.query(
      `SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, w.code AS warehouse_code
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`,
      [id],
    )
    if (!po.rows?.[0]) return res.status(404).json({ message: 'po not found' })
    if (!String(po.rows?.[0]?.po_no || '').trim()) {
      po.rows[0].po_no = await ensurePurchaseOrderNo(pgPool, po.rows[0])
    }
    const lines = await pgPool.query(
      `SELECT l.*, i.name AS item_name, i.sku AS item_sku, lt.sort_order
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
       WHERE l.po_id = $1
       ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`,
      [id],
    )
    const deliveries = await pgPool.query(
      `SELECT d.* FROM purchase_deliveries d WHERE d.po_id = $1 ORDER BY d.received_at DESC`,
      [id],
    )
    return res.json({ po: po.rows[0], lines: lines.rows || [], deliveries: deliveries.rows || [] })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const poPatchSchema = z.object({
  status: z.enum(['draft','ordered','received','closed']).optional(),
  supplier_id: z.string().min(1).optional(),
  warehouse_id: z.string().min(1).optional(),
  ordered_date: z.string().optional(),
  requested_delivery_date: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.object({
    id: z.string().min(1),
    quantity: z.number(),
    note: z.string().optional(),
    unit_price: z.number().nullable().optional(),
  })).optional(),
})

async function refreshPurchaseOrderTotals(client: any, poId: string) {
  const totals = await client.query(
    `SELECT
       COALESCE(SUM(COALESCE(amount_total,0)),0)::numeric AS subtotal_amount
     FROM purchase_order_lines
     WHERE po_id = $1`,
    [poId],
  )
  const subtotal = Number(totals.rows?.[0]?.subtotal_amount || 0)
  const gst = Number((subtotal * 0.1).toFixed(2))
  const totalInclGst = Number((subtotal + gst).toFixed(2))
  await client.query(
    `UPDATE purchase_orders
     SET subtotal_amount = $1::numeric,
         gst_amount = $2::numeric,
         total_amount_inc_gst = $3::numeric,
         updated_at = now()
     WHERE id = $4`,
    [subtotal, gst, totalInclGst, poId],
  )
}

async function syncDraftPurchaseOrderPricesForSupplierItem(
  client: any,
  {
    supplierId,
    itemId,
    unitPrice,
    active,
  }: {
    supplierId: string
    itemId: string
    unitPrice: number
    active: boolean
  },
) {
  if (!supplierId || !itemId || !active) return
  const affected = await client.query(
    `SELECT DISTINCT l.po_id
     FROM purchase_order_lines l
     JOIN purchase_orders po ON po.id = l.po_id
     WHERE po.supplier_id = $1
       AND po.status = 'draft'
       AND l.item_id = $2`,
    [supplierId, itemId],
  )
  const poIds = (affected.rows || []).map((row: any) => String(row.po_id || '')).filter(Boolean)
  if (!poIds.length) return

  await client.query(
    `UPDATE purchase_order_lines l
     SET unit_price = $1::numeric,
         amount_total = ROUND((COALESCE(l.quantity, 0)::numeric * $1::numeric), 2)
     FROM purchase_orders po
     WHERE po.id = l.po_id
       AND po.supplier_id = $2
       AND po.status = 'draft'
       AND l.item_id = $3`,
    [unitPrice, supplierId, itemId],
  )

  for (const poId of poIds) {
    await refreshPurchaseOrderTotals(client, poId)
  }
}

router.patch('/purchase-orders/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = poPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const before = await pgPool.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id])
    const b = before.rows?.[0]
    if (!b) return res.status(404).json({ message: 'po not found' })
    if (String(b.status || '') === 'received' || String(b.status || '') === 'closed') {
      return res.status(400).json({ message: '已到货或已关闭的采购单不可编辑' })
    }
    const payload = parsed.data as any
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const { lines: linePayload, ...poPayload } = payload
      const keys = Object.keys(poPayload).filter((k) => poPayload[k] !== undefined)
      let afterRow = b
      if (keys.length) {
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')
        const values = keys.map((k) => poPayload[k])
        const sql = `UPDATE purchase_orders SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`
        const after = await client.query(sql, [...values, id])
        afterRow = after.rows?.[0] || afterRow
      }
      if (Array.isArray(linePayload) && linePayload.length) {
        for (const line of linePayload) {
          const existing = await client.query(
            `SELECT id, po_id, quantity, unit_price, note
             FROM purchase_order_lines
             WHERE id = $1 AND po_id = $2`,
            [line.id, id],
          )
          const current = existing.rows?.[0]
          if (!current) continue
          const quantity = Number(line.quantity || 0)
          const unitPrice = line.unit_price === undefined ? Number(current.unit_price || 0) : (line.unit_price === null ? null : Number(line.unit_price))
          await client.query(
            `UPDATE purchase_order_lines
             SET quantity = $1::integer,
                 note = $2,
                 unit_price = $3::numeric,
                 amount_total = CASE
                   WHEN $3 IS NULL THEN NULL
                   ELSE ROUND(($1::numeric * $3::numeric), 2)
                 END
             WHERE id = $4 AND po_id = $5`,
            [quantity, line.note || null, unitPrice, line.id, id],
          )
        }
      }
      await refreshPurchaseOrderTotals(client, id)
      const afterPo = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id])
      const afterLines = await client.query(
        `SELECT * FROM purchase_order_lines WHERE po_id = $1 ORDER BY id ASC`,
        [id],
      )
      await client.query('COMMIT')
      const result = { po: afterPo.rows?.[0] || afterRow, lines: afterLines.rows || [] }
      addAudit('PurchaseOrder', id, 'update', b, result.po || null, actorId(req))
      return res.json(result)
    } catch (txErr: any) {
      try { await client.query('ROLLBACK') } catch {}
      throw txErr
    } finally {
      client.release()
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/purchase-orders/:id/export', requirePerm('inventory.po.manage'), async (req, res) => {
  const id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const po = await pgPool.query(
      `SELECT po.id, po.status, po.created_at, s.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`,
      [id],
    )
    if (!po.rows?.[0]) return res.status(404).json({ message: 'po not found' })
    const lines = await pgPool.query(
      `SELECT i.name AS item_name, i.sku AS item_sku, l.quantity, l.unit, l.unit_price, l.note, lt.sort_order
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
       WHERE l.po_id = $1
       ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`,
      [id],
    )
    const header = ['物料','SKU','数量','单位','单价','备注']
    const esc = (v: any) => {
      const s = String(v ?? '')
      if (/[\",\n]/.test(s)) return `"${s.replace(/\"/g, '""')}"`
      return s
    }
    const rows = [header.join(',')]
    for (const r of (lines.rows || [])) {
      rows.push([r.item_name, r.item_sku, r.quantity, r.unit, r.unit_price ?? '', r.note ?? ''].map(esc).join(','))
    }
    const csv = rows.join('\n')
    const filename = `PO_${esc(po.rows[0].supplier_name)}_${id}.csv`.replace(/[^\w\-.()]+/g, '_')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send('\ufeff' + csv)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const deliverySchema = z.object({
  received_at: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(z.object({ item_id: z.string().min(1), quantity_received: z.number().int().min(1), note: z.string().optional() })).min(1),
})

router.post('/purchase-orders/:id/deliveries', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = deliverySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  const po_id = String(req.params.id || '')
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const result = await pgRunInTransaction(async (client) => {
      const po = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [po_id])
      const p = po.rows?.[0]
      if (!p) return { ok: false as const, code: 404 as const, message: 'po not found' }

      const deliveryId = uuidv4()
      const receivedAt = String(parsed.data.received_at || '').trim()
      const d = await client.query(
        `INSERT INTO purchase_deliveries (id, po_id, received_at, received_by, note)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [deliveryId, po_id, receivedAt || new Date().toISOString(), actorId(req), parsed.data.note || null],
      )

      const lineRows: any[] = []
      for (const ln of parsed.data.lines) {
        const dlId = uuidv4()
        const row = await client.query(
          `INSERT INTO purchase_delivery_lines (id, delivery_id, item_id, quantity_received, note)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`,
          [dlId, deliveryId, ln.item_id, ln.quantity_received, ln.note || null],
        )
        lineRows.push(row.rows?.[0] || null)

        const applied = await applyStockDeltaInTx(client, {
          warehouse_id: p.warehouse_id,
          item_id: ln.item_id,
          type: 'in',
          quantity: ln.quantity_received,
          reason: 'purchase_delivery',
          ref_type: 'po',
          ref_id: po_id,
          actor_id: actorId(req),
          note: parsed.data.note || null,
        })
        if (!applied.ok) return applied
      }

      const poAfter = await client.query(`UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`, ['received', po_id])
      return { ok: true as const, delivery: d.rows?.[0] || null, lines: lineRows, po: poAfter.rows?.[0] || null }
    })

    if (!(result as any)?.ok) return res.status((result as any).code).json({ message: (result as any).message })
    addAudit('PurchaseDelivery', (result as any)?.delivery?.id || po_id, 'create', null, result, actorId(req))
    return res.status(201).json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/deliveries', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const q: any = req.query || {}
    const supplierId = String(q.supplier_id || '').trim()
    const warehouseId = String(q.warehouse_id || '').trim()
    const category = String(q.category || '').trim()
    const from = String(q.from || '').trim()
    const to = String(q.to || '').trim()

    const where: string[] = []
    const values: any[] = []
    if (supplierId) { values.push(supplierId); where.push(`po.supplier_id = $${values.length}`) }
    if (warehouseId) { values.push(warehouseId); where.push(`po.warehouse_id = $${values.length}`) }
    if (from) { values.push(from); where.push(`d.received_at >= $${values.length}::timestamptz`) }
    if (to) { values.push(to); where.push(`d.received_at <= $${values.length}::timestamptz`) }
    if (category) {
      values.push(category)
      where.push(`EXISTS (
        SELECT 1
        FROM purchase_delivery_lines dl
        JOIN inventory_items i ON i.id = dl.item_id
        WHERE dl.delivery_id = d.id
          AND i.category = $${values.length}
      )`)
    }
    const rows = await pgPool.query(
      `SELECT d.id, d.po_id, d.received_at, d.received_by, d.note,
              po.supplier_id, po.warehouse_id,
              s.name AS supplier_name,
              w.code AS warehouse_code, w.name AS warehouse_name,
              COUNT(dl.id)::int AS line_count,
              COALESCE(SUM(dl.quantity_received),0)::int AS quantity_total
       FROM purchase_deliveries d
       JOIN purchase_orders po ON po.id = d.po_id
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       LEFT JOIN purchase_delivery_lines dl ON dl.delivery_id = d.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY d.id, d.po_id, d.received_at, d.received_by, d.note, po.supplier_id, po.warehouse_id, s.name, w.code, w.name
       ORDER BY d.received_at DESC
       LIMIT 200`,
      values,
    )
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const optionalNonEmptyString = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s ? s : undefined
}, z.string().min(1).optional())

const supplierItemPriceSchema = z.object({
  supplier_id: z.string().min(1),
  item_id: optionalNonEmptyString,
  linen_type_code: optionalNonEmptyString,
  purchase_unit_price: z.number().min(0),
  refund_unit_price: z.number().min(0).optional(),
  effective_from: z.string().optional(),
  active: z.boolean().optional(),
})

router.get('/supplier-item-prices', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const supplierId = String((req.query as any)?.supplier_id || '').trim()
    const itemId = String((req.query as any)?.item_id || '').trim()
    const active = String((req.query as any)?.active || '').trim().toLowerCase()
    const where: string[] = []
    const values: any[] = []
    if (supplierId) { values.push(supplierId); where.push(`sip.supplier_id = $${values.length}`) }
    if (itemId) { values.push(itemId); where.push(`sip.item_id = $${values.length}`) }
    if (active === 'true' || active === 'false') { values.push(active === 'true'); where.push(`sip.active = $${values.length}`) }
    const rows = await pgPool.query(
      `SELECT sip.*, s.name AS supplier_name, i.name AS item_name, i.sku AS item_sku, i.linen_type_code
       FROM supplier_item_prices sip
       JOIN suppliers s ON s.id = sip.supplier_id
       JOIN inventory_items i ON i.id = sip.item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.name ASC, i.name ASC, COALESCE(sip.effective_from, DATE '1970-01-01') DESC`,
      values,
    )
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/supplier-item-prices', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierItemPriceSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const body = parsed.data
    let itemId = String(body.item_id || '').trim()
    if (!itemId && body.linen_type_code) {
      const item = await ensureLinenInventoryItem(pgPool, String(body.linen_type_code))
      itemId = String(item?.id || '')
    }
    if (!itemId) return res.status(400).json({ message: 'item_id required' })
    const id = uuidv4()
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const row = await client.query(
        `INSERT INTO supplier_item_prices (id, supplier_id, item_id, purchase_unit_price, refund_unit_price, effective_from, active, updated_at)
         VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date,$7,now())
         ON CONFLICT (supplier_id, item_id)
         DO UPDATE SET purchase_unit_price = EXCLUDED.purchase_unit_price,
                       refund_unit_price = EXCLUDED.refund_unit_price,
                       effective_from = EXCLUDED.effective_from,
                       active = EXCLUDED.active,
                       updated_at = now()
         RETURNING *`,
        [id, body.supplier_id, itemId, body.purchase_unit_price, body.refund_unit_price ?? body.purchase_unit_price, body.effective_from || null, body.active ?? true],
      )
      const saved = row.rows?.[0] || null
      if (saved) {
        await syncDraftPurchaseOrderPricesForSupplierItem(client, {
          supplierId: String(saved.supplier_id || ''),
          itemId: String(saved.item_id || ''),
          unitPrice: Number(saved.purchase_unit_price || 0),
          active: Boolean(saved.active),
        })
      }
      await client.query('COMMIT')
      return res.status(201).json(saved)
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch {}
      throw txErr
    } finally {
      client.release()
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/supplier-item-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierItemPriceSchema.partial().safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '')
    const payload = parsed.data as any
    const keys = Object.keys(payload).filter((k) => payload[k] !== undefined)
    if (!keys.length) return res.json(null)
    const sets = keys.map((k, i) => k === 'effective_from' ? `"${k}" = NULLIF($${i + 1}, '')::date` : `"${k}" = $${i + 1}`).join(', ')
    const values = keys.map((k) => payload[k])
    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const row = await client.query(
        `UPDATE supplier_item_prices
         SET ${sets}, updated_at = now()
         WHERE id = $${keys.length + 1}
         RETURNING *`,
        [...values, id],
      )
      const saved = row.rows?.[0] || null
      if (saved) {
        await syncDraftPurchaseOrderPricesForSupplierItem(client, {
          supplierId: String(saved.supplier_id || ''),
          itemId: String(saved.item_id || ''),
          unitPrice: Number(saved.purchase_unit_price || 0),
          active: Boolean(saved.active),
        })
      }
      await client.query('COMMIT')
      return res.json(saved)
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch {}
      throw txErr
    } finally {
      client.release()
    }
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/supplier-item-prices/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '')
    const before = await pgPool.query(`SELECT * FROM supplier_item_prices WHERE id = $1`, [id])
    const row = before.rows?.[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    await pgPool.query(`DELETE FROM supplier_item_prices WHERE id = $1`, [id])
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/reserve-policies', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const warehouseId = String((req.query as any)?.warehouse_id || '').trim()
    const rows = await pgPool.query(
      `SELECT p.id, p.warehouse_id, p.item_id, p.reserve_qty, w.code AS warehouse_code, w.name AS warehouse_name,
              i.name AS item_name, i.sku AS item_sku, i.linen_type_code
       FROM inventory_stock_policies p
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN inventory_items i ON i.id = p.item_id
       ${warehouseId ? 'WHERE p.warehouse_id = $1' : ''}
       ORDER BY w.code ASC, i.name ASC`,
      warehouseId ? [warehouseId] : [],
    )
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const reservePolicySchema = z.object({
  warehouse_id: z.string().min(1),
  item_id: z.string().min(1),
  reserve_qty: z.number().int().min(0),
})

router.put('/linen/reserve-policies', requirePerm('inventory.item.manage'), async (req, res) => {
  const parsed = reservePolicySchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const body = parsed.data
    const id = `reserve.${body.warehouse_id}.${body.item_id}`
    const row = await pgPool.query(
      `INSERT INTO inventory_stock_policies (id, warehouse_id, item_id, reserve_qty, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (warehouse_id, item_id)
       DO UPDATE SET reserve_qty = EXCLUDED.reserve_qty, updated_at = now()
       RETURNING *`,
      [id, body.warehouse_id, body.item_id, body.reserve_qty],
    )
    return res.json(row.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/dashboard', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const client = pgPool
    const smWarehouse = await getSmWarehouse()
    const smWarehouseId = String(smWarehouse?.id || '')
    const cleaningTaskSchemaRes = await client.query(
      `SELECT
         to_regclass('public.cleaning_tasks') IS NOT NULL AS has_cleaning_tasks,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='property_id') AS has_property_id,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='status') AS has_status,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='date') AS has_date,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='task_date') AS has_task_date,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='task_type') AS has_task_type,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='type') AS has_type`,
    )
    const cleaningSchema = cleaningTaskSchemaRes.rows?.[0] || {}
    const canQueryCleaningTasks =
      Boolean(cleaningSchema.has_cleaning_tasks) &&
      Boolean(cleaningSchema.has_property_id) &&
      Boolean(cleaningSchema.has_status) &&
      (Boolean(cleaningSchema.has_date) || Boolean(cleaningSchema.has_task_date)) &&
      (Boolean(cleaningSchema.has_task_type) || Boolean(cleaningSchema.has_type))

    const [warehousesRes, itemsRes, stocksRes, roomRes, pendingRefundRes, deliveredSetsRes, latestStocktakeRes, latestStocktakeLinesRes, cleaningTaskRowsRes] = await Promise.all([
      client.query(`SELECT id, code, name, linen_capacity_sets, active FROM warehouses WHERE active = true ORDER BY code ASC`),
      client.query(
        `SELECT i.id, i.name, i.sku, i.linen_type_code, lt.sort_order
         FROM inventory_items i
         LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
         WHERE i.category = 'linen' AND i.active = true
         ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`,
      ),
      client.query(`SELECT warehouse_id, item_id, quantity FROM warehouse_stocks WHERE item_id IN (SELECT id FROM inventory_items WHERE category = 'linen')`),
      getRoomTypeRequirementMaps(client),
      client.query(`SELECT COALESCE(SUM(expected_amount - received_amount),0) AS pending_amount FROM linen_supplier_refunds WHERE status <> 'settled'`),
      client.query(
        `SELECT r.to_warehouse_id AS warehouse_id,
                l.room_type_code,
                COALESCE(SUM(l.sets), 0)::int AS delivered_sets
         FROM linen_delivery_records r
         JOIN linen_delivery_record_lines l ON l.record_id = r.id
         WHERE r.status = 'completed'
         GROUP BY r.to_warehouse_id, l.room_type_code`,
      ),
      client.query(
        `SELECT DISTINCT ON (warehouse_id)
                id,
                warehouse_id,
                delivery_record_id,
                stocktake_date,
                dirty_bag_note,
                note,
                created_at,
                updated_at
         FROM linen_stocktake_records
         ORDER BY warehouse_id, stocktake_date DESC, created_at DESC, id DESC`,
      ),
      client.query(
        `SELECT sl.record_id,
                sl.room_type_code,
                sl.remaining_sets
         FROM linen_stocktake_record_lines sl
         WHERE sl.record_id IN (
           SELECT DISTINCT ON (warehouse_id) id
           FROM linen_stocktake_records
           ORDER BY warehouse_id, stocktake_date DESC, created_at DESC, id DESC
         )`,
      ),
      canQueryCleaningTasks
        ? client.query(
          `SELECT
              COALESCE(t.task_date, t.date)::date AS task_date,
              t.status,
              COALESCE(t.task_type, t.type) AS task_type,
              COALESCE(p_id.id, p_code.id) AS property_id,
              COALESCE(p_id.code, p_code.code, t.property_id::text) AS property_code,
              COALESCE(p_id.region, p_code.region) AS region,
              COALESCE(p_id.room_type_code, p_code.room_type_code) AS room_type_code,
              COALESCE(p_id.linen_service_warehouse_id, p_code.linen_service_warehouse_id) AS linen_service_warehouse_id
           FROM cleaning_tasks t
           LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
           LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
           WHERE COALESCE(t.task_date, t.date) IS NOT NULL
             AND COALESCE(t.task_date, t.date)::date <= CURRENT_DATE
             AND COALESCE(t.task_type, t.type, '') = 'checkout_clean'
             AND COALESCE(t.status, '') <> 'cancelled'`,
        )
        : Promise.resolve({ rows: [] as any[] }),
    ])
    const warehouses = warehousesRes.rows || []
    const items = itemsRes.rows || []
    const reserveMap = smWarehouseId ? await getLinenReserveMap(client, smWarehouseId) : new Map<string, number>()
    const itemMap = new Map<string, any>(items.map((r: any) => [String(r.id), r]))
    const countsByWarehouse = new Map<string, Record<string, number>>()
    for (const row of stocksRes.rows || []) {
      const warehouseId = String(row.warehouse_id || '')
      if (!countsByWarehouse.has(warehouseId)) countsByWarehouse.set(warehouseId, {})
      const item = itemMap.get(String(row.item_id || ''))
      const linenTypeCode = String(item?.linen_type_code || '')
      if (!linenTypeCode) continue
      countsByWarehouse.get(warehouseId)![linenTypeCode] = Number(countsByWarehouse.get(warehouseId)![linenTypeCode] || 0) + Number(row.quantity || 0)
    }
    const dispatchableByType: Record<string, number> = {}
    if (smWarehouseId) {
      for (const item of items) {
        const itemId = String(item.id)
        const linenTypeCode = String(item.linen_type_code || '')
        const qty = Number((countsByWarehouse.get(smWarehouseId) || {})[linenTypeCode] || 0)
        const reserveQty = Number(reserveMap.get(itemId) || 0)
        dispatchableByType[linenTypeCode] = Math.max(0, qty - reserveQty)
      }
    }
    const roomTypes = roomRes.roomTypes || []
    const deliveredSetsByWarehouse = new Map<string, Record<string, number>>()
    for (const row of deliveredSetsRes.rows || []) {
      const warehouseId = String(row.warehouse_id || '')
      const roomTypeCode = String(row.room_type_code || '')
      if (!warehouseId || !roomTypeCode) continue
      if (!deliveredSetsByWarehouse.has(warehouseId)) deliveredSetsByWarehouse.set(warehouseId, {})
      deliveredSetsByWarehouse.get(warehouseId)![roomTypeCode] = Number(row.delivered_sets || 0)
    }
    const latestStocktakeByWarehouse = new Map<string, any>()
    for (const row of latestStocktakeRes.rows || []) {
      const warehouseId = String(row.warehouse_id || '')
      if (!warehouseId) continue
      latestStocktakeByWarehouse.set(warehouseId, row)
    }
    const stocktakeLinesByRecord = new Map<string, Record<string, number>>()
    for (const row of latestStocktakeLinesRes.rows || []) {
      const recordId = String(row.record_id || '')
      const roomTypeCode = String(row.room_type_code || '')
      if (!recordId || !roomTypeCode) continue
      if (!stocktakeLinesByRecord.has(recordId)) stocktakeLinesByRecord.set(recordId, {})
      stocktakeLinesByRecord.get(recordId)![roomTypeCode] = Number(row.remaining_sets || 0)
    }
    const cleaningTasksByWarehouse = new Map<string, Array<{ room_type_code: string; task_date: string }>>()
    for (const row of cleaningTaskRowsRes.rows || []) {
      const roomTypeCode = String(row.room_type_code || '').trim()
      const taskDate = String(row.task_date || '').slice(0, 10)
      if (!roomTypeCode || !taskDate) continue
      const warehouseId = resolveWarehouseForProperty(row, warehouses)
      if (!warehouseId) continue
      if (!cleaningTasksByWarehouse.has(warehouseId)) cleaningTasksByWarehouse.set(warehouseId, [])
      cleaningTasksByWarehouse.get(warehouseId)!.push({
        room_type_code: roomTypeCode,
        task_date: taskDate,
      })
    }
    const rows = warehouses.map((warehouse: any) => {
      const counts = countsByWarehouse.get(String(warehouse.id)) || {}
      const availableSetsByRoomType: Record<string, number> = {}
      const stocktakeSetsByRoomType: Record<string, number> = {}
      const taskEstimatedConsumedByRoomType: Record<string, number> = {}
      const warehouseId = String(warehouse.id || '')
      const deliveredSets = deliveredSetsByWarehouse.get(warehouseId) || {}
      const latestStocktake = latestStocktakeByWarehouse.get(warehouseId) || null
      const latestStocktakeLines = latestStocktake ? (stocktakeLinesByRecord.get(String(latestStocktake.id || '')) || {}) : {}
      const warehouseCleaningTasks = cleaningTasksByWarehouse.get(warehouseId) || []
      for (const roomType of roomTypes) {
        const roomTypeCode = String(roomType.code || '')
        if (isSmWarehouseRow(warehouse)) {
          availableSetsByRoomType[roomTypeCode] = computeSetsForRoomType(counts, roomRes.reqMap.get(roomTypeCode))
          stocktakeSetsByRoomType[roomTypeCode] = availableSetsByRoomType[roomTypeCode]
        } else {
          stocktakeSetsByRoomType[roomTypeCode] = Number(latestStocktakeLines[roomTypeCode] || 0)
          availableSetsByRoomType[roomTypeCode] = Number(latestStocktakeLines[roomTypeCode] || 0)
        }
        const stocktakeDate = String(latestStocktake?.stocktake_date || '').slice(0, 10)
        const relevantTaskCount = warehouseCleaningTasks.filter((task) => {
          if (task.room_type_code !== roomTypeCode) return false
          if (!stocktakeDate) return true
          return task.task_date >= stocktakeDate
        }).length
        taskEstimatedConsumedByRoomType[roomTypeCode] = Number(relevantTaskCount || 0)
      }
      return {
        warehouse_id: warehouse.id,
        warehouse_code: warehouse.code,
        warehouse_name: warehouse.name,
        linen_capacity_sets: warehouse.linen_capacity_sets,
        is_sm: isSmWarehouseRow(warehouse),
        counts_by_sub_type: counts,
        delivered_sets_by_room_type: deliveredSets,
        stocktake_sets_by_room_type: stocktakeSetsByRoomType,
        available_sets_by_room_type: availableSetsByRoomType,
        task_estimated_consumed_sets_by_room_type: taskEstimatedConsumedByRoomType,
        last_stocktake_at: latestStocktake?.created_at || null,
        stocktake_date: latestStocktake?.stocktake_date || null,
        has_stocktake: Boolean(latestStocktake),
        dirty_bag_note: String(latestStocktake?.dirty_bag_note || ''),
      }
    })
    const pendingReturnRows = await client.query(
      `SELECT i.linen_type_code,
              COALESCE(SUM(CASE WHEN m.reason = 'return_from_subwarehouse' AND m.type = 'in' THEN m.quantity ELSE 0 END),0) -
              COALESCE(SUM(CASE WHEN m.reason = 'return_to_supplier' AND m.type = 'out' THEN m.quantity ELSE 0 END),0) AS qty
       FROM stock_movements m
       JOIN inventory_items i ON i.id = m.item_id
       WHERE i.category = 'linen'
         AND m.warehouse_id = $1
       GROUP BY i.linen_type_code`,
      [smWarehouseId || ''],
    )
    const pendingReturnsByType: Record<string, number> = {}
    for (const row of pendingReturnRows.rows || []) pendingReturnsByType[String(row.linen_type_code || '')] = Math.max(0, Number(row.qty || 0))
    return res.json({
      sm_warehouse_id: smWarehouseId || null,
      room_types: roomTypes,
      linen_items: items,
      reserve_policies: items.map((item: any) => ({
        item_id: item.id,
        item_name: item.name,
        item_sku: item.sku,
        linen_type_code: item.linen_type_code,
        reserve_qty: Number(reserveMap.get(String(item.id)) || 0),
      })),
      dispatchable_by_type: dispatchableByType,
      pending_returns_by_type: pendingReturnsByType,
      pending_refund_amount: Number(pendingRefundRes.rows?.[0]?.pending_amount || 0),
      warehouses: rows,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/delivery-suggestions', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const client = pgPool
    const dateFrom = String((req.query as any)?.date_from || '').trim() || toDayStartIsoMelbourne(0).slice(0, 10)
    const dateTo = String((req.query as any)?.date_to || '').trim() || toDayStartIsoMelbourne(7).slice(0, 10)
    const vehicleCapacitySets = Math.max(1, Number((req.query as any)?.vehicle_capacity_sets || 80))
    const smWarehouse = await getSmWarehouse()
    const warehousesRes = await client.query(`SELECT id, code, name, linen_capacity_sets FROM warehouses WHERE active = true ORDER BY code ASC`)
    const warehouses = warehousesRes.rows || []
    const smWarehouseId = String(smWarehouse?.id || '')
    const [roomData, itemsRes, stocksRes, ordersRes] = await Promise.all([
      getRoomTypeRequirementMaps(client),
      client.query(`SELECT id, name, sku, linen_type_code FROM inventory_items WHERE category = 'linen' AND active = true`),
      client.query(`SELECT warehouse_id, item_id, quantity FROM warehouse_stocks WHERE item_id IN (SELECT id FROM inventory_items WHERE category = 'linen')`),
      client.query(
        `SELECT o.id, substring(o.checkout::text,1,10) AS checkout_day, p.id AS property_id, p.code AS property_code, p.region,
                p.room_type_code, p.linen_service_warehouse_id
         FROM orders o
         JOIN properties p ON p.id = o.property_id
         WHERE substring(o.checkout::text,1,10) >= $1
           AND substring(o.checkout::text,1,10) <= $2
           AND lower(coalesce(o.status,'')) NOT LIKE '%cancel%'
           AND lower(coalesce(o.status,'')) NOT LIKE '%void%'`,
        [dateFrom, dateTo],
      ),
    ])
    const items = itemsRes.rows || []
    const itemMap = new Map<string, any>(items.map((r: any) => [String(r.id), r]))
    const reserveMap = smWarehouseId ? await getLinenReserveMap(client, smWarehouseId) : new Map<string, number>()
    const countsByWarehouse = new Map<string, Record<string, number>>()
    for (const row of stocksRes.rows || []) {
      const warehouseId = String(row.warehouse_id || '')
      if (!countsByWarehouse.has(warehouseId)) countsByWarehouse.set(warehouseId, {})
      const item = itemMap.get(String(row.item_id || ''))
      const linenTypeCode = String(item?.linen_type_code || '')
      if (!linenTypeCode) continue
      countsByWarehouse.get(warehouseId)![linenTypeCode] = Number(countsByWarehouse.get(warehouseId)![linenTypeCode] || 0) + Number(row.quantity || 0)
    }
    const dispatchableByType: Record<string, number> = {}
    for (const item of items) {
      const itemId = String(item.id)
      const linenTypeCode = String(item.linen_type_code || '')
      const qty = Number((countsByWarehouse.get(smWarehouseId) || {})[linenTypeCode] || 0)
      const reserveQty = Number(reserveMap.get(itemId) || 0)
      dispatchableByType[linenTypeCode] = Math.max(0, qty - reserveQty)
    }
    const demandMap = new Map<string, Map<string, number>>()
    const unmatchedProperties: any[] = []
    for (const orderRow of ordersRes.rows || []) {
      const warehouseId = resolveWarehouseForProperty(orderRow, warehouses)
      const roomTypeCode = String(orderRow.room_type_code || '')
      if (!warehouseId || !roomTypeCode) {
        unmatchedProperties.push({
          property_id: orderRow.property_id,
          property_code: orderRow.property_code,
          room_type_code: roomTypeCode || null,
          warehouse_id: warehouseId || null,
        })
        continue
      }
      if (!demandMap.has(warehouseId)) demandMap.set(warehouseId, new Map())
      demandMap.get(warehouseId)!.set(roomTypeCode, Number(demandMap.get(warehouseId)!.get(roomTypeCode) || 0) + 1)
    }
    const lines: any[] = []
    let vehicleRemaining = vehicleCapacitySets
    for (const warehouse of warehouses.filter((w: any) => !isSmWarehouseRow(w))) {
      const warehouseId = String(warehouse.id)
      const counts = countsByWarehouse.get(warehouseId) || {}
      for (const roomType of roomData.roomTypes || []) {
        const roomTypeCode = String(roomType.code || '')
        const currentSets = computeSetsForRoomType(counts, roomData.reqMap.get(roomTypeCode))
        const demandSets = Number(demandMap.get(warehouseId)?.get(roomTypeCode) || 0)
        const capacitySets = Number(warehouse.linen_capacity_sets || 0)
        const targetSets = capacitySets > 0 ? Math.min(capacitySets, demandSets) : demandSets
        let suggestedSets = Math.max(0, targetSets - currentSets)
        if (suggestedSets <= 0 || vehicleRemaining <= 0) continue
        const reqs = roomData.reqMap.get(roomTypeCode)
        if (!reqs || !reqs.size) continue
        let maxByDispatchable = suggestedSets
        for (const [linenTypeCode, quantity] of reqs.entries()) {
          maxByDispatchable = Math.min(maxByDispatchable, Math.floor(Number(dispatchableByType[linenTypeCode] || 0) / Math.max(1, quantity)))
        }
        suggestedSets = Math.max(0, Math.min(suggestedSets, maxByDispatchable, vehicleRemaining))
        if (suggestedSets <= 0) continue
        for (const [linenTypeCode, quantity] of reqs.entries()) {
          dispatchableByType[linenTypeCode] = Math.max(0, Number(dispatchableByType[linenTypeCode] || 0) - suggestedSets * quantity)
        }
        vehicleRemaining -= suggestedSets
        lines.push({
          to_warehouse_id: warehouseId,
          to_warehouse_code: warehouse.code,
          to_warehouse_name: warehouse.name,
          room_type_code: roomTypeCode,
          room_type_name: roomType.name,
          current_sets: currentSets,
          demand_sets: demandSets,
          target_sets: targetSets,
          suggested_sets: suggestedSets,
          warehouse_capacity_sets: capacitySets || null,
          vehicle_load_sets: suggestedSets,
        })
      }
    }
    lines.sort((a, b) => Number(b.demand_sets - b.current_sets) - Number(a.demand_sets - a.current_sets))
    return res.json({
      from_warehouse_id: smWarehouseId || null,
      from_warehouse_name: smWarehouse?.name || null,
      date_from: dateFrom,
      date_to: dateTo,
      vehicle_capacity_sets: vehicleCapacitySets,
      vehicle_remaining_sets: vehicleRemaining,
      unmatched_properties: unmatchedProperties,
      lines,
    })
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const linenDeliveryRecordLineSchema = z.object({
  room_type_code: z.string().min(1),
  sets: z.number().int().min(1),
})

const linenDeliveryRecordExtraLineSchema = z.object({
  linen_type_code: z.string().min(1),
  quantity: z.number().int().min(1),
})

const linenStocktakeLineSchema = z.object({
  room_type_code: z.string().min(1),
  remaining_sets: z.number().int().min(0),
})

const linenDeliveryRecordCreateSchema = z.object({
  delivery_date: z.string().min(1),
  from_warehouse_id: z.string().min(1),
  to_warehouse_id: z.string().min(1),
  note: z.string().optional(),
  lines: z.array(linenDeliveryRecordLineSchema).default([]),
  extra_linen_lines: z.array(linenDeliveryRecordExtraLineSchema).default([]),
  stocktake_lines: z.array(linenStocktakeLineSchema).min(1),
  dirty_bag_note: z.string().optional(),
}).superRefine((data, ctx) => {
  if (!(data.lines?.length || data.extra_linen_lines?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少需要一条配送明细', path: ['lines'] })
  }
})

const linenDeliveryRecordUpdateSchema = linenDeliveryRecordCreateSchema

const linenStocktakeCreateSchema = z.object({
  warehouse_id: z.string().min(1),
  delivery_record_id: z.string().optional(),
  stocktake_date: z.string().min(1),
  dirty_bag_note: z.string().optional(),
  note: z.string().optional(),
  lines: z.array(linenStocktakeLineSchema).min(1),
})

router.get('/linen/delivery-records', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const where: string[] = []
    const params: any[] = []
    const push = (sql: string, value: any) => {
      params.push(value)
      where.push(sql.replace('?', `$${params.length}`))
    }
    const dateFrom = String((req.query as any)?.date_from || '').trim()
    const dateTo = String((req.query as any)?.date_to || '').trim()
    const fromWarehouseId = String((req.query as any)?.from_warehouse_id || '').trim()
    const toWarehouseId = String((req.query as any)?.to_warehouse_id || '').trim()
    const status = String((req.query as any)?.status || '').trim()
    if (dateFrom) push(`r.delivery_date >= ?::date`, dateFrom)
    if (dateTo) push(`r.delivery_date <= ?::date`, dateTo)
    if (fromWarehouseId) push(`r.from_warehouse_id = ?`, fromWarehouseId)
    if (toWarehouseId) push(`r.to_warehouse_id = ?`, toWarehouseId)
    if (status) push(`r.status = ?`, status)
    const rows = await pgPool.query(
      `SELECT r.*,
              fw.code AS from_warehouse_code,
              fw.name AS from_warehouse_name,
              tw.code AS to_warehouse_code,
              tw.name AS to_warehouse_name,
              COALESCE(SUM(l.sets),0)::int AS total_sets,
              COUNT(l.id)::int AS room_type_count,
              COALESCE((
                SELECT SUM(el.quantity)::int
                FROM linen_delivery_record_extra_lines el
                WHERE el.record_id = r.id
              ), 0)::int AS extra_linen_total
       FROM linen_delivery_records r
       JOIN warehouses fw ON fw.id = r.from_warehouse_id
       JOIN warehouses tw ON tw.id = r.to_warehouse_id
       LEFT JOIN linen_delivery_record_lines l ON l.record_id = r.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY r.id, fw.code, fw.name, tw.code, tw.name
       ORDER BY r.delivery_date DESC, r.created_at DESC
       LIMIT 200`,
      params,
    )
    return res.json((rows.rows || []).map((row: any) => ({
      ...row,
      total_sets: Number(row.total_sets || 0),
      room_type_count: Number(row.room_type_count || 0),
      extra_linen_total: Number(row.extra_linen_total || 0),
    })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/delivery-records/:id', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const record = await loadLinenDeliveryRecordDetail(pgPool, String(req.params.id || ''))
    if (!record) return res.status(404).json({ message: 'not found' })
    return res.json(record)
  } catch (e: any) {
    return sendInventoryError(req, res, e)
  }
})

router.get('/linen/stocktakes', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const warehouseId = String((req.query as any)?.warehouse_id || '').trim()
    const dateFrom = String((req.query as any)?.date_from || '').trim()
    const dateTo = String((req.query as any)?.date_to || '').trim()
    const where: string[] = []
    const params: any[] = []
    const push = (sql: string, value: any) => {
      params.push(value)
      where.push(sql.replace('?', `$${params.length}`))
    }
    if (warehouseId) push(`sr.warehouse_id = ?`, warehouseId)
    if (dateFrom) push(`sr.stocktake_date >= ?::date`, dateFrom)
    if (dateTo) push(`sr.stocktake_date <= ?::date`, dateTo)
    const rows = await pgPool.query(
      `SELECT sr.*,
              w.code AS warehouse_code,
              w.name AS warehouse_name,
              dr.delivery_date,
              dr.status AS delivery_record_status,
              COUNT(sl.id)::int AS room_type_count
       FROM linen_stocktake_records sr
       JOIN warehouses w ON w.id = sr.warehouse_id
       LEFT JOIN linen_delivery_records dr ON dr.id = sr.delivery_record_id
       LEFT JOIN linen_stocktake_record_lines sl ON sl.record_id = sr.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY sr.id, w.code, w.name, dr.delivery_date, dr.status
       ORDER BY sr.stocktake_date DESC, sr.created_at DESC
       LIMIT 200`,
      params,
    )
    return res.json((rows.rows || []).map((row: any) => ({
      ...row,
      room_type_count: Number(row.room_type_count || 0),
    })))
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/stocktakes/:id', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const detail = await loadLinenStocktakeDetail(pgPool, String(req.params.id || ''))
    if (!detail) return res.status(404).json({ message: 'not found' })
    return res.json(detail)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/linen/stocktakes', requirePerm('inventory.move'), async (req, res) => {
  const parsed = linenStocktakeCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const actor = actorId(req)
    const detail = await pgRunInTransaction(async (client) => {
      await assertWarehouseAllowsStocktake(client, parsed.data.warehouse_id)
      const recordId = await upsertLinenStocktakeRecordInTx(client, {
        warehouse_id: parsed.data.warehouse_id,
        delivery_record_id: parsed.data.delivery_record_id || null,
        stocktake_date: parsed.data.stocktake_date,
        dirty_bag_note: parsed.data.dirty_bag_note || null,
        note: parsed.data.note || null,
        actor_id: actor,
        lines: parsed.data.lines,
      })
      const saved = await loadLinenStocktakeDetail(client, recordId)
      if (!saved) throw httpError(500, '盘点单保存后读取失败')
      return saved
    })
    addAudit('LinenStocktakeRecord', String(detail?.id || ''), 'create', null, detail, actor)
    return res.status(201).json(detail)
  } catch (e: any) {
    return res.status(Number(e?.statusCode || 500)).json({ message: e?.message || 'failed' })
  }
})

router.post('/linen/delivery-records', requirePerm('inventory.move'), async (req, res) => {
  const parsed = linenDeliveryRecordCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(withTracePayload(req, parsed.error.format() as any))
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json(withTracePayload(req, { message: 'same warehouse' }))
  const requestStartedAt = Date.now()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json(withTracePayload(req, { message: 'not available without PG' }))
    await ensureInventorySchema()
    const actor = actorId(req)
    const recordId = uuidv4()
    const metrics = {
      validate_ms: 0,
      ensure_idempotency_ms: 0,
      expand_lines_ms: 0,
      apply_stock_ms: 0,
      save_stocktake_ms: 0,
      build_response_ms: 0,
      total_ms: 0,
    }
    inventoryLog(req, 'log', 'delivery_create_start', {
      record_id: recordId,
      from_warehouse_id: parsed.data.from_warehouse_id,
      to_warehouse_id: parsed.data.to_warehouse_id,
      delivery_date: parsed.data.delivery_date,
    })
    const result = await pgRunInTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = '5000ms'`)
      const validateStartedAt = Date.now()
      await assertWarehouseAllowsStocktake(client, parsed.data.to_warehouse_id)
      metrics.validate_ms = Date.now() - validateStartedAt
      const expandStartedAt = Date.now()
      const expandedLines = await expandLinenDeliveryInputLines(client, parsed.data.lines)
      const expandedExtraLines = await expandLinenDeliveryExtraInputLines(client, parsed.data.extra_linen_lines || [])
      metrics.expand_lines_ms = Date.now() - expandStartedAt
      const fingerprint = buildLinenDeliveryRecordFingerprint({
        actor_id: actor,
        delivery_date: parsed.data.delivery_date,
        from_warehouse_id: parsed.data.from_warehouse_id,
        to_warehouse_id: parsed.data.to_warehouse_id,
        note: parsed.data.note || null,
        lines: expandedLines.map((line) => ({
          room_type_code: line.room_type_code,
          sets: line.sets,
        })),
        extra_linen_lines: expandedExtraLines.map((line) => ({
          linen_type_code: line.linen_type_code,
          quantity: line.quantity,
        })),
      })
      const idempotencyStartedAt = Date.now()
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [fingerprint])
      const duplicateRes = await client.query(
        `SELECT id
         FROM linen_delivery_records
         WHERE created_by IS NOT DISTINCT FROM $1
           AND status = 'completed'
           AND delivery_date = $2::date
           AND from_warehouse_id = $3
           AND to_warehouse_id = $4
           AND COALESCE(note,'') = COALESCE($5,'')
           AND created_at >= now() - interval '2 minutes'
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT room_type_code, sets
               FROM linen_delivery_record_lines
               WHERE record_id = linen_delivery_records.id
               EXCEPT
               SELECT room_type_code, sets
               FROM jsonb_to_recordset($6::jsonb) AS x(room_type_code text, sets integer)
             ) diff1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT room_type_code, sets
               FROM jsonb_to_recordset($6::jsonb) AS x(room_type_code text, sets integer)
               EXCEPT
               SELECT room_type_code, sets
               FROM linen_delivery_record_lines
               WHERE record_id = linen_delivery_records.id
             ) diff2
           )
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT linen_type_code, quantity
               FROM linen_delivery_record_extra_lines
               WHERE record_id = linen_delivery_records.id
               EXCEPT
               SELECT linen_type_code, quantity
               FROM jsonb_to_recordset($7::jsonb) AS y(linen_type_code text, quantity integer)
             ) diff3
           )
           AND NOT EXISTS (
             SELECT 1
             FROM (
               SELECT linen_type_code, quantity
               FROM jsonb_to_recordset($7::jsonb) AS y(linen_type_code text, quantity integer)
               EXCEPT
               SELECT linen_type_code, quantity
               FROM linen_delivery_record_extra_lines
               WHERE record_id = linen_delivery_records.id
             ) diff4
           )
         ORDER BY created_at DESC
         LIMIT 1`,
        [
          actor,
          parsed.data.delivery_date,
          parsed.data.from_warehouse_id,
          parsed.data.to_warehouse_id,
          parsed.data.note || null,
          JSON.stringify(expandedLines.map((line) => ({ room_type_code: line.room_type_code, sets: line.sets }))),
          JSON.stringify(expandedExtraLines.map((line) => ({ linen_type_code: line.linen_type_code, quantity: line.quantity }))),
        ],
      )
      metrics.ensure_idempotency_ms = Date.now() - idempotencyStartedAt
      const duplicateId = String(duplicateRes.rows?.[0]?.id || '')
      if (duplicateId) {
        const existing = await loadLinenDeliveryRecordSummary(client, duplicateId)
        if (existing) {
          return {
            ok: true as const,
            response: buildDeliverySuccessResponse(existing, { deduped: true }),
            row: existing,
            deduped: true as const,
          }
        }
      }
      const inserted = await client.query(
        `INSERT INTO linen_delivery_records (id, delivery_date, from_warehouse_id, to_warehouse_id, status, note, created_by)
         VALUES ($1,$2::date,$3,$4,'completed',$5,$6)
         RETURNING *`,
        [recordId, parsed.data.delivery_date, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null, actor],
      )
      for (const line of expandedLines) {
        await client.query(
          `INSERT INTO linen_delivery_record_lines (id, record_id, room_type_code, room_type_name, sets)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), recordId, line.room_type_code, line.room_type_name, line.sets],
        )
      }
      for (const line of expandedExtraLines) {
        await client.query(
          `INSERT INTO linen_delivery_record_extra_lines (id, record_id, linen_type_code, linen_type_name, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), recordId, line.linen_type_code, line.linen_type_name, line.quantity],
        )
      }
      const applyStartedAt = Date.now()
      const applied = await applyLinenDeliveryBreakdownsInTx(client, {
        record_id: recordId,
        from_warehouse_id: parsed.data.from_warehouse_id,
        to_warehouse_id: parsed.data.to_warehouse_id,
        note: parsed.data.note || null,
        actor_id: actor,
        breakdowns: [
          ...expandedLines.map((line) => line.breakdown || []),
          ...expandedExtraLines.map((line) => line.breakdown || []),
        ],
        direction: 'apply',
      })
      assertStockTxnOk(applied)
      metrics.apply_stock_ms = Date.now() - applyStartedAt
      const stocktakeStartedAt = Date.now()
      await upsertLinenStocktakeRecordInTx(client, {
        delivery_record_id: recordId,
        warehouse_id: parsed.data.to_warehouse_id,
        stocktake_date: parsed.data.delivery_date,
        dirty_bag_note: parsed.data.dirty_bag_note || null,
        note: parsed.data.note || null,
        actor_id: actor,
        lines: parsed.data.stocktake_lines,
      })
      metrics.save_stocktake_ms = Date.now() - stocktakeStartedAt
      const responseStartedAt = Date.now()
      const summary = await loadLinenDeliveryRecordSummary(client, recordId)
      metrics.build_response_ms = Date.now() - responseStartedAt
      if (!summary) {
        inventoryLog(req, 'error', 'delivery_create_response_degraded', { record_id: recordId, reason: 'summary_read_failed' })
      }
      return {
        ok: true as const,
        response: buildDeliverySuccessResponse(summary || inserted.rows?.[0] || {}, summary ? {} : { details_degraded: true }),
        row: inserted.rows?.[0] || null,
      }
    })
    if (!(result as any)?.deduped) {
      try {
        addAudit('LinenDeliveryRecord', recordId, 'create', null, (result as any).row || (result as any).response || null, actor)
      } catch {}
    }
    metrics.total_ms = Date.now() - requestStartedAt
    inventoryLog(req, metrics.total_ms > 3000 ? 'error' : 'log', 'delivery_create_finish', {
      record_id: String((result as any)?.response?.id || recordId),
      status: 'success',
      ...metrics,
    })
    return res.status(201).json(withTracePayload(req, (result as any).response))
  } catch (e: any) {
    inventoryLog(req, 'error', 'delivery_create_finish', { status: 'failed', total_ms: Date.now() - requestStartedAt, message: String(e?.message || 'failed') })
    return sendInventoryError(req, res, e)
  }
})

router.patch('/linen/delivery-records/:id', requirePerm('inventory.move'), async (req, res) => {
  const parsed = linenDeliveryRecordUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(withTracePayload(req, parsed.error.format() as any))
  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) return res.status(400).json(withTracePayload(req, { message: 'same warehouse' }))
  const id = String(req.params.id || '')
  const requestStartedAt = Date.now()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json(withTracePayload(req, { message: 'not available without PG' }))
    await ensureInventorySchema()
    const actor = actorId(req)
    inventoryLog(req, 'log', 'delivery_update_start', { record_id: id })
    const result = await pgRunInTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = '5000ms'`)
      const current = await getEditableLinenDeliveryRecordForUpdate(client, id)
      if (!current) return { ok: false as const, code: 404 as const, message: 'not found' }
      if (String(current.record.status || '') !== 'completed') return { ok: false as const, code: 400 as const, message: '仅已完成配送单可编辑' }
      await assertWarehouseAllowsStocktake(client, parsed.data.to_warehouse_id)
      const before = await loadLinenDeliveryRecordDetail(client, id)
      const reverted = await revertLinenDeliveryRecordStockByRefInTx(client, {
        record_id: id,
        actor_id: actor,
        note: String(current.record.note || ''),
      })
      assertStockTxnOk(reverted)
      const expandedLines = await expandLinenDeliveryInputLines(client, parsed.data.lines)
      const expandedExtraLines = await expandLinenDeliveryExtraInputLines(client, parsed.data.extra_linen_lines || [])
      await client.query(
        `UPDATE linen_delivery_records
         SET delivery_date = $1::date,
             from_warehouse_id = $2,
             to_warehouse_id = $3,
             note = $4,
             updated_at = now()
         WHERE id = $5`,
        [parsed.data.delivery_date, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null, id],
      )
      await client.query(`DELETE FROM linen_delivery_record_lines WHERE record_id = $1`, [id])
      await client.query(`DELETE FROM linen_delivery_record_extra_lines WHERE record_id = $1`, [id])
      for (const line of expandedLines) {
        await client.query(
          `INSERT INTO linen_delivery_record_lines (id, record_id, room_type_code, room_type_name, sets)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), id, line.room_type_code, line.room_type_name, line.sets],
        )
      }
      for (const line of expandedExtraLines) {
        await client.query(
          `INSERT INTO linen_delivery_record_extra_lines (id, record_id, linen_type_code, linen_type_name, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [uuidv4(), id, line.linen_type_code, line.linen_type_name, line.quantity],
        )
      }
      const applied = await applyLinenDeliveryBreakdownsInTx(client, {
        record_id: id,
        from_warehouse_id: parsed.data.from_warehouse_id,
        to_warehouse_id: parsed.data.to_warehouse_id,
        note: parsed.data.note || null,
        actor_id: actor,
        breakdowns: [
          ...expandedLines.map((line) => line.breakdown || []),
          ...expandedExtraLines.map((line) => line.breakdown || []),
        ],
        direction: 'apply',
      })
      assertStockTxnOk(applied)
      await upsertLinenStocktakeRecordInTx(client, {
        delivery_record_id: id,
        warehouse_id: parsed.data.to_warehouse_id,
        stocktake_date: parsed.data.delivery_date,
        dirty_bag_note: parsed.data.dirty_bag_note || null,
        note: parsed.data.note || null,
        actor_id: actor,
        lines: parsed.data.stocktake_lines,
      })
      const after = await loadLinenDeliveryRecordDetail(client, id)
      if (!after) throw httpError(500, '配送单更新后读取详情失败')
      return { ok: true as const, before, after }
    })
    if (!(result as any)?.ok) {
      return res.status(Number((result as any)?.code || 400)).json(withTracePayload(req, { message: String((result as any)?.message || 'failed') }))
    }
    try {
      addAudit('LinenDeliveryRecord', id, 'update', (result as any).before || null, (result as any).after || null, actor)
    } catch {}
    inventoryLog(req, 'log', 'delivery_update_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'success' })
    return res.json((result as any).after)
  } catch (e: any) {
    inventoryLog(req, 'error', 'delivery_update_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'failed', message: String(e?.message || 'failed') })
    return sendInventoryError(req, res, e)
  }
})

router.post('/linen/delivery-records/:id/cancel', requirePerm('inventory.move'), async (req, res) => {
  const id = String(req.params.id || '')
  const requestStartedAt = Date.now()
  try {
    if (!(hasPg && pgPool)) return res.status(501).json(withTracePayload(req, { message: 'not available without PG' }))
    await ensureInventorySchema()
    const actor = actorId(req)
    inventoryLog(req, 'log', 'delivery_cancel_start', { record_id: id })
    const result = await pgRunInTransaction(async (client) => {
      await client.query(`SET LOCAL lock_timeout = '5000ms'`)
      const current = await getEditableLinenDeliveryRecordForUpdate(client, id)
      if (!current) return { ok: false as const, code: 404 as const, message: 'not found' }
      if (String(current.record.status || '') === 'cancelled') return { ok: false as const, code: 400 as const, message: '该配送单已作废' }
      const before = loadLinenDeliveryRecordSummary(client, id)
      const reverted = await revertLinenDeliveryRecordStockByRefInTx(client, {
        record_id: id,
        actor_id: actor,
        note: String(current.record.note || ''),
      })
      assertStockTxnOk(reverted)
      await client.query(
        `UPDATE linen_delivery_records
         SET status = 'cancelled',
             updated_at = now(),
             cancelled_by = $2,
             cancelled_at = now()
         WHERE id = $1`,
        [id, actor],
      )
      const afterRes = await client.query(
        `SELECT id, delivery_date, status, created_at, updated_at, cancelled_by, cancelled_at
         FROM linen_delivery_records
         WHERE id = $1
         LIMIT 1`,
        [id],
      )
      const afterRow = afterRes.rows?.[0] || null
      if (!afterRow) throw httpError(500, '配送单作废后读取摘要失败')
      const [beforeSummary, afterSummary] = await Promise.all([
        before,
        Promise.resolve(buildDeliverySuccessResponse(afterRow, {
          cancelled_by: afterRow.cancelled_by || null,
          cancelled_at: afterRow.cancelled_at || null,
        })),
      ])
      return { ok: true as const, before: beforeSummary, after: afterSummary }
    })
    if (!(result as any)?.ok) {
      return res.status(Number((result as any)?.code || 400)).json(withTracePayload(req, { message: String((result as any)?.message || 'failed') }))
    }
    try {
      addAudit('LinenDeliveryRecord', id, 'cancel', (result as any).before || null, (result as any).after || null, actor)
    } catch {}
    inventoryLog(req, 'log', 'delivery_cancel_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'success' })
    return res.json((result as any).after)
  } catch (e: any) {
    inventoryLog(req, 'error', 'delivery_cancel_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'failed', message: String(e?.message || 'failed') })
    return sendInventoryError(req, res, e)
  }
})

const linenDeliveryPlanCreateSchema = z.object({
  plan_date: z.string().min(1),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  from_warehouse_id: z.string().min(1),
  vehicle_capacity_sets: z.number().int().min(1).optional(),
  note: z.string().optional(),
  lines: z.array(z.object({
    to_warehouse_id: z.string().min(1),
    room_type_code: z.string().min(1),
    current_sets: z.number().int().min(0),
    demand_sets: z.number().int().min(0),
    target_sets: z.number().int().min(0),
    suggested_sets: z.number().int().min(0),
    warehouse_capacity_sets: z.number().int().nullable().optional(),
    vehicle_load_sets: z.number().int().min(0).optional(),
    note: z.string().optional(),
  })).min(1),
})

router.get('/linen/delivery-plans', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const rows = await pgPool.query(
      `SELECT p.*, fw.code AS from_warehouse_code, fw.name AS from_warehouse_name,
              COUNT(l.id)::int AS line_count,
              COALESCE(SUM(l.actual_sets),0)::int AS actual_sets_total,
              COALESCE(SUM(l.suggested_sets),0)::int AS suggested_sets_total
       FROM linen_delivery_plans p
       JOIN warehouses fw ON fw.id = p.from_warehouse_id
       LEFT JOIN linen_delivery_plan_lines l ON l.plan_id = p.id
       GROUP BY p.id, fw.code, fw.name
       ORDER BY p.plan_date DESC, p.created_at DESC
       LIMIT 100`,
    )
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/linen/delivery-plans', requirePerm('inventory.move'), async (req, res) => {
  const parsed = linenDeliveryPlanCreateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const body = parsed.data
    const planId = uuidv4()
    const result = await pgRunInTransaction(async (client) => {
      const planRow = await client.query(
        `INSERT INTO linen_delivery_plans (id, plan_date, from_warehouse_id, date_from, date_to, vehicle_capacity_sets, status, note, created_by)
         VALUES ($1,$2::date,$3,NULLIF($4,'')::date,NULLIF($5,'')::date,$6,'planned',$7,$8)
         RETURNING *`,
        [planId, body.plan_date, body.from_warehouse_id, body.date_from || null, body.date_to || null, body.vehicle_capacity_sets ?? null, body.note || null, actorId(req)],
      )
      const lines: any[] = []
      for (const line of body.lines) {
        const row = await client.query(
          `INSERT INTO linen_delivery_plan_lines (id, plan_id, to_warehouse_id, room_type_code, current_sets, demand_sets, target_sets, suggested_sets, actual_sets, warehouse_capacity_sets, vehicle_load_sets, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11)
           RETURNING *`,
          [uuidv4(), planId, line.to_warehouse_id, line.room_type_code, line.current_sets, line.demand_sets, line.target_sets, line.suggested_sets, line.warehouse_capacity_sets ?? null, line.vehicle_load_sets ?? line.suggested_sets, line.note || null],
        )
        lines.push(row.rows?.[0] || null)
      }
      return { plan: planRow.rows?.[0] || null, lines }
    })
    return res.status(201).json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const linenReturnIntakeSchema = z.object({
  from_warehouse_id: z.string().min(1),
  quantity: z.number().int().min(1),
  item_id: z.string().min(1),
  note: z.string().optional(),
})

router.post('/linen/return-intakes', requirePerm('inventory.move'), async (req, res) => {
  const parsed = linenReturnIntakeSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const smWarehouse = await getSmWarehouse()
    const smWarehouseId = String(smWarehouse?.id || '')
    const intakeId = uuidv4()
    const result = await pgRunInTransaction(async (client) => {
      const out = await applyStockDeltaInTx(client, {
        warehouse_id: parsed.data.from_warehouse_id,
        item_id: parsed.data.item_id,
        type: 'out',
        quantity: parsed.data.quantity,
        reason: 'return_from_subwarehouse',
        ref_type: 'linen_return_intake',
        ref_id: intakeId,
        actor_id: actorId(req),
        note: parsed.data.note || null,
      })
      if (!out.ok) return out
      const inn = await applyStockDeltaInTx(client, {
        warehouse_id: smWarehouseId,
        item_id: parsed.data.item_id,
        type: 'in',
        quantity: parsed.data.quantity,
        reason: 'return_from_subwarehouse',
        ref_type: 'linen_return_intake',
        ref_id: intakeId,
        actor_id: actorId(req),
        note: parsed.data.note || null,
      })
      if (!inn.ok) return inn
      return { ok: true as const, intake_id: intakeId }
    })
    if (!(result as any)?.ok) return res.status((result as any).code).json({ message: (result as any).message })
    return res.status(201).json(result)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const supplierReturnBatchSchema = z.object({
  supplier_id: z.string().min(1),
  warehouse_id: z.string().optional(),
  returned_at: z.string().optional(),
  note: z.string().optional(),
  photo_urls: z.array(z.string().min(1)).optional(),
  lines: z.array(z.object({
    item_id: z.string().min(1),
    quantity: z.number().int().min(1),
    refund_unit_price: z.number().min(0).optional(),
    note: z.string().optional(),
  })).min(1),
})

function supplierReturnBatchError(info: { code: number; message: string }) {
  const err: any = new Error(info.message || 'failed')
  err.statusCode = info.code
  return err
}

router.get('/linen/supplier-return-batches', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const missingNoRows = await pgPool.query(`SELECT id, return_no, returned_at, created_at FROM linen_supplier_return_batches WHERE COALESCE(return_no, '') = '' ORDER BY created_at ASC LIMIT 200`)
    for (const row of missingNoRows.rows || []) await ensureSupplierReturnNo(pgPool, row)
    const rows = await pgPool.query(
      `SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
              COALESCE(t.quantity_total,0)::int AS quantity_total,
              COALESCE(t.amount_total,0) AS amount_total,
              COALESCE(x.lines, '[]'::json) AS lines,
              COALESCE(b.photo_urls, '[]'::jsonb) AS photo_urls
       FROM linen_supplier_return_batches b
       JOIN suppliers s ON s.id = b.supplier_id
       JOIN warehouses w ON w.id = b.warehouse_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(l.quantity),0)::int AS quantity_total,
                COALESCE(SUM(l.amount_total),0) AS amount_total
         FROM linen_supplier_return_batch_lines l
         WHERE l.batch_id = b.id
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object(
                    'id', l.id,
                    'item_id', l.item_id,
                    'item_name', i.name,
                    'item_sku', i.sku,
                    'quantity', l.quantity,
                    'refund_unit_price', l.refund_unit_price,
                    'amount_total', l.amount_total,
                    'note', l.note
                  )
                  ORDER BY i.name, i.sku, l.id
                ) AS lines
         FROM linen_supplier_return_batch_lines l
         JOIN inventory_items i ON i.id = l.item_id
         WHERE l.batch_id = b.id
       ) x ON true
       ORDER BY COALESCE(b.returned_at, b.created_at) DESC
      LIMIT 100`,
    )
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.post('/linen/supplier-return-batches', requirePerm('inventory.move'), async (req, res) => {
  const parsed = supplierReturnBatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const smWarehouse = await getSmWarehouse()
    const warehouseId = String(parsed.data.warehouse_id || smWarehouse?.id || '').trim()
    const batchId = uuidv4()
    const result = await pgRunInTransaction(async (client) => {
      const priceMap = await getLatestSupplierItemPrice(client, parsed.data.supplier_id)
      const batchRow = await client.query(
        `INSERT INTO linen_supplier_return_batches (id, supplier_id, warehouse_id, status, returned_at, note, photo_urls, created_by)
         VALUES ($1,$2,$3,'returned',$4,$5,$6::jsonb,$7)
         RETURNING *`,
        [
          batchId,
          parsed.data.supplier_id,
          warehouseId,
          parsed.data.returned_at || new Date().toISOString(),
          parsed.data.note || null,
          JSON.stringify(Array.isArray(parsed.data.photo_urls) ? parsed.data.photo_urls.filter(Boolean) : []),
          actorId(req),
        ],
      )
      await ensureSupplierReturnNo(client, batchRow.rows?.[0] || { id: batchId, returned_at: parsed.data.returned_at || new Date().toISOString() })
      const lines: any[] = []
      let expectedAmount = 0
      for (const line of parsed.data.lines) {
        const priceRow = priceMap.get(String(line.item_id))
        const refundUnitPrice = line.refund_unit_price ?? (priceRow ? Number(priceRow.refund_unit_price || 0) : 0)
        const amountTotal = Number(refundUnitPrice || 0) * Number(line.quantity || 0)
        const row = await client.query(
          `INSERT INTO linen_supplier_return_batch_lines (id, batch_id, item_id, quantity, refund_unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [uuidv4(), batchId, line.item_id, line.quantity, refundUnitPrice, amountTotal, line.note || null],
        )
        lines.push(row.rows?.[0] || null)
        expectedAmount += amountTotal
        const applied = await applyStockDeltaInTx(client, {
          warehouse_id: warehouseId,
          item_id: line.item_id,
          type: 'out',
          quantity: line.quantity,
          reason: 'return_to_supplier',
          actor_id: actorId(req),
          note: parsed.data.note || null,
          ref_type: 'linen_supplier_return_batch',
          ref_id: batchId,
        })
        if (!applied.ok) throw supplierReturnBatchError({ code: applied.code, message: applied.message })
      }
      const refundRow = await client.query(
        `INSERT INTO linen_supplier_refunds (id, batch_id, supplier_id, warehouse_id, expected_amount, received_amount, variance_amount, status, note, updated_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'pending',$7,now())
         RETURNING *`,
        [uuidv4(), batchId, parsed.data.supplier_id, warehouseId, expectedAmount, 0 - expectedAmount, parsed.data.note || null],
      )
      await client.query(`UPDATE linen_supplier_return_batches SET updated_at = now() WHERE id = $1`, [batchId])
      const batchFinal = await client.query(`SELECT * FROM linen_supplier_return_batches WHERE id = $1`, [batchId])
      return { ok: true as const, batch: batchFinal.rows?.[0] || batchRow.rows?.[0] || null, lines, refund: refundRow.rows?.[0] || null }
    })
    if (!(result as any)?.ok) return res.status((result as any).code).json({ message: (result as any).message })
    return res.status(201).json(result)
  } catch (e: any) {
    if (Number(e?.statusCode || 0) > 0) return res.status(Number(e.statusCode)).json({ message: e?.message || 'failed' })
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/supplier-return-batches/:id', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    const row = await pgPool.query(
      `SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
              COALESCE(t.quantity_total,0)::int AS quantity_total,
              COALESCE(t.amount_total,0) AS amount_total,
              COALESCE(x.lines, '[]'::json) AS lines,
              COALESCE(b.photo_urls, '[]'::jsonb) AS photo_urls
       FROM linen_supplier_return_batches b
       JOIN suppliers s ON s.id = b.supplier_id
       JOIN warehouses w ON w.id = b.warehouse_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(l.quantity),0)::int AS quantity_total,
                COALESCE(SUM(l.amount_total),0) AS amount_total
         FROM linen_supplier_return_batch_lines l
         WHERE l.batch_id = b.id
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object(
                    'id', l.id,
                    'item_id', l.item_id,
                    'item_name', i.name,
                    'item_sku', i.sku,
                    'quantity', l.quantity,
                    'refund_unit_price', l.refund_unit_price,
                    'amount_total', l.amount_total,
                    'note', l.note
                  )
                  ORDER BY i.name, i.sku, l.id
                ) AS lines
         FROM linen_supplier_return_batch_lines l
         JOIN inventory_items i ON i.id = l.item_id
         WHERE l.batch_id = b.id
       ) x ON true
       WHERE b.id = $1
       LIMIT 1`,
      [id],
    )
    if (!row.rows?.[0]) return res.status(404).json({ message: 'not found' })
    if (!String(row.rows[0].return_no || '').trim()) row.rows[0].return_no = await ensureSupplierReturnNo(pgPool, row.rows[0])
    return res.json(row.rows[0])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.patch('/linen/supplier-return-batches/:id', requirePerm('inventory.move'), async (req, res) => {
  const parsed = supplierReturnBatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    const result = await pgRunInTransaction(async (client) => {
      const existing = await client.query(`SELECT * FROM linen_supplier_return_batches WHERE id = $1 LIMIT 1`, [id])
      const batch = existing.rows?.[0]
      if (!batch) throw supplierReturnBatchError({ code: 404, message: 'not found' })
      const existingLinesRes = await client.query(`SELECT * FROM linen_supplier_return_batch_lines WHERE batch_id = $1`, [id])
      const existingLines = existingLinesRes.rows || []

      for (const line of existingLines) {
        const reversed = await applyStockDeltaInTx(client, {
          warehouse_id: String(batch.warehouse_id || ''),
          item_id: String(line.item_id || ''),
          type: 'in',
          quantity: Number(line.quantity || 0),
          reason: 'return_to_supplier_reversal',
          actor_id: actorId(req),
          note: 'edit linen supplier return batch',
          ref_type: 'linen_supplier_return_batch',
          ref_id: id,
        })
        if (!reversed.ok) throw supplierReturnBatchError({ code: reversed.code, message: reversed.message })
      }

      await client.query(`DELETE FROM linen_supplier_refunds WHERE batch_id = $1`, [id])
      await client.query(`DELETE FROM linen_supplier_return_batch_lines WHERE batch_id = $1`, [id])

      const priceMap = await getLatestSupplierItemPrice(client, parsed.data.supplier_id)
      const nextWarehouseId = String(parsed.data.warehouse_id || batch.warehouse_id || '').trim()
      const nextPhotoUrls = JSON.stringify(Array.isArray(parsed.data.photo_urls) ? parsed.data.photo_urls.filter(Boolean) : [])
      await client.query(
        `UPDATE linen_supplier_return_batches
         SET supplier_id = $2,
             warehouse_id = $3,
             returned_at = $4,
             note = $5,
             photo_urls = $6::jsonb,
             updated_at = now()
         WHERE id = $1`,
        [id, parsed.data.supplier_id, nextWarehouseId, parsed.data.returned_at || batch.returned_at || new Date().toISOString(), parsed.data.note || null, nextPhotoUrls],
      )
      await ensureSupplierReturnNo(client, { id, return_no: batch.return_no, returned_at: parsed.data.returned_at || batch.returned_at || new Date().toISOString(), created_at: batch.created_at })

      const lines: any[] = []
      let expectedAmount = 0
      for (const line of parsed.data.lines) {
        const priceRow = priceMap.get(String(line.item_id))
        const refundUnitPrice = line.refund_unit_price ?? (priceRow ? Number(priceRow.refund_unit_price || 0) : 0)
        const amountTotal = Number(refundUnitPrice || 0) * Number(line.quantity || 0)
        const row = await client.query(
          `INSERT INTO linen_supplier_return_batch_lines (id, batch_id, item_id, quantity, refund_unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [uuidv4(), id, line.item_id, line.quantity, refundUnitPrice, amountTotal, line.note || null],
        )
        lines.push(row.rows?.[0] || null)
        expectedAmount += amountTotal
        const applied = await applyStockDeltaInTx(client, {
          warehouse_id: nextWarehouseId,
          item_id: line.item_id,
          type: 'out',
          quantity: line.quantity,
          reason: 'return_to_supplier',
          actor_id: actorId(req),
          note: parsed.data.note || null,
          ref_type: 'linen_supplier_return_batch',
          ref_id: id,
        })
        if (!applied.ok) throw supplierReturnBatchError({ code: applied.code, message: applied.message })
      }

      const refundRow = await client.query(
        `INSERT INTO linen_supplier_refunds (id, batch_id, supplier_id, warehouse_id, expected_amount, received_amount, variance_amount, status, note, updated_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'pending',$7,now())
         RETURNING *`,
        [uuidv4(), id, parsed.data.supplier_id, nextWarehouseId, expectedAmount, 0 - expectedAmount, parsed.data.note || null],
      )

      const detail = await client.query(
        `SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
                COALESCE(t.quantity_total,0)::int AS quantity_total,
                COALESCE(t.amount_total,0) AS amount_total,
                COALESCE(x.lines, '[]'::json) AS lines,
                COALESCE(b.photo_urls, '[]'::jsonb) AS photo_urls
         FROM linen_supplier_return_batches b
         JOIN suppliers s ON s.id = b.supplier_id
         JOIN warehouses w ON w.id = b.warehouse_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(l.quantity),0)::int AS quantity_total,
                  COALESCE(SUM(l.amount_total),0) AS amount_total
           FROM linen_supplier_return_batch_lines l
           WHERE l.batch_id = b.id
         ) t ON true
         LEFT JOIN LATERAL (
           SELECT json_agg(
                    json_build_object(
                      'id', l.id,
                      'item_id', l.item_id,
                      'item_name', i.name,
                      'item_sku', i.sku,
                      'quantity', l.quantity,
                      'refund_unit_price', l.refund_unit_price,
                      'amount_total', l.amount_total,
                      'note', l.note
                    )
                    ORDER BY i.name, i.sku, l.id
                  ) AS lines
           FROM linen_supplier_return_batch_lines l
           JOIN inventory_items i ON i.id = l.item_id
           WHERE l.batch_id = b.id
         ) x ON true
         WHERE b.id = $1
         LIMIT 1`,
        [id],
      )
      if (detail.rows?.[0] && !String(detail.rows[0].return_no || '').trim()) detail.rows[0].return_no = await ensureSupplierReturnNo(client, detail.rows[0])

      return { ok: true as const, batch: detail.rows?.[0] || null, lines, refund: refundRow.rows?.[0] || null }
    })
    return res.json(result)
  } catch (e: any) {
    if (Number(e?.statusCode || 0) > 0) return res.status(Number(e.statusCode)).json({ message: e?.message || 'failed' })
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.delete('/linen/supplier-return-batches/:id', requirePerm('inventory.move'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '').trim()
    if (!id) return res.status(400).json({ message: 'missing id' })
    await pgRunInTransaction(async (client) => {
      const existing = await client.query(`SELECT * FROM linen_supplier_return_batches WHERE id = $1 LIMIT 1`, [id])
      const batch = existing.rows?.[0]
      if (!batch) throw supplierReturnBatchError({ code: 404, message: 'not found' })
      const existingLinesRes = await client.query(`SELECT * FROM linen_supplier_return_batch_lines WHERE batch_id = $1`, [id])
      for (const line of existingLinesRes.rows || []) {
        const reversed = await applyStockDeltaInTx(client, {
          warehouse_id: String(batch.warehouse_id || ''),
          item_id: String(line.item_id || ''),
          type: 'in',
          quantity: Number(line.quantity || 0),
          reason: 'return_to_supplier_reversal',
          actor_id: actorId(req),
          note: 'delete linen supplier return batch',
          ref_type: 'linen_supplier_return_batch_delete',
          ref_id: id,
        })
        if (!reversed.ok) throw supplierReturnBatchError({ code: reversed.code, message: reversed.message })
      }
      await client.query(`DELETE FROM linen_supplier_return_batches WHERE id = $1`, [id])
      return { ok: true as const }
    })
    return res.json({ ok: true })
  } catch (e: any) {
    if (Number(e?.statusCode || 0) > 0) return res.status(Number(e.statusCode)).json({ message: e?.message || 'failed' })
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

router.get('/linen/supplier-refunds', requirePerm('inventory.view'), async (req, res) => {
  try {
    if (!(hasPg && pgPool)) return res.json([])
    await ensureInventorySchema()
    const rows = await pgPool.query(
      `SELECT r.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name
       FROM linen_supplier_refunds r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN warehouses w ON w.id = r.warehouse_id
       ORDER BY r.created_at DESC
       LIMIT 100`,
    )
    return res.json(rows.rows || [])
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})

const supplierRefundPatchSchema = z.object({
  received_amount: z.number().min(0).optional(),
  status: z.enum(['pending', 'partial', 'settled', 'disputed']).optional(),
  received_at: z.string().optional(),
  note: z.string().optional(),
})

router.patch('/linen/supplier-refunds/:id', requirePerm('inventory.po.manage'), async (req, res) => {
  const parsed = supplierRefundPatchSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json(parsed.error.format())
  try {
    if (!(hasPg && pgPool)) return res.status(501).json({ message: 'not available without PG' })
    await ensureInventorySchema()
    const id = String(req.params.id || '')
    const before = await pgPool.query(`SELECT * FROM linen_supplier_refunds WHERE id = $1`, [id])
    const row = before.rows?.[0]
    if (!row) return res.status(404).json({ message: 'not found' })
    const nextReceivedAmount = parsed.data.received_amount ?? Number(row.received_amount || 0)
    const expectedAmount = Number(row.expected_amount || 0)
    let nextStatus = parsed.data.status
    if (!nextStatus) {
      if (nextReceivedAmount <= 0) nextStatus = 'pending'
      else if (Math.abs(nextReceivedAmount - expectedAmount) < 0.0001) nextStatus = 'settled'
      else if (nextReceivedAmount < expectedAmount) nextStatus = 'partial'
      else nextStatus = 'disputed'
    }
    const updated = await pgPool.query(
      `UPDATE linen_supplier_refunds
       SET received_amount = $1,
           variance_amount = $1 - expected_amount,
           status = $2,
           received_at = COALESCE(NULLIF($3,'')::timestamptz, received_at),
           note = COALESCE($4, note),
           updated_at = now()
       WHERE id = $5
       RETURNING *`,
      [nextReceivedAmount, nextStatus, parsed.data.received_at || null, parsed.data.note || null, id],
    )
    return res.json(updated.rows?.[0] || null)
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || 'failed' })
  }
})
