"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
exports.warmupInventoryModule = warmupInventoryModule;
exports.recordCleaningTaskStandardLinenUsage = recordCleaningTaskStandardLinenUsage;
exports.syncDayEndRejectLinenUsage = syncDayEndRejectLinenUsage;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const dbAdapter_1 = require("../dbAdapter");
const uuid_1 = require("uuid");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const uploadImageResize_1 = require("../lib/uploadImageResize");
const r2_1 = require("../r2");
exports.router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
function actorId(req) {
    const u = (req === null || req === void 0 ? void 0 : req.user) || {};
    return (u === null || u === void 0 ? void 0 : u.sub) || (u === null || u === void 0 ? void 0 : u.username) || null;
}
function httpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}
function remapInventoryPgError(error) {
    const code = String((error === null || error === void 0 ? void 0 : error.code) || '');
    if (code === '55P03' || code === '57014')
        return httpError(409, '库存正在被其他操作占用，请稍后重试');
    return error;
}
function requestTraceId(req) {
    var _a, _b;
    return String((req === null || req === void 0 ? void 0 : req.traceId) || ((_a = req === null || req === void 0 ? void 0 : req.headers) === null || _a === void 0 ? void 0 : _a['x-trace-id']) || ((_b = req === null || req === void 0 ? void 0 : req.headers) === null || _b === void 0 ? void 0 : _b['x-request-id']) || '').trim();
}
function withTracePayload(req, payload) {
    const traceId = requestTraceId(req);
    return traceId ? { ...payload, trace_id: traceId } : payload;
}
function inventoryLog(req, level, event, payload) {
    const traceId = requestTraceId(req);
    const body = {
        trace_id: traceId || undefined,
        event,
        ...(payload || {}),
    };
    try {
        console[level](`[inventory] ${JSON.stringify(body)}`);
    }
    catch (_a) {
        console[level](`[inventory] event=${event} trace_id=${traceId}`);
    }
}
function sendInventoryError(req, res, error) {
    const remapped = remapInventoryPgError(error);
    const statusCode = Number((remapped === null || remapped === void 0 ? void 0 : remapped.statusCode) || (remapped === null || remapped === void 0 ? void 0 : remapped.status) || 500);
    const code = Number.isFinite(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
    const message = String((remapped === null || remapped === void 0 ? void 0 : remapped.message) || 'failed');
    inventoryLog(req, code >= 500 ? 'error' : 'warn', 'request_failed', { status: code, message });
    return res.status(code).json(withTracePayload(req, { message }));
}
function randomSuffix(len) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < len; i++)
        s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}
function isSmWarehouseRow(row) {
    const id = String((row === null || row === void 0 ? void 0 : row.id) || '').trim().toLowerCase();
    const code = String((row === null || row === void 0 ? void 0 : row.code) || '').trim().toLowerCase();
    const name = String((row === null || row === void 0 ? void 0 : row.name) || '').trim().toLowerCase();
    return id === 'wh.south_melbourne' || code === 'sou' || name.includes('south melbourne');
}
function toDayStartIsoMelbourne(daysFromToday = 0) {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const mel = new Date(utc + 10 * 60 * 60000);
    mel.setHours(0, 0, 0, 0);
    mel.setDate(mel.getDate() + Number(daysFromToday || 0));
    return mel.toISOString();
}
function buildDailyItemSku(id) {
    const raw = String(id || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase();
    return `DY-${(raw || 'ITEM').slice(0, 8)}`;
}
function toDailyInventoryItemId(priceId) {
    return `item.daily_price.${String(priceId || '').trim()}`;
}
function buildConsumableItemSku(id) {
    const raw = String(id || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase();
    return `CO-${(raw || 'ITEM').slice(0, 8)}`;
}
function toConsumableInventoryItemId(priceId) {
    return `item.consumable_price.${String(priceId || '').trim()}`;
}
function buildOtherItemSku(id) {
    const raw = String(id || '').replace(/[^a-zA-Z0-9]+/g, '').toUpperCase();
    return `OT-${(raw || 'ITEM').slice(0, 8)}`;
}
function toOtherInventoryItemId(priceId) {
    return `item.other_price.${String(priceId || '').trim()}`;
}
async function ensureDailyPriceListSchema(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
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
  );`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_items_price ON daily_items_price_list(category, item_name);');
    await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS sku text;');
    await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS cost_unit_price numeric NOT NULL DEFAULT 0;');
    await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS unit text;');
    await client.query('ALTER TABLE daily_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;');
}
async function backfillDailyPriceSkus(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    const rows = await client.query(`SELECT id FROM daily_items_price_list WHERE COALESCE(NULLIF(TRIM(sku), ''), '') = ''`);
    for (const row of rows.rows || []) {
        const id = String((row === null || row === void 0 ? void 0 : row.id) || '');
        if (!id)
            continue;
        await client.query(`UPDATE daily_items_price_list SET sku = $1 WHERE id = $2`, [buildDailyItemSku(id), id]);
    }
}
async function syncDailyInventoryItemFromPriceRow(row, executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureInventorySchema();
    const priceId = String((row === null || row === void 0 ? void 0 : row.id) || '').trim();
    if (!priceId)
        return;
    const sku = String((row === null || row === void 0 ? void 0 : row.sku) || '').trim() || buildDailyItemSku(priceId);
    await client.query(`INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item, updated_at)
     VALUES ($1,$2,$3,'daily','daily_price',NULL,$4,0,NULL,$5,false,now())
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         sub_type = EXCLUDED.sub_type,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         updated_at = now()`, [toDailyInventoryItemId(priceId), String((row === null || row === void 0 ? void 0 : row.item_name) || '').trim(), sku, String((row === null || row === void 0 ? void 0 : row.unit) || '').trim() || 'pcs', (row === null || row === void 0 ? void 0 : row.is_active) !== false]);
}
async function syncAllDailyInventoryItems(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureDailyPriceListSchema(client);
    await backfillDailyPriceSkus(client);
    const rows = await client.query(`SELECT * FROM daily_items_price_list`);
    for (const row of rows.rows || [])
        await syncDailyInventoryItemFromPriceRow(row, client);
}
async function ensureConsumableChecklistSeed(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
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
  );`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cleaning_checklist_active_sort ON cleaning_checklist_items (active, sort_order, created_at);`);
    await client.query(`INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order)
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
     ON CONFLICT (id) DO NOTHING`);
}
async function ensureOtherPriceListSchema(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
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
  );`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_other_items_price_name ON other_items_price_list(item_name);');
    await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS sku text;');
    await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS cost_unit_price numeric NOT NULL DEFAULT 0;');
    await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS unit_price numeric NOT NULL DEFAULT 0;');
    await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS unit text;');
    await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;');
    await client.query('ALTER TABLE other_items_price_list ADD COLUMN IF NOT EXISTS sort_order integer;');
}
async function backfillOtherSkus(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    const rows = await client.query(`SELECT id FROM other_items_price_list WHERE COALESCE(NULLIF(TRIM(sku), ''), '') = ''`);
    for (const row of rows.rows || []) {
        const id = String((row === null || row === void 0 ? void 0 : row.id) || '');
        if (!id)
            continue;
        await client.query(`UPDATE other_items_price_list SET sku = $1 WHERE id = $2`, [buildOtherItemSku(id), id]);
    }
}
async function syncOtherInventoryItemFromPriceRow(row, executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureInventorySchema();
    const priceId = String((row === null || row === void 0 ? void 0 : row.id) || '').trim();
    if (!priceId)
        return;
    const sku = String((row === null || row === void 0 ? void 0 : row.sku) || '').trim() || buildOtherItemSku(priceId);
    await client.query(`INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item, updated_at)
     VALUES ($1,$2,$3,'other','other_price',NULL,$4,0,NULL,$5,false,now())
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         sub_type = EXCLUDED.sub_type,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         updated_at = now()`, [toOtherInventoryItemId(priceId), String((row === null || row === void 0 ? void 0 : row.item_name) || '').trim(), sku, String((row === null || row === void 0 ? void 0 : row.unit) || '').trim() || 'pcs', (row === null || row === void 0 ? void 0 : row.is_active) !== false]);
}
async function syncAllOtherInventoryItems(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureOtherPriceListSchema(client);
    await backfillOtherSkus(client);
    const rows = await client.query(`SELECT * FROM other_items_price_list`);
    for (const row of rows.rows || [])
        await syncOtherInventoryItemFromPriceRow(row, client);
}
async function ensureConsumablePriceListSchema(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureConsumableChecklistSeed(client);
    const tableExists = await client.query(`SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'consumable_items_price_list'
      LIMIT 1`);
    if (!tableExists.rowCount) {
        const orphanType = await client.query(`SELECT 1
         FROM pg_type
        WHERE typname = 'consumable_items_price_list'
        LIMIT 1`);
        if (orphanType.rowCount) {
            await client.query(`DROP TYPE IF EXISTS consumable_items_price_list`);
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
    );`);
    }
    await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS sku text;');
    await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS cost_unit_price numeric NOT NULL DEFAULT 0;');
    await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS unit_price numeric NOT NULL DEFAULT 0;');
    await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS unit text;');
    await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS default_quantity integer;');
    await client.query('ALTER TABLE consumable_items_price_list ADD COLUMN IF NOT EXISTS sort_order integer;');
}
async function backfillConsumableSkus(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    const rows = await client.query(`SELECT id FROM consumable_items_price_list WHERE COALESCE(NULLIF(TRIM(sku), ''), '') = ''`);
    for (const row of rows.rows || []) {
        const id = String((row === null || row === void 0 ? void 0 : row.id) || '');
        if (!id)
            continue;
        await client.query(`UPDATE consumable_items_price_list SET sku = $1 WHERE id = $2`, [buildConsumableItemSku(id), id]);
    }
}
async function syncConsumablePriceListFromChecklist(executor) {
    var _a;
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureConsumablePriceListSchema(client);
    const checklistRows = await client.query(`SELECT id, label, active, sort_order
     FROM cleaning_checklist_items
     WHERE kind = 'consumable' AND id NOT IN ('spare_pillowcase', 'other')
     ORDER BY sort_order ASC NULLS LAST, label ASC`);
    for (const row of checklistRows.rows || []) {
        const id = String((row === null || row === void 0 ? void 0 : row.id) || '').trim();
        if (!id)
            continue;
        await client.query(`INSERT INTO consumable_items_price_list (id, item_name, sku, cost_unit_price, unit_price, currency, unit, default_quantity, sort_order, is_active)
       VALUES ($1,$2,$3,0,0,'AUD','pcs',1,$4,$5)
       ON CONFLICT (id) DO UPDATE
       SET item_name = EXCLUDED.item_name,
           sort_order = EXCLUDED.sort_order,
           is_active = EXCLUDED.is_active`, [id, String((row === null || row === void 0 ? void 0 : row.label) || '').trim(), buildConsumableItemSku(id), (_a = row === null || row === void 0 ? void 0 : row.sort_order) !== null && _a !== void 0 ? _a : null, (row === null || row === void 0 ? void 0 : row.active) !== false]);
    }
    await client.query(`DELETE FROM consumable_items_price_list WHERE id IN ('spare_pillowcase', 'other')`);
    await backfillConsumableSkus(client);
}
async function syncConsumableInventoryItemFromPriceRow(row, executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await ensureInventorySchema();
    const priceId = String((row === null || row === void 0 ? void 0 : row.id) || '').trim();
    if (!priceId)
        return;
    const sku = String((row === null || row === void 0 ? void 0 : row.sku) || '').trim() || buildConsumableItemSku(priceId);
    await client.query(`INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item, updated_at)
     VALUES ($1,$2,$3,'consumable','consumable_price',NULL,$4,0,NULL,$5,false,now())
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         sku = EXCLUDED.sku,
         category = EXCLUDED.category,
         sub_type = EXCLUDED.sub_type,
         unit = EXCLUDED.unit,
         active = EXCLUDED.active,
         updated_at = now()`, [toConsumableInventoryItemId(priceId), String((row === null || row === void 0 ? void 0 : row.item_name) || '').trim(), sku, String((row === null || row === void 0 ? void 0 : row.unit) || '').trim() || 'pcs', (row === null || row === void 0 ? void 0 : row.is_active) !== false]);
}
async function syncAllConsumableInventoryItems(executor) {
    const client = executor || dbAdapter_1.pgPool;
    if (!client)
        return;
    await syncConsumablePriceListFromChecklist(client);
    const rows = await client.query(`SELECT * FROM consumable_items_price_list`);
    for (const row of rows.rows || [])
        await syncConsumableInventoryItemFromPriceRow(row, client);
}
let inventorySchemaEnsured = false;
let inventorySchemaEnsurePromise = null;
let dailyInventorySyncEnsured = false;
let consumableInventorySyncEnsured = false;
let consumablePriceListSeedEnsured = false;
let otherInventorySyncEnsured = false;
let inventoryWarehousesFirstRequestLogged = false;
async function ensureDailyInventoryItemsSynced() {
    if (dailyInventorySyncEnsured)
        return;
    if (!dbAdapter_1.pgPool)
        return;
    dailyInventorySyncEnsured = true;
    try {
        await syncAllDailyInventoryItems();
    }
    catch (e) {
        dailyInventorySyncEnsured = false;
        throw e;
    }
}
async function ensureConsumableInventoryItemsSynced() {
    if (consumableInventorySyncEnsured)
        return;
    if (!dbAdapter_1.pgPool)
        return;
    consumableInventorySyncEnsured = true;
    try {
        await syncAllConsumableInventoryItems();
    }
    catch (e) {
        consumableInventorySyncEnsured = false;
        throw e;
    }
}
async function ensureConsumablePriceListSeeded() {
    if (consumablePriceListSeedEnsured)
        return;
    if (!dbAdapter_1.pgPool)
        return;
    consumablePriceListSeedEnsured = true;
    try {
        await syncConsumablePriceListFromChecklist();
    }
    catch (e) {
        consumablePriceListSeedEnsured = false;
        throw e;
    }
}
async function ensureOtherInventoryItemsSynced() {
    if (otherInventorySyncEnsured)
        return;
    if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
        return;
    otherInventorySyncEnsured = true;
    try {
        await syncAllOtherInventoryItems();
    }
    catch (error) {
        otherInventorySyncEnsured = false;
        throw error;
    }
}
async function ensureInventorySchema() {
    if (!dbAdapter_1.pgPool)
        return;
    if (inventorySchemaEnsured)
        return;
    if (inventorySchemaEnsurePromise) {
        await inventorySchemaEnsurePromise;
        return;
    }
    inventorySchemaEnsurePromise = (async () => {
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS warehouses (
      id text PRIMARY KEY,
      code text NOT NULL,
      name text NOT NULL,
      linen_capacity_sets integer,
      stocktake_enabled boolean NOT NULL DEFAULT true,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS stocktake_enabled boolean NOT NULL DEFAULT true;');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouses_code') THEN
        ALTER TABLE warehouses ADD CONSTRAINT unique_warehouses_code UNIQUE (code);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_items (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_items_sku') THEN
        ALTER TABLE inventory_items ADD CONSTRAINT unique_inventory_items_sku UNIQUE (sku);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items(category);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_active ON inventory_items(active);');
        await dbAdapter_1.pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sub_type text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS linen_type_code text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_category_sub_type ON inventory_items(category, sub_type);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_items_linen_type ON inventory_items(linen_type_code);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_linen_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      psl_code text,
      in_set boolean NOT NULL DEFAULT true,
      set_divisor integer NOT NULL DEFAULT 1,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('ALTER TABLE inventory_linen_types ADD COLUMN IF NOT EXISTS psl_code text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_types_active_sort ON inventory_linen_types(active, sort_order, code);');
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_linen_types (code, name, in_set, set_divisor, sort_order, active) VALUES
      ('bedsheet','床单',true,1,10,true),
      ('duvet_cover','被套',true,1,20,true),
      ('pillowcase','枕套',true,2,30,true),
      ('hand_towel','手巾',true,1,35,true),
      ('bath_mat','地巾',true,1,36,true),
      ('tea_towel','茶巾',true,1,37,true),
      ('bath_towel','浴巾',true,1,40,true)
    ON CONFLICT (code) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
      VALUES
        ('item.linen_type.bedsheet','床单','LT:bedsheet','linen','bedsheet','pcs',0,NULL,true,false),
        ('item.linen_type.duvet_cover','被套','LT:duvet_cover','linen','duvet_cover','pcs',0,NULL,true,false),
        ('item.linen_type.pillowcase','枕套','LT:pillowcase','linen','pillowcase','pcs',0,NULL,true,false),
        ('item.linen_type.hand_towel','手巾','LT:hand_towel','linen','hand_towel','pcs',0,NULL,true,false),
        ('item.linen_type.bath_mat','地巾','LT:bath_mat','linen','bath_mat','pcs',0,NULL,true,false),
        ('item.linen_type.tea_towel','茶巾','LT:tea_towel','linen','tea_towel','pcs',0,NULL,true,false),
        ('item.linen_type.bath_towel','浴巾','LT:bath_towel','linen','bath_towel','pcs',0,NULL,true,false)
      ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`
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
    `);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_types (
      code text PRIMARY KEY,
      name text NOT NULL,
      bedrooms integer,
      bathrooms integer,
      sort_order integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_types_active_sort ON inventory_room_types(active, sort_order, code);');
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active) VALUES
      ('1b1b','一房一卫',1,1,10,true),
      ('2b1b','两房一卫',2,1,20,true),
      ('2b2b','两房两卫',2,2,30,true),
      ('3b2b','三房两卫',3,2,40,true),
      ('3b3b','三房三卫',3,3,50,true)
    ON CONFLICT (code) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_room_type_requirements (
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE CASCADE,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      PRIMARY KEY (room_type_code, linen_type_code)
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_room_type_req_room ON inventory_room_type_requirements(room_type_code);');
        await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS linen_service_warehouse_id text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_properties_room_type_code ON properties(room_type_code);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS warehouse_stocks (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      quantity integer NOT NULL DEFAULT 0,
      threshold integer,
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_warehouse_item') THEN
        ALTER TABLE warehouse_stocks ADD CONSTRAINT unique_warehouse_item UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_wh ON warehouse_stocks(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_warehouse_stocks_item ON warehouse_stocks(item_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stock_policies (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      reserve_qty integer NOT NULL DEFAULT 0,
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_inventory_stock_policy') THEN
        ALTER TABLE inventory_stock_policies ADD CONSTRAINT unique_inventory_stock_policy UNIQUE (warehouse_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_wh ON inventory_stock_policies(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stock_policies_item ON inventory_stock_policies(item_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS suppliers (
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
    );`);
        await dbAdapter_1.pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS supply_items_note text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_url text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_username text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_password text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS login_note text;');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(active);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS supplier_item_prices (
      id text PRIMARY KEY,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      purchase_unit_price numeric NOT NULL DEFAULT 0,
      refund_unit_price numeric NOT NULL DEFAULT 0,
      effective_from date,
      active boolean NOT NULL DEFAULT true,
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_supplier_item_price') THEN
        ALTER TABLE supplier_item_prices ADD CONSTRAINT unique_supplier_item_price UNIQUE (supplier_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_supplier ON supplier_item_prices(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_supplier_item_prices_item ON supplier_item_prices(item_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS region_supplier_rules (
      id text PRIMARY KEY,
      region_key text NOT NULL,
      supplier_id text NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
      priority integer NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_region ON region_supplier_rules(region_key);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_region_supplier_rules_active ON region_supplier_rules(active);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
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
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at ON purchase_orders(created_at);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_region ON purchase_orders(region);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_property ON purchase_orders(property_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_orders_ordered_date ON purchase_orders(ordered_date);');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_no text;');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS subtotal_amount numeric NOT NULL DEFAULT 0;');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS gst_amount numeric NOT NULL DEFAULT 0;');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS total_amount_inc_gst numeric NOT NULL DEFAULT 0;');
        await dbAdapter_1.pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_po_no_unique ON purchase_orders(po_no) WHERE po_no IS NOT NULL;');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      unit text NOT NULL,
      unit_price numeric,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines(po_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_item ON purchase_order_lines(item_id);');
        await dbAdapter_1.pgPool.query('ALTER TABLE purchase_order_lines ADD COLUMN IF NOT EXISTS amount_total numeric;');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_deliveries (
      id text PRIMARY KEY,
      po_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      received_at timestamptz NOT NULL DEFAULT now(),
      received_by text,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_po ON purchase_deliveries(po_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_deliveries_received_at ON purchase_deliveries(received_at);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS purchase_delivery_lines (
      id text PRIMARY KEY,
      delivery_id text NOT NULL REFERENCES purchase_deliveries(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity_received integer NOT NULL,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_purchase_delivery_lines_delivery ON purchase_delivery_lines(delivery_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS stock_movements (
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
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_wh ON stock_movements(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements(item_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_property ON stock_movements(property_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_created_at ON stock_movements(created_at);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_type_check') THEN
        ALTER TABLE stock_movements
          ADD CONSTRAINT stock_movements_type_check
          CHECK (type IN ('in','out','adjust'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_linen_usage_records (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_linen_usage_records_usage_key_unique') THEN
        ALTER TABLE inventory_linen_usage_records
          ADD CONSTRAINT inventory_linen_usage_records_usage_key_unique
          UNIQUE (usage_key);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_date ON inventory_linen_usage_records(usage_date DESC, created_at DESC);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_source ON inventory_linen_usage_records(source_type, source_ref);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_property ON inventory_linen_usage_records(property_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_wh ON inventory_linen_usage_records(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_linen_usage_records_linen_type ON inventory_linen_usage_records(linen_type_code);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_transfer_records (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfer_records_status_check') THEN
        ALTER TABLE inventory_transfer_records
          ADD CONSTRAINT inventory_transfer_records_status_check
          CHECK (status IN ('completed','cancelled'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_created_at ON inventory_transfer_records(created_at DESC);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_from_wh ON inventory_transfer_records(from_warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_to_wh ON inventory_transfer_records(to_warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_records_status ON inventory_transfer_records(status);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_transfer_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES inventory_transfer_records(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL DEFAULT 0
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_transfer_record_lines_record ON inventory_transfer_record_lines(record_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_transfer_record_lines_unique_item') THEN
        ALTER TABLE inventory_transfer_record_lines
          ADD CONSTRAINT inventory_transfer_record_lines_unique_item
          UNIQUE (record_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS stock_change_requests (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_type_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_type_check
          CHECK (type IN ('out'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_change_requests_status_check') THEN
        ALTER TABLE stock_change_requests
          ADD CONSTRAINT stock_change_requests_status_check
          CHECK (status IN ('pending','approved','rejected'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_status ON stock_change_requests(status);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_reason ON stock_change_requests(reason);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_wh ON stock_change_requests(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_item ON stock_change_requests(item_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_stock_change_requests_created_at ON stock_change_requests(created_at);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stocktake_records (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      category text NOT NULL,
      stocktake_type text NOT NULL DEFAULT 'routine',
      stocktake_date date NOT NULL,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_stocktake_records_type_check') THEN
        ALTER TABLE inventory_stocktake_records
          ADD CONSTRAINT inventory_stocktake_records_type_check
          CHECK (stocktake_type IN ('initial','routine'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_records_wh ON inventory_stocktake_records(warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_records_category ON inventory_stocktake_records(category);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_records_date ON inventory_stocktake_records(stocktake_date DESC, created_at DESC);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS inventory_stocktake_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES inventory_stocktake_records(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      previous_quantity integer NOT NULL DEFAULT 0,
      counted_quantity integer NOT NULL DEFAULT 0,
      delta_quantity integer NOT NULL DEFAULT 0
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_inventory_stocktake_record_lines_record ON inventory_stocktake_record_lines(record_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_stocktake_record_lines_unique_item') THEN
        ALTER TABLE inventory_stocktake_record_lines
          ADD CONSTRAINT inventory_stocktake_record_lines_unique_item
          UNIQUE (record_id, item_id);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_plans (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_plans_status_check') THEN
        ALTER TABLE linen_delivery_plans
          ADD CONSTRAINT linen_delivery_plans_status_check
          CHECK (status IN ('draft','planned','dispatched','cancelled'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_plans_plan_date ON linen_delivery_plans(plan_date DESC);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_plan_lines (
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
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_plan_lines_plan ON linen_delivery_plan_lines(plan_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_records (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_records_status_check') THEN
        ALTER TABLE linen_delivery_records
          ADD CONSTRAINT linen_delivery_records_status_check
          CHECK (status IN ('completed','cancelled'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_delivery_date ON linen_delivery_records(delivery_date DESC);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_from_wh ON linen_delivery_records(from_warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_to_wh ON linen_delivery_records(to_warehouse_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_records_status ON linen_delivery_records(status);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES linen_delivery_records(id) ON DELETE CASCADE,
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE RESTRICT,
      room_type_name text,
      sets integer NOT NULL DEFAULT 0
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_record_lines_record ON linen_delivery_record_lines(record_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_record_lines_unique_room_type') THEN
        ALTER TABLE linen_delivery_record_lines
          ADD CONSTRAINT linen_delivery_record_lines_unique_room_type
          UNIQUE (record_id, room_type_code);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_delivery_record_extra_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES linen_delivery_records(id) ON DELETE CASCADE,
      linen_type_code text NOT NULL REFERENCES inventory_linen_types(code) ON DELETE RESTRICT,
      linen_type_name text,
      quantity integer NOT NULL DEFAULT 0
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_delivery_record_extra_lines_record ON linen_delivery_record_extra_lines(record_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_delivery_record_extra_lines_unique_type') THEN
        ALTER TABLE linen_delivery_record_extra_lines
          ADD CONSTRAINT linen_delivery_record_extra_lines_unique_type
          UNIQUE (record_id, linen_type_code);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_stocktake_records (
      id text PRIMARY KEY,
      warehouse_id text NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      delivery_record_id text REFERENCES linen_delivery_records(id) ON DELETE SET NULL,
      stocktake_date date NOT NULL,
      dirty_bag_note text,
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_stocktake_records_wh_date ON linen_stocktake_records(warehouse_id, stocktake_date DESC, created_at DESC);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_stocktake_records_delivery_record ON linen_stocktake_records(delivery_record_id);');
        await dbAdapter_1.pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_linen_stocktake_records_delivery_record_unique
      ON linen_stocktake_records(delivery_record_id)
      WHERE delivery_record_id IS NOT NULL;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_stocktake_record_lines (
      id text PRIMARY KEY,
      record_id text NOT NULL REFERENCES linen_stocktake_records(id) ON DELETE CASCADE,
      room_type_code text NOT NULL REFERENCES inventory_room_types(code) ON DELETE RESTRICT,
      remaining_sets integer NOT NULL DEFAULT 0
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_stocktake_record_lines_record ON linen_stocktake_record_lines(record_id);');
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_stocktake_record_lines_unique_room_type') THEN
        ALTER TABLE linen_stocktake_record_lines
          ADD CONSTRAINT linen_stocktake_record_lines_unique_room_type
          UNIQUE (record_id, room_type_code);
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_return_batches (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_return_batches_status_check') THEN
        ALTER TABLE linen_supplier_return_batches
          ADD CONSTRAINT linen_supplier_return_batches_status_check
          CHECK (status IN ('draft','returned','settled'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_supplier ON linen_supplier_return_batches(supplier_id);');
        await dbAdapter_1.pgPool.query('ALTER TABLE linen_supplier_return_batches ADD COLUMN IF NOT EXISTS return_no text;');
        await dbAdapter_1.pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_linen_supplier_return_batches_return_no_unique ON linen_supplier_return_batches(return_no) WHERE return_no IS NOT NULL;');
        await dbAdapter_1.pgPool.query(`ALTER TABLE linen_supplier_return_batches ADD COLUMN IF NOT EXISTS photo_urls jsonb NOT NULL DEFAULT '[]'::jsonb;`);
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_return_batch_lines (
      id text PRIMARY KEY,
      batch_id text NOT NULL REFERENCES linen_supplier_return_batches(id) ON DELETE CASCADE,
      item_id text NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
      quantity integer NOT NULL,
      refund_unit_price numeric NOT NULL DEFAULT 0,
      amount_total numeric NOT NULL DEFAULT 0,
      note text
    );`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_return_batch_lines_batch ON linen_supplier_return_batch_lines(batch_id);');
        await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS linen_supplier_refunds (
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
    );`);
        await dbAdapter_1.pgPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linen_supplier_refunds_status_check') THEN
        ALTER TABLE linen_supplier_refunds
          ADD CONSTRAINT linen_supplier_refunds_status_check
          CHECK (status IN ('pending','partial','settled','disputed'));
      END IF;
    END $$;`);
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_supplier ON linen_supplier_refunds(supplier_id);');
        await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_linen_supplier_refunds_status ON linen_supplier_refunds(status);');
        await dbAdapter_1.pgPool.query(`INSERT INTO warehouses (id, code, name) VALUES
      ('wh.south_melbourne', 'SOU', 'South Melbourne'),
      ('wh.msq', 'MSQ', 'MSQ'),
      ('wh.wsp', 'WSP', 'WSP'),
      ('wh.my80', 'MY80', 'My80')
    ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO suppliers (id, name, kind) VALUES
      ('sup.linen.1', '床品供应商1', 'linen'),
      ('sup.linen.2', '床品供应商2', 'linen')
    ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority) VALUES
      ('rsr.southbank', 'Southbank', 'sup.linen.1', 100),
      ('rsr.default', '*', 'sup.linen.2', 0)
    ON CONFLICT (id) DO NOTHING;`);
        await dbAdapter_1.pgPool.query(`UPDATE warehouses
      SET linen_capacity_sets = CASE
        WHEN id = 'wh.south_melbourne' THEN COALESCE(linen_capacity_sets, 500)
        WHEN id = 'wh.msq' THEN COALESCE(linen_capacity_sets, 120)
        WHEN id = 'wh.wsp' THEN COALESCE(linen_capacity_sets, 120)
        WHEN id = 'wh.my80' THEN COALESCE(linen_capacity_sets, 100)
        ELSE linen_capacity_sets
      END;`);
        inventorySchemaEnsured = true;
    })().catch((e) => {
        inventorySchemaEnsured = false;
        inventorySchemaEnsurePromise = null;
        throw e;
    });
    try {
        await inventorySchemaEnsurePromise;
    }
    finally {
        if (inventorySchemaEnsured)
            inventorySchemaEnsurePromise = null;
    }
}
async function warmupInventoryModule() {
    if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
        return;
    await ensureInventorySchema();
}
async function pickSupplierIdForRegion(region) {
    var _a, _b;
    if (!dbAdapter_1.pgPool)
        return null;
    await ensureInventorySchema();
    const r = String(region || '').trim();
    const rows = await dbAdapter_1.pgPool.query(`SELECT supplier_id
     FROM region_supplier_rules
     WHERE active = true
       AND (region_key = $1 OR region_key = '*')
     ORDER BY (CASE WHEN region_key = $1 THEN 1 ELSE 0 END) DESC, priority DESC
     LIMIT 1`, [r || '__none__']);
    return ((_b = (_a = rows.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.supplier_id) || null;
}
async function ensureWarehouseStockRow(client, warehouse_id, item_id) {
    const id = `ws.${warehouse_id}.${item_id}`;
    await client.query(`INSERT INTO warehouse_stocks (id, warehouse_id, item_id, quantity)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (warehouse_id, item_id) DO NOTHING`, [id, warehouse_id, item_id]);
}
async function ensurePurchaseOrderNo(client, rowOrId) {
    const id = typeof rowOrId === 'string' ? String(rowOrId) : String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.id) || '');
    if (!id)
        return null;
    const current = typeof rowOrId === 'object' ? String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.po_no) || '').trim() : '';
    if (current)
        return current;
    let date = typeof rowOrId === 'object'
        ? String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.ordered_date) || (rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.created_at) || '').slice(0, 10)
        : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        date = new Date().toISOString().slice(0, 10);
    const base = date.replace(/-/g, '').slice(2);
    const prefix = `PO-${base}-`;
    let candidate = `${prefix}${randomSuffix(4)}`;
    for (let i = 0; i < 8; i++) {
        const chk = await client.query('SELECT 1 FROM purchase_orders WHERE po_no = $1 LIMIT 1', [candidate]);
        if (!chk.rowCount)
            break;
        candidate = `${prefix}${randomSuffix(4 + Math.min(i, 2))}`;
    }
    await client.query(`UPDATE purchase_orders SET po_no = $1 WHERE id = $2 AND COALESCE(po_no, '') = ''`, [candidate, id]);
    return candidate;
}
async function ensureSupplierReturnNo(client, rowOrId) {
    const id = typeof rowOrId === 'string' ? String(rowOrId) : String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.id) || '');
    if (!id)
        return null;
    const current = typeof rowOrId === 'object' ? String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.return_no) || '').trim() : '';
    if (current)
        return current;
    let date = typeof rowOrId === 'object'
        ? String((rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.returned_at) || (rowOrId === null || rowOrId === void 0 ? void 0 : rowOrId.created_at) || '').slice(0, 10)
        : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        date = new Date().toISOString().slice(0, 10);
    const base = date.replace(/-/g, '').slice(2);
    const prefix = `RT-${base}-`;
    let candidate = `${prefix}${randomSuffix(4)}`;
    for (let i = 0; i < 8; i++) {
        const chk = await client.query('SELECT 1 FROM linen_supplier_return_batches WHERE return_no = $1 LIMIT 1', [candidate]);
        if (!chk.rowCount)
            break;
        candidate = `${prefix}${randomSuffix(4 + Math.min(i, 2))}`;
    }
    await client.query(`UPDATE linen_supplier_return_batches SET return_no = $1 WHERE id = $2 AND COALESCE(return_no, '') = ''`, [candidate, id]);
    return candidate;
}
async function ensureLinenInventoryItem(client, linenTypeCode) {
    var _a, _b, _c, _d;
    const code = String(linenTypeCode || '').trim();
    if (!code)
        return null;
    const existing = await client.query(`SELECT id, name, sku, linen_type_code
     FROM inventory_items
     WHERE category = 'linen' AND linen_type_code = $1
     ORDER BY active DESC, name ASC, id ASC
     LIMIT 1`, [code]);
    if ((_b = (_a = existing.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id)
        return existing.rows[0];
    const linenType = await client.query(`SELECT code, name, active
     FROM inventory_linen_types
     WHERE code = $1
     LIMIT 1`, [code]);
    const row = (_c = linenType.rows) === null || _c === void 0 ? void 0 : _c[0];
    if (!row)
        return null;
    const itemId = `item.linen_type.${code}`;
    const inserted = await client.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
     VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code
     RETURNING id, name, sku, linen_type_code`, [itemId, row.name, `LT:${code}`, code, row.active]);
    return ((_d = inserted.rows) === null || _d === void 0 ? void 0 : _d[0]) || null;
}
async function getSmWarehouse() {
    if (!dbAdapter_1.pgPool)
        return null;
    const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, name, linen_capacity_sets FROM warehouses ORDER BY code ASC`);
    const list = rows.rows || [];
    return list.find((r) => isSmWarehouseRow(r)) || list[0] || null;
}
async function getActiveLinenTypes(client) {
    const rows = await client.query(`SELECT code, name, in_set, set_divisor, sort_order
     FROM inventory_linen_types
     WHERE active = true
     ORDER BY sort_order ASC, code ASC`);
    return rows.rows || [];
}
async function getRoomTypeRequirementMaps(client) {
    const [roomTypesRows, reqRows] = await Promise.all([
        client.query(`SELECT code, name, sort_order
       FROM inventory_room_types
       WHERE active = true
       ORDER BY sort_order ASC, code ASC`),
        client.query(`SELECT room_type_code, linen_type_code, quantity FROM inventory_room_type_requirements`),
    ]);
    const roomTypes = roomTypesRows.rows || [];
    const reqMap = new Map();
    for (const r of reqRows.rows || []) {
        const roomTypeCode = String(r.room_type_code || '');
        const linenTypeCode = String(r.linen_type_code || '');
        const quantity = Number(r.quantity || 0);
        if (!roomTypeCode || !linenTypeCode || quantity <= 0)
            continue;
        if (!reqMap.has(roomTypeCode))
            reqMap.set(roomTypeCode, new Map());
        reqMap.get(roomTypeCode).set(linenTypeCode, quantity);
    }
    return { roomTypes, reqMap };
}
function buildLinenUsageSourceLabel(sourceType) {
    const source = String(sourceType || '').trim();
    if (source === 'cleaning_task_standard')
        return '清洁完成自动记录';
    if (source === 'day_end_reject_usage')
        return '备用床品补记';
    return source || '床品使用';
}
async function syncLinenUsageEntriesInTx(client, input) {
    const sourceType = String(input.source_type || '').trim();
    const sourceRef = String(input.source_ref || '').trim();
    if (!sourceType || !sourceRef)
        throw new Error('linen usage source is required');
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
        .filter((item) => item.usage_key && item.usage_date && item.linen_type_code);
    const desiredMap = new Map();
    for (const item of normalized)
        desiredMap.set(item.usage_key, item);
    const existingRes = await client.query(`SELECT id, usage_key
     FROM inventory_linen_usage_records
     WHERE source_type = $1 AND source_ref = $2`, [sourceType, sourceRef]);
    const existingRows = existingRes.rows || [];
    const existingMap = new Map(existingRows.map((row) => [String(row.usage_key || ''), row]));
    for (const row of existingRows) {
        const usageKey = String(row.usage_key || '');
        if (!usageKey || desiredMap.has(usageKey))
            continue;
        await client.query(`DELETE FROM inventory_linen_usage_records WHERE id = $1`, [String(row.id || '')]);
    }
    for (const item of desiredMap.values()) {
        const existing = existingMap.get(item.usage_key) || null;
        if (existing === null || existing === void 0 ? void 0 : existing.id) {
            await client.query(`UPDATE inventory_linen_usage_records
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
         WHERE id = $1`, [
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
            ]);
        }
        else {
            await client.query(`INSERT INTO inventory_linen_usage_records (
           id, usage_key, usage_date, source_type, source_ref, cleaning_task_id,
           property_id, property_code, room_type_code, warehouse_id, linen_type_code,
           quantity, actor_id, note, created_at, updated_at
         )
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())`, [
                (0, uuid_1.v4)(),
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
            ]);
        }
    }
}
async function recordCleaningTaskStandardLinenUsage(params) {
    if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
        return { ok: false, reason: 'pg_unavailable' };
    await ensureInventorySchema();
    const taskId = String(params.cleaningTaskId || '').trim();
    if (!taskId)
        return { ok: false, reason: 'missing_task_id' };
    const actor = String(params.actorId || '').trim() || null;
    return (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
        var _a;
        const taskRes = await client.query(`SELECT
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
       LIMIT 1`, [taskId]);
        const task = ((_a = taskRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        if (!(task === null || task === void 0 ? void 0 : task.task_id) || !(task === null || task === void 0 ? void 0 : task.usage_date) || !(task === null || task === void 0 ? void 0 : task.property_code))
            return { ok: false, reason: 'task_not_ready' };
        const { roomTypes, reqMap } = await getRoomTypeRequirementMaps(client);
        const resolvedRoomType = resolveRoomTypeCode(String(task.room_type_code || task.property_type || '').trim(), roomTypes, reqMap);
        const roomTypeCode = String(resolvedRoomType.code || '').trim();
        if (!roomTypeCode)
            return { ok: false, reason: 'missing_room_type' };
        const reqs = reqMap.get(roomTypeCode);
        if (!reqs || !reqs.size)
            return { ok: false, reason: 'room_type_requirements_missing' };
        const whRes = await client.query(`SELECT id, code, name FROM warehouses WHERE active = true ORDER BY code ASC`);
        const warehouseId = resolveWarehouseForProperty(task, whRes.rows || []);
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
        })).filter((item) => item.linen_type_code && item.quantity > 0);
        await syncLinenUsageEntriesInTx(client, {
            source_type: 'cleaning_task_standard',
            source_ref: taskId,
            desired,
        });
        return { ok: true, count: desired.length };
    });
}
async function syncDayEndRejectLinenUsage(params) {
    if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
        return { ok: false, reason: 'pg_unavailable' };
    await ensureInventorySchema();
    const userId = String(params.userId || '').trim();
    const date = String(params.date || '').trim().slice(0, 10);
    const actor = String(params.actorId || '').trim() || null;
    if (!userId || !date)
        return { ok: false, reason: 'missing_source' };
    return (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
        const sourceRef = `${userId}:${date}`;
        const rows = (Array.isArray(params.rejectItems) ? params.rejectItems : [])
            .map((item) => ({
            linen_type: String((item === null || item === void 0 ? void 0 : item.linen_type) || '').trim(),
            quantity: Math.max(0, Number((item === null || item === void 0 ? void 0 : item.quantity) || 0)),
            used_room: String((item === null || item === void 0 ? void 0 : item.used_room) || '').trim(),
        }))
            .filter((item) => item.linen_type && item.quantity > 0 && item.used_room);
        if (!rows.length) {
            await syncLinenUsageEntriesInTx(client, {
                source_type: 'day_end_reject_usage',
                source_ref: sourceRef,
                desired: [],
            });
            return { ok: true, count: 0 };
        }
        const roomCodes = Array.from(new Set(rows.map((item) => item.used_room.toUpperCase())));
        const propertiesRes = await client.query(`SELECT id::text AS id, code, room_type_code, type, linen_service_warehouse_id, region
       FROM properties
       WHERE upper(code) = ANY($1::text[]) OR id::text = ANY($2::text[])`, [roomCodes, rows.map((item) => item.used_room)]);
        const whRes = await client.query(`SELECT id, code, name FROM warehouses WHERE active = true ORDER BY code ASC`);
        const propertyByCode = new Map();
        for (const property of propertiesRes.rows || []) {
            const code = String(property.code || '').trim().toUpperCase();
            const id = String(property.id || '').trim();
            if (code)
                propertyByCode.set(code, property);
            if (id)
                propertyByCode.set(id, property);
        }
        const aggregate = new Map();
        for (const row of rows) {
            const property = propertyByCode.get(row.used_room.toUpperCase()) || propertyByCode.get(row.used_room) || null;
            const warehouseId = property ? resolveWarehouseForProperty(property, whRes.rows || []) : null;
            const propertyId = property ? String(property.id || '').trim() || null : null;
            const propertyCode = property ? String(property.code || '').trim() || row.used_room : row.used_room;
            const roomTypeCode = property ? String(property.room_type_code || property.type || '').trim() || null : null;
            const key = `${propertyCode}:${row.linen_type}`;
            const current = aggregate.get(key);
            if (current)
                current.quantity += row.quantity;
            else {
                aggregate.set(key, {
                    property_id: propertyId,
                    property_code: propertyCode,
                    room_type_code: roomTypeCode,
                    warehouse_id: String(warehouseId || '').trim() || null,
                    linen_type_code: row.linen_type,
                    quantity: row.quantity,
                });
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
        }));
        await syncLinenUsageEntriesInTx(client, {
            source_type: 'day_end_reject_usage',
            source_ref: sourceRef,
            desired,
        });
        return { ok: true, count: desired.length };
    });
}
function computeSetsForRoomType(countsByLinenType, requirements) {
    if (!requirements || !requirements.size)
        return 0;
    const candidates = [];
    for (const [linenTypeCode, quantity] of requirements.entries()) {
        const stockQty = Number(countsByLinenType[linenTypeCode] || 0);
        candidates.push(Math.floor(stockQty / Math.max(1, quantity)));
    }
    return candidates.length ? Math.max(0, Math.min(...candidates)) : 0;
}
function resolveWarehouseForProperty(property, warehouses) {
    const explicit = String((property === null || property === void 0 ? void 0 : property.linen_service_warehouse_id) || '').trim();
    if (explicit)
        return explicit;
    const region = String((property === null || property === void 0 ? void 0 : property.region) || '').trim().toLowerCase();
    if (!region)
        return null;
    const found = (warehouses || []).find((w) => {
        const code = String(w.code || '').trim().toLowerCase();
        const name = String(w.name || '').trim().toLowerCase();
        return code === region || name === region || name.includes(region) || region.includes(code);
    });
    return found ? String(found.id) : null;
}
async function getLinenReserveMap(client, warehouseId) {
    const rows = await client.query(`SELECT item_id, reserve_qty
     FROM inventory_stock_policies
     WHERE warehouse_id = $1`, [warehouseId]);
    return new Map((rows.rows || []).map((r) => [String(r.item_id), Number(r.reserve_qty || 0)]));
}
async function assertWarehouseAllowsStocktake(client, warehouseId) {
    var _a;
    const row = await client.query(`SELECT id, code, name, stocktake_enabled, active FROM warehouses WHERE id = $1 LIMIT 1`, [warehouseId]);
    const warehouse = ((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
    if (!warehouse)
        throw httpError(400, '盘点分仓不存在');
    if (!Boolean(warehouse.active))
        throw httpError(400, '盘点分仓未启用');
    if (warehouse.stocktake_enabled === false)
        throw httpError(400, '该仓库未开启盘点');
    return warehouse;
}
async function getLatestSupplierItemPrice(client, supplierId) {
    const rows = await client.query(`SELECT sip.id, sip.supplier_id, sip.item_id, sip.purchase_unit_price, sip.refund_unit_price, sip.effective_from, sip.active,
            i.name AS item_name, i.sku AS item_sku, i.linen_type_code
     FROM supplier_item_prices sip
     JOIN inventory_items i ON i.id = sip.item_id
     WHERE sip.supplier_id = $1
       AND sip.active = true
     ORDER BY COALESCE(sip.effective_from, DATE '1970-01-01') DESC, sip.updated_at DESC NULLS LAST, sip.id DESC`, [supplierId]);
    const out = new Map();
    for (const row of rows.rows || []) {
        const itemId = String(row.item_id || '');
        if (!itemId || out.has(itemId))
            continue;
        out.set(itemId, row);
    }
    return out;
}
async function applyStockDeltaInTx(client, input) {
    var _a, _b;
    await ensureWarehouseStockRow(client, input.warehouse_id, input.item_id);
    const lock = await client.query(`SELECT id, quantity
     FROM warehouse_stocks
     WHERE warehouse_id = $1 AND item_id = $2
     FOR UPDATE`, [input.warehouse_id, input.item_id]);
    const row = (_a = lock.rows) === null || _a === void 0 ? void 0 : _a[0];
    if (!row)
        throw new Error('warehouse stock missing');
    const delta = input.type === 'in' ? input.quantity : input.type === 'out' ? -input.quantity : input.quantity;
    const nextQty = Number(row.quantity || 0) + Number(delta || 0);
    if (nextQty < 0)
        return { ok: false, code: 409, message: 'insufficient stock' };
    const shouldReturnStockRow = input.return_stock_row !== false;
    const updated = shouldReturnStockRow
        ? await client.query(`UPDATE warehouse_stocks
       SET quantity = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`, [nextQty, row.id])
        : await client.query(`UPDATE warehouse_stocks
       SET quantity = $1, updated_at = now()
       WHERE id = $2`, [nextQty, row.id]);
    const moveId = (0, uuid_1.v4)();
    await client.query(`INSERT INTO stock_movements (id, warehouse_id, item_id, type, reason, quantity, property_id, ref_type, ref_id, actor_id, note, photo_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
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
    ]);
    return { ok: true, stock: shouldReturnStockRow ? (((_b = updated.rows) === null || _b === void 0 ? void 0 : _b[0]) || null) : null, movement_id: moveId };
}
function normalizeRoomTypeLookupKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^房型[:：\s-]*/g, '')
        .replace(/[（(].*?[）)]/g, '')
        .replace(/[\s_-]+/g, '');
}
function buildRoomTypeAliasKeys(row) {
    var _a, _b;
    const keys = new Set();
    const code = String(row.code || '').trim();
    const name = String(row.name || '').trim();
    const bedrooms = Number((_a = row.bedrooms) !== null && _a !== void 0 ? _a : 0);
    const bathrooms = Number((_b = row.bathrooms) !== null && _b !== void 0 ? _b : 0);
    for (const value of [code, name]) {
        const normalized = normalizeRoomTypeLookupKey(value);
        if (normalized)
            keys.add(normalized);
    }
    if (bedrooms > 0 || bathrooms > 0) {
        keys.add(normalizeRoomTypeLookupKey(`${bedrooms}b${bathrooms}b`));
        keys.add(normalizeRoomTypeLookupKey(`${bedrooms}房${bathrooms}卫`));
        keys.add(normalizeRoomTypeLookupKey(`房型${bedrooms}房${bathrooms}卫`));
    }
    if (name) {
        keys.add(normalizeRoomTypeLookupKey(name.replace(/^房型/, '')));
        keys.add(normalizeRoomTypeLookupKey(`房型${name}`));
    }
    return Array.from(keys).filter(Boolean);
}
function resolveRoomTypeCode(inputCode, roomTypeRows, reqMap) {
    const rows = roomTypeRows || [];
    const exact = rows.find((row) => String(row.code || '') === inputCode) || null;
    const lookupKeys = new Set([inputCode, exact === null || exact === void 0 ? void 0 : exact.name].map((value) => normalizeRoomTypeLookupKey(value)).filter(Boolean));
    const aliasCandidates = new Set();
    for (const row of rows) {
        const aliases = buildRoomTypeAliasKeys(row);
        if (aliases.some((alias) => lookupKeys.has(alias)))
            aliasCandidates.add(String(row.code || '').trim());
    }
    const inputCodeExists = rows.some((row) => String(row.code || '').trim() === String(inputCode || '').trim());
    const candidateCodes = Array.from(new Set([
        ...Array.from(aliasCandidates),
        ...(inputCodeExists ? [String(inputCode || '').trim()] : []),
        ...(exact ? [String(exact.code || '').trim()] : []),
        String(inputCode || '').trim(),
    ])).filter(Boolean);
    const preferredCode = candidateCodes.find((code) => {
        if (!reqMap)
            return false;
        const reqs = reqMap.get(code);
        return !!reqs && reqs.size > 0;
    });
    const resolvedCode = preferredCode || candidateCodes[0] || '';
    const resolvedRow = rows.find((row) => String(row.code || '').trim() === resolvedCode)
        || exact
        || rows.find((row) => buildRoomTypeAliasKeys(row).some((alias) => lookupKeys.has(alias)))
        || null;
    return {
        code: resolvedCode,
        name: String((resolvedRow === null || resolvedRow === void 0 ? void 0 : resolvedRow.name) || (exact === null || exact === void 0 ? void 0 : exact.name) || inputCode || ''),
    };
}
async function expandLinenDeliveryInputLines(client, lines) {
    const normalized = (lines || []).map((line) => ({
        room_type_code: String((line === null || line === void 0 ? void 0 : line.room_type_code) || '').trim(),
        sets: Number((line === null || line === void 0 ? void 0 : line.sets) || 0),
    }));
    if (!normalized.length)
        throw new Error('至少需要一条配送明细');
    const seen = new Set();
    for (const line of normalized) {
        if (!line.room_type_code)
            throw new Error('配送明细缺少房型');
        if (!Number.isInteger(line.sets) || line.sets < 1)
            throw new Error('配送套数必须大于 0');
        if (seen.has(line.room_type_code))
            throw new Error('同一配送单内房型不能重复');
        seen.add(line.room_type_code);
    }
    const [roomTypesRes, reqRows, itemsRes] = await Promise.all([
        client.query(`SELECT code, name, bedrooms, bathrooms
       FROM inventory_room_types`),
        client.query(`SELECT room_type_code, linen_type_code, quantity FROM inventory_room_type_requirements`),
        client.query(`SELECT id, name, sku, linen_type_code
       FROM inventory_items
       WHERE category = 'linen' AND active = true`),
    ]);
    const roomTypeRows = (roomTypesRes.rows || []).map((row) => ({
        code: String(row.code || ''),
        name: String(row.name || row.code || ''),
        bedrooms: row.bedrooms == null ? null : Number(row.bedrooms),
        bathrooms: row.bathrooms == null ? null : Number(row.bathrooms),
    }));
    const reqMap = new Map();
    for (const row of reqRows.rows || []) {
        const roomTypeCode = String(row.room_type_code || '');
        const linenTypeCode = String(row.linen_type_code || '');
        const quantity = Number(row.quantity || 0);
        if (!roomTypeCode || !linenTypeCode || quantity <= 0)
            continue;
        if (!reqMap.has(roomTypeCode))
            reqMap.set(roomTypeCode, new Map());
        reqMap.get(roomTypeCode).set(linenTypeCode, quantity);
    }
    const itemByLinenType = new Map();
    for (const row of itemsRes.rows || []) {
        const code = String(row.linen_type_code || '');
        if (!code || itemByLinenType.has(code))
            continue;
        itemByLinenType.set(code, row);
    }
    return normalized.map((line) => {
        const resolvedRoomType = resolveRoomTypeCode(line.room_type_code, roomTypeRows, reqMap);
        const roomTypeCode = String(resolvedRoomType.code || '').trim();
        const roomTypeName = String(resolvedRoomType.name || '');
        if (!roomTypeName)
            throw new Error(`未知房型：${line.room_type_code}`);
        const reqs = reqMap.get(roomTypeCode);
        if (!reqs || !reqs.size)
            throw new Error(`房型 ${roomTypeName} 未配置床品占用清单`);
        const breakdown = Array.from(reqs.entries()).map(([linenTypeCode, quantity]) => {
            const item = itemByLinenType.get(String(linenTypeCode));
            if (!(item === null || item === void 0 ? void 0 : item.id))
                throw new Error(`床品类型 ${linenTypeCode} 未配置库存物料`);
            return {
                linen_type_code: String(linenTypeCode),
                item_id: String(item.id),
                item_name: String(item.name || linenTypeCode),
                item_sku: String(item.sku || ''),
                quantity_per_set: Number(quantity || 0),
                quantity_total: Number(quantity || 0) * line.sets,
            };
        }).filter((row) => row.quantity_per_set > 0 && row.quantity_total > 0);
        if (!breakdown.length)
            throw new Error(`房型 ${roomTypeName} 未配置有效床品占用清单`);
        return {
            room_type_code: roomTypeCode,
            room_type_name: roomTypeName,
            sets: line.sets,
            breakdown,
        };
    });
}
async function normalizeLinenStocktakeLines(client, lines) {
    const normalized = (lines || []).map((line) => {
        var _a;
        return ({
            room_type_code: String((line === null || line === void 0 ? void 0 : line.room_type_code) || '').trim(),
            remaining_sets: Number((_a = line === null || line === void 0 ? void 0 : line.remaining_sets) !== null && _a !== void 0 ? _a : 0),
        });
    });
    if (!normalized.length)
        throw new Error('至少需要填写一条盘点明细');
    const roomTypesRes = await client.query(`SELECT code, name, bedrooms, bathrooms
     FROM inventory_room_types
     WHERE active = true
     ORDER BY sort_order ASC, code ASC`);
    const roomTypeRows = (roomTypesRes.rows || []).map((row) => ({
        code: String(row.code || ''),
        name: String(row.name || row.code || ''),
        bedrooms: row.bedrooms == null ? null : Number(row.bedrooms),
        bathrooms: row.bathrooms == null ? null : Number(row.bathrooms),
    }));
    const seen = new Set();
    for (const line of normalized) {
        if (!line.room_type_code)
            throw new Error('盘点明细缺少房型');
        const resolvedRoomType = resolveRoomTypeCode(line.room_type_code, roomTypeRows);
        if (!resolvedRoomType.code)
            throw new Error(`未知房型：${line.room_type_code}`);
        if (!Number.isInteger(line.remaining_sets) || line.remaining_sets < 0)
            throw new Error('盘点剩余套数不能小于 0');
        if (seen.has(resolvedRoomType.code))
            throw new Error('同一盘点单内房型不能重复');
        seen.add(resolvedRoomType.code);
        line.room_type_code = resolvedRoomType.code;
    }
    return normalized.map((line) => ({
        room_type_code: line.room_type_code,
        room_type_name: String(resolveRoomTypeCode(line.room_type_code, roomTypeRows).name || line.room_type_code),
        remaining_sets: line.remaining_sets,
    }));
}
async function expandLinenDeliveryExtraInputLines(client, lines) {
    const normalized = (lines || []).map((line) => ({
        linen_type_code: String((line === null || line === void 0 ? void 0 : line.linen_type_code) || '').trim(),
        quantity: Number((line === null || line === void 0 ? void 0 : line.quantity) || 0),
    })).filter((line) => line.linen_type_code || line.quantity);
    if (!normalized.length)
        return [];
    const seen = new Set();
    for (const line of normalized) {
        if (!line.linen_type_code)
            throw new Error('备用床品类型不能为空');
        if (!Number.isInteger(line.quantity) || line.quantity < 1)
            throw new Error('备用床品数量必须大于 0');
        if (seen.has(line.linen_type_code))
            throw new Error('同一配送单内备用床品类型不能重复');
        seen.add(line.linen_type_code);
    }
    const [linenTypeRowsRes, itemsRes] = await Promise.all([
        client.query(`SELECT code, name
       FROM inventory_linen_types
       WHERE active = true
       ORDER BY sort_order ASC, code ASC`),
        client.query(`SELECT id, name, sku, linen_type_code
       FROM inventory_items
       WHERE category = 'linen' AND active = true`),
    ]);
    const linenTypeMap = new Map();
    for (const row of linenTypeRowsRes.rows || [])
        linenTypeMap.set(String(row.code || ''), { code: String(row.code || ''), name: String(row.name || row.code || '') });
    const itemByLinenType = new Map();
    for (const row of itemsRes.rows || []) {
        const code = String(row.linen_type_code || '');
        if (!code || itemByLinenType.has(code))
            continue;
        itemByLinenType.set(code, row);
    }
    return normalized.map((line) => {
        const linenType = linenTypeMap.get(line.linen_type_code);
        if (!linenType)
            throw new Error(`未知床品类型：${line.linen_type_code}`);
        const item = itemByLinenType.get(line.linen_type_code);
        if (!(item === null || item === void 0 ? void 0 : item.id))
            throw new Error(`床品类型 ${line.linen_type_code} 未配置库存物料`);
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
        };
    });
}
async function applyLinenDeliveryBreakdownsInTx(client, input) {
    for (const breakdown of input.breakdowns || []) {
        for (const item of breakdown || []) {
            const fromType = input.direction === 'apply' ? 'out' : 'in';
            const toType = input.direction === 'apply' ? 'in' : 'out';
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
            });
            if (!out.ok)
                return out;
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
            });
            if (!inn.ok)
                return inn;
        }
    }
    return { ok: true };
}
async function applyLinenDeliveryRecordStockInTx(client, input) {
    return applyLinenDeliveryBreakdownsInTx(client, {
        ...input,
        breakdowns: (input.lines || []).map((line) => line.breakdown || []),
    });
}
async function revertLinenDeliveryRecordStockByRefInTx(client, input) {
    const effectsRes = await client.query(`SELECT warehouse_id,
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
     ) <> 0`, [input.record_id]);
    for (const row of effectsRes.rows || []) {
        const netQuantity = Number(row.net_quantity || 0);
        if (!netQuantity)
            continue;
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
        });
        if (!reversed.ok)
            return reversed;
    }
    return { ok: true };
}
function assertStockTxnOk(result) {
    if (result === null || result === void 0 ? void 0 : result.ok)
        return;
    throw httpError(Number((result === null || result === void 0 ? void 0 : result.code) || 500), String((result === null || result === void 0 ? void 0 : result.message) || 'failed'));
}
async function loadLinenDeliveryRecordDetail(client, id) {
    var _a, _b;
    const recordRes = await client.query(`SELECT r.*,
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
     GROUP BY r.id, fw.code, fw.name, tw.code, tw.name`, [id]);
    const record = ((_a = recordRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
    if (!record)
        return null;
    const linesRes = await client.query(`SELECT l.id,
            l.record_id,
            l.room_type_code,
            COALESCE(l.room_type_name, rt.name, l.room_type_code) AS room_type_name,
            l.sets
     FROM linen_delivery_record_lines l
     LEFT JOIN inventory_room_types rt ON rt.code = l.room_type_code
     WHERE l.record_id = $1
     ORDER BY COALESCE(rt.sort_order, 9999) ASC, l.room_type_code ASC`, [id]);
    const stocktakeRes = await client.query(`SELECT sr.id,
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
     LIMIT 1`, [id]);
    const stocktake = ((_b = stocktakeRes.rows) === null || _b === void 0 ? void 0 : _b[0]) || null;
    const extraLinesRes = await client.query(`SELECT el.id,
            el.record_id,
            el.linen_type_code,
            COALESCE(el.linen_type_name, lt.name, el.linen_type_code) AS linen_type_name,
            el.quantity
     FROM linen_delivery_record_extra_lines el
     LEFT JOIN inventory_linen_types lt ON lt.code = el.linen_type_code
     WHERE el.record_id = $1
     ORDER BY COALESCE(lt.sort_order, 9999) ASC, el.linen_type_code ASC`, [id]);
    const stocktakeLinesRes = (stocktake === null || stocktake === void 0 ? void 0 : stocktake.id)
        ? await client.query(`SELECT sl.id,
              sl.record_id,
              sl.room_type_code,
              COALESCE(rt.name, sl.room_type_code) AS room_type_name,
              sl.remaining_sets
       FROM linen_stocktake_record_lines sl
       LEFT JOIN inventory_room_types rt ON rt.code = sl.room_type_code
       WHERE sl.record_id = $1
       ORDER BY COALESCE(rt.sort_order, 9999) ASC, sl.room_type_code ASC`, [stocktake.id])
        : { rows: [] };
    let expanded = [];
    try {
        expanded = await expandLinenDeliveryInputLines(client, (linesRes.rows || []).map((line) => ({
            room_type_code: String(line.room_type_code || ''),
            sets: Number(line.sets || 0),
        })));
    }
    catch (_c) {
        expanded = [];
    }
    const breakdownTotals = new Map();
    const lines = (linesRes.rows || []).map((line) => {
        const details = expanded.find((row) => row.room_type_code === String(line.room_type_code || ''));
        const breakdown = (details === null || details === void 0 ? void 0 : details.breakdown) || [];
        for (const item of breakdown) {
            const key = `${item.item_id}`;
            const current = breakdownTotals.get(key);
            if (current)
                current.quantity_total += item.quantity_total;
            else
                breakdownTotals.set(key, {
                    linen_type_code: item.linen_type_code,
                    item_id: item.item_id,
                    item_name: item.item_name,
                    item_sku: item.item_sku,
                    quantity_total: item.quantity_total,
                });
        }
        return {
            id: String(line.id || ''),
            record_id: String(line.record_id || ''),
            room_type_code: String(line.room_type_code || ''),
            room_type_name: String(line.room_type_name || line.room_type_code || ''),
            sets: Number(line.sets || 0),
            breakdown,
        };
    });
    const extra_lines = (extraLinesRes.rows || []).map((line) => {
        const breakdown = [{
                linen_type_code: String(line.linen_type_code || ''),
                item_id: `item.linen_type.${String(line.linen_type_code || '')}`,
                item_name: String(line.linen_type_name || line.linen_type_code || ''),
                item_sku: '',
                quantity_per_set: 1,
                quantity_total: Number(line.quantity || 0),
            }];
        const key = String(line.linen_type_code || '');
        const current = breakdownTotals.get(key);
        if (current)
            current.quantity_total += Number(line.quantity || 0);
        else
            breakdownTotals.set(key, {
                linen_type_code: key,
                item_id: `item.linen_type.${key}`,
                item_name: String(line.linen_type_name || line.linen_type_code || ''),
                item_sku: '',
                quantity_total: Number(line.quantity || 0),
            });
        return {
            id: String(line.id || ''),
            record_id: String(line.record_id || ''),
            linen_type_code: key,
            linen_type_name: String(line.linen_type_name || line.linen_type_code || ''),
            quantity: Number(line.quantity || 0),
            breakdown,
        };
    });
    return {
        ...record,
        total_sets: Number(record.total_sets || 0),
        room_type_count: Number(record.room_type_count || 0),
        dirty_bag_note: String((stocktake === null || stocktake === void 0 ? void 0 : stocktake.dirty_bag_note) || ''),
        lines,
        extra_lines,
        stocktake: stocktake ? {
            ...stocktake,
            lines: (stocktakeLinesRes.rows || []).map((line) => ({
                id: String(line.id || ''),
                record_id: String(line.record_id || ''),
                room_type_code: String(line.room_type_code || ''),
                room_type_name: String(line.room_type_name || line.room_type_code || ''),
                remaining_sets: Number(line.remaining_sets || 0),
            })),
        } : null,
        breakdown_summary: Array.from(breakdownTotals.values()).sort((a, b) => a.item_name.localeCompare(b.item_name, 'zh-Hans-CN')),
    };
}
async function loadLinenDeliveryRecordSummary(client, id) {
    var _a;
    const res = await client.query(`SELECT id, delivery_date, status, created_at, updated_at
     FROM linen_delivery_records
     WHERE id = $1
     LIMIT 1`, [id]);
    const row = ((_a = res.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
    if (!row)
        return null;
    return {
        id: String(row.id || ''),
        delivery_date: String(row.delivery_date || ''),
        status: String(row.status || ''),
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
    };
}
function buildDeliverySuccessResponse(row, extra) {
    return {
        id: String((row === null || row === void 0 ? void 0 : row.id) || ''),
        delivery_date: String((row === null || row === void 0 ? void 0 : row.delivery_date) || ''),
        status: String((row === null || row === void 0 ? void 0 : row.status) || ''),
        created_at: (row === null || row === void 0 ? void 0 : row.created_at) || null,
        updated_at: (row === null || row === void 0 ? void 0 : row.updated_at) || null,
        ...(extra || {}),
    };
}
async function upsertLinenStocktakeRecordInTx(client, input) {
    var _a, _b;
    const normalizedLines = await normalizeLinenStocktakeLines(client, input.lines);
    let recordId = '';
    if (input.delivery_record_id) {
        const existingRes = await client.query(`SELECT id
       FROM linen_stocktake_records
       WHERE delivery_record_id = $1
       LIMIT 1`, [input.delivery_record_id]);
        recordId = String(((_b = (_a = existingRes.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id) || '');
    }
    if (recordId) {
        await client.query(`UPDATE linen_stocktake_records
       SET warehouse_id = $1,
           stocktake_date = $2::date,
           dirty_bag_note = $3,
           note = $4,
           updated_at = now()
       WHERE id = $5`, [input.warehouse_id, input.stocktake_date, input.dirty_bag_note || null, input.note || null, recordId]);
        await client.query(`DELETE FROM linen_stocktake_record_lines WHERE record_id = $1`, [recordId]);
    }
    else {
        recordId = (0, uuid_1.v4)();
        await client.query(`INSERT INTO linen_stocktake_records (id, warehouse_id, delivery_record_id, stocktake_date, dirty_bag_note, note, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7)`, [recordId, input.warehouse_id, input.delivery_record_id || null, input.stocktake_date, input.dirty_bag_note || null, input.note || null, input.actor_id || null]);
    }
    for (const line of normalizedLines) {
        await client.query(`INSERT INTO linen_stocktake_record_lines (id, record_id, room_type_code, remaining_sets)
       VALUES ($1,$2,$3,$4)`, [(0, uuid_1.v4)(), recordId, line.room_type_code, line.remaining_sets]);
    }
    return recordId;
}
async function loadLinenStocktakeDetail(client, id) {
    var _a;
    const recordRes = await client.query(`SELECT sr.*,
            w.code AS warehouse_code,
            w.name AS warehouse_name,
            dr.delivery_date,
            dr.status AS delivery_record_status
     FROM linen_stocktake_records sr
     JOIN warehouses w ON w.id = sr.warehouse_id
     LEFT JOIN linen_delivery_records dr ON dr.id = sr.delivery_record_id
     WHERE sr.id = $1`, [id]);
    const record = ((_a = recordRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
    if (!record)
        return null;
    const linesRes = await client.query(`SELECT sl.id,
            sl.record_id,
            sl.room_type_code,
            COALESCE(rt.name, sl.room_type_code) AS room_type_name,
            sl.remaining_sets
     FROM linen_stocktake_record_lines sl
     LEFT JOIN inventory_room_types rt ON rt.code = sl.room_type_code
     WHERE sl.record_id = $1
     ORDER BY COALESCE(rt.sort_order, 9999) ASC, sl.room_type_code ASC`, [id]);
    return {
        ...record,
        lines: (linesRes.rows || []).map((line) => ({
            id: String(line.id || ''),
            record_id: String(line.record_id || ''),
            room_type_code: String(line.room_type_code || ''),
            room_type_name: String(line.room_type_name || line.room_type_code || ''),
            remaining_sets: Number(line.remaining_sets || 0),
        })),
    };
}
async function getEditableLinenDeliveryRecordForUpdate(client, id) {
    var _a;
    const recordRes = await client.query(`SELECT *
     FROM linen_delivery_records
     WHERE id = $1
     FOR UPDATE`, [id]);
    const record = ((_a = recordRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
    if (!record)
        return null;
    const linesRes = await client.query(`SELECT room_type_code, sets
     FROM linen_delivery_record_lines
     WHERE record_id = $1
     ORDER BY room_type_code ASC`, [id]);
    return {
        record,
        lines: (linesRes.rows || []).map((line) => ({
            room_type_code: String(line.room_type_code || ''),
            sets: Number(line.sets || 0),
        })),
    };
}
function buildLinenDeliveryRecordFingerprint(input) {
    const lines = [...(input.lines || [])]
        .map((line) => ({
        room_type_code: String(line.room_type_code || '').trim(),
        sets: Number(line.sets || 0),
    }))
        .sort((a, b) => {
        const byCode = a.room_type_code.localeCompare(b.room_type_code);
        if (byCode !== 0)
            return byCode;
        return a.sets - b.sets;
    });
    const extra_linen_lines = [...(input.extra_linen_lines || [])]
        .map((line) => ({
        linen_type_code: String(line.linen_type_code || '').trim(),
        quantity: Number(line.quantity || 0),
    }))
        .sort((a, b) => {
        const byCode = a.linen_type_code.localeCompare(b.linen_type_code);
        if (byCode !== 0)
            return byCode;
        return a.quantity - b.quantity;
    });
    return JSON.stringify({
        actor_id: String(input.actor_id || ''),
        delivery_date: String(input.delivery_date || ''),
        from_warehouse_id: String(input.from_warehouse_id || ''),
        to_warehouse_id: String(input.to_warehouse_id || ''),
        note: String(input.note || '').trim(),
        lines,
        extra_linen_lines,
    });
}
exports.router.get('/warehouses', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    const startedAt = Date.now();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, name, linen_capacity_sets, stocktake_enabled, active FROM warehouses ORDER BY code ASC`);
            const durationMs = Date.now() - startedAt;
            if (!inventoryWarehousesFirstRequestLogged) {
                inventoryWarehousesFirstRequestLogged = true;
                inventoryLog(req, durationMs > 500 ? 'error' : 'log', 'warehouses_first_request', { duration_ms: durationMs, target_ms: 500 });
            }
            return res.json(rows.rows || []);
        }
        return res.json([
            { id: 'wh.south_melbourne', code: 'SOU', name: 'South Melbourne', linen_capacity_sets: 500, stocktake_enabled: false, active: true },
            { id: 'wh.msq', code: 'MSQ', name: 'MSQ', linen_capacity_sets: 120, stocktake_enabled: true, active: true },
            { id: 'wh.wsp', code: 'WSP', name: 'WSP', linen_capacity_sets: 120, stocktake_enabled: true, active: true },
            { id: 'wh.my80', code: 'MY80', name: 'My80', linen_capacity_sets: 100, stocktake_enabled: true, active: true },
        ]);
    }
    catch (e) {
        return sendInventoryError(req, res, e);
    }
});
const warehouseUpsertSchema = zod_1.z.object({
    code: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    linen_capacity_sets: zod_1.z.number().int().min(0).optional(),
    stocktake_enabled: zod_1.z.boolean().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.post('/warehouses', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const parsed = warehouseUpsertSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        const id = `wh.${String(body.code || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || randomSuffix(6).toLowerCase()}`;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO warehouses (id, code, name, linen_capacity_sets, stocktake_enabled, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`, [id, body.code, body.name, (_a = body.linen_capacity_sets) !== null && _a !== void 0 ? _a : null, (_b = body.stocktake_enabled) !== null && _b !== void 0 ? _b : true, (_c = body.active) !== null && _c !== void 0 ? _c : true]);
        return res.status(201).json(((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/warehouses/:id', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const parsed = warehouseUpsertSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const payload = parsed.data;
        const keys = Object.keys(payload).filter((k) => payload[k] !== undefined);
        if (!keys.length)
            return res.json(null);
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const row = await dbAdapter_1.pgPool.query(`UPDATE warehouses
       SET ${sets}
       WHERE id = $${keys.length + 1}
       RETURNING *`, [...keys.map((k) => payload[k]), String(req.params.id || '')]);
        if (!((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]))
            return res.status(404).json({ message: 'not found' });
        return res.json(row.rows[0]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const dailyPriceUpsertSchema = zod_1.z.object({
    category: zod_1.z.string().optional().nullable(),
    item_name: zod_1.z.string().min(1),
    cost_unit_price: zod_1.z.coerce.number().min(0).optional(),
    unit_price: zod_1.z.coerce.number().min(0),
    currency: zod_1.z.string().optional().nullable(),
    unit: zod_1.z.string().optional().nullable(),
    default_quantity: zod_1.z.coerce.number().int().min(1).optional().nullable(),
    is_active: zod_1.z.boolean().optional(),
});
const consumablePriceUpdateSchema = zod_1.z.object({
    item_name: zod_1.z.string().min(1).optional(),
    cost_unit_price: zod_1.z.coerce.number().min(0).optional(),
    unit_price: zod_1.z.coerce.number().min(0).optional(),
    currency: zod_1.z.string().optional().nullable(),
    unit: zod_1.z.string().optional().nullable(),
    default_quantity: zod_1.z.coerce.number().int().min(1).optional().nullable(),
    is_active: zod_1.z.boolean().optional(),
});
const consumableUsageQuerySchema = zod_1.z.object({
    property_id: zod_1.z.string().optional(),
    item_id: zod_1.z.string().optional(),
    keyword: zod_1.z.string().optional(),
    from: zod_1.z.string().optional(),
    to: zod_1.z.string().optional(),
});
exports.router.get('/daily-items-prices', (0, auth_1.requireAnyPerm)(['inventory.view', 'inventory.po.manage']), async (req, res) => {
    var _a;
    const category = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.category) || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureDailyPriceListSchema();
        await backfillDailyPriceSkus();
        await ensureDailyInventoryItemsSynced();
        const values = [];
        const where = [];
        if (category) {
            values.push(category);
            where.push(`category = $${values.length}`);
        }
        const sql = `SELECT * FROM daily_items_price_list${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(category, ''), item_name ASC`;
        const rows = await dbAdapter_1.pgPool.query(sql, values);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/daily-items-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = dailyPriceUpsertSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureDailyPriceListSchema();
        const id = (0, uuid_1.v4)();
        const row = {
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
        };
        const created = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const inserted = await client.query(`INSERT INTO daily_items_price_list (id, sku, category, item_name, cost_unit_price, unit_price, currency, unit, default_quantity, is_active, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`, [row.id, row.sku, row.category, row.item_name, row.cost_unit_price, row.unit_price, row.currency, row.unit, row.default_quantity, row.is_active, row.updated_at, row.updated_by]);
            await syncDailyInventoryItemFromPriceRow(((_a = inserted.rows) === null || _a === void 0 ? void 0 : _a[0]) || row, client);
            return ((_b = inserted.rows) === null || _b === void 0 ? void 0 : _b[0]) || row;
        });
        return res.status(201).json(created || row);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/daily-items-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = dailyPriceUpsertSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureDailyPriceListSchema();
        const updated = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            await backfillDailyPriceSkus(client);
            const current = await client.query(`SELECT * FROM daily_items_price_list WHERE id = $1`, [id]);
            const existing = (_a = current.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!existing)
                throw httpError(404, 'not found');
            const nextPayload = {
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
            };
            const keys = Object.keys(nextPayload);
            const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
            const values = keys.map((key) => nextPayload[key]);
            const result = await client.query(`UPDATE daily_items_price_list SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...values, id]);
            const row = ((_b = result.rows) === null || _b === void 0 ? void 0 : _b[0]) || { ...existing, ...nextPayload };
            await syncDailyInventoryItemFromPriceRow(row, client);
            return row;
        });
        return res.json(updated || null);
    }
    catch (e) {
        const status = Number((e === null || e === void 0 ? void 0 : e.statusCode) || 500);
        return res.status(status).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/daily-items-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureDailyPriceListSchema();
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`DELETE FROM daily_items_price_list WHERE id = $1`, [id]);
            await ensureInventorySchema();
            await client.query(`UPDATE inventory_items SET active = false, updated_at = now() WHERE id = $1`, [toDailyInventoryItemId(id)]);
        });
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/daily-stock-overview', (0, auth_1.requirePerm)('inventory.view'), async (_req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json({ warehouses: [], items: [] });
        await ensureDailyPriceListSchema();
        await backfillDailyPriceSkus();
        await ensureDailyInventoryItemsSynced();
        await ensureInventorySchema();
        const [warehouseRows, priceRows] = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY code ASC`),
            dbAdapter_1.pgPool.query(`SELECT * FROM daily_items_price_list WHERE is_active = true ORDER BY COALESCE(category, ''), item_name ASC`),
        ]);
        const warehouses = warehouseRows.rows || [];
        const items = priceRows.rows || [];
        const itemIds = items.map((row) => toDailyInventoryItemId(String(row.id)));
        const warehouseIds = warehouses.map((row) => String(row.id));
        const stockMap = new Map();
        if (itemIds.length && warehouseIds.length) {
            const stockRows = await dbAdapter_1.pgPool.query(`SELECT warehouse_id, item_id, quantity
         FROM warehouse_stocks
         WHERE warehouse_id = ANY($1::text[]) AND item_id = ANY($2::text[])`, [warehouseIds, itemIds]);
            for (const row of stockRows.rows || []) {
                stockMap.set(`${String(row.warehouse_id)}::${String(row.item_id)}`, Number(row.quantity || 0));
            }
        }
        return res.json({
            warehouses,
            items: items.map((row) => {
                const itemId = toDailyInventoryItemId(String(row.id));
                const stock_by_warehouse = warehouses.map((warehouse) => ({
                    warehouse_id: String(warehouse.id),
                    quantity: Number(stockMap.get(`${String(warehouse.id)}::${itemId}`) || 0),
                }));
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
                    total_quantity: stock_by_warehouse.reduce((sum, stock) => sum + Number(stock.quantity || 0), 0),
                };
            }),
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/consumable-items-prices', (0, auth_1.requireAnyPerm)(['inventory.view', 'inventory.po.manage']), async (_req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureConsumablePriceListSeeded();
        await ensureConsumableInventoryItemsSynced();
        const rows = await dbAdapter_1.pgPool.query(`SELECT * FROM consumable_items_price_list ORDER BY sort_order ASC NULLS LAST, item_name ASC`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/consumable-items-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = consumablePriceUpdateSchema.extend({
        item_name: zod_1.z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureConsumablePriceListSeeded();
        const id = (0, uuid_1.v4)();
        const row = {
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
        };
        const created = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const inserted = await client.query(`INSERT INTO consumable_items_price_list (id, sku, item_name, cost_unit_price, unit_price, currency, unit, default_quantity, sort_order, is_active, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`, [row.id, row.sku, row.item_name, row.cost_unit_price, row.unit_price, row.currency, row.unit, row.default_quantity, row.sort_order, row.is_active, row.updated_at, row.updated_by]);
            await syncConsumableInventoryItemFromPriceRow(((_a = inserted.rows) === null || _a === void 0 ? void 0 : _a[0]) || row, client);
            return ((_b = inserted.rows) === null || _b === void 0 ? void 0 : _b[0]) || row;
        });
        return res.status(201).json(created || row);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/consumable-items-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = consumablePriceUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureConsumablePriceListSeeded();
        const updated = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const current = await client.query(`SELECT * FROM consumable_items_price_list WHERE id = $1`, [id]);
            const existing = (_a = current.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!existing)
                throw httpError(404, 'not found');
            const nextPayload = {
                ...(parsed.data.item_name !== undefined ? { item_name: String(parsed.data.item_name || '').trim() } : {}),
                ...(parsed.data.cost_unit_price !== undefined ? { cost_unit_price: Number(parsed.data.cost_unit_price || 0) } : {}),
                ...(parsed.data.unit_price !== undefined ? { unit_price: Number(parsed.data.unit_price || 0) } : {}),
                ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency || 'AUD' } : {}),
                ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit || null } : {}),
                ...(parsed.data.default_quantity !== undefined ? { default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null } : {}),
                ...(parsed.data.is_active !== undefined ? { is_active: !!parsed.data.is_active } : {}),
                updated_at: new Date().toISOString(),
                updated_by: actorId(req),
            };
            const keys = Object.keys(nextPayload);
            if (!keys.length)
                return existing;
            const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
            const values = keys.map((key) => nextPayload[key]);
            const result = await client.query(`UPDATE consumable_items_price_list SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...values, id]);
            const row = ((_b = result.rows) === null || _b === void 0 ? void 0 : _b[0]) || { ...existing, ...nextPayload };
            await syncConsumableInventoryItemFromPriceRow(row, client);
            return row;
        });
        return res.json(updated || null);
    }
    catch (e) {
        const status = Number((e === null || e === void 0 ? void 0 : e.statusCode) || 500);
        return res.status(status).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/consumable-items-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureConsumablePriceListSeeded();
        await ensureInventorySchema();
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`DELETE FROM consumable_items_price_list WHERE id = $1`, [id]);
            await client.query(`DELETE FROM inventory_items WHERE id = $1`, [toConsumableInventoryItemId(id)]);
            await client.query(`DELETE FROM warehouse_stocks WHERE item_id = $1`, [toConsumableInventoryItemId(id)]);
        });
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/consumable-stock-overview', (0, auth_1.requirePerm)('inventory.view'), async (_req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json({ warehouses: [], items: [] });
        await ensureConsumablePriceListSeeded();
        await ensureConsumableInventoryItemsSynced();
        await ensureInventorySchema();
        const [warehouseRows, priceRows] = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY code ASC`),
            dbAdapter_1.pgPool.query(`SELECT * FROM consumable_items_price_list WHERE is_active = true ORDER BY sort_order ASC NULLS LAST, item_name ASC`),
        ]);
        const warehouses = warehouseRows.rows || [];
        const items = priceRows.rows || [];
        const itemIds = items.map((row) => toConsumableInventoryItemId(String(row.id)));
        const warehouseIds = warehouses.map((row) => String(row.id));
        const stockMap = new Map();
        if (itemIds.length && warehouseIds.length) {
            const stockRows = await dbAdapter_1.pgPool.query(`SELECT warehouse_id, item_id, quantity
         FROM warehouse_stocks
         WHERE warehouse_id = ANY($1::text[]) AND item_id = ANY($2::text[])`, [warehouseIds, itemIds]);
            for (const row of stockRows.rows || []) {
                stockMap.set(`${String(row.warehouse_id)}::${String(row.item_id)}`, Number(row.quantity || 0));
            }
        }
        return res.json({
            warehouses,
            items: items.map((row) => {
                const itemId = toConsumableInventoryItemId(String(row.id));
                const stock_by_warehouse = warehouses.map((warehouse) => ({
                    warehouse_id: String(warehouse.id),
                    quantity: Number(stockMap.get(`${String(warehouse.id)}::${itemId}`) || 0),
                }));
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
                    total_quantity: stock_by_warehouse.reduce((sum, stock) => sum + Number(stock.quantity || 0), 0),
                };
            }),
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/other-items-prices', (0, auth_1.requireAnyPerm)(['inventory.view', 'inventory.po.manage']), async (_req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureOtherPriceListSchema();
        await backfillOtherSkus();
        await ensureOtherInventoryItemsSynced();
        const rows = await dbAdapter_1.pgPool.query(`SELECT * FROM other_items_price_list ORDER BY sort_order ASC NULLS LAST, item_name ASC`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/other-items-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = consumablePriceUpdateSchema.extend({
        item_name: zod_1.z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureOtherPriceListSchema();
        const id = (0, uuid_1.v4)();
        const row = {
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
        };
        const created = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const inserted = await client.query(`INSERT INTO other_items_price_list (id, sku, item_name, cost_unit_price, unit_price, currency, unit, default_quantity, sort_order, is_active, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`, [row.id, row.sku, row.item_name, row.cost_unit_price, row.unit_price, row.currency, row.unit, row.default_quantity, row.sort_order, row.is_active, row.updated_at, row.updated_by]);
            await syncOtherInventoryItemFromPriceRow(((_a = inserted.rows) === null || _a === void 0 ? void 0 : _a[0]) || row, client);
            return ((_b = inserted.rows) === null || _b === void 0 ? void 0 : _b[0]) || row;
        });
        return res.status(201).json(created || row);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/other-items-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const parsed = consumablePriceUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureOtherPriceListSchema();
        const updated = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const current = await client.query(`SELECT * FROM other_items_price_list WHERE id = $1`, [id]);
            const existing = (_a = current.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!existing)
                throw httpError(404, 'not found');
            const nextPayload = {
                ...(parsed.data.item_name !== undefined ? { item_name: String(parsed.data.item_name || '').trim() } : {}),
                ...(parsed.data.cost_unit_price !== undefined ? { cost_unit_price: Number(parsed.data.cost_unit_price || 0) } : {}),
                ...(parsed.data.unit_price !== undefined ? { unit_price: Number(parsed.data.unit_price || 0) } : {}),
                ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency || 'AUD' } : {}),
                ...(parsed.data.unit !== undefined ? { unit: parsed.data.unit || null } : {}),
                ...(parsed.data.default_quantity !== undefined ? { default_quantity: parsed.data.default_quantity != null ? Number(parsed.data.default_quantity) : null } : {}),
                ...(parsed.data.is_active !== undefined ? { is_active: !!parsed.data.is_active } : {}),
                updated_at: new Date().toISOString(),
                updated_by: actorId(req),
            };
            const keys = Object.keys(nextPayload);
            if (!keys.length)
                return existing;
            const sets = keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
            const values = keys.map((key) => nextPayload[key]);
            const result = await client.query(`UPDATE other_items_price_list SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, [...values, id]);
            const row = ((_b = result.rows) === null || _b === void 0 ? void 0 : _b[0]) || { ...existing, ...nextPayload };
            await syncOtherInventoryItemFromPriceRow(row, client);
            return row;
        });
        return res.json(updated || null);
    }
    catch (e) {
        const status = Number((e === null || e === void 0 ? void 0 : e.statusCode) || 500);
        return res.status(status).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/other-items-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureOtherPriceListSchema();
        await ensureInventorySchema();
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`DELETE FROM other_items_price_list WHERE id = $1`, [id]);
            await client.query(`DELETE FROM inventory_items WHERE id = $1`, [toOtherInventoryItemId(id)]);
            await client.query(`DELETE FROM warehouse_stocks WHERE item_id = $1`, [toOtherInventoryItemId(id)]);
        });
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/other-stock-overview', (0, auth_1.requirePerm)('inventory.view'), async (_req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json({ warehouses: [], items: [] });
        await ensureOtherPriceListSchema();
        await ensureOtherInventoryItemsSynced();
        await ensureInventorySchema();
        const [warehouseRows, priceRows] = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT id, code, name, active FROM warehouses WHERE active = true ORDER BY code ASC`),
            dbAdapter_1.pgPool.query(`SELECT * FROM other_items_price_list WHERE is_active = true ORDER BY sort_order ASC NULLS LAST, item_name ASC`),
        ]);
        const warehouses = warehouseRows.rows || [];
        const items = priceRows.rows || [];
        const itemIds = items.map((row) => toOtherInventoryItemId(String(row.id)));
        const warehouseIds = warehouses.map((row) => String(row.id));
        const stockMap = new Map();
        if (itemIds.length && warehouseIds.length) {
            const stockRows = await dbAdapter_1.pgPool.query(`SELECT warehouse_id, item_id, quantity
         FROM warehouse_stocks
         WHERE warehouse_id = ANY($1::text[]) AND item_id = ANY($2::text[])`, [warehouseIds, itemIds]);
            for (const row of stockRows.rows || []) {
                stockMap.set(`${String(row.warehouse_id)}::${String(row.item_id)}`, Number(row.quantity || 0));
            }
        }
        return res.json({
            warehouses,
            items: items.map((row) => {
                const itemId = toOtherInventoryItemId(String(row.id));
                const stock_by_warehouse = warehouses.map((warehouse) => ({
                    warehouse_id: String(warehouse.id),
                    quantity: Number(stockMap.get(`${String(warehouse.id)}::${itemId}`) || 0),
                }));
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
                    total_quantity: stock_by_warehouse.reduce((sum, stock) => sum + Number(stock.quantity || 0), 0),
                };
            }),
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/consumable-usage-records', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    const parsed = consumableUsageQuerySchema.safeParse(req.query || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        const where = [`(COALESCE(u.status,'') = 'low' OR u.need_restock = true)`];
        const values = [];
        const propertyId = String(parsed.data.property_id || '').trim();
        const itemId = String(parsed.data.item_id || '').trim();
        const keyword = String(parsed.data.keyword || '').trim();
        const from = String(parsed.data.from || '').trim();
        const to = String(parsed.data.to || '').trim();
        if (propertyId) {
            values.push(propertyId);
            where.push(`COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) = $${values.length}`);
        }
        if (itemId) {
            values.push(itemId);
            where.push(`u.item_id::text = $${values.length}`);
        }
        if (from) {
            values.push(from);
            where.push(`COALESCE(t.task_date, t.date, u.created_at)::date >= $${values.length}::date`);
        }
        if (to) {
            values.push(to);
            where.push(`COALESCE(t.task_date, t.date, u.created_at)::date <= $${values.length}::date`);
        }
        if (keyword) {
            values.push(`%${keyword}%`);
            where.push(`(
        COALESCE(p_id.code::text, p_code.code::text, '') ILIKE $${values.length}
        OR COALESCE(p_id.address::text, p_code.address::text, '') ILIKE $${values.length}
        OR COALESCE(u.item_label::text, c.label::text, u.item_id::text, '') ILIKE $${values.length}
        OR COALESCE(u.note::text, '') ILIKE $${values.length}
      )`);
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
    `;
        const result = await dbAdapter_1.pgPool.query(sql, values);
        return res.json((result.rows || []).map((row) => ({
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
        })));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const linenTypeSchema = zod_1.z.object({
    code: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    psl_code: zod_1.z.string().optional(),
    in_set: zod_1.z.boolean().optional(),
    set_divisor: zod_1.z.number().int().min(1).optional(),
    sort_order: zod_1.z.number().int().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.get('/linen-types', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`
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
      `);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen-types', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const parsed = linenTypeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const v = parsed.data;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_linen_types (code, name, psl_code, in_set, set_divisor, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING code, name, psl_code, in_set, set_divisor, sort_order, active`, [v.code, v.name, (_a = v.psl_code) !== null && _a !== void 0 ? _a : null, (_b = v.in_set) !== null && _b !== void 0 ? _b : true, (_c = v.set_divisor) !== null && _c !== void 0 ? _c : 1, (_d = v.sort_order) !== null && _d !== void 0 ? _d : 0, (_e = v.active) !== null && _e !== void 0 ? _e : true]);
        const itemId = `item.linen_type.${v.code}`;
        await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
       VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`, [itemId, v.name, `LT:${v.code}`, v.code, (_f = v.active) !== null && _f !== void 0 ? _f : true]);
        (0, store_1.addAudit)('InventoryLinenType', v.code, 'create', null, ((_g = row.rows) === null || _g === void 0 ? void 0 : _g[0]) || null, actorId(req));
        return res.status(201).json(((_h = row.rows) === null || _h === void 0 ? void 0 : _h[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/linen-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const code = String(req.params.code || '').trim();
    const parsed = linenTypeSchema.partial().safeParse({ ...req.body, code });
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code]);
        const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!b)
            return res.status(404).json({ message: 'not found' });
        const payload = parsed.data;
        const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code');
        if (!keys.length)
            return res.json(b);
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map(k => payload[k]);
        const sql = `UPDATE inventory_linen_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, psl_code, in_set, set_divisor, sort_order, active`;
        const after = await dbAdapter_1.pgPool.query(sql, [...values, code]);
        const a = (_b = after.rows) === null || _b === void 0 ? void 0 : _b[0];
        if (a) {
            const itemId = `item.linen_type.${code}`;
            await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,'linen',$4,'pcs',0,NULL,$5,false)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, linen_type_code = EXCLUDED.linen_type_code`, [itemId, a.name, `LT:${code}`, code, a.active]);
        }
        (0, store_1.addAudit)('InventoryLinenType', code, 'update', b, ((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, actorId(req));
        return res.json(((_d = after.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/linen-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const itemId = `item.linen_type.${code}`;
        const used1 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM warehouse_stocks WHERE item_id = $1 LIMIT 1`, [itemId]);
        if ((used1.rows || []).length)
            return res.status(409).json({ message: '该类型已有库存记录，无法删除' });
        const used2 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM stock_movements WHERE item_id = $1 LIMIT 1`, [itemId]);
        if ((used2.rows || []).length)
            return res.status(409).json({ message: '该类型已有流水记录，无法删除' });
        const used3 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM purchase_order_lines WHERE item_id = $1 LIMIT 1`, [itemId]);
        if ((used3.rows || []).length)
            return res.status(409).json({ message: '该类型已有采购记录，无法删除' });
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_linen_types WHERE code = $1`, [code]);
        const b = ((_a = before.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`DELETE FROM inventory_linen_types WHERE code = $1`, [code]);
            await client.query(`DELETE FROM inventory_items WHERE id = $1`, [itemId]);
            return { ok: true };
        });
        (0, store_1.addAudit)('InventoryLinenType', code, 'delete', b, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const roomTypeSchema = zod_1.z.object({
    code: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    bedrooms: zod_1.z.number().int().min(0).optional(),
    bathrooms: zod_1.z.number().int().min(0).optional(),
    sort_order: zod_1.z.number().int().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.get('/room-types', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types ORDER BY active DESC, sort_order ASC, code ASC`);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/room-types', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f;
    const parsed = roomTypeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const v = parsed.data;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_room_types (code, name, bedrooms, bathrooms, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING code, name, bedrooms, bathrooms, sort_order, active`, [v.code, v.name, (_a = v.bedrooms) !== null && _a !== void 0 ? _a : null, (_b = v.bathrooms) !== null && _b !== void 0 ? _b : null, (_c = v.sort_order) !== null && _c !== void 0 ? _c : 0, (_d = v.active) !== null && _d !== void 0 ? _d : true]);
        (0, store_1.addAudit)('InventoryRoomType', v.code, 'create', null, ((_e = row.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, actorId(req));
        return res.status(201).json(((_f = row.rows) === null || _f === void 0 ? void 0 : _f[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/room-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c;
    const code = String(req.params.code || '').trim();
    const parsed = roomTypeSchema.partial().safeParse({ ...req.body, code });
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code]);
        const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!b)
            return res.status(404).json({ message: 'not found' });
        const payload = parsed.data;
        const keys = Object.keys(payload).filter(k => payload[k] !== undefined && k !== 'code');
        if (!keys.length)
            return res.json(b);
        const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map(k => payload[k]);
        const sql = `UPDATE inventory_room_types SET ${sets}, updated_at = now() WHERE code = $${keys.length + 1} RETURNING code, name, bedrooms, bathrooms, sort_order, active`;
        const after = await dbAdapter_1.pgPool.query(sql, [...values, code]);
        (0, store_1.addAudit)('InventoryRoomType', code, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
        return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/room-types/:code', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const used1 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM inventory_room_type_requirements WHERE room_type_code = $1 LIMIT 1`, [code]);
        if ((used1.rows || []).length)
            return res.status(409).json({ message: '该房型已有占用配置，无法删除' });
        const used2 = await dbAdapter_1.pgPool.query(`SELECT 1 FROM properties WHERE room_type_code = $1 LIMIT 1`, [code]);
        if ((used2.rows || []).length)
            return res.status(409).json({ message: '该房型已被房源使用，无法删除' });
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code]);
        const b = ((_a = before.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        await dbAdapter_1.pgPool.query(`DELETE FROM inventory_room_types WHERE code = $1`, [code]);
        (0, store_1.addAudit)('InventoryRoomType', code, 'delete', b, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/room-types/:code/requirements', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const [rt, reqs, types] = await Promise.all([
                dbAdapter_1.pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order, active FROM inventory_room_types WHERE code = $1`, [code]),
                dbAdapter_1.pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code]),
                dbAdapter_1.pgPool.query(`SELECT code, name, sort_order, active FROM inventory_linen_types WHERE active = true ORDER BY sort_order ASC, code ASC`),
            ]);
            const roomType = ((_a = rt.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!roomType)
                return res.status(404).json({ message: 'not found' });
            const map = new Map((reqs.rows || []).map((r) => [String(r.linen_type_code), Number(r.quantity || 0)]));
            const out = (types.rows || []).map((t) => ({
                linen_type_code: String(t.code),
                linen_type_name: String(t.name),
                quantity: Number(map.get(String(t.code)) || 0),
            }));
            return res.json({ room_type: roomType, requirements: out });
        }
        return res.json({ room_type: null, requirements: [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const roomTypeRequirementsSchema = zod_1.z.object({
    requirements: zod_1.z.array(zod_1.z.object({
        linen_type_code: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(0),
    })),
});
exports.router.put('/room-types/:code/requirements', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const code = String(req.params.code || '').trim();
    const parsed = roomTypeRequirementsSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const rt = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_room_types WHERE code = $1`, [code]);
        const roomType = (_a = rt.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!roomType)
            return res.status(404).json({ message: 'not found' });
        const next = (parsed.data.requirements || []).map((r) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }));
        const nextMap = new Map(next.map((r) => [r.linen_type_code, r.quantity]));
        const old = await dbAdapter_1.pgPool.query(`SELECT linen_type_code, quantity FROM inventory_room_type_requirements WHERE room_type_code = $1`, [code]);
        const oldRows = old.rows || [];
        const oldMap = new Map(oldRows.map((r) => [String(r.linen_type_code), Number(r.quantity || 0)]));
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            for (const [k] of oldMap.entries()) {
                if (!nextMap.has(k))
                    await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k]);
            }
            for (const [k, qty] of nextMap.entries()) {
                if (qty <= 0) {
                    await client.query(`DELETE FROM inventory_room_type_requirements WHERE room_type_code = $1 AND linen_type_code = $2`, [code, k]);
                }
                else {
                    await client.query(`INSERT INTO inventory_room_type_requirements (room_type_code, linen_type_code, quantity)
             VALUES ($1,$2,$3)
             ON CONFLICT (room_type_code, linen_type_code)
             DO UPDATE SET quantity = EXCLUDED.quantity`, [code, k, qty]);
                }
            }
            return { ok: true };
        });
        (0, store_1.addAudit)('InventoryRoomType', code, 'update_requirements', { requirements: oldRows }, { requirements: next }, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/items', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d;
    try {
        const q = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.q) || '').trim();
        const category = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.category) || '').trim();
        const active = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.active) || '').trim().toLowerCase();
        const linenTypeCode = String(((_d = req.query) === null || _d === void 0 ? void 0 : _d.linen_type_code) || '').trim();
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const where = [];
            const values = [];
            const linenAlias = category === 'linen' ? 'i' : '';
            const col = (name) => linenAlias ? `${linenAlias}.${name}` : name;
            if (q) {
                values.push(`%${q}%`);
                values.push(`%${q}%`);
                where.push(`(${col('name')} ILIKE $${values.length - 1} OR ${col('sku')} ILIKE $${values.length})`);
            }
            if (category) {
                values.push(category);
                where.push(`${col('category')} = $${values.length}`);
            }
            if (active === 'true' || active === 'false') {
                values.push(active === 'true');
                where.push(`${col('active')} = $${values.length}`);
            }
            if (linenTypeCode) {
                values.push(linenTypeCode);
                where.push(`${col('linen_type_code')} = $${values.length}`);
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
             ORDER BY name ASC`;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(rows.rows || []);
        }
        return res.json(store_1.db.inventoryItems || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const createItemSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    sku: zod_1.z.string().min(1),
    category: zod_1.z.enum(['linen', 'consumable', 'daily']).optional(),
    sub_type: zod_1.z.string().optional(),
    linen_type_code: zod_1.z.string().optional(),
    unit: zod_1.z.string().min(1),
    default_threshold: zod_1.z.number().int().min(0).optional(),
    bin_location: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
    is_key_item: zod_1.z.boolean().optional(),
});
exports.router.post('/items', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f;
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const item = {
                id: (0, uuid_1.v4)(),
                name: parsed.data.name,
                sku: parsed.data.sku,
                category: parsed.data.category || 'consumable',
                sub_type: parsed.data.sub_type || null,
                linen_type_code: parsed.data.linen_type_code || null,
                unit: parsed.data.unit,
                default_threshold: (_a = parsed.data.default_threshold) !== null && _a !== void 0 ? _a : 0,
                bin_location: parsed.data.bin_location || null,
                active: (_b = parsed.data.active) !== null && _b !== void 0 ? _b : true,
                is_key_item: (_c = parsed.data.is_key_item) !== null && _c !== void 0 ? _c : false,
            };
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_items (id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`, [item.id, item.name, item.sku, item.category, item.sub_type, item.linen_type_code, item.unit, item.default_threshold, item.bin_location, item.active, item.is_key_item]);
            (0, store_1.addAudit)('InventoryItem', item.id, 'create', null, ((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || item, actorId(req));
            return res.status(201).json(((_e = row.rows) === null || _e === void 0 ? void 0 : _e[0]) || item);
        }
        const item = { id: (0, uuid_1.v4)(), threshold: (_f = parsed.data.default_threshold) !== null && _f !== void 0 ? _f : 0, quantity: 0, ...parsed.data, category: parsed.data.category || 'consumable' };
        store_1.db.inventoryItems.push(item);
        (0, store_1.addAudit)('InventoryItem', item.id, 'create', null, item, actorId(req));
        return res.status(201).json(item);
    }
    catch (e) {
        const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
        if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg))
            return res.status(400).json({ message: 'SKU 已存在' });
        return res.status(500).json({ message: msg || 'failed' });
    }
});
const patchItemSchema = createItemSchema.partial();
exports.router.patch('/items/:id', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = patchItemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM inventory_items WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'item not found' });
            const payload = parsed.data;
            const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
            if (!keys.length)
                return res.json(b);
            const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map(k => payload[k]);
            const sql = `UPDATE inventory_items SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`;
            const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
            (0, store_1.addAudit)('InventoryItem', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        const it = store_1.db.inventoryItems.find((x) => x.id === id);
        if (!it)
            return res.status(404).json({ message: 'item not found' });
        const before = { ...it };
        Object.assign(it, parsed.data);
        (0, store_1.addAudit)('InventoryItem', id, 'update', before, it, actorId(req));
        return res.json(it);
    }
    catch (e) {
        const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
        if (/unique_inventory_items_sku/i.test(msg) || /duplicate key value/i.test(msg))
            return res.status(400).json({ message: 'SKU 已存在' });
        return res.status(500).json({ message: msg || 'failed' });
    }
});
exports.router.get('/stocks', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d;
    const warehouse_id = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
    if (!warehouse_id)
        return res.status(400).json({ message: 'warehouse_id required' });
    const warningsOnly = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.warnings_only) || '').toLowerCase() === 'true';
    const keyOnly = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.key_only) || '').toLowerCase() === 'true';
    const category = String(((_d = req.query) === null || _d === void 0 ? void 0 : _d.category) || '').trim();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            if (category) {
                const itemVals = [category];
                let itemSql = category === 'linen'
                    ? `SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item, lt.sort_order
               FROM inventory_items i
               LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
               WHERE i.category = $1`
                    : `SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
               FROM inventory_items
               WHERE category = $1`;
                if (keyOnly)
                    itemSql += ` AND is_key_item = true`;
                itemSql += category === 'linen'
                    ? ` ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`
                    : ` ORDER BY name ASC`;
                const items = await dbAdapter_1.pgPool.query(itemSql, itemVals);
                const itemRows = items.rows || [];
                if (!itemRows.length)
                    return res.json([]);
                const itemMap = new Map(itemRows.map((r) => [String(r.id), r]));
                const ids = itemRows.map((r) => String(r.id));
                const stocks = await dbAdapter_1.pgPool.query(`SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE warehouse_id = $1 AND item_id = ANY($2::text[])
           ORDER BY item_id ASC`, [warehouse_id, ids]);
                let out = (stocks.rows || []).map((s) => {
                    const it = itemMap.get(String(s.item_id)) || {};
                    const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0);
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
                    };
                }).sort((a, b) => {
                    if (category === 'linen') {
                        const sortA = Number.isFinite(Number(a.sort_order)) ? Number(a.sort_order) : 9999;
                        const sortB = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : 9999;
                        if (sortA !== sortB)
                            return sortA - sortB;
                    }
                    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
                });
                if (warningsOnly)
                    out = out.filter((x) => Number(x.quantity || 0) < Number(x.threshold_effective || 0));
                return res.json(out);
            }
            const values = [warehouse_id];
            const where = [`s.warehouse_id = $1`];
            if (keyOnly)
                where.push(`i.is_key_item = true`);
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            let out = (rows.rows || []).map((r) => ({
                ...r,
                threshold_effective: r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0),
            }));
            if (warningsOnly)
                out = out.filter((x) => Number(x.quantity || 0) < Number(x.threshold_effective || 0));
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/warnings', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    const warehouse_id = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const values = [];
            const where = [];
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`s.warehouse_id = $${values.length}`);
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            const out = (rows.rows || []).map((r) => {
                const eff = r.threshold === null || r.threshold === undefined ? Number(r.default_threshold || 0) : Number(r.threshold || 0);
                return { ...r, threshold_effective: eff };
            }).filter((x) => Number(x.quantity || 0) < Number(x.threshold_effective || 0));
            return res.json(out);
        }
        return res.json((store_1.db.inventoryItems || []).filter((i) => i.quantity < i.threshold));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const movementSchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    type: zod_1.z.enum(['in', 'out', 'adjust']),
    quantity: zod_1.z.number().int(),
    reason: zod_1.z.string().optional(),
    property_id: zod_1.z.string().optional(),
    ref_type: zod_1.z.string().optional(),
    ref_id: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
}).superRefine((v, ctx) => {
    if (v.type === 'in' || v.type === 'out') {
        if (v.quantity <= 0)
            ctx.addIssue({ code: 'custom', message: 'quantity must be >= 1', path: ['quantity'] });
    }
    else {
        if (v.quantity === 0)
            ctx.addIssue({ code: 'custom', message: 'quantity must not be 0', path: ['quantity'] });
    }
});
exports.router.post('/movements', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = movementSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
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
                });
                if (!r.ok)
                    return r;
                const stockRow = r.stock;
                (0, store_1.addAudit)('WarehouseStock', (stockRow === null || stockRow === void 0 ? void 0 : stockRow.id) || `${parsed.data.warehouse_id}.${parsed.data.item_id}`, 'movement', null, { movement_id: r.movement_id, stock: stockRow }, actorId(req));
                return r;
            });
            if (!result)
                return res.status(500).json({ message: 'db not ready' });
            if (!result.ok)
                return res.status(result.code).json({ message: result.message });
            return res.json(result.stock || null);
        }
        const item = store_1.db.inventoryItems.find((i) => i.id === parsed.data.item_id);
        if (!item)
            return res.status(404).json({ message: 'item not found' });
        const before = { ...item };
        if (parsed.data.type === 'in')
            item.quantity += parsed.data.quantity;
        else if (parsed.data.type === 'out') {
            if (item.quantity < parsed.data.quantity)
                return res.status(409).json({ message: 'insufficient stock' });
            item.quantity -= parsed.data.quantity;
        }
        else
            item.quantity += parsed.data.quantity;
        store_1.db.stockMovements.push({ id: (0, uuid_1.v4)(), item_id: item.id, type: parsed.data.type, quantity: parsed.data.quantity, timestamp: new Date().toISOString() });
        (0, store_1.addAudit)('InventoryItem', item.id, 'movement', before, item, actorId(req));
        return res.json(item);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const transferSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    to_warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
    note: zod_1.z.string().optional(),
    photo_url: zod_1.z.string().optional(),
});
const transferRecordCreateSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    to_warehouse_id: zod_1.z.string().min(1),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        item_id: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(1),
    })).min(1),
});
const transferRecordUpdateSchema = transferRecordCreateSchema;
function normalizeTransferRecordLines(lines) {
    const normalized = Array.from((lines || []).reduce((map, line) => {
        const itemId = String((line === null || line === void 0 ? void 0 : line.item_id) || '').trim();
        const quantity = Number((line === null || line === void 0 ? void 0 : line.quantity) || 0);
        if (!itemId || quantity < 1)
            return map;
        map.set(itemId, (map.get(itemId) || 0) + quantity);
        return map;
    }, new Map())).map(([item_id, quantity]) => ({ item_id, quantity }));
    return normalized;
}
async function loadLegacyTransferRecordDetail(client, id) {
    var _a, _b, _c;
    const rs = await client.query(`SELECT
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
     ORDER BY m.created_at DESC, m.item_id ASC`, [id]);
    if (!((_a = rs.rows) === null || _a === void 0 ? void 0 : _a.length))
        return null;
    const detail = {
        id,
        status: 'completed',
        created_at: ((_b = rs.rows[0]) === null || _b === void 0 ? void 0 : _b.created_at) || null,
        updated_at: null,
        cancelled_at: null,
        cancelled_by: null,
        note: ((_c = rs.rows.find((row) => row.note)) === null || _c === void 0 ? void 0 : _c.note) || null,
        from_warehouse_id: '',
        from_warehouse_code: '',
        from_warehouse_name: '',
        to_warehouse_id: '',
        to_warehouse_code: '',
        to_warehouse_name: '',
        lines: [],
    };
    for (const row of rs.rows || []) {
        if (!detail.created_at || String(detail.created_at) < String(row.created_at || ''))
            detail.created_at = row.created_at;
        if (row.type === 'out') {
            detail.from_warehouse_id = String(row.warehouse_id || '');
            detail.from_warehouse_code = String(row.warehouse_code || '');
            detail.from_warehouse_name = String(row.warehouse_name || '');
        }
        if (row.type === 'in') {
            detail.to_warehouse_id = String(row.warehouse_id || '');
            detail.to_warehouse_code = String(row.warehouse_code || '');
            detail.to_warehouse_name = String(row.warehouse_name || '');
        }
        let line = detail.lines.find((item) => String(item.item_id) === String(row.item_id || ''));
        if (!line) {
            line = {
                item_id: String(row.item_id || ''),
                item_name: String(row.item_name || ''),
                item_sku: String(row.item_sku || ''),
                item_category: String(row.item_category || ''),
                quantity: 0,
            };
            detail.lines.push(line);
        }
        if (row.type === 'out')
            line.quantity = Number(row.quantity || 0);
    }
    detail.item_count = Number(detail.lines.length);
    detail.quantity_total = Number(detail.lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0));
    return detail;
}
async function materializeLegacyTransferRecordInTx(client, id) {
    var _a, _b;
    const existing = await client.query(`SELECT id FROM inventory_transfer_records WHERE id = $1 LIMIT 1`, [id]);
    if ((_b = (_a = existing.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id)
        return;
    const legacy = await loadLegacyTransferRecordDetail(client, id);
    if (!legacy)
        return;
    await client.query(`INSERT INTO inventory_transfer_records (id, from_warehouse_id, to_warehouse_id, status, note, created_at)
     VALUES ($1,$2,$3,'completed',$4,$5)
     ON CONFLICT (id) DO NOTHING`, [id, legacy.from_warehouse_id, legacy.to_warehouse_id, legacy.note || null, legacy.created_at || new Date().toISOString()]);
    for (const line of legacy.lines || []) {
        await client.query(`INSERT INTO inventory_transfer_record_lines (id, record_id, item_id, quantity)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (record_id, item_id) DO NOTHING`, [(0, uuid_1.v4)(), id, String(line.item_id || ''), Number(line.quantity || 0)]);
    }
}
async function loadTransferRecordDetail(client, id) {
    var _a;
    const metaRes = await client.query(`SELECT tr.*,
            fw.code AS from_warehouse_code,
            fw.name AS from_warehouse_name,
            tw.code AS to_warehouse_code,
            tw.name AS to_warehouse_name
     FROM inventory_transfer_records tr
     JOIN warehouses fw ON fw.id = tr.from_warehouse_id
     JOIN warehouses tw ON tw.id = tr.to_warehouse_id
     WHERE tr.id = $1
     LIMIT 1`, [id]);
    const meta = ((_a = metaRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
    if (!meta)
        return loadLegacyTransferRecordDetail(client, id);
    const linesRes = await client.query(`SELECT l.item_id, l.quantity, i.name AS item_name, i.sku AS item_sku, i.category AS item_category
     FROM inventory_transfer_record_lines l
     JOIN inventory_items i ON i.id = l.item_id
     WHERE l.record_id = $1
     ORDER BY i.name ASC, l.item_id ASC`, [id]);
    const lines = (linesRes.rows || []).map((row) => ({
        item_id: String(row.item_id || ''),
        item_name: String(row.item_name || ''),
        item_sku: String(row.item_sku || ''),
        item_category: String(row.item_category || ''),
        quantity: Number(row.quantity || 0),
    }));
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
        quantity_total: Number(lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0)),
        lines,
    };
}
async function applyTransferRecordStockInTx(client, input) {
    for (const line of input.lines || []) {
        const fromType = input.direction === 'apply' ? 'out' : 'in';
        const toType = input.direction === 'apply' ? 'in' : 'out';
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
        });
        if (!out.ok)
            return out;
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
        });
        if (!inn.ok)
            return inn;
    }
    return { ok: true };
}
exports.router.get('/transfers', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const fromWh = String(q.from_warehouse_id || '').trim();
            const toWh = String(q.to_warehouse_id || '').trim();
            const itemId = String(q.item_id || '').trim();
            const category = String(q.category || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 200)));
            let itemIdsByCategory = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                itemIdsByCategory = (its.rows || []).map((r) => String(r.id));
                if (!itemIdsByCategory.length)
                    return res.json([]);
            }
            const where = [`m.ref_type = 'transfer'`];
            const values = [];
            if (fromWh) {
                values.push(fromWh);
                where.push(`(m.type = 'out' AND m.warehouse_id = $${values.length})`);
            }
            if (toWh) {
                values.push(toWh);
                where.push(`(m.type = 'in' AND m.warehouse_id = $${values.length})`);
            }
            if (itemId) {
                values.push(itemId);
                where.push(`m.item_id = $${values.length}`);
            }
            if (itemIdsByCategory) {
                values.push(itemIdsByCategory);
                where.push(`m.item_id = ANY($${values.length}::text[])`);
            }
            if (from) {
                values.push(from);
                where.push(`m.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`m.created_at <= $${values.length}::timestamptz`);
            }
            values.push(limit);
            const moves = await dbAdapter_1.pgPool.query(`SELECT
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
         LIMIT $${values.length}`, values);
            const rows = moves.rows || [];
            if (!rows.length)
                return res.json([]);
            const byRef = new Map();
            for (const r of rows) {
                const ref = String(r.ref_id || '');
                if (!ref)
                    continue;
                const key = `${ref}:${String(r.item_id)}`;
                const cur = byRef.get(key) || { transfer_id: ref, item_id: String(r.item_id) };
                if (r.type === 'out')
                    cur.from_warehouse_id = String(r.warehouse_id);
                if (r.type === 'in')
                    cur.to_warehouse_id = String(r.warehouse_id);
                cur.quantity = Number(r.quantity || 0);
                cur.created_at = cur.created_at ? (String(cur.created_at) > String(r.created_at) ? cur.created_at : r.created_at) : r.created_at;
                if (r.note && !cur.note)
                    cur.note = r.note;
                if (r.photo_url && !cur.photo_url)
                    cur.photo_url = r.photo_url;
                byRef.set(key, cur);
            }
            const list = Array.from(byRef.values());
            const warehouseIds = Array.from(new Set(list.flatMap((x) => [x.from_warehouse_id, x.to_warehouse_id]).filter(Boolean)));
            const itemIds = Array.from(new Set(list.map((x) => x.item_id).filter(Boolean)));
            const [whRows, itRows] = await Promise.all([
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                itemIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] }),
            ]);
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const itMap = new Map(itRows.rows.map((r) => [String(r.id), r]));
            const out = list.map((x) => {
                const fw = whMap.get(String(x.from_warehouse_id)) || {};
                const tw = whMap.get(String(x.to_warehouse_id)) || {};
                const it = itMap.get(String(x.item_id)) || {};
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
                };
            }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const transferRoomTypeSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    to_warehouse_id: zod_1.z.string().min(1),
    room_type_code: zod_1.z.string().min(1),
    sets: zod_1.z.number().int().min(1),
    delivery_plan_id: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    photo_url: zod_1.z.string().optional(),
});
exports.router.post('/transfers/room-type', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = transferRoomTypeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json({ message: 'same warehouse' });
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'transfer not available without PG' });
        await ensureInventorySchema();
        const transferId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            const reqs = await client.query(`SELECT linen_type_code, quantity
         FROM inventory_room_type_requirements
         WHERE room_type_code = $1`, [parsed.data.room_type_code]);
            const lines = (reqs.rows || [])
                .map((r) => ({ linen_type_code: String(r.linen_type_code), quantity: Number(r.quantity || 0) }))
                .filter((r) => r.linen_type_code && r.quantity > 0);
            if (!lines.length)
                return { ok: false, code: 400, message: '该房型未配置占用清单' };
            for (const ln of lines) {
                const item_id = `item.linen_type.${ln.linen_type_code}`;
                const qty = parsed.data.sets * ln.quantity;
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
                });
                if (!out.ok)
                    return out;
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
                });
                if (!inn.ok)
                    return inn;
            }
            if (parsed.data.delivery_plan_id) {
                await client.query(`UPDATE linen_delivery_plan_lines
           SET actual_sets = $1, vehicle_load_sets = $1
           WHERE plan_id = $2
             AND to_warehouse_id = $3
             AND room_type_code = $4`, [parsed.data.sets, parsed.data.delivery_plan_id, parsed.data.to_warehouse_id, parsed.data.room_type_code]);
                await client.query(`UPDATE linen_delivery_plans
           SET status = 'dispatched', updated_at = now()
           WHERE id = $1`, [parsed.data.delivery_plan_id]);
            }
            return { ok: true, transfer_id: transferId };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        return res.json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/transfers', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json({ message: 'same warehouse' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const transferId = (0, uuid_1.v4)();
            const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
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
                });
                if (!out.ok)
                    return out;
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
                });
                if (!inn.ok)
                    return inn;
                return { ok: true, transfer_id: transferId, from_stock: out.stock, to_stock: inn.stock };
            });
            if (!result)
                return res.status(500).json({ message: 'db not ready' });
            if (!result.ok)
                return res.status(result.code).json({ message: result.message });
            return res.json(result);
        }
        return res.status(501).json({ message: 'transfer not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/transfer-records', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const q = req.query || {};
        const fromWh = String(q.from_warehouse_id || '').trim();
        const toWh = String(q.to_warehouse_id || '').trim();
        const category = String(q.category || '').trim();
        const from = String(q.from || '').trim();
        const to = String(q.to || '').trim();
        const status = String(q.status || '').trim();
        const limit = Math.min(500, Math.max(1, Number(q.limit || 200)));
        const values = [];
        const where = ['1=1'];
        if (fromWh) {
            values.push(fromWh);
            where.push(`tr.from_warehouse_id = $${values.length}`);
        }
        if (toWh) {
            values.push(toWh);
            where.push(`tr.to_warehouse_id = $${values.length}`);
        }
        if (from) {
            values.push(from);
            where.push(`tr.created_at >= $${values.length}::timestamptz`);
        }
        if (to) {
            values.push(to);
            where.push(`tr.created_at <= $${values.length}::timestamptz`);
        }
        if (status) {
            values.push(status);
            where.push(`tr.status = $${values.length}`);
        }
        if (category) {
            values.push(category);
            where.push(`EXISTS (
        SELECT 1
        FROM inventory_transfer_record_lines l
        JOIN inventory_items i ON i.id = l.item_id
        WHERE l.record_id = tr.id AND i.category = $${values.length}
      )`);
        }
        values.push(limit);
        const metaRows = await dbAdapter_1.pgPool.query(`SELECT tr.id,
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
       LIMIT $${values.length}`, values);
        const legacyRows = status && status !== 'completed'
            ? { rows: [] }
            : await (async () => {
                const legacyValues = [];
                const legacyWhere = [`m.ref_type = 'transfer'`, `COALESCE(m.reason, 'transfer') = 'transfer'`, `tr.id IS NULL`];
                if (fromWh) {
                    legacyValues.push(fromWh);
                    legacyWhere.push(`(m.type = 'out' AND m.warehouse_id = $${legacyValues.length})`);
                }
                if (toWh) {
                    legacyValues.push(toWh);
                    legacyWhere.push(`(m.type = 'in' AND m.warehouse_id = $${legacyValues.length})`);
                }
                if (from) {
                    legacyValues.push(from);
                    legacyWhere.push(`m.created_at >= $${legacyValues.length}::timestamptz`);
                }
                if (to) {
                    legacyValues.push(to);
                    legacyWhere.push(`m.created_at <= $${legacyValues.length}::timestamptz`);
                }
                if (category) {
                    legacyValues.push(category);
                    legacyWhere.push(`i.category = $${legacyValues.length}`);
                }
                legacyValues.push(limit);
                return dbAdapter_1.pgPool.query(`SELECT
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
           LIMIT $${legacyValues.length}`, legacyValues);
            })();
        const byId = new Map();
        for (const row of metaRows.rows || []) {
            byId.set(String(row.id || ''), { ...row, lines: [] });
        }
        if (byId.size) {
            const ids = Array.from(byId.keys());
            const linesRes = await dbAdapter_1.pgPool.query(`SELECT l.record_id, l.item_id, l.quantity, i.name AS item_name, i.sku AS item_sku, i.category AS item_category
         FROM inventory_transfer_record_lines l
         JOIN inventory_items i ON i.id = l.item_id
         WHERE l.record_id = ANY($1::text[])
         ORDER BY i.name ASC, l.item_id ASC`, [ids]);
            for (const line of linesRes.rows || []) {
                const current = byId.get(String(line.record_id || ''));
                if (!current)
                    continue;
                current.lines.push({
                    item_id: String(line.item_id || ''),
                    item_name: String(line.item_name || ''),
                    item_sku: String(line.item_sku || ''),
                    quantity: Number(line.quantity || 0),
                });
            }
        }
        for (const row of legacyRows.rows || []) {
            const refId = String(row.ref_id || '');
            if (!refId || byId.has(refId))
                continue;
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
            };
            if (row.type === 'out') {
                current.from_warehouse_id = String(row.warehouse_id || '');
                current.from_warehouse_code = String(row.warehouse_code || '');
                current.from_warehouse_name = String(row.warehouse_name || '');
            }
            if (row.type === 'in') {
                current.to_warehouse_id = String(row.warehouse_id || '');
                current.to_warehouse_code = String(row.warehouse_code || '');
                current.to_warehouse_name = String(row.warehouse_name || '');
            }
            let line = current.lines.find((item) => String(item.item_id) === String(row.item_id || ''));
            if (!line) {
                line = { item_id: String(row.item_id || ''), item_name: String(row.item_name || ''), item_sku: String(row.item_sku || ''), quantity: 0 };
                current.lines.push(line);
            }
            if (row.type === 'out')
                line.quantity = Number(row.quantity || 0);
            byId.set(refId, current);
        }
        const out = Array.from(byId.values())
            .map((row) => ({
            ...row,
            item_count: Number((row.lines || []).length),
            quantity_total: Number((row.lines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0)),
        }))
            .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
            .slice(0, limit);
        return res.json(out);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/transfer-records/:id', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'transfer records not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '').trim();
        if (!id)
            return res.status(400).json({ message: 'id required' });
        const detail = await loadTransferRecordDetail(dbAdapter_1.pgPool, id);
        if (!detail)
            return res.status(404).json({ message: 'not found' });
        return res.json(detail);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/transfer-records', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = transferRecordCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json({ message: 'same warehouse' });
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'transfer not available without PG' });
        await ensureInventorySchema();
        const transferId = (0, uuid_1.v4)();
        const uniqueLines = normalizeTransferRecordLines(parsed.data.lines);
        if (!uniqueLines.length)
            return res.status(400).json({ message: '请至少填写一条调配明细' });
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`INSERT INTO inventory_transfer_records (id, from_warehouse_id, to_warehouse_id, status, note, created_by)
         VALUES ($1,$2,$3,'completed',$4,$5)`, [transferId, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null, actorId(req)]);
            for (const line of uniqueLines) {
                await client.query(`INSERT INTO inventory_transfer_record_lines (id, record_id, item_id, quantity)
           VALUES ($1,$2,$3,$4)`, [(0, uuid_1.v4)(), transferId, line.item_id, line.quantity]);
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
            });
            if (!applied.ok)
                return applied;
            const detail = await loadTransferRecordDetail(client, transferId);
            return { ok: true, transfer_id: transferId, detail };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        return res.json(result.detail || result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/transfer-records/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = transferRecordUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json({ message: 'same warehouse' });
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'transfer not available without PG' });
        await ensureInventorySchema();
        const transferId = String(req.params.id || '').trim();
        const uniqueLines = normalizeTransferRecordLines(parsed.data.lines);
        if (!uniqueLines.length)
            return res.status(400).json({ message: '请至少填写一条调配明细' });
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await materializeLegacyTransferRecordInTx(client, transferId);
            const current = await loadTransferRecordDetail(client, transferId);
            if (!current)
                return { ok: false, code: 404, message: 'not found' };
            if (String(current.status || '') !== 'completed')
                return { ok: false, code: 400, message: '仅已完成配送单可编辑' };
            const reverted = await applyTransferRecordStockInTx(client, {
                record_id: transferId,
                from_warehouse_id: current.from_warehouse_id,
                to_warehouse_id: current.to_warehouse_id,
                note: current.note || null,
                actor_id: actorId(req),
                lines: normalizeTransferRecordLines(current.lines || []),
                direction: 'revert',
                reason: 'transfer_edit_revert',
            });
            if (!reverted.ok)
                return reverted;
            await client.query(`UPDATE inventory_transfer_records
         SET from_warehouse_id = $2,
             to_warehouse_id = $3,
             note = $4,
             updated_at = now()
         WHERE id = $1`, [transferId, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null]);
            await client.query(`DELETE FROM inventory_transfer_record_lines WHERE record_id = $1`, [transferId]);
            for (const line of uniqueLines) {
                await client.query(`INSERT INTO inventory_transfer_record_lines (id, record_id, item_id, quantity)
           VALUES ($1,$2,$3,$4)`, [(0, uuid_1.v4)(), transferId, line.item_id, line.quantity]);
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
            });
            if (!applied.ok)
                return applied;
            const detail = await loadTransferRecordDetail(client, transferId);
            return { ok: true, detail };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(Number((result === null || result === void 0 ? void 0 : result.code) || 400)).json({ message: String((result === null || result === void 0 ? void 0 : result.message) || 'failed') });
        return res.json(result.detail);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/transfer-records/:id/cancel', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'transfer not available without PG' });
        await ensureInventorySchema();
        const transferId = String(req.params.id || '').trim();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await materializeLegacyTransferRecordInTx(client, transferId);
            const current = await loadTransferRecordDetail(client, transferId);
            if (!current)
                return { ok: false, code: 404, message: 'not found' };
            if (String(current.status || '') === 'cancelled')
                return { ok: false, code: 400, message: '该配送单已作废' };
            const reverted = await applyTransferRecordStockInTx(client, {
                record_id: transferId,
                from_warehouse_id: current.from_warehouse_id,
                to_warehouse_id: current.to_warehouse_id,
                note: current.note || null,
                actor_id: actorId(req),
                lines: normalizeTransferRecordLines(current.lines || []),
                direction: 'revert',
                reason: 'transfer_cancel',
            });
            if (!reverted.ok)
                return reverted;
            await client.query(`UPDATE inventory_transfer_records
         SET status = 'cancelled',
             updated_at = now(),
             cancelled_by = $2,
             cancelled_at = now()
         WHERE id = $1`, [transferId, actorId(req)]);
            const detail = await loadTransferRecordDetail(client, transferId);
            return { ok: true, detail };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(Number((result === null || result === void 0 ? void 0 : result.code) || 400)).json({ message: String((result === null || result === void 0 ? void 0 : result.message) || 'failed') });
        return res.json(result.detail);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/upload', (0, auth_1.requirePerm)('inventory.move'), upload.single('file'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ message: 'missing file' });
    try {
        if (!r2_1.hasR2 || !req.file.buffer)
            return res.status(500).json({ message: 'R2 not configured' });
        const img = await (0, uploadImageResize_1.resizeUploadImage)({ buffer: req.file.buffer, contentType: req.file.mimetype, originalName: req.file.originalname });
        const ext = img.ext || path_1.default.extname(req.file.originalname) || '';
        const key = `inventory/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const url = await (0, r2_1.r2Upload)(key, img.contentType || req.file.mimetype || 'application/octet-stream', img.buffer);
        return res.status(201).json({ url });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'upload failed' });
    }
});
exports.router.get('/category-dashboard', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d, _e;
    const category = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.category) || '').trim();
    if (!category)
        return res.status(400).json({ message: 'category required' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const ws = await dbAdapter_1.pgPool.query(`SELECT id, code, name, active FROM warehouses ORDER BY code ASC`);
            const warehouses = (ws.rows || []).filter((w) => w.active);
            const linenTypes = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT code, name, in_set, set_divisor, sort_order
           FROM inventory_linen_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`)
                : { rows: [] };
            const roomTypes = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT code, name, bedrooms, bathrooms, sort_order
           FROM inventory_room_types
           WHERE active = true
           ORDER BY sort_order ASC, code ASC`)
                : { rows: [] };
            const roomTypeReqs = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT room_type_code, linen_type_code, quantity
           FROM inventory_room_type_requirements`)
                : { rows: [] };
            const its = category === 'linen'
                ? await dbAdapter_1.pgPool.query(`SELECT i.id, i.name, i.sku, i.category, i.sub_type, i.linen_type_code, i.unit, i.default_threshold, i.bin_location, i.active, i.is_key_item, lt.sort_order
           FROM inventory_items i
           LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
           WHERE i.category = $1
           ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, [category])
                : await dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type, linen_type_code, unit, default_threshold, bin_location, active, is_key_item
           FROM inventory_items
           WHERE category = $1`, [category]);
            const items = its.rows || [];
            const itemIds = items.map((r) => String(r.id));
            const itemMap = new Map(items.map((r) => [String(r.id), r]));
            const stocksRaw = itemIds.length
                ? await dbAdapter_1.pgPool.query(`SELECT id, warehouse_id, item_id, quantity, threshold
           FROM warehouse_stocks
           WHERE item_id = ANY($1::text[])`, [itemIds])
                : { rows: [] };
            const stocks = (stocksRaw.rows || []).map((s) => {
                const it = itemMap.get(String(s.item_id)) || {};
                const eff = s.threshold === null || s.threshold === undefined ? Number(it.default_threshold || 0) : Number(s.threshold || 0);
                const qty = Number(s.quantity || 0);
                const status = qty <= 0 ? 'out_of_stock' :
                    qty < eff ? 'warning' :
                        'normal';
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
                };
            });
            const totalQty = stocks.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
            const lowSkuCount = stocks.filter((r) => Number(r.quantity || 0) < Number(r.threshold_effective || 0)).length;
            const byWarehouse = new Map();
            for (const w of warehouses) {
                byWarehouse.set(String(w.id), {
                    warehouse_id: String(w.id),
                    warehouse_code: String(w.code),
                    warehouse_name: String(w.name),
                    counts_by_sub_type: {},
                    available_sets: 0,
                    low_stock: false,
                });
            }
            for (const r of stocks) {
                const wh = byWarehouse.get(String(r.warehouse_id));
                if (!wh)
                    continue;
                const st = category === 'linen'
                    ? String(r.linen_type_code || r.sub_type || 'other')
                    : String(r.sub_type || 'other');
                wh.counts_by_sub_type[st] = Number(wh.counts_by_sub_type[st] || 0) + Number(r.quantity || 0);
                if (Number(r.quantity || 0) < Number(r.threshold_effective || 0))
                    wh.low_stock = true;
            }
            const roomTypeMap = new Map((roomTypes.rows || []).map((r) => [String(r.code), r]));
            const reqMap = new Map();
            for (const r of roomTypeReqs.rows || []) {
                const rt = String(r.room_type_code || '');
                const lt = String(r.linen_type_code || '');
                const qty = Number(r.quantity || 0);
                if (!rt || !lt || qty <= 0)
                    continue;
                if (!reqMap.has(rt))
                    reqMap.set(rt, new Map());
                reqMap.get(rt).set(lt, qty);
            }
            const roomTypesArr = roomTypes.rows || [];
            const defaultRoomType = category === 'linen' && roomTypesArr.length ? roomTypesArr[0] : null;
            const defaultRoomTypeCode = defaultRoomType ? String(defaultRoomType.code) : null;
            const defaultRoomTypeName = defaultRoomType ? String(defaultRoomType.name) : null;
            let availableSetsTotal = 0;
            for (const wh of byWarehouse.values()) {
                const c = wh.counts_by_sub_type || {};
                if (category === 'linen') {
                    wh.available_sets_by_room_type = {};
                    for (const [rtCode] of roomTypeMap.entries()) {
                        const reqs = reqMap.get(rtCode);
                        if (!reqs || reqs.size === 0) {
                            wh.available_sets_by_room_type[rtCode] = 0;
                            continue;
                        }
                        const candidates = [];
                        for (const [lt, qty] of reqs.entries()) {
                            const stockQty = Number(c[lt] || 0);
                            candidates.push(Math.floor(stockQty / Math.max(1, qty)));
                        }
                        const sets = candidates.length ? Math.min(...candidates) : 0;
                        wh.available_sets_by_room_type[rtCode] = isFinite(sets) ? Math.max(0, sets) : 0;
                    }
                    wh.available_sets = defaultRoomTypeCode ? Number(wh.available_sets_by_room_type[defaultRoomTypeCode] || 0) : 0;
                }
                else {
                    wh.available_sets = 0;
                }
                availableSetsTotal += Number(wh.available_sets || 0);
            }
            const damagePending = itemIds.length
                ? await dbAdapter_1.pgPool.query(`SELECT COUNT(*)::int AS c
           FROM stock_change_requests
           WHERE status = 'pending'
             AND reason = 'damage'
             AND item_id = ANY($1::text[])`, [itemIds])
                : { rows: [{ c: 0 }] };
            const damagePendingCount = Number(((_c = (_b = damagePending.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.c) || 0);
            const todayMoves = itemIds.length
                ? await dbAdapter_1.pgPool.query(`SELECT type, COALESCE(SUM(quantity),0)::int AS qty
           FROM stock_movements
           WHERE item_id = ANY($1::text[])
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') AT TIME ZONE 'Australia/Melbourne')
           GROUP BY type`, [itemIds])
                : { rows: [] };
            const todayMap = new Map(todayMoves.rows.map((r) => [String(r.type), Number(r.qty || 0)]));
            const todayIn = Number(todayMap.get('in') || 0);
            const todayOut = Number(todayMap.get('out') || 0);
            const cards = {
                total_qty: totalQty,
                available_sets_total: availableSetsTotal,
                available_sets_total_room_type_code: defaultRoomTypeCode,
                available_sets_total_room_type_name: defaultRoomTypeName,
                low_sku_count: lowSkuCount,
                damage_pending_count: damagePendingCount,
                today_in_qty: todayIn,
                today_out_qty: todayOut,
            };
            let unboundPropertyCount = 0;
            if (category === 'linen') {
                try {
                    const c = await dbAdapter_1.pgPool.query(`SELECT COUNT(*)::int AS c FROM properties WHERE room_type_code IS NULL`);
                    unboundPropertyCount = Number(((_e = (_d = c.rows) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.c) || 0);
                }
                catch (_f) { }
            }
            return res.json({
                category,
                linen_types: linenTypes.rows || [],
                room_types: roomTypes.rows || [],
                unbound_property_count: unboundPropertyCount,
                cards,
                warehouses: Array.from(byWarehouse.values()).sort((a, b) => String(a.warehouse_code).localeCompare(String(b.warehouse_code))),
                stocks,
            });
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/unbound-properties', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    const limit = Math.min(500, Math.max(1, Number(((_a = req.query) === null || _a === void 0 ? void 0 : _a.limit) || 200)));
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, code, address, type, region
         FROM properties
         WHERE room_type_code IS NULL
         ORDER BY code NULLS LAST, address ASC
         LIMIT $1`, [limit]);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const changeRequestCreateSchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
    reason: zod_1.z.enum(['damage', 'return_to_supplier']),
    note: zod_1.z.string().optional(),
    photo_url: zod_1.z.string().optional(),
});
const stocktakeCreateSchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    category: zod_1.z.string().min(1),
    stocktake_type: zod_1.z.enum(['initial', 'routine']),
    stocktake_date: zod_1.z.string().min(1),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        item_id: zod_1.z.string().min(1),
        counted_quantity: zod_1.z.number().int().min(0),
    })).min(1),
});
exports.router.post('/stock-change-requests', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    var _a, _b;
    const parsed = changeRequestCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = (0, uuid_1.v4)();
        const created_by = actorId(req);
        const r = await dbAdapter_1.pgPool.query(`INSERT INTO stock_change_requests (id, warehouse_id, item_id, type, quantity, reason, note, photo_url, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`, [
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
        ]);
        (0, store_1.addAudit)('StockChangeRequest', id, 'create', null, ((_a = r.rows) === null || _a === void 0 ? void 0 : _a[0]) || null, actorId(req));
        return res.status(201).json(((_b = r.rows) === null || _b === void 0 ? void 0 : _b[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/stock-change-requests', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const reason = String(q.reason || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const item_id = String(q.item_id || '').trim();
            const category = String(q.category || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 200)));
            let itemIdsByCategory = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                itemIdsByCategory = (its.rows || []).map((r) => String(r.id));
                if (!itemIdsByCategory.length)
                    return res.json([]);
            }
            const where = [];
            const values = [];
            if (status) {
                values.push(status);
                where.push(`r.status = $${values.length}`);
            }
            if (reason) {
                values.push(reason);
                where.push(`r.reason = $${values.length}`);
            }
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`r.warehouse_id = $${values.length}`);
            }
            if (item_id) {
                values.push(item_id);
                where.push(`r.item_id = $${values.length}`);
            }
            if (itemIdsByCategory) {
                values.push(itemIdsByCategory);
                where.push(`r.item_id = ANY($${values.length}::text[])`);
            }
            if (from) {
                values.push(from);
                where.push(`r.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`r.created_at <= $${values.length}::timestamptz`);
            }
            values.push(limit);
            const sql = `
        SELECT r.*
        FROM stock_change_requests r
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC
        LIMIT $${values.length}
      `;
            const rr = await dbAdapter_1.pgPool.query(sql, values);
            const rows = rr.rows || [];
            if (!rows.length)
                return res.json([]);
            const warehouseIds = Array.from(new Set(rows.map((x) => String(x.warehouse_id || '')).filter(Boolean)));
            const itemIds = Array.from(new Set(rows.map((x) => String(x.item_id || '')).filter(Boolean)));
            const [whRows, itRows] = await Promise.all([
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                itemIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] }),
            ]);
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const itMap = new Map(itRows.rows.map((r) => [String(r.id), r]));
            const out = rows.map((r) => {
                const w = whMap.get(String(r.warehouse_id)) || {};
                const it = itMap.get(String(r.item_id)) || {};
                return {
                    ...r,
                    warehouse_code: w.code,
                    warehouse_name: w.name,
                    item_name: it.name,
                    item_sku: it.sku,
                    item_category: it.category,
                    item_sub_type: it.sub_type,
                };
            });
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const changeRequestPatchSchema = zod_1.z.object({
    status: zod_1.z.enum(['approved', 'rejected']),
});
exports.router.patch('/stock-change-requests/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    var _a, _b, _c;
    const id = String(req.params.id || '');
    const parsed = changeRequestPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const handled_by = actorId(req);
        const handled_at = new Date().toISOString();
        if (parsed.data.status === 'rejected') {
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM stock_change_requests WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'not found' });
            if (String(b.status) !== 'pending')
                return res.status(409).json({ message: 'already handled' });
            const after = await dbAdapter_1.pgPool.query(`UPDATE stock_change_requests
         SET status = 'rejected', handled_by = $1, handled_at = $2
         WHERE id = $3
         RETURNING *`, [handled_by, handled_at, id]);
            (0, store_1.addAudit)('StockChangeRequest', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const r0 = await client.query(`SELECT * FROM stock_change_requests WHERE id = $1 FOR UPDATE`, [id]);
            const row = (_a = r0.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!row)
                return { ok: false, code: 404, message: 'not found' };
            if (String(row.status) !== 'pending')
                return { ok: false, code: 409, message: 'already handled' };
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
            });
            if (!move.ok)
                return move;
            const after = await client.query(`UPDATE stock_change_requests
         SET status = 'approved', handled_by = $1, handled_at = $2, movement_id = $3
         WHERE id = $4
         RETURNING *`, [handled_by, handled_at, move.movement_id, id]);
            return { ok: true, row: ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        (0, store_1.addAudit)('StockChangeRequest', id, 'approve', null, result.row || null, actorId(req));
        return res.json(result.row || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/stocktakes', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const q = req.query || {};
        const warehouseId = String(q.warehouse_id || '').trim();
        const category = String(q.category || '').trim();
        const limit = Math.min(200, Math.max(1, Number(q.limit || 50)));
        const values = [];
        const where = [];
        if (warehouseId) {
            values.push(warehouseId);
            where.push(`r.warehouse_id = $${values.length}`);
        }
        if (category) {
            values.push(category);
            where.push(`r.category = $${values.length}`);
        }
        values.push(limit);
        let rs;
        try {
            rs = await dbAdapter_1.pgPool.query(`SELECT
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
         LIMIT $${values.length}`, values);
        }
        catch (error) {
            if (category === 'consumable') {
                console.error('[inventory] consumable stocktakes fallback to empty list:', (error === null || error === void 0 ? void 0 : error.message) || error);
                return res.json([]);
            }
            throw error;
        }
        return res.json(rs.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/stocktakes/:id', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '').trim();
        const head = await dbAdapter_1.pgPool.query(`SELECT r.*, w.code AS warehouse_code, w.name AS warehouse_name
       FROM inventory_stocktake_records r
       JOIN warehouses w ON w.id = r.warehouse_id
       WHERE r.id = $1
       LIMIT 1`, [id]);
        const record = (_a = head.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!record)
            return res.status(404).json({ message: 'not found' });
        const lines = await dbAdapter_1.pgPool.query(`SELECT
         rl.*,
         i.name AS item_name,
         i.sku AS item_sku,
         i.unit AS item_unit
       FROM inventory_stocktake_record_lines rl
       JOIN inventory_items i ON i.id = rl.item_id
       WHERE rl.record_id = $1
       ORDER BY i.name ASC`, [id]);
        return res.json({ ...record, lines: lines.rows || [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/stocktakes', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = stocktakeCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const recordId = (0, uuid_1.v4)();
        const normalizedLines = Array.from(parsed.data.lines.reduce((map, line) => {
            var _a;
            const itemId = String(line.item_id || '').trim();
            const countedQuantity = Number((_a = line.counted_quantity) !== null && _a !== void 0 ? _a : 0);
            if (!itemId)
                return map;
            map.set(itemId, countedQuantity);
            return map;
        }, new Map())).map(([item_id, counted_quantity]) => ({ item_id, counted_quantity }));
        if (!normalizedLines.length)
            return res.status(400).json({ message: '请至少填写一条盘点明细' });
        const actor = actorId(req);
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const itemIds = normalizedLines.map((line) => line.item_id);
            const itemRows = await client.query(`SELECT id, category FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]);
            const itemMap = new Map((itemRows.rows || []).map((row) => [String(row.id), row]));
            for (const line of normalizedLines) {
                const item = itemMap.get(String(line.item_id));
                if (!item)
                    return { ok: false, code: 400, message: '存在无效物品，无法盘点' };
                if (String(item.category || '') !== parsed.data.category)
                    return { ok: false, code: 400, message: '盘点物品分类不一致' };
            }
            await client.query(`INSERT INTO inventory_stocktake_records (id, warehouse_id, category, stocktake_type, stocktake_date, note, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7)`, [recordId, parsed.data.warehouse_id, parsed.data.category, parsed.data.stocktake_type, parsed.data.stocktake_date, parsed.data.note || null, actor]);
            for (const line of normalizedLines) {
                await ensureWarehouseStockRow(client, parsed.data.warehouse_id, line.item_id);
                const current = await client.query(`SELECT id, quantity
           FROM warehouse_stocks
           WHERE warehouse_id = $1 AND item_id = $2
           FOR UPDATE`, [parsed.data.warehouse_id, line.item_id]);
                const stock = (_a = current.rows) === null || _a === void 0 ? void 0 : _a[0];
                const previousQuantity = Number((stock === null || stock === void 0 ? void 0 : stock.quantity) || 0);
                const countedQuantity = Number(line.counted_quantity || 0);
                const delta = countedQuantity - previousQuantity;
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
                    });
                    if (!move.ok)
                        return move;
                }
                await client.query(`INSERT INTO inventory_stocktake_record_lines (id, record_id, item_id, previous_quantity, counted_quantity, delta_quantity)
           VALUES ($1,$2,$3,$4,$5,$6)`, [(0, uuid_1.v4)(), recordId, line.item_id, previousQuantity, countedQuantity, delta]);
            }
            const saved = await client.query(`SELECT r.*, w.code AS warehouse_code, w.name AS warehouse_name
         FROM inventory_stocktake_records r
         JOIN warehouses w ON w.id = r.warehouse_id
         WHERE r.id = $1
         LIMIT 1`, [recordId]);
            return { ok: true, record: ((_b = saved.rows) === null || _b === void 0 ? void 0 : _b[0]) || null };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        (0, store_1.addAudit)('InventoryStocktake', recordId, 'create', null, result.record || null, actor);
        return res.status(201).json(result.record || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/movements', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const wh = String(q.warehouse_id || '').trim();
            const item = String(q.item_id || '').trim();
            const prop = String(q.property_id || '').trim();
            const type = String(q.type || '').trim();
            const category = String(q.category || '').trim();
            const reason = String(q.reason || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 100)));
            const where = [];
            const values = [];
            if (wh) {
                values.push(wh);
                where.push(`m.warehouse_id = $${values.length}`);
            }
            if (item) {
                values.push(item);
                where.push(`m.item_id = $${values.length}`);
            }
            if (prop) {
                values.push(prop);
                where.push(`m.property_id = $${values.length}`);
            }
            if (type) {
                values.push(type);
                where.push(`m.type = $${values.length}`);
            }
            if (category) {
                values.push(category);
                where.push(`i.category = $${values.length}`);
            }
            if (reason) {
                values.push(reason);
                where.push(`m.reason = $${values.length}`);
            }
            if (from) {
                values.push(from);
                where.push(`m.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`m.created_at <= $${values.length}::timestamptz`);
            }
            values.push(limit);
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
      `;
            const rows = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(rows.rows || []);
        }
        return res.json(store_1.db.stockMovements || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen-usage-records', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const q = req.query || {};
        const wh = String(q.warehouse_id || '').trim();
        const prop = String(q.property_id || '').trim();
        const roomType = String(q.room_type_code || '').trim();
        const linenType = String(q.linen_type_code || '').trim();
        const sourceType = String(q.source_type || '').trim();
        const from = String(q.from || '').trim();
        const to = String(q.to || '').trim();
        const limit = Math.min(500, Math.max(1, Number(q.limit || 200)));
        const where = [];
        const values = [];
        if (wh) {
            values.push(wh);
            where.push(`r.warehouse_id = $${values.length}`);
        }
        if (prop) {
            values.push(prop);
            where.push(`r.property_id = $${values.length}`);
        }
        if (roomType) {
            values.push(roomType);
            where.push(`r.room_type_code = $${values.length}`);
        }
        if (linenType) {
            values.push(linenType);
            where.push(`r.linen_type_code = $${values.length}`);
        }
        if (sourceType) {
            values.push(sourceType);
            where.push(`r.source_type = $${values.length}`);
        }
        if (from) {
            values.push(from);
            where.push(`r.usage_date >= $${values.length}::date`);
        }
        if (to) {
            values.push(to);
            where.push(`r.usage_date <= $${values.length}::date`);
        }
        values.push(limit);
        const rows = await dbAdapter_1.pgPool.query(`SELECT
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
       LIMIT $${values.length}`, values);
        const out = (rows.rows || []).map((row) => ({
            ...row,
            source_label: buildLinenUsageSourceLabel(String(row.source_type || '')),
        }));
        return res.json(out);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
async function ensureDailyNecessitiesSchema() {
    if (!dbAdapter_1.pgPool)
        return;
    await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS property_daily_necessities (
    id text PRIMARY KEY,
    property_id text,
    created_by text,
    created_at timestamptz DEFAULT now()
  );`);
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS property_code text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS status text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_name text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS quantity integer;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS note text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS photo_urls jsonb;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS before_photo_urls jsonb;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS after_photo_urls jsonb;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS source_task_id text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitted_at timestamptz;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS submitter_name text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS item_id text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS replacement_at timestamptz;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS replacer_name text;');
    await dbAdapter_1.pgPool.query('ALTER TABLE property_daily_necessities ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();');
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_prop ON property_daily_necessities(property_id);');
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_status ON property_daily_necessities(status);');
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_property_daily_necessities_created_at ON property_daily_necessities(created_at);');
}
async function getActorDisplayName(client, userId) {
    var _a;
    const id = String(userId || '').trim();
    if (!id)
        return '';
    try {
        const row = await client.query(`SELECT display_name, username, email FROM users WHERE id = $1 LIMIT 1`, [id]);
        const user = ((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        return String((user === null || user === void 0 ? void 0 : user.display_name) || (user === null || user === void 0 ? void 0 : user.username) || (user === null || user === void 0 ? void 0 : user.email) || id);
    }
    catch (_b) {
        return id;
    }
}
const dailyReplacementCreateSchema = zod_1.z.object({
    property_id: zod_1.z.string().min(1),
    occurred_at: zod_1.z.string().min(1),
    item_id: zod_1.z.string().optional().nullable(),
    item_name: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1).default(1),
    note: zod_1.z.string().optional(),
    before_photo_urls: zod_1.z.array(zod_1.z.string()).optional(),
    after_photo_urls: zod_1.z.array(zod_1.z.string()).optional(),
    replacement_at: zod_1.z.string().optional().nullable(),
    replacer_name: zod_1.z.string().optional(),
    status: zod_1.z.enum(['need_replace', 'replaced', 'no_action']).optional(),
});
const dailyReplacementPatchSchema = zod_1.z.object({
    occurred_at: zod_1.z.string().optional(),
    item_id: zod_1.z.string().optional().nullable(),
    item_name: zod_1.z.string().min(1).optional(),
    quantity: zod_1.z.number().int().min(1).optional(),
    note: zod_1.z.string().optional(),
    before_photo_urls: zod_1.z.array(zod_1.z.string()).optional(),
    after_photo_urls: zod_1.z.array(zod_1.z.string()).optional(),
    replacement_at: zod_1.z.string().optional().nullable(),
    replacer_name: zod_1.z.string().optional(),
    status: zod_1.z.enum(['need_replace', 'replaced', 'no_action']).optional(),
});
exports.router.get('/daily-replacements', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            await ensureDailyNecessitiesSchema();
            const q = req.query || {};
            const statusRaw = String(q.status || '').trim();
            const statuses = statusRaw
                ? statusRaw
                    .split(',')
                    .map((s) => String(s || '').trim())
                    .filter(Boolean)
                : [];
            const prop = String(q.property_id || '').trim();
            const code = String(q.property_code || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            const limit = Math.min(500, Math.max(1, Number(q.limit || 100)));
            const where = [];
            const values = [];
            if (prop) {
                values.push(prop);
                where.push(`n.property_id = $${values.length}`);
            }
            if (code) {
                values.push(code);
                where.push(`COALESCE(n.property_code, p.code) = $${values.length}`);
            }
            if (statuses.length) {
                values.push(statuses);
                where.push(`COALESCE(n.status,'') = ANY($${values.length}::text[])`);
            }
            if (from) {
                values.push(from);
                where.push(`COALESCE(n.submitted_at, n.created_at) >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`COALESCE(n.submitted_at, n.created_at) <= $${values.length}::timestamptz`);
            }
            values.push(limit);
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
          n.photo_urls,
          n.before_photo_urls,
          n.after_photo_urls,
          n.submitter_name,
          n.submitted_at,
          n.replacement_at,
          n.replacer_name,
          n.created_at,
          n.updated_at
        FROM property_daily_necessities n
        LEFT JOIN properties p ON p.id = n.property_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(n.submitted_at, n.created_at) DESC
        LIMIT $${values.length}
      `;
            const r = await dbAdapter_1.pgPool.query(sql, values);
            return res.json(r.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/daily-replacements', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = dailyReplacementCreateSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        await ensureDailyNecessitiesSchema();
        const id = (0, uuid_1.v4)();
        const actor = actorId(req);
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b;
            const prop = await client.query(`SELECT id, code FROM properties WHERE id = $1 LIMIT 1`, [parsed.data.property_id]);
            const property = (_a = prop.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!property)
                return { ok: false, code: 400, message: '房号不存在' };
            const submitterName = await getActorDisplayName(client, actor);
            const nextStatus = String(parsed.data.status || 'need_replace').trim();
            const created = await client.query(`INSERT INTO property_daily_necessities (
           id, property_id, property_code, status, item_id, item_name, quantity, note,
           photo_urls, before_photo_urls, after_photo_urls, submitted_at, replacement_at,
           submitter_name, replacer_name, created_by, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::timestamptz,$13::timestamptz,$14,$15,$16,now())
         RETURNING *`, [
                id,
                parsed.data.property_id,
                String(property.code || ''),
                nextStatus,
                parsed.data.item_id || null,
                parsed.data.item_name,
                parsed.data.quantity,
                parsed.data.note || null,
                JSON.stringify(parsed.data.before_photo_urls || []),
                JSON.stringify(parsed.data.before_photo_urls || []),
                JSON.stringify(parsed.data.after_photo_urls || []),
                parsed.data.occurred_at,
                parsed.data.replacement_at || null,
                submitterName || null,
                parsed.data.replacer_name || null,
                actor || null,
            ]);
            return { ok: true, row: ((_b = created.rows) === null || _b === void 0 ? void 0 : _b[0]) || null };
        });
        if (!result)
            return res.status(500).json({ message: 'db not ready' });
        if (!result.ok)
            return res.status(result.code).json({ message: result.message });
        (0, store_1.addAudit)('DailyReplacement', id, 'create', null, result.row || null, actor);
        return res.status(201).json(result.row || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/daily-replacements/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    var _a, _b, _c;
    const id = String(req.params.id || '').trim();
    const parsed = dailyReplacementPatchSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        await ensureDailyNecessitiesSchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM property_daily_necessities WHERE id = $1 LIMIT 1`, [id]);
        const prev = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!prev)
            return res.status(404).json({ message: 'not found' });
        const patch = {};
        if (parsed.data.occurred_at !== undefined)
            patch.submitted_at = parsed.data.occurred_at;
        if (parsed.data.item_id !== undefined)
            patch.item_id = parsed.data.item_id || null;
        if (parsed.data.item_name !== undefined)
            patch.item_name = parsed.data.item_name;
        if (parsed.data.quantity !== undefined)
            patch.quantity = parsed.data.quantity;
        if (parsed.data.note !== undefined)
            patch.note = parsed.data.note || null;
        if (parsed.data.before_photo_urls !== undefined) {
            patch.before_photo_urls = JSON.stringify(parsed.data.before_photo_urls || []);
            patch.photo_urls = JSON.stringify(parsed.data.before_photo_urls || []);
        }
        if (parsed.data.after_photo_urls !== undefined)
            patch.after_photo_urls = JSON.stringify(parsed.data.after_photo_urls || []);
        if (parsed.data.replacement_at !== undefined)
            patch.replacement_at = parsed.data.replacement_at || null;
        if (parsed.data.replacer_name !== undefined)
            patch.replacer_name = parsed.data.replacer_name || null;
        if (parsed.data.status !== undefined)
            patch.status = parsed.data.status;
        patch.updated_at = new Date().toISOString();
        const keys = Object.keys(patch);
        if (!keys.length)
            return res.json(prev);
        const setSql = keys.map((key, idx) => `${key} = $${idx + 1}${key === 'before_photo_urls' || key === 'after_photo_urls' || key === 'photo_urls' ? '::jsonb' : key === 'submitted_at' || key === 'replacement_at' || key === 'updated_at' ? '::timestamptz' : ''}`).join(', ');
        const values = keys.map((key) => patch[key]);
        const updated = await dbAdapter_1.pgPool.query(`UPDATE property_daily_necessities
       SET ${setSql}
       WHERE id = $${keys.length + 1}
       RETURNING *`, [...values, id]);
        (0, store_1.addAudit)('DailyReplacement', id, 'update', prev, ((_b = updated.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
        return res.json(((_c = updated.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/suppliers', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT id, name, kind, supply_items_note, login_url, login_username, login_password, login_note, active FROM suppliers ORDER BY name ASC`);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const supplierSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    kind: zod_1.z.string().optional(),
    supply_items_note: zod_1.z.string().optional().nullable(),
    login_url: zod_1.z.string().optional().nullable(),
    login_username: zod_1.z.string().optional().nullable(),
    login_password: zod_1.z.string().optional().nullable(),
    login_note: zod_1.z.string().optional().nullable(),
    active: zod_1.z.boolean().optional(),
});
exports.router.post('/suppliers', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const id = (0, uuid_1.v4)();
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO suppliers (id, name, kind, supply_items_note, login_url, login_username, login_password, login_note, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [id, parsed.data.name, parsed.data.kind || 'linen', parsed.data.supply_items_note || null, parsed.data.login_url || null, parsed.data.login_username || null, parsed.data.login_password || null, parsed.data.login_note || null, (_a = parsed.data.active) !== null && _a !== void 0 ? _a : true]);
            (0, store_1.addAudit)('Supplier', id, 'create', null, ((_b = row.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.status(201).json(((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/suppliers/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'supplier not found' });
            const payload = parsed.data;
            const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
            if (!keys.length)
                return res.json(b);
            const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map(k => payload[k]);
            const sql = `UPDATE suppliers SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`;
            const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
            (0, store_1.addAudit)('Supplier', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/suppliers/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'supplier not found' });
        const refs = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT 1 FROM purchase_orders WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM region_supplier_rules WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM supplier_item_prices WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_return_batches WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_refunds WHERE supplier_id = $1 LIMIT 1`, [id]),
        ]);
        if (refs.some((r) => (r.rows || []).length > 0)) {
            return res.status(409).json({ message: '该供应商已有采购、价格、规则或返厂退款记录，无法删除' });
        }
        await dbAdapter_1.pgPool.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
        (0, store_1.addAudit)('Supplier', id, 'delete', row, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/suppliers/:id/delete', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM suppliers WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'supplier not found' });
        const refs = await Promise.all([
            dbAdapter_1.pgPool.query(`SELECT 1 FROM purchase_orders WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM region_supplier_rules WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM supplier_item_prices WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_return_batches WHERE supplier_id = $1 LIMIT 1`, [id]),
            dbAdapter_1.pgPool.query(`SELECT 1 FROM linen_supplier_refunds WHERE supplier_id = $1 LIMIT 1`, [id]),
        ]);
        if (refs.some((r) => (r.rows || []).length > 0)) {
            return res.status(409).json({ message: '该供应商已有采购、价格、规则或返厂退款记录，无法删除' });
        }
        await dbAdapter_1.pgPool.query(`DELETE FROM suppliers WHERE id = $1`, [id]);
        (0, store_1.addAudit)('Supplier', id, 'delete', row, null, actorId(req));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/region-supplier-rules', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const rows = await dbAdapter_1.pgPool.query(`SELECT r.*, s.name AS supplier_name
         FROM region_supplier_rules r
         JOIN suppliers s ON s.id = r.supplier_id
         ORDER BY r.region_key ASC, r.priority DESC`);
            return res.json(rows.rows || []);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const regionRuleSchema = zod_1.z.object({
    region_key: zod_1.z.string().min(1),
    supplier_id: zod_1.z.string().min(1),
    priority: zod_1.z.number().int().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.post('/region-supplier-rules', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const parsed = regionRuleSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const id = (0, uuid_1.v4)();
            const row = await dbAdapter_1.pgPool.query(`INSERT INTO region_supplier_rules (id, region_key, supplier_id, priority, active)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`, [id, parsed.data.region_key, parsed.data.supplier_id, (_a = parsed.data.priority) !== null && _a !== void 0 ? _a : 0, (_b = parsed.data.active) !== null && _b !== void 0 ? _b : true]);
            (0, store_1.addAudit)('RegionSupplierRule', id, 'create', null, ((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, actorId(req));
            return res.status(201).json(((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/region-supplier-rules/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = regionRuleSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const before = await dbAdapter_1.pgPool.query(`SELECT * FROM region_supplier_rules WHERE id = $1`, [id]);
            const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!b)
                return res.status(404).json({ message: 'rule not found' });
            const payload = parsed.data;
            const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
            if (!keys.length)
                return res.json(b);
            const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map(k => payload[k]);
            const sql = `UPDATE region_supplier_rules SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`;
            const after = await dbAdapter_1.pgPool.query(sql, [...values, id]);
            (0, store_1.addAudit)('RegionSupplierRule', id, 'update', b, ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || null, actorId(req));
            return res.json(((_c = after.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
        }
        return res.status(501).json({ message: 'not available without PG' });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const poCreateSchema = zod_1.z.object({
    supplier_id: zod_1.z.string().optional(),
    warehouse_id: zod_1.z.string().min(1),
    property_id: zod_1.z.string().optional(),
    region: zod_1.z.string().optional(),
    ordered_date: zod_1.z.string().optional(),
    requested_delivery_date: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.union([
        zod_1.z.object({
            item_id: zod_1.z.string().min(1),
            quantity: zod_1.z.number().int().min(1),
            unit: zod_1.z.string().optional(),
            unit_price: zod_1.z.number().optional(),
            note: zod_1.z.string().optional(),
        }),
        zod_1.z.object({
            room_type_code: zod_1.z.string().min(1),
            sets: zod_1.z.number().int().min(1),
        }),
    ])).min(1),
});
exports.router.get('/purchase-orders', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const supplier_id = String(q.supplier_id || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const category = String(q.category || '').trim();
            let poIds = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                const itemIds = (its.rows || []).map((r) => String(r.id));
                if (!itemIds.length)
                    return res.json([]);
                const prs = await dbAdapter_1.pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIds]);
                poIds = (prs.rows || []).map((r) => String(r.po_id));
                if (!poIds.length)
                    return res.json([]);
            }
            const where = [];
            const values = [];
            if (status) {
                values.push(status);
                where.push(`po.status = $${values.length}`);
            }
            if (supplier_id) {
                values.push(supplier_id);
                where.push(`po.supplier_id = $${values.length}`);
            }
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`po.warehouse_id = $${values.length}`);
            }
            if (poIds) {
                values.push(poIds);
                where.push(`po.id = ANY($${values.length}::text[])`);
            }
            const sql = `
        SELECT po.*
        FROM purchase_orders po
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(po.ordered_date, (po.created_at AT TIME ZONE 'Australia/Melbourne')::date) DESC, po.created_at DESC
        LIMIT 200
      `;
            const poRows = await dbAdapter_1.pgPool.query(sql, values);
            const rows = poRows.rows || [];
            for (const row of rows) {
                if (!String((row === null || row === void 0 ? void 0 : row.po_no) || '').trim()) {
                    ;
                    row.po_no = await ensurePurchaseOrderNo(dbAdapter_1.pgPool, row);
                }
            }
            if (!rows.length)
                return res.json([]);
            const supplierIds = Array.from(new Set(rows.map((r) => String(r.supplier_id || '')).filter(Boolean)));
            const warehouseIds = Array.from(new Set(rows.map((r) => String(r.warehouse_id || '')).filter(Boolean)));
            const [supRows, whRows, aggRows] = await Promise.all([
                supplierIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] }),
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                dbAdapter_1.pgPool.query(`SELECT po_id,
                  COUNT(*)::int AS line_count,
                  COALESCE(SUM(quantity),0)::int AS quantity_total,
                  COALESCE(SUM(COALESCE(unit_price,0) * quantity),0) AS amount_total
           FROM purchase_order_lines
           WHERE po_id = ANY($1::text[])
           GROUP BY po_id`, [rows.map((r) => String(r.id))]),
            ]);
            const supMap = new Map(supRows.rows.map((r) => [String(r.id), r]));
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const aggMap = new Map(aggRows.rows.map((r) => [String(r.po_id), r]));
            const out = rows.map((r) => {
                const s = supMap.get(String(r.supplier_id)) || {};
                const w = whMap.get(String(r.warehouse_id)) || {};
                const a = aggMap.get(String(r.id)) || {};
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
                };
            });
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/purchase-order-lines', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureInventorySchema();
            const q = req.query || {};
            const status = String(q.status || '').trim();
            const supplier_id = String(q.supplier_id || '').trim();
            const warehouse_id = String(q.warehouse_id || '').trim();
            const category = String(q.category || '').trim();
            const from = String(q.from || '').trim();
            const to = String(q.to || '').trim();
            let itemIdsByCategory = null;
            let poIdsByCategory = null;
            if (category) {
                const its = await dbAdapter_1.pgPool.query(`SELECT id FROM inventory_items WHERE category = $1`, [category]);
                itemIdsByCategory = (its.rows || []).map((r) => String(r.id));
                if (!itemIdsByCategory.length)
                    return res.json([]);
                const prs = await dbAdapter_1.pgPool.query(`SELECT DISTINCT po_id FROM purchase_order_lines WHERE item_id = ANY($1::text[])`, [itemIdsByCategory]);
                poIdsByCategory = (prs.rows || []).map((r) => String(r.po_id));
                if (!poIdsByCategory.length)
                    return res.json([]);
            }
            const where = [];
            const values = [];
            if (status) {
                values.push(status);
                where.push(`po.status = $${values.length}`);
            }
            if (supplier_id) {
                values.push(supplier_id);
                where.push(`po.supplier_id = $${values.length}`);
            }
            if (warehouse_id) {
                values.push(warehouse_id);
                where.push(`po.warehouse_id = $${values.length}`);
            }
            if (from) {
                values.push(from);
                where.push(`po.created_at >= $${values.length}::timestamptz`);
            }
            if (to) {
                values.push(to);
                where.push(`po.created_at <= $${values.length}::timestamptz`);
            }
            if (poIdsByCategory) {
                values.push(poIdsByCategory);
                where.push(`po.id = ANY($${values.length}::text[])`);
            }
            const pos = await dbAdapter_1.pgPool.query(`SELECT po.*
         FROM purchase_orders po
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY po.created_at DESC
         LIMIT 200`, values);
            const poRows = pos.rows || [];
            if (!poRows.length)
                return res.json([]);
            const poIds = poRows.map((r) => String(r.id));
            const lineWhere = [`po_id = ANY($1::text[])`];
            const lineVals = [poIds];
            if (itemIdsByCategory) {
                lineVals.push(itemIdsByCategory);
                lineWhere.push(`item_id = ANY($${lineVals.length}::text[])`);
            }
            const lines = await dbAdapter_1.pgPool.query(`SELECT l.*, i.name AS item_name, i.sku AS item_sku, lt.sort_order
         FROM purchase_order_lines l
         JOIN inventory_items i ON i.id = l.item_id
         LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
         WHERE ${lineWhere.join(' AND ')}
         ORDER BY l.po_id ASC, COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, lineVals);
            const lineRows = lines.rows || [];
            if (!lineRows.length)
                return res.json([]);
            const supplierIds = Array.from(new Set(poRows.map((r) => String(r.supplier_id || '')).filter(Boolean)));
            const warehouseIds = Array.from(new Set(poRows.map((r) => String(r.warehouse_id || '')).filter(Boolean)));
            const itemIds = Array.from(new Set(lineRows.map((r) => String(r.item_id || '')).filter(Boolean)));
            const [supRows, whRows, itRows] = await Promise.all([
                supplierIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name FROM suppliers WHERE id = ANY($1::text[])`, [supplierIds]) : Promise.resolve({ rows: [] }),
                warehouseIds.length ? dbAdapter_1.pgPool.query(`SELECT id, code, name FROM warehouses WHERE id = ANY($1::text[])`, [warehouseIds]) : Promise.resolve({ rows: [] }),
                itemIds.length ? dbAdapter_1.pgPool.query(`SELECT id, name, sku, category, sub_type FROM inventory_items WHERE id = ANY($1::text[])`, [itemIds]) : Promise.resolve({ rows: [] }),
            ]);
            const poMap = new Map(poRows.map((r) => [String(r.id), r]));
            const supMap = new Map(supRows.rows.map((r) => [String(r.id), r]));
            const whMap = new Map(whRows.rows.map((r) => [String(r.id), r]));
            const itMap = new Map(itRows.rows.map((r) => [String(r.id), r]));
            const out = lineRows.map((l) => {
                const po = poMap.get(String(l.po_id)) || {};
                const s = supMap.get(String(po.supplier_id)) || {};
                const w = whMap.get(String(po.warehouse_id)) || {};
                const it = itMap.get(String(l.item_id)) || {};
                const qty = Number(l.quantity || 0);
                const unitPrice = l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price);
                const amount = unitPrice === null ? null : unitPrice * qty;
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
                };
            }).sort((a, b) => String(b.po_created_at || '').localeCompare(String(a.po_created_at || '')));
            return res.json(out);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/purchase-orders', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const parsed = poCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const supplierIdExplicit = String(parsed.data.supplier_id || '').trim();
        const pool = dbAdapter_1.pgPool;
        if (!pool)
            throw new Error('db not ready');
        let regionExplicit = String(parsed.data.region || '').trim();
        const propertyIdExplicit = String(parsed.data.property_id || '').trim();
        let propertyRow = null;
        if (propertyIdExplicit) {
            const propRes = await pool.query(`SELECT id, region FROM properties WHERE id = $1`, [propertyIdExplicit]);
            propertyRow = ((_a = propRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!regionExplicit && (propertyRow === null || propertyRow === void 0 ? void 0 : propertyRow.region))
                regionExplicit = String(propertyRow.region || '').trim();
        }
        let regionFinal = regionExplicit;
        const supplier_id = supplierIdExplicit || (regionFinal ? await pickSupplierIdForRegion(regionFinal) : null);
        if (!supplier_id)
            return res.status(400).json({ message: '无法确定供应商，请手动选择 supplier_id' });
        const poId = (0, uuid_1.v4)();
        const created_by = actorId(req);
        const smWarehouse = await getSmWarehouse();
        const warehouseDefault = (smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) ? String(smWarehouse.id) : 'wh.south_melbourne';
        const warehouseFinal = String(parsed.data.warehouse_id || '').trim() || warehouseDefault;
        const orderedDate = String(parsed.data.ordered_date || '').trim();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            const poRow = await client.query(`INSERT INTO purchase_orders (id, supplier_id, warehouse_id, status, ordered_date, requested_delivery_date, region, property_id, note, created_by)
         VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,'')::date, (now() AT TIME ZONE 'Australia/Melbourne')::date),$6,$7,$8,$9,$10)
         RETURNING *`, [
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
            ]);
            await ensurePurchaseOrderNo(client, ((_a = poRow.rows) === null || _a === void 0 ? void 0 : _a[0]) || { id: poId, ordered_date: orderedDate });
            const poRowWithNo = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
            const priceMap = await getLatestSupplierItemPrice(client, supplier_id);
            const qtyByItem = new Map();
            const metaByItem = new Map();
            for (const ln of parsed.data.lines) {
                if (ln.item_id) {
                    const item_id = String(ln.item_id);
                    const qty = Number(ln.quantity || 0);
                    qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty);
                    const priceRow = priceMap.get(item_id);
                    metaByItem.set(item_id, {
                        unit_price: (_b = ln.unit_price) !== null && _b !== void 0 ? _b : (priceRow ? Number(priceRow.purchase_unit_price || 0) : null),
                        note: ln.note || null,
                        unit: ln.unit || null,
                    });
                    continue;
                }
                if (ln.room_type_code) {
                    const roomTypeCode = String(ln.room_type_code);
                    const sets = Number(ln.sets || 0);
                    const reqs = await client.query(`SELECT linen_type_code, quantity
             FROM inventory_room_type_requirements
             WHERE room_type_code = $1`, [roomTypeCode]);
                    for (const r of reqs.rows || []) {
                        const linenTypeCode = String(r.linen_type_code);
                        const perSet = Number(r.quantity || 0);
                        if (perSet <= 0)
                            continue;
                        const item_id = `item.linen_type.${linenTypeCode}`;
                        const qty = sets * perSet;
                        qtyByItem.set(item_id, (qtyByItem.get(item_id) || 0) + qty);
                        if (!metaByItem.has(item_id))
                            metaByItem.set(item_id, { unit_price: null, note: null, unit: null });
                    }
                }
            }
            const linesOut = [];
            for (const [item_id, quantity] of qtyByItem.entries()) {
                const item = await client.query(`SELECT id, unit FROM inventory_items WHERE id = $1`, [item_id]);
                const meta = metaByItem.get(item_id) || { unit_price: null, note: null, unit: null };
                const unit = meta.unit || ((_d = (_c = item.rows) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.unit);
                if (!unit)
                    throw new Error('unit missing');
                const lineId = (0, uuid_1.v4)();
                const row = await client.query(`INSERT INTO purchase_order_lines (id, po_id, item_id, quantity, unit, unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING *`, [
                    lineId,
                    poId,
                    item_id,
                    quantity,
                    unit,
                    meta.unit_price,
                    meta.unit_price === null || meta.unit_price === undefined ? null : Number(meta.unit_price) * Number(quantity || 0),
                    meta.note,
                ]);
                linesOut.push(((_e = row.rows) === null || _e === void 0 ? void 0 : _e[0]) || null);
            }
            await refreshPurchaseOrderTotals(client, poId);
            const poFinal = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [poId]);
            return { po: ((_f = poFinal.rows) === null || _f === void 0 ? void 0 : _f[0]) || ((_g = poRowWithNo.rows) === null || _g === void 0 ? void 0 : _g[0]) || ((_h = poRow.rows) === null || _h === void 0 ? void 0 : _h[0]) || null, lines: linesOut };
        });
        (0, store_1.addAudit)('PurchaseOrder', poId, 'create', null, result, actorId(req));
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/purchase-orders/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const po = await dbAdapter_1.pgPool.query(`SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, w.code AS warehouse_code
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`, [id]);
        if (!((_a = po.rows) === null || _a === void 0 ? void 0 : _a[0]))
            return res.status(404).json({ message: 'po not found' });
        if (!String(((_c = (_b = po.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.po_no) || '').trim()) {
            po.rows[0].po_no = await ensurePurchaseOrderNo(dbAdapter_1.pgPool, po.rows[0]);
        }
        const lines = await dbAdapter_1.pgPool.query(`SELECT l.*, i.name AS item_name, i.sku AS item_sku, lt.sort_order
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
       WHERE l.po_id = $1
       ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, [id]);
        const deliveries = await dbAdapter_1.pgPool.query(`SELECT d.* FROM purchase_deliveries d WHERE d.po_id = $1 ORDER BY d.received_at DESC`, [id]);
        return res.json({ po: po.rows[0], lines: lines.rows || [], deliveries: deliveries.rows || [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const poPatchSchema = zod_1.z.object({
    status: zod_1.z.enum(['draft', 'ordered', 'received', 'closed']).optional(),
    supplier_id: zod_1.z.string().min(1).optional(),
    warehouse_id: zod_1.z.string().min(1).optional(),
    ordered_date: zod_1.z.string().optional(),
    requested_delivery_date: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().min(1),
        quantity: zod_1.z.number(),
        note: zod_1.z.string().optional(),
        unit_price: zod_1.z.number().nullable().optional(),
    })).optional(),
});
async function refreshPurchaseOrderTotals(client, poId) {
    var _a, _b;
    const totals = await client.query(`SELECT
       COALESCE(SUM(COALESCE(amount_total,0)),0)::numeric AS subtotal_amount
     FROM purchase_order_lines
     WHERE po_id = $1`, [poId]);
    const subtotal = Number(((_b = (_a = totals.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.subtotal_amount) || 0);
    const gst = Number((subtotal * 0.1).toFixed(2));
    const totalInclGst = Number((subtotal + gst).toFixed(2));
    await client.query(`UPDATE purchase_orders
     SET subtotal_amount = $1::numeric,
         gst_amount = $2::numeric,
         total_amount_inc_gst = $3::numeric,
         updated_at = now()
     WHERE id = $4`, [subtotal, gst, totalInclGst, poId]);
}
async function syncDraftPurchaseOrderPricesForSupplierItem(client, { supplierId, itemId, unitPrice, active, }) {
    if (!supplierId || !itemId || !active)
        return;
    const affected = await client.query(`SELECT DISTINCT l.po_id
     FROM purchase_order_lines l
     JOIN purchase_orders po ON po.id = l.po_id
     WHERE po.supplier_id = $1
       AND po.status = 'draft'
       AND l.item_id = $2`, [supplierId, itemId]);
    const poIds = (affected.rows || []).map((row) => String(row.po_id || '')).filter(Boolean);
    if (!poIds.length)
        return;
    await client.query(`UPDATE purchase_order_lines l
     SET unit_price = $1::numeric,
         amount_total = ROUND((COALESCE(l.quantity, 0)::numeric * $1::numeric), 2)
     FROM purchase_orders po
     WHERE po.id = l.po_id
       AND po.supplier_id = $2
       AND po.status = 'draft'
       AND l.item_id = $3`, [unitPrice, supplierId, itemId]);
    for (const poId of poIds) {
        await refreshPurchaseOrderTotals(client, poId);
    }
}
exports.router.patch('/purchase-orders/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const parsed = poPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id]);
        const b = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!b)
            return res.status(404).json({ message: 'po not found' });
        if (String(b.status || '') === 'received' || String(b.status || '') === 'closed') {
            return res.status(400).json({ message: '已到货或已关闭的采购单不可编辑' });
        }
        const payload = parsed.data;
        const client = await dbAdapter_1.pgPool.connect();
        try {
            await client.query('BEGIN');
            const { lines: linePayload, ...poPayload } = payload;
            const keys = Object.keys(poPayload).filter((k) => poPayload[k] !== undefined);
            let afterRow = b;
            if (keys.length) {
                const sets = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
                const values = keys.map((k) => poPayload[k]);
                const sql = `UPDATE purchase_orders SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`;
                const after = await client.query(sql, [...values, id]);
                afterRow = ((_b = after.rows) === null || _b === void 0 ? void 0 : _b[0]) || afterRow;
            }
            if (Array.isArray(linePayload) && linePayload.length) {
                for (const line of linePayload) {
                    const existing = await client.query(`SELECT id, po_id, quantity, unit_price, note
             FROM purchase_order_lines
             WHERE id = $1 AND po_id = $2`, [line.id, id]);
                    const current = (_c = existing.rows) === null || _c === void 0 ? void 0 : _c[0];
                    if (!current)
                        continue;
                    const quantity = Number(line.quantity || 0);
                    const unitPrice = line.unit_price === undefined ? Number(current.unit_price || 0) : (line.unit_price === null ? null : Number(line.unit_price));
                    await client.query(`UPDATE purchase_order_lines
             SET quantity = $1::integer,
                 note = $2,
                 unit_price = $3::numeric,
                 amount_total = CASE
                   WHEN $3 IS NULL THEN NULL
                   ELSE ROUND(($1::numeric * $3::numeric), 2)
                 END
             WHERE id = $4 AND po_id = $5`, [quantity, line.note || null, unitPrice, line.id, id]);
                }
            }
            await refreshPurchaseOrderTotals(client, id);
            const afterPo = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [id]);
            const afterLines = await client.query(`SELECT * FROM purchase_order_lines WHERE po_id = $1 ORDER BY id ASC`, [id]);
            await client.query('COMMIT');
            const result = { po: ((_d = afterPo.rows) === null || _d === void 0 ? void 0 : _d[0]) || afterRow, lines: afterLines.rows || [] };
            (0, store_1.addAudit)('PurchaseOrder', id, 'update', b, result.po || null, actorId(req));
            return res.json(result);
        }
        catch (txErr) {
            try {
                await client.query('ROLLBACK');
            }
            catch (_e) { }
            throw txErr;
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/purchase-orders/:id/export', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const po = await dbAdapter_1.pgPool.query(`SELECT po.id, po.status, po.created_at, s.name AS supplier_name, w.name AS warehouse_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       WHERE po.id = $1`, [id]);
        if (!((_a = po.rows) === null || _a === void 0 ? void 0 : _a[0]))
            return res.status(404).json({ message: 'po not found' });
        const lines = await dbAdapter_1.pgPool.query(`SELECT i.name AS item_name, i.sku AS item_sku, l.quantity, l.unit, l.unit_price, l.note, lt.sort_order
       FROM purchase_order_lines l
       JOIN inventory_items i ON i.id = l.item_id
       LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
       WHERE l.po_id = $1
       ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`, [id]);
        const header = ['物料', 'SKU', '数量', '单位', '单价', '备注'];
        const esc = (v) => {
            const s = String(v !== null && v !== void 0 ? v : '');
            if (/[\",\n]/.test(s))
                return `"${s.replace(/\"/g, '""')}"`;
            return s;
        };
        const rows = [header.join(',')];
        for (const r of (lines.rows || [])) {
            rows.push([r.item_name, r.item_sku, r.quantity, r.unit, (_b = r.unit_price) !== null && _b !== void 0 ? _b : '', (_c = r.note) !== null && _c !== void 0 ? _c : ''].map(esc).join(','));
        }
        const csv = rows.join('\n');
        const filename = `PO_${esc(po.rows[0].supplier_name)}_${id}.csv`.replace(/[^\w\-.()]+/g, '_');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send('\ufeff' + csv);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const deliverySchema = zod_1.z.object({
    received_at: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({ item_id: zod_1.z.string().min(1), quantity_received: zod_1.z.number().int().min(1), note: zod_1.z.string().optional() })).min(1),
});
exports.router.post('/purchase-orders/:id/deliveries', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const parsed = deliverySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const po_id = String(req.params.id || '');
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d;
            const po = await client.query(`SELECT * FROM purchase_orders WHERE id = $1`, [po_id]);
            const p = (_a = po.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!p)
                return { ok: false, code: 404, message: 'po not found' };
            const deliveryId = (0, uuid_1.v4)();
            const receivedAt = String(parsed.data.received_at || '').trim();
            const d = await client.query(`INSERT INTO purchase_deliveries (id, po_id, received_at, received_by, note)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`, [deliveryId, po_id, receivedAt || new Date().toISOString(), actorId(req), parsed.data.note || null]);
            const lineRows = [];
            for (const ln of parsed.data.lines) {
                const dlId = (0, uuid_1.v4)();
                const row = await client.query(`INSERT INTO purchase_delivery_lines (id, delivery_id, item_id, quantity_received, note)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING *`, [dlId, deliveryId, ln.item_id, ln.quantity_received, ln.note || null]);
                lineRows.push(((_b = row.rows) === null || _b === void 0 ? void 0 : _b[0]) || null);
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
                });
                if (!applied.ok)
                    return applied;
            }
            const poAfter = await client.query(`UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`, ['received', po_id]);
            return { ok: true, delivery: ((_c = d.rows) === null || _c === void 0 ? void 0 : _c[0]) || null, lines: lineRows, po: ((_d = poAfter.rows) === null || _d === void 0 ? void 0 : _d[0]) || null };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(result.code).json({ message: result.message });
        (0, store_1.addAudit)('PurchaseDelivery', ((_a = result === null || result === void 0 ? void 0 : result.delivery) === null || _a === void 0 ? void 0 : _a.id) || po_id, 'create', null, result, actorId(req));
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/deliveries', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const q = req.query || {};
        const supplierId = String(q.supplier_id || '').trim();
        const warehouseId = String(q.warehouse_id || '').trim();
        const category = String(q.category || '').trim();
        const from = String(q.from || '').trim();
        const to = String(q.to || '').trim();
        const where = [];
        const values = [];
        if (supplierId) {
            values.push(supplierId);
            where.push(`po.supplier_id = $${values.length}`);
        }
        if (warehouseId) {
            values.push(warehouseId);
            where.push(`po.warehouse_id = $${values.length}`);
        }
        if (from) {
            values.push(from);
            where.push(`d.received_at >= $${values.length}::timestamptz`);
        }
        if (to) {
            values.push(to);
            where.push(`d.received_at <= $${values.length}::timestamptz`);
        }
        if (category) {
            values.push(category);
            where.push(`EXISTS (
        SELECT 1
        FROM purchase_delivery_lines dl
        JOIN inventory_items i ON i.id = dl.item_id
        WHERE dl.delivery_id = d.id
          AND i.category = $${values.length}
      )`);
        }
        const rows = await dbAdapter_1.pgPool.query(`SELECT d.id, d.po_id, d.received_at, d.received_by, d.note,
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
       LIMIT 200`, values);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const optionalNonEmptyString = zod_1.z.preprocess((v) => {
    if (v === undefined || v === null)
        return undefined;
    const s = String(v).trim();
    return s ? s : undefined;
}, zod_1.z.string().min(1).optional());
const supplierItemPriceSchema = zod_1.z.object({
    supplier_id: zod_1.z.string().min(1),
    item_id: optionalNonEmptyString,
    linen_type_code: optionalNonEmptyString,
    purchase_unit_price: zod_1.z.number().min(0),
    refund_unit_price: zod_1.z.number().min(0).optional(),
    effective_from: zod_1.z.string().optional(),
    active: zod_1.z.boolean().optional(),
});
exports.router.get('/supplier-item-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const supplierId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.supplier_id) || '').trim();
        const itemId = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.item_id) || '').trim();
        const active = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.active) || '').trim().toLowerCase();
        const where = [];
        const values = [];
        if (supplierId) {
            values.push(supplierId);
            where.push(`sip.supplier_id = $${values.length}`);
        }
        if (itemId) {
            values.push(itemId);
            where.push(`sip.item_id = $${values.length}`);
        }
        if (active === 'true' || active === 'false') {
            values.push(active === 'true');
            where.push(`sip.active = $${values.length}`);
        }
        const rows = await dbAdapter_1.pgPool.query(`SELECT sip.*, s.name AS supplier_name, i.name AS item_name, i.sku AS item_sku, i.linen_type_code
       FROM supplier_item_prices sip
       JOIN suppliers s ON s.id = sip.supplier_id
       JOIN inventory_items i ON i.id = sip.item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.name ASC, i.name ASC, COALESCE(sip.effective_from, DATE '1970-01-01') DESC`, values);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/supplier-item-prices', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierItemPriceSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        let itemId = String(body.item_id || '').trim();
        if (!itemId && body.linen_type_code) {
            const item = await ensureLinenInventoryItem(dbAdapter_1.pgPool, String(body.linen_type_code));
            itemId = String((item === null || item === void 0 ? void 0 : item.id) || '');
        }
        if (!itemId)
            return res.status(400).json({ message: 'item_id required' });
        const id = (0, uuid_1.v4)();
        const client = await dbAdapter_1.pgPool.connect();
        try {
            await client.query('BEGIN');
            const row = await client.query(`INSERT INTO supplier_item_prices (id, supplier_id, item_id, purchase_unit_price, refund_unit_price, effective_from, active, updated_at)
         VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date,$7,now())
         ON CONFLICT (supplier_id, item_id)
         DO UPDATE SET purchase_unit_price = EXCLUDED.purchase_unit_price,
                       refund_unit_price = EXCLUDED.refund_unit_price,
                       effective_from = EXCLUDED.effective_from,
                       active = EXCLUDED.active,
                       updated_at = now()
         RETURNING *`, [id, body.supplier_id, itemId, body.purchase_unit_price, (_a = body.refund_unit_price) !== null && _a !== void 0 ? _a : body.purchase_unit_price, body.effective_from || null, (_b = body.active) !== null && _b !== void 0 ? _b : true]);
            const saved = ((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null;
            if (saved) {
                await syncDraftPurchaseOrderPricesForSupplierItem(client, {
                    supplierId: String(saved.supplier_id || ''),
                    itemId: String(saved.item_id || ''),
                    unitPrice: Number(saved.purchase_unit_price || 0),
                    active: Boolean(saved.active),
                });
            }
            await client.query('COMMIT');
            return res.status(201).json(saved);
        }
        catch (txErr) {
            try {
                await client.query('ROLLBACK');
            }
            catch (_d) { }
            throw txErr;
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/supplier-item-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    const parsed = supplierItemPriceSchema.partial().safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '');
        const payload = parsed.data;
        const keys = Object.keys(payload).filter((k) => payload[k] !== undefined);
        if (!keys.length)
            return res.json(null);
        const sets = keys.map((k, i) => k === 'effective_from' ? `"${k}" = NULLIF($${i + 1}, '')::date` : `"${k}" = $${i + 1}`).join(', ');
        const values = keys.map((k) => payload[k]);
        const client = await dbAdapter_1.pgPool.connect();
        try {
            await client.query('BEGIN');
            const row = await client.query(`UPDATE supplier_item_prices
         SET ${sets}, updated_at = now()
         WHERE id = $${keys.length + 1}
         RETURNING *`, [...values, id]);
            const saved = ((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (saved) {
                await syncDraftPurchaseOrderPricesForSupplierItem(client, {
                    supplierId: String(saved.supplier_id || ''),
                    itemId: String(saved.item_id || ''),
                    unitPrice: Number(saved.purchase_unit_price || 0),
                    active: Boolean(saved.active),
                });
            }
            await client.query('COMMIT');
            return res.json(saved);
        }
        catch (txErr) {
            try {
                await client.query('ROLLBACK');
            }
            catch (_b) { }
            throw txErr;
        }
        finally {
            client.release();
        }
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/supplier-item-prices/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '');
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM supplier_item_prices WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'not found' });
        await dbAdapter_1.pgPool.query(`DELETE FROM supplier_item_prices WHERE id = $1`, [id]);
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/reserve-policies', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const warehouseId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
        const rows = await dbAdapter_1.pgPool.query(`SELECT p.id, p.warehouse_id, p.item_id, p.reserve_qty, w.code AS warehouse_code, w.name AS warehouse_name,
              i.name AS item_name, i.sku AS item_sku, i.linen_type_code
       FROM inventory_stock_policies p
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN inventory_items i ON i.id = p.item_id
       ${warehouseId ? 'WHERE p.warehouse_id = $1' : ''}
       ORDER BY w.code ASC, i.name ASC`, warehouseId ? [warehouseId] : []);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const reservePolicySchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    item_id: zod_1.z.string().min(1),
    reserve_qty: zod_1.z.number().int().min(0),
});
exports.router.put('/linen/reserve-policies', (0, auth_1.requirePerm)('inventory.item.manage'), async (req, res) => {
    var _a;
    const parsed = reservePolicySchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        const id = `reserve.${body.warehouse_id}.${body.item_id}`;
        const row = await dbAdapter_1.pgPool.query(`INSERT INTO inventory_stock_policies (id, warehouse_id, item_id, reserve_qty, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (warehouse_id, item_id)
       DO UPDATE SET reserve_qty = EXCLUDED.reserve_qty, updated_at = now()
       RETURNING *`, [id, body.warehouse_id, body.item_id, body.reserve_qty]);
        return res.json(((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/dashboard', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const client = dbAdapter_1.pgPool;
        const smWarehouse = await getSmWarehouse();
        const smWarehouseId = String((smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '');
        const cleaningTaskSchemaRes = await client.query(`SELECT
         to_regclass('public.cleaning_tasks') IS NOT NULL AS has_cleaning_tasks,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='property_id') AS has_property_id,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='status') AS has_status,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='date') AS has_date,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='task_date') AS has_task_date,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='task_type') AS has_task_type,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cleaning_tasks' AND column_name='type') AS has_type`);
        const cleaningSchema = ((_a = cleaningTaskSchemaRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || {};
        const canQueryCleaningTasks = Boolean(cleaningSchema.has_cleaning_tasks) &&
            Boolean(cleaningSchema.has_property_id) &&
            Boolean(cleaningSchema.has_status) &&
            (Boolean(cleaningSchema.has_date) || Boolean(cleaningSchema.has_task_date)) &&
            (Boolean(cleaningSchema.has_task_type) || Boolean(cleaningSchema.has_type));
        const [warehousesRes, itemsRes, stocksRes, roomRes, pendingRefundRes, deliveredSetsRes, latestStocktakeRes, latestStocktakeLinesRes, cleaningTaskRowsRes] = await Promise.all([
            client.query(`SELECT id, code, name, linen_capacity_sets, active FROM warehouses WHERE active = true ORDER BY code ASC`),
            client.query(`SELECT i.id, i.name, i.sku, i.linen_type_code, lt.sort_order
         FROM inventory_items i
         LEFT JOIN inventory_linen_types lt ON lt.code = i.linen_type_code
         WHERE i.category = 'linen' AND i.active = true
         ORDER BY COALESCE(lt.sort_order, 9999) ASC, COALESCE(lt.code, i.linen_type_code, i.name) ASC, i.name ASC`),
            client.query(`SELECT warehouse_id, item_id, quantity FROM warehouse_stocks WHERE item_id IN (SELECT id FROM inventory_items WHERE category = 'linen')`),
            getRoomTypeRequirementMaps(client),
            client.query(`SELECT COALESCE(SUM(expected_amount - received_amount),0) AS pending_amount FROM linen_supplier_refunds WHERE status <> 'settled'`),
            client.query(`SELECT r.to_warehouse_id AS warehouse_id,
                l.room_type_code,
                COALESCE(SUM(l.sets), 0)::int AS delivered_sets
         FROM linen_delivery_records r
         JOIN linen_delivery_record_lines l ON l.record_id = r.id
         WHERE r.status = 'completed'
         GROUP BY r.to_warehouse_id, l.room_type_code`),
            client.query(`SELECT DISTINCT ON (warehouse_id)
                id,
                warehouse_id,
                delivery_record_id,
                stocktake_date,
                dirty_bag_note,
                note,
                created_at,
                updated_at
         FROM linen_stocktake_records
         ORDER BY warehouse_id, stocktake_date DESC, created_at DESC, id DESC`),
            client.query(`SELECT sl.record_id,
                sl.room_type_code,
                sl.remaining_sets
         FROM linen_stocktake_record_lines sl
         WHERE sl.record_id IN (
           SELECT DISTINCT ON (warehouse_id) id
           FROM linen_stocktake_records
           ORDER BY warehouse_id, stocktake_date DESC, created_at DESC, id DESC
         )`),
            canQueryCleaningTasks
                ? client.query(`SELECT
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
             AND COALESCE(t.status, '') <> 'cancelled'`)
                : Promise.resolve({ rows: [] }),
        ]);
        const warehouses = warehousesRes.rows || [];
        const items = itemsRes.rows || [];
        const reserveMap = smWarehouseId ? await getLinenReserveMap(client, smWarehouseId) : new Map();
        const itemMap = new Map(items.map((r) => [String(r.id), r]));
        const countsByWarehouse = new Map();
        for (const row of stocksRes.rows || []) {
            const warehouseId = String(row.warehouse_id || '');
            if (!countsByWarehouse.has(warehouseId))
                countsByWarehouse.set(warehouseId, {});
            const item = itemMap.get(String(row.item_id || ''));
            const linenTypeCode = String((item === null || item === void 0 ? void 0 : item.linen_type_code) || '');
            if (!linenTypeCode)
                continue;
            countsByWarehouse.get(warehouseId)[linenTypeCode] = Number(countsByWarehouse.get(warehouseId)[linenTypeCode] || 0) + Number(row.quantity || 0);
        }
        const dispatchableByType = {};
        if (smWarehouseId) {
            for (const item of items) {
                const itemId = String(item.id);
                const linenTypeCode = String(item.linen_type_code || '');
                const qty = Number((countsByWarehouse.get(smWarehouseId) || {})[linenTypeCode] || 0);
                const reserveQty = Number(reserveMap.get(itemId) || 0);
                dispatchableByType[linenTypeCode] = Math.max(0, qty - reserveQty);
            }
        }
        const roomTypes = roomRes.roomTypes || [];
        const deliveredSetsByWarehouse = new Map();
        for (const row of deliveredSetsRes.rows || []) {
            const warehouseId = String(row.warehouse_id || '');
            const roomTypeCode = String(row.room_type_code || '');
            if (!warehouseId || !roomTypeCode)
                continue;
            if (!deliveredSetsByWarehouse.has(warehouseId))
                deliveredSetsByWarehouse.set(warehouseId, {});
            deliveredSetsByWarehouse.get(warehouseId)[roomTypeCode] = Number(row.delivered_sets || 0);
        }
        const latestStocktakeByWarehouse = new Map();
        for (const row of latestStocktakeRes.rows || []) {
            const warehouseId = String(row.warehouse_id || '');
            if (!warehouseId)
                continue;
            latestStocktakeByWarehouse.set(warehouseId, row);
        }
        const stocktakeLinesByRecord = new Map();
        for (const row of latestStocktakeLinesRes.rows || []) {
            const recordId = String(row.record_id || '');
            const roomTypeCode = String(row.room_type_code || '');
            if (!recordId || !roomTypeCode)
                continue;
            if (!stocktakeLinesByRecord.has(recordId))
                stocktakeLinesByRecord.set(recordId, {});
            stocktakeLinesByRecord.get(recordId)[roomTypeCode] = Number(row.remaining_sets || 0);
        }
        const cleaningTasksByWarehouse = new Map();
        for (const row of cleaningTaskRowsRes.rows || []) {
            const roomTypeCode = String(row.room_type_code || '').trim();
            const taskDate = String(row.task_date || '').slice(0, 10);
            if (!roomTypeCode || !taskDate)
                continue;
            const warehouseId = resolveWarehouseForProperty(row, warehouses);
            if (!warehouseId)
                continue;
            if (!cleaningTasksByWarehouse.has(warehouseId))
                cleaningTasksByWarehouse.set(warehouseId, []);
            cleaningTasksByWarehouse.get(warehouseId).push({
                room_type_code: roomTypeCode,
                task_date: taskDate,
            });
        }
        const rows = warehouses.map((warehouse) => {
            const counts = countsByWarehouse.get(String(warehouse.id)) || {};
            const availableSetsByRoomType = {};
            const stocktakeSetsByRoomType = {};
            const taskEstimatedConsumedByRoomType = {};
            const warehouseId = String(warehouse.id || '');
            const deliveredSets = deliveredSetsByWarehouse.get(warehouseId) || {};
            const latestStocktake = latestStocktakeByWarehouse.get(warehouseId) || null;
            const latestStocktakeLines = latestStocktake ? (stocktakeLinesByRecord.get(String(latestStocktake.id || '')) || {}) : {};
            const warehouseCleaningTasks = cleaningTasksByWarehouse.get(warehouseId) || [];
            for (const roomType of roomTypes) {
                const roomTypeCode = String(roomType.code || '');
                if (isSmWarehouseRow(warehouse)) {
                    availableSetsByRoomType[roomTypeCode] = computeSetsForRoomType(counts, roomRes.reqMap.get(roomTypeCode));
                    stocktakeSetsByRoomType[roomTypeCode] = availableSetsByRoomType[roomTypeCode];
                }
                else {
                    stocktakeSetsByRoomType[roomTypeCode] = Number(latestStocktakeLines[roomTypeCode] || 0);
                    availableSetsByRoomType[roomTypeCode] = Number(latestStocktakeLines[roomTypeCode] || 0);
                }
                const stocktakeDate = String((latestStocktake === null || latestStocktake === void 0 ? void 0 : latestStocktake.stocktake_date) || '').slice(0, 10);
                const relevantTaskCount = warehouseCleaningTasks.filter((task) => {
                    if (task.room_type_code !== roomTypeCode)
                        return false;
                    if (!stocktakeDate)
                        return true;
                    return task.task_date >= stocktakeDate;
                }).length;
                taskEstimatedConsumedByRoomType[roomTypeCode] = Number(relevantTaskCount || 0);
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
                last_stocktake_at: (latestStocktake === null || latestStocktake === void 0 ? void 0 : latestStocktake.created_at) || null,
                stocktake_date: (latestStocktake === null || latestStocktake === void 0 ? void 0 : latestStocktake.stocktake_date) || null,
                has_stocktake: Boolean(latestStocktake),
                dirty_bag_note: String((latestStocktake === null || latestStocktake === void 0 ? void 0 : latestStocktake.dirty_bag_note) || ''),
            };
        });
        const pendingReturnRows = await client.query(`SELECT i.linen_type_code,
              COALESCE(SUM(CASE WHEN m.reason = 'return_from_subwarehouse' AND m.type = 'in' THEN m.quantity ELSE 0 END),0) -
              COALESCE(SUM(CASE WHEN m.reason = 'return_to_supplier' AND m.type = 'out' THEN m.quantity ELSE 0 END),0) AS qty
       FROM stock_movements m
       JOIN inventory_items i ON i.id = m.item_id
       WHERE i.category = 'linen'
         AND m.warehouse_id = $1
       GROUP BY i.linen_type_code`, [smWarehouseId || '']);
        const pendingReturnsByType = {};
        for (const row of pendingReturnRows.rows || [])
            pendingReturnsByType[String(row.linen_type_code || '')] = Math.max(0, Number(row.qty || 0));
        return res.json({
            sm_warehouse_id: smWarehouseId || null,
            room_types: roomTypes,
            linen_items: items,
            reserve_policies: items.map((item) => ({
                item_id: item.id,
                item_name: item.name,
                item_sku: item.sku,
                linen_type_code: item.linen_type_code,
                reserve_qty: Number(reserveMap.get(String(item.id)) || 0),
            })),
            dispatchable_by_type: dispatchableByType,
            pending_returns_by_type: pendingReturnsByType,
            pending_refund_amount: Number(((_c = (_b = pendingRefundRes.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.pending_amount) || 0),
            warehouses: rows,
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/delivery-suggestions', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const client = dbAdapter_1.pgPool;
        const dateFrom = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.date_from) || '').trim() || toDayStartIsoMelbourne(0).slice(0, 10);
        const dateTo = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.date_to) || '').trim() || toDayStartIsoMelbourne(7).slice(0, 10);
        const vehicleCapacitySets = Math.max(1, Number(((_c = req.query) === null || _c === void 0 ? void 0 : _c.vehicle_capacity_sets) || 80));
        const smWarehouse = await getSmWarehouse();
        const warehousesRes = await client.query(`SELECT id, code, name, linen_capacity_sets FROM warehouses WHERE active = true ORDER BY code ASC`);
        const warehouses = warehousesRes.rows || [];
        const smWarehouseId = String((smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '');
        const [roomData, itemsRes, stocksRes, ordersRes] = await Promise.all([
            getRoomTypeRequirementMaps(client),
            client.query(`SELECT id, name, sku, linen_type_code FROM inventory_items WHERE category = 'linen' AND active = true`),
            client.query(`SELECT warehouse_id, item_id, quantity FROM warehouse_stocks WHERE item_id IN (SELECT id FROM inventory_items WHERE category = 'linen')`),
            client.query(`SELECT o.id, substring(o.checkout::text,1,10) AS checkout_day, p.id AS property_id, p.code AS property_code, p.region,
                p.room_type_code, p.linen_service_warehouse_id
         FROM orders o
         JOIN properties p ON p.id = o.property_id
         WHERE substring(o.checkout::text,1,10) >= $1
           AND substring(o.checkout::text,1,10) <= $2
           AND lower(coalesce(o.status,'')) NOT LIKE '%cancel%'
           AND lower(coalesce(o.status,'')) NOT LIKE '%void%'`, [dateFrom, dateTo]),
        ]);
        const items = itemsRes.rows || [];
        const itemMap = new Map(items.map((r) => [String(r.id), r]));
        const reserveMap = smWarehouseId ? await getLinenReserveMap(client, smWarehouseId) : new Map();
        const countsByWarehouse = new Map();
        for (const row of stocksRes.rows || []) {
            const warehouseId = String(row.warehouse_id || '');
            if (!countsByWarehouse.has(warehouseId))
                countsByWarehouse.set(warehouseId, {});
            const item = itemMap.get(String(row.item_id || ''));
            const linenTypeCode = String((item === null || item === void 0 ? void 0 : item.linen_type_code) || '');
            if (!linenTypeCode)
                continue;
            countsByWarehouse.get(warehouseId)[linenTypeCode] = Number(countsByWarehouse.get(warehouseId)[linenTypeCode] || 0) + Number(row.quantity || 0);
        }
        const dispatchableByType = {};
        for (const item of items) {
            const itemId = String(item.id);
            const linenTypeCode = String(item.linen_type_code || '');
            const qty = Number((countsByWarehouse.get(smWarehouseId) || {})[linenTypeCode] || 0);
            const reserveQty = Number(reserveMap.get(itemId) || 0);
            dispatchableByType[linenTypeCode] = Math.max(0, qty - reserveQty);
        }
        const demandMap = new Map();
        const unmatchedProperties = [];
        for (const orderRow of ordersRes.rows || []) {
            const warehouseId = resolveWarehouseForProperty(orderRow, warehouses);
            const roomTypeCode = String(orderRow.room_type_code || '');
            if (!warehouseId || !roomTypeCode) {
                unmatchedProperties.push({
                    property_id: orderRow.property_id,
                    property_code: orderRow.property_code,
                    room_type_code: roomTypeCode || null,
                    warehouse_id: warehouseId || null,
                });
                continue;
            }
            if (!demandMap.has(warehouseId))
                demandMap.set(warehouseId, new Map());
            demandMap.get(warehouseId).set(roomTypeCode, Number(demandMap.get(warehouseId).get(roomTypeCode) || 0) + 1);
        }
        const lines = [];
        let vehicleRemaining = vehicleCapacitySets;
        for (const warehouse of warehouses.filter((w) => !isSmWarehouseRow(w))) {
            const warehouseId = String(warehouse.id);
            const counts = countsByWarehouse.get(warehouseId) || {};
            for (const roomType of roomData.roomTypes || []) {
                const roomTypeCode = String(roomType.code || '');
                const currentSets = computeSetsForRoomType(counts, roomData.reqMap.get(roomTypeCode));
                const demandSets = Number(((_d = demandMap.get(warehouseId)) === null || _d === void 0 ? void 0 : _d.get(roomTypeCode)) || 0);
                const capacitySets = Number(warehouse.linen_capacity_sets || 0);
                const targetSets = capacitySets > 0 ? Math.min(capacitySets, demandSets) : demandSets;
                let suggestedSets = Math.max(0, targetSets - currentSets);
                if (suggestedSets <= 0 || vehicleRemaining <= 0)
                    continue;
                const reqs = roomData.reqMap.get(roomTypeCode);
                if (!reqs || !reqs.size)
                    continue;
                let maxByDispatchable = suggestedSets;
                for (const [linenTypeCode, quantity] of reqs.entries()) {
                    maxByDispatchable = Math.min(maxByDispatchable, Math.floor(Number(dispatchableByType[linenTypeCode] || 0) / Math.max(1, quantity)));
                }
                suggestedSets = Math.max(0, Math.min(suggestedSets, maxByDispatchable, vehicleRemaining));
                if (suggestedSets <= 0)
                    continue;
                for (const [linenTypeCode, quantity] of reqs.entries()) {
                    dispatchableByType[linenTypeCode] = Math.max(0, Number(dispatchableByType[linenTypeCode] || 0) - suggestedSets * quantity);
                }
                vehicleRemaining -= suggestedSets;
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
                });
            }
        }
        lines.sort((a, b) => Number(b.demand_sets - b.current_sets) - Number(a.demand_sets - a.current_sets));
        return res.json({
            from_warehouse_id: smWarehouseId || null,
            from_warehouse_name: (smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.name) || null,
            date_from: dateFrom,
            date_to: dateTo,
            vehicle_capacity_sets: vehicleCapacitySets,
            vehicle_remaining_sets: vehicleRemaining,
            unmatched_properties: unmatchedProperties,
            lines,
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const linenDeliveryRecordLineSchema = zod_1.z.object({
    room_type_code: zod_1.z.string().min(1),
    sets: zod_1.z.number().int().min(1),
});
const linenDeliveryRecordExtraLineSchema = zod_1.z.object({
    linen_type_code: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
});
const linenStocktakeLineSchema = zod_1.z.object({
    room_type_code: zod_1.z.string().min(1),
    remaining_sets: zod_1.z.number().int().min(0),
});
const linenDeliveryRecordCreateSchema = zod_1.z.object({
    delivery_date: zod_1.z.string().min(1),
    from_warehouse_id: zod_1.z.string().min(1),
    to_warehouse_id: zod_1.z.string().min(1),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(linenDeliveryRecordLineSchema).default([]),
    extra_linen_lines: zod_1.z.array(linenDeliveryRecordExtraLineSchema).default([]),
    stocktake_lines: zod_1.z.array(linenStocktakeLineSchema).min(1),
    dirty_bag_note: zod_1.z.string().optional(),
}).superRefine((data, ctx) => {
    var _a, _b;
    if (!(((_a = data.lines) === null || _a === void 0 ? void 0 : _a.length) || ((_b = data.extra_linen_lines) === null || _b === void 0 ? void 0 : _b.length))) {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: '至少需要一条配送明细', path: ['lines'] });
    }
});
const linenDeliveryRecordUpdateSchema = linenDeliveryRecordCreateSchema;
const linenStocktakeCreateSchema = zod_1.z.object({
    warehouse_id: zod_1.z.string().min(1),
    delivery_record_id: zod_1.z.string().optional(),
    stocktake_date: zod_1.z.string().min(1),
    dirty_bag_note: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(linenStocktakeLineSchema).min(1),
});
exports.router.get('/linen/delivery-records', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c, _d, _e;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const where = [];
        const params = [];
        const push = (sql, value) => {
            params.push(value);
            where.push(sql.replace('?', `$${params.length}`));
        };
        const dateFrom = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.date_from) || '').trim();
        const dateTo = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.date_to) || '').trim();
        const fromWarehouseId = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.from_warehouse_id) || '').trim();
        const toWarehouseId = String(((_d = req.query) === null || _d === void 0 ? void 0 : _d.to_warehouse_id) || '').trim();
        const status = String(((_e = req.query) === null || _e === void 0 ? void 0 : _e.status) || '').trim();
        if (dateFrom)
            push(`r.delivery_date >= ?::date`, dateFrom);
        if (dateTo)
            push(`r.delivery_date <= ?::date`, dateTo);
        if (fromWarehouseId)
            push(`r.from_warehouse_id = ?`, fromWarehouseId);
        if (toWarehouseId)
            push(`r.to_warehouse_id = ?`, toWarehouseId);
        if (status)
            push(`r.status = ?`, status);
        const rows = await dbAdapter_1.pgPool.query(`SELECT r.*,
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
       LIMIT 200`, params);
        return res.json((rows.rows || []).map((row) => ({
            ...row,
            total_sets: Number(row.total_sets || 0),
            room_type_count: Number(row.room_type_count || 0),
            extra_linen_total: Number(row.extra_linen_total || 0),
        })));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/delivery-records/:id', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const record = await loadLinenDeliveryRecordDetail(dbAdapter_1.pgPool, String(req.params.id || ''));
        if (!record)
            return res.status(404).json({ message: 'not found' });
        return res.json(record);
    }
    catch (e) {
        return sendInventoryError(req, res, e);
    }
});
exports.router.get('/linen/stocktakes', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a, _b, _c;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const warehouseId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.warehouse_id) || '').trim();
        const dateFrom = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.date_from) || '').trim();
        const dateTo = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.date_to) || '').trim();
        const where = [];
        const params = [];
        const push = (sql, value) => {
            params.push(value);
            where.push(sql.replace('?', `$${params.length}`));
        };
        if (warehouseId)
            push(`sr.warehouse_id = ?`, warehouseId);
        if (dateFrom)
            push(`sr.stocktake_date >= ?::date`, dateFrom);
        if (dateTo)
            push(`sr.stocktake_date <= ?::date`, dateTo);
        const rows = await dbAdapter_1.pgPool.query(`SELECT sr.*,
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
       LIMIT 200`, params);
        return res.json((rows.rows || []).map((row) => ({
            ...row,
            room_type_count: Number(row.room_type_count || 0),
        })));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/stocktakes/:id', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const detail = await loadLinenStocktakeDetail(dbAdapter_1.pgPool, String(req.params.id || ''));
        if (!detail)
            return res.status(404).json({ message: 'not found' });
        return res.json(detail);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen/stocktakes', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = linenStocktakeCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const actor = actorId(req);
        const detail = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await assertWarehouseAllowsStocktake(client, parsed.data.warehouse_id);
            const recordId = await upsertLinenStocktakeRecordInTx(client, {
                warehouse_id: parsed.data.warehouse_id,
                delivery_record_id: parsed.data.delivery_record_id || null,
                stocktake_date: parsed.data.stocktake_date,
                dirty_bag_note: parsed.data.dirty_bag_note || null,
                note: parsed.data.note || null,
                actor_id: actor,
                lines: parsed.data.lines,
            });
            const saved = await loadLinenStocktakeDetail(client, recordId);
            if (!saved)
                throw httpError(500, '盘点单保存后读取失败');
            return saved;
        });
        (0, store_1.addAudit)('LinenStocktakeRecord', String((detail === null || detail === void 0 ? void 0 : detail.id) || ''), 'create', null, detail, actor);
        return res.status(201).json(detail);
    }
    catch (e) {
        return res.status(Number((e === null || e === void 0 ? void 0 : e.statusCode) || 500)).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen/delivery-records', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    var _a;
    const parsed = linenDeliveryRecordCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(withTracePayload(req, parsed.error.format()));
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json(withTracePayload(req, { message: 'same warehouse' }));
    const requestStartedAt = Date.now();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json(withTracePayload(req, { message: 'not available without PG' }));
        await ensureInventorySchema();
        const actor = actorId(req);
        const recordId = (0, uuid_1.v4)();
        const metrics = {
            validate_ms: 0,
            ensure_idempotency_ms: 0,
            expand_lines_ms: 0,
            apply_stock_ms: 0,
            save_stocktake_ms: 0,
            build_response_ms: 0,
            total_ms: 0,
        };
        inventoryLog(req, 'log', 'delivery_create_start', {
            record_id: recordId,
            from_warehouse_id: parsed.data.from_warehouse_id,
            to_warehouse_id: parsed.data.to_warehouse_id,
            delivery_date: parsed.data.delivery_date,
        });
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d;
            await client.query(`SET LOCAL lock_timeout = '5000ms'`);
            const validateStartedAt = Date.now();
            await assertWarehouseAllowsStocktake(client, parsed.data.to_warehouse_id);
            metrics.validate_ms = Date.now() - validateStartedAt;
            const expandStartedAt = Date.now();
            const expandedLines = await expandLinenDeliveryInputLines(client, parsed.data.lines);
            const expandedExtraLines = await expandLinenDeliveryExtraInputLines(client, parsed.data.extra_linen_lines || []);
            metrics.expand_lines_ms = Date.now() - expandStartedAt;
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
            });
            const idempotencyStartedAt = Date.now();
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [fingerprint]);
            const duplicateRes = await client.query(`SELECT id
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
         LIMIT 1`, [
                actor,
                parsed.data.delivery_date,
                parsed.data.from_warehouse_id,
                parsed.data.to_warehouse_id,
                parsed.data.note || null,
                JSON.stringify(expandedLines.map((line) => ({ room_type_code: line.room_type_code, sets: line.sets }))),
                JSON.stringify(expandedExtraLines.map((line) => ({ linen_type_code: line.linen_type_code, quantity: line.quantity }))),
            ]);
            metrics.ensure_idempotency_ms = Date.now() - idempotencyStartedAt;
            const duplicateId = String(((_b = (_a = duplicateRes.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id) || '');
            if (duplicateId) {
                const existing = await loadLinenDeliveryRecordSummary(client, duplicateId);
                if (existing) {
                    return {
                        ok: true,
                        response: buildDeliverySuccessResponse(existing, { deduped: true }),
                        row: existing,
                        deduped: true,
                    };
                }
            }
            const inserted = await client.query(`INSERT INTO linen_delivery_records (id, delivery_date, from_warehouse_id, to_warehouse_id, status, note, created_by)
         VALUES ($1,$2::date,$3,$4,'completed',$5,$6)
         RETURNING *`, [recordId, parsed.data.delivery_date, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null, actor]);
            for (const line of expandedLines) {
                await client.query(`INSERT INTO linen_delivery_record_lines (id, record_id, room_type_code, room_type_name, sets)
           VALUES ($1,$2,$3,$4,$5)`, [(0, uuid_1.v4)(), recordId, line.room_type_code, line.room_type_name, line.sets]);
            }
            for (const line of expandedExtraLines) {
                await client.query(`INSERT INTO linen_delivery_record_extra_lines (id, record_id, linen_type_code, linen_type_name, quantity)
           VALUES ($1,$2,$3,$4,$5)`, [(0, uuid_1.v4)(), recordId, line.linen_type_code, line.linen_type_name, line.quantity]);
            }
            const applyStartedAt = Date.now();
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
            });
            assertStockTxnOk(applied);
            metrics.apply_stock_ms = Date.now() - applyStartedAt;
            const stocktakeStartedAt = Date.now();
            await upsertLinenStocktakeRecordInTx(client, {
                delivery_record_id: recordId,
                warehouse_id: parsed.data.to_warehouse_id,
                stocktake_date: parsed.data.delivery_date,
                dirty_bag_note: parsed.data.dirty_bag_note || null,
                note: parsed.data.note || null,
                actor_id: actor,
                lines: parsed.data.stocktake_lines,
            });
            metrics.save_stocktake_ms = Date.now() - stocktakeStartedAt;
            const responseStartedAt = Date.now();
            const summary = await loadLinenDeliveryRecordSummary(client, recordId);
            metrics.build_response_ms = Date.now() - responseStartedAt;
            if (!summary) {
                inventoryLog(req, 'error', 'delivery_create_response_degraded', { record_id: recordId, reason: 'summary_read_failed' });
            }
            return {
                ok: true,
                response: buildDeliverySuccessResponse(summary || ((_c = inserted.rows) === null || _c === void 0 ? void 0 : _c[0]) || {}, summary ? {} : { details_degraded: true }),
                row: ((_d = inserted.rows) === null || _d === void 0 ? void 0 : _d[0]) || null,
            };
        });
        if (!(result === null || result === void 0 ? void 0 : result.deduped)) {
            try {
                (0, store_1.addAudit)('LinenDeliveryRecord', recordId, 'create', null, result.row || result.response || null, actor);
            }
            catch (_b) { }
        }
        metrics.total_ms = Date.now() - requestStartedAt;
        inventoryLog(req, metrics.total_ms > 3000 ? 'error' : 'log', 'delivery_create_finish', {
            record_id: String(((_a = result === null || result === void 0 ? void 0 : result.response) === null || _a === void 0 ? void 0 : _a.id) || recordId),
            status: 'success',
            ...metrics,
        });
        return res.status(201).json(withTracePayload(req, result.response));
    }
    catch (e) {
        inventoryLog(req, 'error', 'delivery_create_finish', { status: 'failed', total_ms: Date.now() - requestStartedAt, message: String((e === null || e === void 0 ? void 0 : e.message) || 'failed') });
        return sendInventoryError(req, res, e);
    }
});
exports.router.patch('/linen/delivery-records/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = linenDeliveryRecordUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(withTracePayload(req, parsed.error.format()));
    if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id)
        return res.status(400).json(withTracePayload(req, { message: 'same warehouse' }));
    const id = String(req.params.id || '');
    const requestStartedAt = Date.now();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json(withTracePayload(req, { message: 'not available without PG' }));
        await ensureInventorySchema();
        const actor = actorId(req);
        inventoryLog(req, 'log', 'delivery_update_start', { record_id: id });
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            await client.query(`SET LOCAL lock_timeout = '5000ms'`);
            const current = await getEditableLinenDeliveryRecordForUpdate(client, id);
            if (!current)
                return { ok: false, code: 404, message: 'not found' };
            if (String(current.record.status || '') !== 'completed')
                return { ok: false, code: 400, message: '仅已完成配送单可编辑' };
            await assertWarehouseAllowsStocktake(client, parsed.data.to_warehouse_id);
            const before = await loadLinenDeliveryRecordDetail(client, id);
            const reverted = await revertLinenDeliveryRecordStockByRefInTx(client, {
                record_id: id,
                actor_id: actor,
                note: String(current.record.note || ''),
            });
            assertStockTxnOk(reverted);
            const expandedLines = await expandLinenDeliveryInputLines(client, parsed.data.lines);
            const expandedExtraLines = await expandLinenDeliveryExtraInputLines(client, parsed.data.extra_linen_lines || []);
            await client.query(`UPDATE linen_delivery_records
         SET delivery_date = $1::date,
             from_warehouse_id = $2,
             to_warehouse_id = $3,
             note = $4,
             updated_at = now()
         WHERE id = $5`, [parsed.data.delivery_date, parsed.data.from_warehouse_id, parsed.data.to_warehouse_id, parsed.data.note || null, id]);
            await client.query(`DELETE FROM linen_delivery_record_lines WHERE record_id = $1`, [id]);
            await client.query(`DELETE FROM linen_delivery_record_extra_lines WHERE record_id = $1`, [id]);
            for (const line of expandedLines) {
                await client.query(`INSERT INTO linen_delivery_record_lines (id, record_id, room_type_code, room_type_name, sets)
           VALUES ($1,$2,$3,$4,$5)`, [(0, uuid_1.v4)(), id, line.room_type_code, line.room_type_name, line.sets]);
            }
            for (const line of expandedExtraLines) {
                await client.query(`INSERT INTO linen_delivery_record_extra_lines (id, record_id, linen_type_code, linen_type_name, quantity)
           VALUES ($1,$2,$3,$4,$5)`, [(0, uuid_1.v4)(), id, line.linen_type_code, line.linen_type_name, line.quantity]);
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
            });
            assertStockTxnOk(applied);
            await upsertLinenStocktakeRecordInTx(client, {
                delivery_record_id: id,
                warehouse_id: parsed.data.to_warehouse_id,
                stocktake_date: parsed.data.delivery_date,
                dirty_bag_note: parsed.data.dirty_bag_note || null,
                note: parsed.data.note || null,
                actor_id: actor,
                lines: parsed.data.stocktake_lines,
            });
            const after = await loadLinenDeliveryRecordDetail(client, id);
            if (!after)
                throw httpError(500, '配送单更新后读取详情失败');
            return { ok: true, before, after };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok)) {
            return res.status(Number((result === null || result === void 0 ? void 0 : result.code) || 400)).json(withTracePayload(req, { message: String((result === null || result === void 0 ? void 0 : result.message) || 'failed') }));
        }
        try {
            (0, store_1.addAudit)('LinenDeliveryRecord', id, 'update', result.before || null, result.after || null, actor);
        }
        catch (_a) { }
        inventoryLog(req, 'log', 'delivery_update_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'success' });
        return res.json(result.after);
    }
    catch (e) {
        inventoryLog(req, 'error', 'delivery_update_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'failed', message: String((e === null || e === void 0 ? void 0 : e.message) || 'failed') });
        return sendInventoryError(req, res, e);
    }
});
exports.router.post('/linen/delivery-records/:id/cancel', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const id = String(req.params.id || '');
    const requestStartedAt = Date.now();
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json(withTracePayload(req, { message: 'not available without PG' }));
        await ensureInventorySchema();
        const actor = actorId(req);
        inventoryLog(req, 'log', 'delivery_cancel_start', { record_id: id });
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a;
            await client.query(`SET LOCAL lock_timeout = '5000ms'`);
            const current = await getEditableLinenDeliveryRecordForUpdate(client, id);
            if (!current)
                return { ok: false, code: 404, message: 'not found' };
            if (String(current.record.status || '') === 'cancelled')
                return { ok: false, code: 400, message: '该配送单已作废' };
            const before = loadLinenDeliveryRecordSummary(client, id);
            const reverted = await revertLinenDeliveryRecordStockByRefInTx(client, {
                record_id: id,
                actor_id: actor,
                note: String(current.record.note || ''),
            });
            assertStockTxnOk(reverted);
            await client.query(`UPDATE linen_delivery_records
         SET status = 'cancelled',
             updated_at = now(),
             cancelled_by = $2,
             cancelled_at = now()
         WHERE id = $1`, [id, actor]);
            const afterRes = await client.query(`SELECT id, delivery_date, status, created_at, updated_at, cancelled_by, cancelled_at
         FROM linen_delivery_records
         WHERE id = $1
         LIMIT 1`, [id]);
            const afterRow = ((_a = afterRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!afterRow)
                throw httpError(500, '配送单作废后读取摘要失败');
            const [beforeSummary, afterSummary] = await Promise.all([
                before,
                Promise.resolve(buildDeliverySuccessResponse(afterRow, {
                    cancelled_by: afterRow.cancelled_by || null,
                    cancelled_at: afterRow.cancelled_at || null,
                })),
            ]);
            return { ok: true, before: beforeSummary, after: afterSummary };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok)) {
            return res.status(Number((result === null || result === void 0 ? void 0 : result.code) || 400)).json(withTracePayload(req, { message: String((result === null || result === void 0 ? void 0 : result.message) || 'failed') }));
        }
        try {
            (0, store_1.addAudit)('LinenDeliveryRecord', id, 'cancel', result.before || null, result.after || null, actor);
        }
        catch (_a) { }
        inventoryLog(req, 'log', 'delivery_cancel_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'success' });
        return res.json(result.after);
    }
    catch (e) {
        inventoryLog(req, 'error', 'delivery_cancel_finish', { record_id: id, total_ms: Date.now() - requestStartedAt, status: 'failed', message: String((e === null || e === void 0 ? void 0 : e.message) || 'failed') });
        return sendInventoryError(req, res, e);
    }
});
const linenDeliveryPlanCreateSchema = zod_1.z.object({
    plan_date: zod_1.z.string().min(1),
    date_from: zod_1.z.string().optional(),
    date_to: zod_1.z.string().optional(),
    from_warehouse_id: zod_1.z.string().min(1),
    vehicle_capacity_sets: zod_1.z.number().int().min(1).optional(),
    note: zod_1.z.string().optional(),
    lines: zod_1.z.array(zod_1.z.object({
        to_warehouse_id: zod_1.z.string().min(1),
        room_type_code: zod_1.z.string().min(1),
        current_sets: zod_1.z.number().int().min(0),
        demand_sets: zod_1.z.number().int().min(0),
        target_sets: zod_1.z.number().int().min(0),
        suggested_sets: zod_1.z.number().int().min(0),
        warehouse_capacity_sets: zod_1.z.number().int().nullable().optional(),
        vehicle_load_sets: zod_1.z.number().int().min(0).optional(),
        note: zod_1.z.string().optional(),
    })).min(1),
});
exports.router.get('/linen/delivery-plans', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const rows = await dbAdapter_1.pgPool.query(`SELECT p.*, fw.code AS from_warehouse_code, fw.name AS from_warehouse_name,
              COUNT(l.id)::int AS line_count,
              COALESCE(SUM(l.actual_sets),0)::int AS actual_sets_total,
              COALESCE(SUM(l.suggested_sets),0)::int AS suggested_sets_total
       FROM linen_delivery_plans p
       JOIN warehouses fw ON fw.id = p.from_warehouse_id
       LEFT JOIN linen_delivery_plan_lines l ON l.plan_id = p.id
       GROUP BY p.id, fw.code, fw.name
       ORDER BY p.plan_date DESC, p.created_at DESC
       LIMIT 100`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen/delivery-plans', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = linenDeliveryPlanCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const body = parsed.data;
        const planId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e;
            const planRow = await client.query(`INSERT INTO linen_delivery_plans (id, plan_date, from_warehouse_id, date_from, date_to, vehicle_capacity_sets, status, note, created_by)
         VALUES ($1,$2::date,$3,NULLIF($4,'')::date,NULLIF($5,'')::date,$6,'planned',$7,$8)
         RETURNING *`, [planId, body.plan_date, body.from_warehouse_id, body.date_from || null, body.date_to || null, (_a = body.vehicle_capacity_sets) !== null && _a !== void 0 ? _a : null, body.note || null, actorId(req)]);
            const lines = [];
            for (const line of body.lines) {
                const row = await client.query(`INSERT INTO linen_delivery_plan_lines (id, plan_id, to_warehouse_id, room_type_code, current_sets, demand_sets, target_sets, suggested_sets, actual_sets, warehouse_capacity_sets, vehicle_load_sets, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11)
           RETURNING *`, [(0, uuid_1.v4)(), planId, line.to_warehouse_id, line.room_type_code, line.current_sets, line.demand_sets, line.target_sets, line.suggested_sets, (_b = line.warehouse_capacity_sets) !== null && _b !== void 0 ? _b : null, (_c = line.vehicle_load_sets) !== null && _c !== void 0 ? _c : line.suggested_sets, line.note || null]);
                lines.push(((_d = row.rows) === null || _d === void 0 ? void 0 : _d[0]) || null);
            }
            return { plan: ((_e = planRow.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, lines };
        });
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const linenReturnIntakeSchema = zod_1.z.object({
    from_warehouse_id: zod_1.z.string().min(1),
    quantity: zod_1.z.number().int().min(1),
    item_id: zod_1.z.string().min(1),
    note: zod_1.z.string().optional(),
});
exports.router.post('/linen/return-intakes', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = linenReturnIntakeSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const smWarehouse = await getSmWarehouse();
        const smWarehouseId = String((smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '');
        const intakeId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
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
            });
            if (!out.ok)
                return out;
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
            });
            if (!inn.ok)
                return inn;
            return { ok: true, intake_id: intakeId };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(result.code).json({ message: result.message });
        return res.status(201).json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const supplierReturnBatchSchema = zod_1.z.object({
    supplier_id: zod_1.z.string().min(1),
    warehouse_id: zod_1.z.string().optional(),
    returned_at: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
    photo_urls: zod_1.z.array(zod_1.z.string().min(1)).optional(),
    lines: zod_1.z.array(zod_1.z.object({
        item_id: zod_1.z.string().min(1),
        quantity: zod_1.z.number().int().min(1),
        refund_unit_price: zod_1.z.number().min(0).optional(),
        note: zod_1.z.string().optional(),
    })).min(1),
});
function supplierReturnBatchError(info) {
    const err = new Error(info.message || 'failed');
    err.statusCode = info.code;
    return err;
}
exports.router.get('/linen/supplier-return-batches', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const missingNoRows = await dbAdapter_1.pgPool.query(`SELECT id, return_no, returned_at, created_at FROM linen_supplier_return_batches WHERE COALESCE(return_no, '') = '' ORDER BY created_at ASC LIMIT 200`);
        for (const row of missingNoRows.rows || [])
            await ensureSupplierReturnNo(dbAdapter_1.pgPool, row);
        const rows = await dbAdapter_1.pgPool.query(`SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
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
      LIMIT 100`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.post('/linen/supplier-return-batches', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = supplierReturnBatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const smWarehouse = await getSmWarehouse();
        const warehouseId = String(parsed.data.warehouse_id || (smWarehouse === null || smWarehouse === void 0 ? void 0 : smWarehouse.id) || '').trim();
        const batchId = (0, uuid_1.v4)();
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e, _f;
            const priceMap = await getLatestSupplierItemPrice(client, parsed.data.supplier_id);
            const batchRow = await client.query(`INSERT INTO linen_supplier_return_batches (id, supplier_id, warehouse_id, status, returned_at, note, photo_urls, created_by)
         VALUES ($1,$2,$3,'returned',$4,$5,$6::jsonb,$7)
         RETURNING *`, [
                batchId,
                parsed.data.supplier_id,
                warehouseId,
                parsed.data.returned_at || new Date().toISOString(),
                parsed.data.note || null,
                JSON.stringify(Array.isArray(parsed.data.photo_urls) ? parsed.data.photo_urls.filter(Boolean) : []),
                actorId(req),
            ]);
            await ensureSupplierReturnNo(client, ((_a = batchRow.rows) === null || _a === void 0 ? void 0 : _a[0]) || { id: batchId, returned_at: parsed.data.returned_at || new Date().toISOString() });
            const lines = [];
            let expectedAmount = 0;
            for (const line of parsed.data.lines) {
                const priceRow = priceMap.get(String(line.item_id));
                const refundUnitPrice = (_b = line.refund_unit_price) !== null && _b !== void 0 ? _b : (priceRow ? Number(priceRow.refund_unit_price || 0) : 0);
                const amountTotal = Number(refundUnitPrice || 0) * Number(line.quantity || 0);
                const row = await client.query(`INSERT INTO linen_supplier_return_batch_lines (id, batch_id, item_id, quantity, refund_unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`, [(0, uuid_1.v4)(), batchId, line.item_id, line.quantity, refundUnitPrice, amountTotal, line.note || null]);
                lines.push(((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
                expectedAmount += amountTotal;
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
                });
                if (!applied.ok)
                    throw supplierReturnBatchError({ code: applied.code, message: applied.message });
            }
            const refundRow = await client.query(`INSERT INTO linen_supplier_refunds (id, batch_id, supplier_id, warehouse_id, expected_amount, received_amount, variance_amount, status, note, updated_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'pending',$7,now())
         RETURNING *`, [(0, uuid_1.v4)(), batchId, parsed.data.supplier_id, warehouseId, expectedAmount, 0 - expectedAmount, parsed.data.note || null]);
            await client.query(`UPDATE linen_supplier_return_batches SET updated_at = now() WHERE id = $1`, [batchId]);
            const batchFinal = await client.query(`SELECT * FROM linen_supplier_return_batches WHERE id = $1`, [batchId]);
            return { ok: true, batch: ((_d = batchFinal.rows) === null || _d === void 0 ? void 0 : _d[0]) || ((_e = batchRow.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, lines, refund: ((_f = refundRow.rows) === null || _f === void 0 ? void 0 : _f[0]) || null };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(result.code).json({ message: result.message });
        return res.status(201).json(result);
    }
    catch (e) {
        if (Number((e === null || e === void 0 ? void 0 : e.statusCode) || 0) > 0)
            return res.status(Number(e.statusCode)).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/supplier-return-batches/:id', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    var _a;
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '').trim();
        if (!id)
            return res.status(400).json({ message: 'missing id' });
        const row = await dbAdapter_1.pgPool.query(`SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
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
       LIMIT 1`, [id]);
        if (!((_a = row.rows) === null || _a === void 0 ? void 0 : _a[0]))
            return res.status(404).json({ message: 'not found' });
        if (!String(row.rows[0].return_no || '').trim())
            row.rows[0].return_no = await ensureSupplierReturnNo(dbAdapter_1.pgPool, row.rows[0]);
        return res.json(row.rows[0]);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.patch('/linen/supplier-return-batches/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    const parsed = supplierReturnBatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '').trim();
        if (!id)
            return res.status(400).json({ message: 'missing id' });
        const result = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a, _b, _c, _d, _e, _f;
            const existing = await client.query(`SELECT * FROM linen_supplier_return_batches WHERE id = $1 LIMIT 1`, [id]);
            const batch = (_a = existing.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!batch)
                throw supplierReturnBatchError({ code: 404, message: 'not found' });
            const existingLinesRes = await client.query(`SELECT * FROM linen_supplier_return_batch_lines WHERE batch_id = $1`, [id]);
            const existingLines = existingLinesRes.rows || [];
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
                });
                if (!reversed.ok)
                    throw supplierReturnBatchError({ code: reversed.code, message: reversed.message });
            }
            await client.query(`DELETE FROM linen_supplier_refunds WHERE batch_id = $1`, [id]);
            await client.query(`DELETE FROM linen_supplier_return_batch_lines WHERE batch_id = $1`, [id]);
            const priceMap = await getLatestSupplierItemPrice(client, parsed.data.supplier_id);
            const nextWarehouseId = String(parsed.data.warehouse_id || batch.warehouse_id || '').trim();
            const nextPhotoUrls = JSON.stringify(Array.isArray(parsed.data.photo_urls) ? parsed.data.photo_urls.filter(Boolean) : []);
            await client.query(`UPDATE linen_supplier_return_batches
         SET supplier_id = $2,
             warehouse_id = $3,
             returned_at = $4,
             note = $5,
             photo_urls = $6::jsonb,
             updated_at = now()
         WHERE id = $1`, [id, parsed.data.supplier_id, nextWarehouseId, parsed.data.returned_at || batch.returned_at || new Date().toISOString(), parsed.data.note || null, nextPhotoUrls]);
            await ensureSupplierReturnNo(client, { id, return_no: batch.return_no, returned_at: parsed.data.returned_at || batch.returned_at || new Date().toISOString(), created_at: batch.created_at });
            const lines = [];
            let expectedAmount = 0;
            for (const line of parsed.data.lines) {
                const priceRow = priceMap.get(String(line.item_id));
                const refundUnitPrice = (_b = line.refund_unit_price) !== null && _b !== void 0 ? _b : (priceRow ? Number(priceRow.refund_unit_price || 0) : 0);
                const amountTotal = Number(refundUnitPrice || 0) * Number(line.quantity || 0);
                const row = await client.query(`INSERT INTO linen_supplier_return_batch_lines (id, batch_id, item_id, quantity, refund_unit_price, amount_total, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`, [(0, uuid_1.v4)(), id, line.item_id, line.quantity, refundUnitPrice, amountTotal, line.note || null]);
                lines.push(((_c = row.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
                expectedAmount += amountTotal;
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
                });
                if (!applied.ok)
                    throw supplierReturnBatchError({ code: applied.code, message: applied.message });
            }
            const refundRow = await client.query(`INSERT INTO linen_supplier_refunds (id, batch_id, supplier_id, warehouse_id, expected_amount, received_amount, variance_amount, status, note, updated_at)
         VALUES ($1,$2,$3,$4,$5,0,$6,'pending',$7,now())
         RETURNING *`, [(0, uuid_1.v4)(), id, parsed.data.supplier_id, nextWarehouseId, expectedAmount, 0 - expectedAmount, parsed.data.note || null]);
            const detail = await client.query(`SELECT b.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name,
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
         LIMIT 1`, [id]);
            if (((_d = detail.rows) === null || _d === void 0 ? void 0 : _d[0]) && !String(detail.rows[0].return_no || '').trim())
                detail.rows[0].return_no = await ensureSupplierReturnNo(client, detail.rows[0]);
            return { ok: true, batch: ((_e = detail.rows) === null || _e === void 0 ? void 0 : _e[0]) || null, lines, refund: ((_f = refundRow.rows) === null || _f === void 0 ? void 0 : _f[0]) || null };
        });
        return res.json(result);
    }
    catch (e) {
        if (Number((e === null || e === void 0 ? void 0 : e.statusCode) || 0) > 0)
            return res.status(Number(e.statusCode)).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.delete('/linen/supplier-return-batches/:id', (0, auth_1.requirePerm)('inventory.move'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '').trim();
        if (!id)
            return res.status(400).json({ message: 'missing id' });
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            var _a;
            const existing = await client.query(`SELECT * FROM linen_supplier_return_batches WHERE id = $1 LIMIT 1`, [id]);
            const batch = (_a = existing.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!batch)
                throw supplierReturnBatchError({ code: 404, message: 'not found' });
            const existingLinesRes = await client.query(`SELECT * FROM linen_supplier_return_batch_lines WHERE batch_id = $1`, [id]);
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
                });
                if (!reversed.ok)
                    throw supplierReturnBatchError({ code: reversed.code, message: reversed.message });
            }
            await client.query(`DELETE FROM linen_supplier_return_batches WHERE id = $1`, [id]);
            return { ok: true };
        });
        return res.json({ ok: true });
    }
    catch (e) {
        if (Number((e === null || e === void 0 ? void 0 : e.statusCode) || 0) > 0)
            return res.status(Number(e.statusCode)).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
exports.router.get('/linen/supplier-refunds', (0, auth_1.requirePerm)('inventory.view'), async (req, res) => {
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.json([]);
        await ensureInventorySchema();
        const rows = await dbAdapter_1.pgPool.query(`SELECT r.*, s.name AS supplier_name, w.code AS warehouse_code, w.name AS warehouse_name
       FROM linen_supplier_refunds r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN warehouses w ON w.id = r.warehouse_id
       ORDER BY r.created_at DESC
       LIMIT 100`);
        return res.json(rows.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
const supplierRefundPatchSchema = zod_1.z.object({
    received_amount: zod_1.z.number().min(0).optional(),
    status: zod_1.z.enum(['pending', 'partial', 'settled', 'disputed']).optional(),
    received_at: zod_1.z.string().optional(),
    note: zod_1.z.string().optional(),
});
exports.router.patch('/linen/supplier-refunds/:id', (0, auth_1.requirePerm)('inventory.po.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = supplierRefundPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (!(dbAdapter_1.hasPg && dbAdapter_1.pgPool))
            return res.status(501).json({ message: 'not available without PG' });
        await ensureInventorySchema();
        const id = String(req.params.id || '');
        const before = await dbAdapter_1.pgPool.query(`SELECT * FROM linen_supplier_refunds WHERE id = $1`, [id]);
        const row = (_a = before.rows) === null || _a === void 0 ? void 0 : _a[0];
        if (!row)
            return res.status(404).json({ message: 'not found' });
        const nextReceivedAmount = (_b = parsed.data.received_amount) !== null && _b !== void 0 ? _b : Number(row.received_amount || 0);
        const expectedAmount = Number(row.expected_amount || 0);
        let nextStatus = parsed.data.status;
        if (!nextStatus) {
            if (nextReceivedAmount <= 0)
                nextStatus = 'pending';
            else if (Math.abs(nextReceivedAmount - expectedAmount) < 0.0001)
                nextStatus = 'settled';
            else if (nextReceivedAmount < expectedAmount)
                nextStatus = 'partial';
            else
                nextStatus = 'disputed';
        }
        const updated = await dbAdapter_1.pgPool.query(`UPDATE linen_supplier_refunds
       SET received_amount = $1,
           variance_amount = $1 - expected_amount,
           status = $2,
           received_at = COALESCE(NULLIF($3,'')::timestamptz, received_at),
           note = COALESCE($4, note),
           updated_at = now()
       WHERE id = $5
       RETURNING *`, [nextReceivedAmount, nextStatus, parsed.data.received_at || null, parsed.data.note || null, id]);
        return res.json(((_c = updated.rows) === null || _c === void 0 ? void 0 : _c[0]) || null);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'failed' });
    }
});
