"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const events_1 = require("./events");
const zod_1 = require("zod");
const auth_1 = require("../auth");
// Supabase removed
const dbAdapter_1 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
function dayOnly(s) {
    if (!s)
        return undefined;
    try {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${yyyy}-${mm}-${dd}`;
        }
    }
    catch (_a) { }
    const m = /^\d{4}-\d{2}-\d{2}/.exec(String(s));
    return m ? m[0] : undefined;
}
async function findSimilarOrders(candidate) {
    var _a, _b, _c, _d;
    const reasons = [];
    const similar = [];
    const cc = String((candidate === null || candidate === void 0 ? void 0 : candidate.confirmation_code) || '').trim();
    const pid = String((candidate === null || candidate === void 0 ? void 0 : candidate.property_id) || '').trim();
    const gn = String((candidate === null || candidate === void 0 ? void 0 : candidate.guest_name) || '').trim().toLowerCase();
    const gp = String((candidate === null || candidate === void 0 ? void 0 : candidate.guest_phone) || '').trim();
    const ci = String((candidate === null || candidate === void 0 ? void 0 : candidate.checkin) || '').slice(0, 10);
    const co = String((candidate === null || candidate === void 0 ? void 0 : candidate.checkout) || '').slice(0, 10);
    const price = Number((candidate === null || candidate === void 0 ? void 0 : candidate.price) || 0);
    const nowIso = new Date().toISOString();
    try {
        if (dbAdapter_1.hasPg) {
            const rows = (await (0, dbAdapter_1.pgSelect)('orders')) || [];
            const sameCode = rows.filter(r => cc && String(r.confirmation_code || '').trim() === cc && (!pid || String(r.property_id || '') === pid));
            if (sameCode.length) {
                reasons.push('confirmation_code_duplicate');
                similar.push(...sameCode);
                if ((_a = sameCode[0]) === null || _a === void 0 ? void 0 : _a.id)
                    candidate.__dup_id = sameCode[0].id;
            }
            const sameContent = rows.filter(r => {
                const rPid = String(r.property_id || '');
                const rGn = String(r.guest_name || '').trim().toLowerCase();
                const rGp = String(r.guest_phone || '').trim();
                const rCi = String(r.checkin || '').slice(0, 10);
                const rCo = String(r.checkout || '').slice(0, 10);
                const rPrice = Number(r.price || 0);
                const nameMatch = !!gn && rGn === gn;
                const phoneMatch = !!gp && rGp === gp;
                const whoMatch = (nameMatch || phoneMatch);
                const propertyMatch = !!pid && rPid === pid;
                const rangeMatch = !!ci && !!co && rCi === ci && rCo === co;
                const priceMatch = isFinite(price) && isFinite(rPrice) && Math.abs(rPrice - price) < 0.01;
                return propertyMatch && whoMatch && rangeMatch && priceMatch;
            });
            if (sameContent.length) {
                reasons.push('content_duplicate');
                similar.push(...sameContent.filter(x => !similar.find(y => y.id === x.id)));
            }
            const near = rows.filter(r => {
                const rCi = String(r.checkin || '').slice(0, 10);
                const rCo = String(r.checkout || '').slice(0, 10);
                const sameRange = !!ci && !!co && rCi === ci && rCo === co;
                const samePid = !!pid && String(r.property_id || '') === pid;
                const createdAt = new Date(String(r.created_at || r.createdAt || nowIso));
                const within15m = isFinite(createdAt.getTime()) ? (Math.abs(Date.now() - createdAt.getTime()) <= 15 * 60 * 1000) : false;
                const whoMatch = (String(r.guest_name || '').trim().toLowerCase() === gn) || (!!gp && String(r.guest_phone || '').trim() === gp);
                return sameRange && samePid && whoMatch && within15m;
            });
            if (near.length) {
                reasons.push('recent_duplicate');
                similar.push(...near.filter(x => !similar.find(y => y.id === x.id)));
            }
            const dupByCodeId = ((_b = sameCode[0]) === null || _b === void 0 ? void 0 : _b.id) ? String(sameCode[0].id) : undefined;
            return { reasons: Array.from(new Set(reasons)), similar, duplicateByCodeId: dupByCodeId };
        }
    }
    catch (_e) { }
    const localRows = store_1.db.orders;
    const sameCode = localRows.filter(r => cc && String(r.confirmation_code || '').trim() === cc && (!pid || String(r.property_id || '') === pid));
    if (sameCode.length) {
        reasons.push('confirmation_code_duplicate');
        similar.push(...sameCode);
        if ((_c = sameCode[0]) === null || _c === void 0 ? void 0 : _c.id)
            candidate.__dup_id = sameCode[0].id;
    }
    const sameContent = localRows.filter(r => {
        const rPid = String(r.property_id || '');
        const rGn = String(r.guest_name || '').trim().toLowerCase();
        const rGp = String(r.guest_phone || '').trim();
        const rCi = String(r.checkin || '').slice(0, 10);
        const rCo = String(r.checkout || '').slice(0, 10);
        const rPrice = Number(r.price || 0);
        const nameMatch = !!gn && rGn === gn;
        const phoneMatch = !!gp && rGp === gp;
        const whoMatch = (nameMatch || phoneMatch);
        const propertyMatch = !!pid && rPid === pid;
        const rangeMatch = !!ci && !!co && rCi === ci && rCo === co;
        const priceMatch = isFinite(price) && isFinite(rPrice) && Math.abs(rPrice - price) < 0.01;
        return propertyMatch && whoMatch && rangeMatch && priceMatch;
    });
    if (sameContent.length) {
        reasons.push('content_duplicate');
        similar.push(...sameContent.filter(x => !similar.find(y => y.id === x.id)));
    }
    const near = localRows.filter(r => {
        const rCi = String(r.checkin || '').slice(0, 10);
        const rCo = String(r.checkout || '').slice(0, 10);
        const sameRange = !!ci && !!co && rCi === ci && rCo === co;
        const samePid = !!pid && String(r.property_id || '') === pid;
        const createdAt = new Date(String(r.created_at || nowIso));
        const within15m = isFinite(createdAt.getTime()) ? (Math.abs(Date.now() - createdAt.getTime()) <= 15 * 60 * 1000) : false;
        const whoMatch = (String(r.guest_name || '').trim().toLowerCase() === gn) || (!!gp && String(r.guest_phone || '').trim() === gp);
        return sameRange && samePid && whoMatch && within15m;
    });
    if (near.length) {
        reasons.push('recent_duplicate');
        similar.push(...near.filter(x => !similar.find(y => y.id === x.id)));
    }
    const dupByCodeId = ((_d = sameCode[0]) === null || _d === void 0 ? void 0 : _d.id) ? String(sameCode[0].id) : undefined;
    return { reasons: Array.from(new Set(reasons)), similar, duplicateByCodeId: dupByCodeId };
}
async function recordDuplicateAttempt(payload, reasons, similar, actor) {
    try {
        const row = { id: require('uuid').v4(), payload, reasons, similar_ids: similar.map(x => x.id), actor_id: actor === null || actor === void 0 ? void 0 : actor.sub, created_at: new Date().toISOString() };
        (0, store_1.addAudit)('OrderDuplicate', row.id, 'attempt', null, row, actor === null || actor === void 0 ? void 0 : actor.sub);
        if (dbAdapter_1.hasPg) {
            try {
                await (0, dbAdapter_1.pgInsert)('order_duplicate_attempts', row);
            }
            catch (e) {
                const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                try {
                    const { pgPool } = require('../dbAdapter');
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(`CREATE TABLE IF NOT EXISTS order_duplicate_attempts (
            id text PRIMARY KEY,
            payload jsonb,
            reasons text[],
            similar_ids text[],
            actor_id text,
            created_at timestamptz DEFAULT now()
          )`));
                    await (0, dbAdapter_1.pgInsert)('order_duplicate_attempts', row);
                }
                catch (_a) { }
            }
        }
    }
    catch (_b) { }
}
exports.router.get('/', async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const remote = (await (0, dbAdapter_1.pgSelect)('orders')) || [];
            let pRows = [];
            try {
                const raw = await (0, dbAdapter_1.pgSelect)('properties', 'id,code,address,listing_names');
                pRows = Array.isArray(raw) ? raw : [];
            }
            catch (_a) { }
            const byId = Object.fromEntries((pRows || []).map((p) => [String(p.id), p]));
            const byCode = Object.fromEntries((pRows || []).map((p) => [String(p.code || ''), p]));
            const byListing = {};
            (pRows || []).forEach((p) => {
                const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {};
                Object.values(ln || {}).forEach((name) => { if (name)
                    byListing[String(name).toLowerCase()] = String(p.id); });
            });
            const labeled = (remote || []).map((o) => {
                const pid = String(o.property_id || '');
                const pid2 = byListing[String((o.listing_name || '')).toLowerCase()] || '';
                const prop = byId[pid] || byCode[pid] || byId[pid2];
                const label = (o.property_code || (prop === null || prop === void 0 ? void 0 : prop.code) || (prop === null || prop === void 0 ? void 0 : prop.address) || pid);
                const property_name = ((prop === null || prop === void 0 ? void 0 : prop.address) || undefined);
                const base = { ...o, checkin: dayOnly(o.checkin), checkout: dayOnly(o.checkout) };
                return property_name ? { ...base, property_code: label, property_name } : { ...base, property_code: label };
            });
            async function enrich(rows) {
                const ids = rows.map(r => String(r.id));
                const totals = {};
                try {
                    const { pgPool } = require('../dbAdapter');
                    const sql = 'SELECT order_id, COALESCE(SUM(amount),0) AS total FROM order_internal_deductions WHERE is_active=true AND order_id = ANY($1) GROUP BY order_id';
                    const rs = await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(sql, [ids]));
                    const arr = ((rs === null || rs === void 0 ? void 0 : rs.rows) || []);
                    arr.forEach(r => { totals[String(r.order_id)] = Number(r.total || 0); });
                }
                catch (_a) { }
                return rows.map(r => {
                    const t = totals[String(r.id)] || 0;
                    const vn = Number(r.net_income || 0) - t;
                    const status = String(r.status || '').toLowerCase();
                    const isCanceled = status.includes('cancel');
                    const include = (!isCanceled) || !!r.count_in_income;
                    const visible = include ? Number(vn.toFixed(2)) : 0;
                    return { ...r, internal_deduction_total: Number(t.toFixed(2)), visible_net_income: visible };
                });
            }
            const enriched = await enrich(labeled);
            return res.json(enriched);
        }
        // Supabase branch removed
        const out = store_1.db.orders.map((o) => {
            const prop = store_1.db.properties.find((p) => String(p.id) === String(o.property_id)) || store_1.db.properties.find((p) => String(p.code || '') === String(o.property_id || '')) || store_1.db.properties.find((p) => { const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {}; return Object.values(ln || {}).map(String).map(s => s.toLowerCase()).includes(String(o.listing_name || '').toLowerCase()); });
            const property_name = (prop === null || prop === void 0 ? void 0 : prop.address) || undefined;
            const label = (o.property_code || (prop === null || prop === void 0 ? void 0 : prop.code) || (prop === null || prop === void 0 ? void 0 : prop.address) || o.property_id || '');
            const base = { ...o, checkin: dayOnly(o.checkin), checkout: dayOnly(o.checkout) };
            const row = property_name ? { ...base, property_code: label, property_name } : { ...base, property_code: label };
            const t = 0;
            const vn = Number(row.net_income || 0) - t;
            return { ...row, internal_deduction_total: 0, visible_net_income: Number(vn.toFixed(2)) };
        });
        return res.json(out);
    }
    catch (_b) {
        const out2 = store_1.db.orders.map((o) => {
            const prop = store_1.db.properties.find((p) => String(p.id) === String(o.property_id)) || store_1.db.properties.find((p) => String(p.code || '') === String(o.property_id || '')) || store_1.db.properties.find((p) => { const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {}; return Object.values(ln || {}).map(String).map(s => s.toLowerCase()).includes(String(o.listing_name || '').toLowerCase()); });
            const property_name = (prop === null || prop === void 0 ? void 0 : prop.address) || undefined;
            const label = (o.property_code || (prop === null || prop === void 0 ? void 0 : prop.code) || (prop === null || prop === void 0 ? void 0 : prop.address) || o.property_id || '');
            const base = { ...o, checkin: dayOnly(o.checkin), checkout: dayOnly(o.checkout) };
            const row = property_name ? { ...base, property_code: label, property_name } : { ...base, property_code: label };
            const t = 0;
            const vn = Number(row.net_income || 0) - t;
            return { ...row, internal_deduction_total: 0, visible_net_income: Number(vn.toFixed(2)) };
        });
        return res.json(out2);
    }
});
exports.router.get('/:id', async (req, res) => {
    var _a, _b;
    const { id } = req.params;
    const local = store_1.db.orders.find((o) => o.id === id);
    if (local)
        return res.json(local);
    try {
        if (dbAdapter_1.hasPg) {
            const remote = await (0, dbAdapter_1.pgSelect)('orders', '*', { id });
            const row = Array.isArray(remote) ? remote[0] : null;
            if (row) {
                let total = 0;
                try {
                    const { pgPool } = require('../dbAdapter');
                    const rs = await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('SELECT COALESCE(SUM(amount),0) AS total FROM order_internal_deductions WHERE is_active=true AND order_id=$1', [id]));
                    total = Number(((_b = (_a = rs === null || rs === void 0 ? void 0 : rs.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.total) || 0);
                }
                catch (_c) { }
                const vn = Number(row.net_income || 0) - total;
                return res.json({ ...row, checkin: dayOnly(row.checkin), checkout: dayOnly(row.checkout), internal_deduction_total: Number(total.toFixed(2)), visible_net_income: Number(vn.toFixed(2)) });
            }
        }
        // Supabase branch removed
    }
    catch (_d) { }
    return res.status(404).json({ message: 'order not found' });
});
exports.router.get('/:id', (req, res) => {
    const { id } = req.params;
    const order = store_1.db.orders.find((o) => o.id === id);
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    const t = 0;
    const vn = Number(order.net_income || 0) - t;
    return res.json({ ...order, checkin: dayOnly(order.checkin), checkout: dayOnly(order.checkout), internal_deduction_total: 0, visible_net_income: Number(vn.toFixed(2)) });
});
const createOrderSchema = zod_1.z.object({
    source: zod_1.z.string(),
    external_id: zod_1.z.string().optional(),
    property_id: zod_1.z.string().optional(),
    property_code: zod_1.z.string().optional(),
    confirmation_code: zod_1.z.coerce.string().optional(),
    guest_name: zod_1.z.string().optional(),
    guest_phone: zod_1.z.string().optional(),
    checkin: zod_1.z.coerce.string().optional(),
    checkout: zod_1.z.coerce.string().optional(),
    price: zod_1.z.coerce.number().optional(),
    cleaning_fee: zod_1.z.coerce.number().optional(),
    net_income: zod_1.z.coerce.number().optional(),
    avg_nightly_price: zod_1.z.coerce.number().optional(),
    nights: zod_1.z.coerce.number().optional(),
    currency: zod_1.z.string().optional(),
    payment_currency: zod_1.z.string().optional(),
    payment_received: zod_1.z.boolean().optional(),
    status: zod_1.z.string().optional(),
    count_in_income: zod_1.z.boolean().optional(),
    idempotency_key: zod_1.z.string().optional(),
});
const updateOrderSchema = createOrderSchema.partial();
function parseDate(s) {
    if (!s)
        return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}
function normalizeStart(s) {
    if (!s)
        return null;
    const hasTime = /T\d{2}:\d{2}/.test(s);
    const d = new Date(hasTime ? s : `${s}T12:00:00`);
    return isNaN(d.getTime()) ? null : d;
}
function normalizeEnd(s) {
    if (!s)
        return null;
    const hasTime = /T\d{2}:\d{2}/.test(s);
    const d = new Date(hasTime ? s : `${s}T11:59:59`);
    return isNaN(d.getTime()) ? null : d;
}
function parseAirbnbDate(value) {
    const v = (value || '').trim();
    if (!v)
        return null;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    if (!m)
        return null;
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yyyy = Number(m[3]);
    const d = new Date(yyyy, mm - 1, dd);
    if (isNaN(d.getTime()))
        return null;
    if (d.getFullYear() !== yyyy || (d.getMonth() + 1) !== mm || d.getDate() !== dd)
        return null;
    return `${yyyy}-${m[1]}-${m[2]}`;
}
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    const ds = (s) => (s ? String(s).slice(0, 10) : '');
    const as = ds(aStart);
    const ae = ds(aEnd);
    const bs = ds(bStart);
    const be = ds(bEnd);
    if (!as || !ae || !bs || !be)
        return false;
    const asDay = new Date(`${as}T00:00:00`);
    const aeDay = new Date(`${ae}T00:00:00`);
    const bsDay = new Date(`${bs}T00:00:00`);
    const beDay = new Date(`${be}T00:00:00`);
    // day-level exclusive end: [checkin, checkout)
    return asDay < beDay && bsDay < aeDay;
}
function toIsoString(v) {
    if (!v)
        return '';
    if (typeof v === 'string')
        return v;
    try {
        const d = new Date(v);
        return isNaN(d.getTime()) ? '' : d.toISOString();
    }
    catch (_a) {
        return '';
    }
}
async function ensureOrdersColumns() {
    try {
        if (!dbAdapter_1.hasPg)
            return;
        const { pgPool } = require('../dbAdapter');
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_payment_raw numeric'));
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS processed_status text'));
    }
    catch (_a) { }
}
async function ensureOrdersIndexes() {
    try {
        if (!dbAdapter_1.hasPg)
            return;
        const { pgPool } = require('../dbAdapter');
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = "idx_orders_source_confirmation_code_unique") THEN DROP INDEX idx_orders_source_confirmation_code_unique; END $$;'));
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = "idx_orders_conf_pid_unique") THEN DROP INDEX idx_orders_conf_pid_unique; END $$;'));
        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_code_unique ON orders(confirmation_code) WHERE confirmation_code IS NOT NULL'));
    }
    catch (_a) { }
}
function round2(n) {
    if (n == null)
        return undefined;
    const x = Number(n);
    if (!isFinite(x))
        return undefined;
    return Number(x.toFixed(2));
}
async function hasOrderOverlap(propertyId, checkin, checkout, excludeId) {
    if (!propertyId || !checkin || !checkout)
        return false;
    const ciDay = String(checkin || '').slice(0, 10);
    const coDay = String(checkout || '').slice(0, 10);
    const localHit = store_1.db.orders.some(o => {
        if (o.property_id !== propertyId || o.id === excludeId)
            return false;
        const oCiDay = String(o.checkin || '').slice(0, 10);
        const oCoDay = String(o.checkout || '').slice(0, 10);
        if (oCoDay === ciDay || coDay === oCiDay)
            return false;
        return rangesOverlap(checkin, checkout, o.checkin, o.checkout);
    });
    if (localHit)
        return true;
    try {
        if (dbAdapter_1.hasPg) {
            const rows = (await (0, dbAdapter_1.pgSelect)('orders', '*', { property_id: propertyId })) || [];
            const remoteHit = rows.some((o) => {
                if (o.id === excludeId)
                    return false;
                const oCiDay = String(o.checkin || '').slice(0, 10);
                const oCoDay = String(o.checkout || '').slice(0, 10);
                if (oCoDay === ciDay || coDay === oCiDay)
                    return false;
                return rangesOverlap(checkin, checkout, o.checkin, o.checkout);
            });
            if (remoteHit)
                return true;
        }
        // Supabase branch removed
    }
    catch (_a) { }
    return false;
}
exports.router.post('/sync', (0, auth_1.requireAnyPerm)(['order.create', 'order.manage']), async (req, res) => {
    var _a, _b, _c, _d, _e;
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    const force = String((_b = (_a = req.body.force) !== null && _a !== void 0 ? _a : req.query.force) !== null && _b !== void 0 ? _b : '').toLowerCase() === 'true';
    try {
        const ci = normalizeStart(o.checkin || '');
        const co = normalizeEnd(o.checkout || '');
        if (ci && co && !(ci < co))
            return res.status(400).json({ message: '入住日期必须早于退房日期' });
    }
    catch (_f) { }
    let propertyId = o.property_id || (o.property_code ? ((_c = store_1.db.properties.find(p => (p.code || '') === o.property_code)) === null || _c === void 0 ? void 0 : _c.id) : undefined);
    // 如果传入的 property_id 不存在于 PG，则尝试用房号 code 在 PG 中查找并替换
    if (dbAdapter_1.hasPg) {
        try {
            const byId = propertyId ? (await (0, dbAdapter_1.pgSelect)('properties', 'id', { id: propertyId })) || [] : [];
            const existsById = Array.isArray(byId) && !!byId[0];
            if (!existsById && o.property_code) {
                const byCode = (await (0, dbAdapter_1.pgSelect)('properties', '*', { code: o.property_code })) || [];
                if (Array.isArray(byCode) && ((_d = byCode[0]) === null || _d === void 0 ? void 0 : _d.id))
                    propertyId = byCode[0].id;
            }
        }
        catch (_g) { }
    }
    const key = o.idempotency_key || `${propertyId || ''}-${o.checkin || ''}-${o.checkout || ''}`;
    const exists = store_1.db.orders.find((x) => x.idempotency_key === key);
    if (exists)
        return res.status(409).json({ message: '订单已存在：同一房源同时间段重复创建', order: exists });
    const { v4: uuid } = require('uuid');
    // derive values if not provided
    let nights = o.nights;
    if (!nights && o.checkin && o.checkout) {
        try {
            const ci = new Date(o.checkin);
            const co = new Date(o.checkout);
            const ms = co.getTime() - ci.getTime();
            nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
        }
        catch (_h) {
            nights = 0;
        }
    }
    const cleaning = round2(o.cleaning_fee || 0) || 0;
    const price = round2(o.price || 0) || 0;
    const net = o.net_income != null ? (round2(o.net_income) || 0) : ((round2(price - cleaning) || 0));
    const avg = o.avg_nightly_price != null ? (round2(o.avg_nightly_price) || 0) : (nights && nights > 0 ? (round2(net / nights) || 0) : 0);
    const newOrder = { id: uuid(), ...o, property_id: propertyId, price, cleaning_fee: cleaning, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key, status: 'confirmed' };
    newOrder.payment_currency = o.payment_currency || 'AUD';
    newOrder.payment_received = (_e = o.payment_received) !== null && _e !== void 0 ? _e : false;
    try {
        const dup = await findSimilarOrders({ ...newOrder });
        if (dup.reasons.length) {
            await recordDuplicateAttempt(newOrder, dup.reasons, dup.similar, req.user);
            if (!force)
                return res.status(409).json({ message: '疑似重复订单', reasons: dup.reasons, similar_orders: dup.similar });
        }
    }
    catch (_j) { }
    // overlap guard
    const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
    if (conflict)
        return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' });
    // confirmation_code 唯一性（PG）
    try {
        const cc = newOrder.confirmation_code;
        if (dbAdapter_1.hasPg && cc) {
            const dup = (await (0, dbAdapter_1.pgSelect)('orders', '*', { confirmation_code: cc })) || [];
            if (Array.isArray(dup) && dup[0]) {
                if (force) {
                    try {
                        const allow = ['source', 'external_id', 'property_id', 'guest_name', 'guest_phone', 'checkin', 'checkout', 'price', 'cleaning_fee', 'net_income', 'avg_nightly_price', 'nights', 'currency', 'status', 'confirmation_code', 'payment_currency', 'payment_received'];
                        const payload = {};
                        for (const k of allow) {
                            if (newOrder[k] !== undefined)
                                payload[k] = newOrder[k];
                        }
                        const row = await (0, dbAdapter_1.pgUpdate)('orders', String(dup[0].id), payload);
                        try {
                            (0, events_1.broadcastOrdersUpdated)({ action: 'update', id: String(dup[0].id) });
                        }
                        catch (_k) { }
                        return res.status(200).json(row || dup[0]);
                    }
                    catch (_l) { }
                }
                return res.status(409).json({ message: '确认码已存在', existing_order_id: String(dup[0].id) });
            }
        }
    }
    catch (_m) { }
    if (dbAdapter_1.hasPg) {
        try {
            if (newOrder.property_id) {
                try {
                    const propRows = (await (0, dbAdapter_1.pgSelect)('properties', 'id', { id: newOrder.property_id })) || [];
                    const existsProp = Array.isArray(propRows) && propRows[0];
                    if (!existsProp) {
                        const localProp = store_1.db.properties.find(p => p.id === newOrder.property_id);
                        const code = (newOrder.property_code || (localProp === null || localProp === void 0 ? void 0 : localProp.code));
                        const payload = { id: newOrder.property_id };
                        if (code)
                            payload.code = code;
                        if (localProp === null || localProp === void 0 ? void 0 : localProp.address)
                            payload.address = localProp.address;
                        await (0, dbAdapter_1.pgInsert)('properties', payload);
                    }
                }
                catch (_o) { }
            }
            const insertOrder = { ...newOrder };
            delete insertOrder.property_code;
            await ensureOrdersIndexes();
            const row = await (0, dbAdapter_1.pgInsert)('orders', insertOrder);
            try {
                (0, events_1.broadcastOrdersUpdated)({ action: 'create', id: row === null || row === void 0 ? void 0 : row.id });
            }
            catch (_p) { }
            return res.status(201).json(row);
        }
        catch (e) {
            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
            if (/column\s+"?confirmation_code"?\s+of\s+relation\s+"?orders"?\s+does\s+not\s+exist/i.test(msg)) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = \"idx_orders_confirmation_code_unique\") THEN BEGIN DROP INDEX IF EXISTS idx_orders_confirmation_code_unique; EXCEPTION WHEN others THEN NULL; END; END IF; END $$;'));
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_source_confirmation_code_unique ON orders(source, confirmation_code) WHERE confirmation_code IS NOT NULL'));
                    await ensureOrdersIndexes();
                    const ins = { ...newOrder };
                    delete ins.property_code;
                    const row = await (0, dbAdapter_1.pgInsert)('orders', ins);
                    return res.status(201).json(row);
                }
                catch (e2) {
                    return res.status(500).json({ message: '数据库写入失败', error: String((e2 === null || e2 === void 0 ? void 0 : e2.message) || '') });
                }
            }
            if (msg.includes('duplicate') || msg.includes('unique'))
                return res.status(409).json({ message: '确认码已存在' });
            return res.status(500).json({ message: '数据库写入失败', error: msg });
        }
    }
    // Supabase removed
    // 无远端数据库，使用内存存储
    store_1.db.orders.push(newOrder);
    try {
        (0, events_1.broadcastOrdersUpdated)({ action: 'create', id: newOrder.id });
    }
    catch (_q) { }
    return res.status(201).json(newOrder);
});
exports.router.post('/validate-duplicate', (0, auth_1.requireAnyPerm)(['order.create', 'order.manage']), async (req, res) => {
    var _a;
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    const propertyId = o.property_id || (o.property_code ? ((_a = store_1.db.properties.find(p => (p.code || '') === o.property_code)) === null || _a === void 0 ? void 0 : _a.id) : undefined);
    const candidate = { ...o, property_id: propertyId };
    try {
        const dup = await findSimilarOrders(candidate);
        if (dup.reasons.length) {
            await recordDuplicateAttempt(candidate, dup.reasons, dup.similar, req.user);
            return res.json({ is_duplicate: true, reasons: dup.reasons, similar_orders: dup.similar });
        }
        return res.json({ is_duplicate: false, reasons: [], similar_orders: [] });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'check_failed' });
    }
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('order.write'), async (req, res) => {
    var _a, _b, _c;
    const { id } = req.params;
    const parsed = updateOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    const force = String((_b = (_a = req.body.force) !== null && _a !== void 0 ? _a : req.query.force) !== null && _b !== void 0 ? _b : '').toLowerCase() === 'true';
    const idx = store_1.db.orders.findIndex((x) => x.id === id);
    const prev = idx !== -1 ? store_1.db.orders[idx] : undefined;
    let base = prev;
    if (!base && dbAdapter_1.hasPg) {
        try {
            const rows = (await (0, dbAdapter_1.pgSelect)('orders', '*', { id })) || [];
            base = Array.isArray(rows) ? rows[0] : undefined;
        }
        catch (_d) { }
    }
    if (!base)
        return res.status(404).json({ message: 'order not found' });
    if (!base)
        base = {};
    let nights = o.nights;
    const checkin = o.checkin || base.checkin;
    const checkout = o.checkout || base.checkout;
    try {
        const ci0 = normalizeStart(checkin || '');
        const co0 = normalizeEnd(checkout || '');
        if (ci0 && co0 && !(ci0 < co0))
            return res.status(400).json({ message: '入住日期必须早于退房日期' });
    }
    catch (_e) { }
    if (!nights && checkin && checkout) {
        try {
            const ci = new Date(checkin);
            const co = new Date(checkout);
            const ms = co.getTime() - ci.getTime();
            nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
        }
        catch (_f) {
            nights = 0;
        }
    }
    const price = o.price != null ? (round2(o.price) || 0) : (round2(base.price || 0) || 0);
    const cleaning = o.cleaning_fee != null ? (round2(o.cleaning_fee) || 0) : (round2(base.cleaning_fee || 0) || 0);
    const net = o.net_income != null ? (round2(o.net_income) || 0) : ((round2(price - cleaning) || 0));
    const avg = o.avg_nightly_price != null ? (round2(o.avg_nightly_price) || 0) : (nights && nights > 0 ? (round2(net / nights) || 0) : 0);
    const updated = { ...base, ...o, id, price, cleaning_fee: cleaning, nights, net_income: net, avg_nightly_price: avg };
    const prevStatus = String((prev === null || prev === void 0 ? void 0 : prev.status) || '');
    const nextStatus = String((updated === null || updated === void 0 ? void 0 : updated.status) || '');
    if (nextStatus === 'cancelled' && updated.count_in_income == null) {
        updated.count_in_income = false;
    }
    if (nextStatus !== 'cancelled' && updated.count_in_income == null) {
        updated.count_in_income = true;
    }
    if (prevStatus !== 'cancelled' && nextStatus === 'cancelled') {
        const role = String(((_c = req.user) === null || _c === void 0 ? void 0 : _c.role) || '');
        const locked = await isOrderMonthLocked(prev);
        if (!locked) {
            const { roleHasPermission } = require('../store');
            if (!roleHasPermission(role, 'order.cancel'))
                return res.status(403).json({ message: 'no permission to cancel' });
        }
        else {
            const { roleHasPermission } = require('../store');
            if (!roleHasPermission(role, 'order.cancel.override'))
                return res.status(403).json({ message: 'payout locked, override cancel required' });
        }
    }
    const changedCore = ((updated.property_id || '') !== ((prev === null || prev === void 0 ? void 0 : prev.property_id) || '') ||
        ((updated.checkin || '').slice(0, 10)) !== (((prev === null || prev === void 0 ? void 0 : prev.checkin) || '').slice(0, 10)) ||
        ((updated.checkout || '').slice(0, 10)) !== (((prev === null || prev === void 0 ? void 0 : prev.checkout) || '').slice(0, 10)));
    // 编辑场景不再阻断，允许覆盖更新（冲突仅在创建时校验）
    // 保留内部工具函数供日志或后续使用，但不阻塞响应
    if (idx !== -1) {
        store_1.db.orders[idx] = updated;
    }
    if (dbAdapter_1.hasPg) {
        try {
            const allow = ['source', 'external_id', 'property_id', 'guest_name', 'guest_phone', 'checkin', 'checkout', 'price', 'cleaning_fee', 'net_income', 'avg_nightly_price', 'nights', 'currency', 'status', 'confirmation_code'];
            const allowExtra = ['payment_currency', 'payment_received'];
            const allowAll = [...allow, ...allowExtra];
            const payload = {};
            for (const k of [...allowAll, 'count_in_income']) {
                if (updated[k] !== undefined)
                    payload[k] = updated[k];
            }
            const row = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
                const r1 = await (0, dbAdapter_1.pgUpdate)('orders', id, payload, client);
                // revert cancel -> confirmed: clean up cancel_fee records atomically
                const prevSt = prevStatus;
                const nextSt = String((updated === null || updated === void 0 ? void 0 : updated.status) || '');
                if (prevSt === 'cancelled' && nextSt !== 'cancelled') {
                    const q1 = await client.query(`SELECT id, occurred_at, amount, currency, note, property_id FROM finance_transactions WHERE ref_type='order' AND ref_id=$1 AND category='cancel_fee'`, [id]);
                    const txRows = q1.rows || [];
                    for (const t of txRows) {
                        try {
                            const q2 = await client.query(`DELETE FROM company_incomes
                 WHERE category='cancel_fee'
                   AND occurred_at=$1
                   AND amount=$2
                   AND (property_id IS NOT DISTINCT FROM $3)
                   AND coalesce(note,'') = coalesce($4,'')
                 RETURNING *`, [String(t.occurred_at).slice(0, 10), Number(t.amount || 0), t.property_id || null, String(t.note || '')]);
                            const delIncomes = q2.rows || [];
                            for (const ci of delIncomes) {
                                try {
                                    (0, store_1.addAudit)('CompanyIncome', ci.id, 'delete', ci, null);
                                }
                                catch (_a) { }
                            }
                        }
                        catch (_b) { }
                    }
                    if (txRows.length) {
                        const q3 = await client.query(`DELETE FROM finance_transactions WHERE ref_type='order' AND ref_id=$1 AND category='cancel_fee' RETURNING *`, [id]);
                        const delTxs = q3.rows || [];
                        for (const tx of delTxs) {
                            try {
                                (0, store_1.addAudit)('FinanceTransaction', tx.id, 'delete', tx, null);
                            }
                            catch (_c) { }
                        }
                    }
                }
                return r1;
            });
            if (idx !== -1)
                store_1.db.orders[idx] = row;
            try {
                (0, events_1.broadcastOrdersUpdated)({ action: 'update', id });
            }
            catch (_g) { }
            return res.json(row);
        }
        catch (e) {
            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
            if (/column\s+"?confirmation_code"?\s+of\s+relation\s+"?orders"?\s+does\s+not\s+exist/i.test(msg)) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = \"idx_orders_confirmation_code_unique\") THEN BEGIN DROP INDEX IF EXISTS idx_orders_confirmation_code_unique; EXCEPTION WHEN others THEN NULL; END; END IF; END $$;'));
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_source_confirmation_code_unique ON orders(source, confirmation_code) WHERE confirmation_code IS NOT NULL'));
                    const allow = ['source', 'external_id', 'property_id', 'guest_name', 'guest_phone', 'checkin', 'checkout', 'price', 'cleaning_fee', 'net_income', 'avg_nightly_price', 'nights', 'currency', 'status', 'confirmation_code'];
                    const allowExtra2 = ['payment_currency', 'payment_received'];
                    const payload2 = {};
                    for (const k of [...allow, ...allowExtra2]) {
                        if (updated[k] !== undefined)
                            payload2[k] = updated[k];
                    }
                    const row = await (0, dbAdapter_1.pgUpdate)('orders', id, payload2);
                    if (idx !== -1)
                        store_1.db.orders[idx] = row;
                    return res.json(row);
                }
                catch (e2) {
                    return res.status(500).json({ message: '数据库更新失败', error: String((e2 === null || e2 === void 0 ? void 0 : e2.message) || '') });
                }
            }
            if (msg.includes('duplicate') || msg.includes('unique'))
                return res.status(409).json({ message: '确认码已存在' });
            return res.status(500).json({ message: '数据库更新失败', error: msg });
        }
    }
    // Supabase branch removed
    try {
        (0, events_1.broadcastOrdersUpdated)({ action: 'update', id });
    }
    catch (_h) { }
    return res.json(updated);
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('order.write'), (req, res) => {
    var _a, _b;
    const { id } = req.params;
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    const force = String((_b = (_a = req.body.force) !== null && _a !== void 0 ? _a : req.query.force) !== null && _b !== void 0 ? _b : '').toLowerCase() === 'true';
    const idx = store_1.db.orders.findIndex((x) => x.id === id);
    if (idx === -1)
        return res.status(404).json({ message: 'order not found' });
    const prev = store_1.db.orders[idx];
    let nights = o.nights;
    const checkin = o.checkin || prev.checkin;
    const checkout = o.checkout || prev.checkout;
    if (!nights && checkin && checkout) {
        try {
            const ci = new Date(checkin);
            const co = new Date(checkout);
            const ms = co.getTime() - ci.getTime();
            nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
        }
        catch (_c) {
            nights = 0;
        }
    }
    const price = o.price != null ? o.price : (prev.price || 0);
    const cleaning = o.cleaning_fee != null ? o.cleaning_fee : (prev.cleaning_fee || 0);
    const net = o.net_income != null ? o.net_income : (price - cleaning);
    const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
    const updated = { ...prev, ...o, nights, net_income: net, avg_nightly_price: avg };
    // local overlap guard on update，仅在关键字段变更时检查
    const changedCore2 = ((updated.property_id || '') !== ((prev === null || prev === void 0 ? void 0 : prev.property_id) || '') ||
        ((updated.checkin || '').slice(0, 10)) !== (((prev === null || prev === void 0 ? void 0 : prev.checkin) || '').slice(0, 10)) ||
        ((updated.checkout || '').slice(0, 10)) !== (((prev === null || prev === void 0 ? void 0 : prev.checkout) || '').slice(0, 10)));
    // 编辑场景：不再返回 409 冲突
    store_1.db.orders[idx] = updated;
    // try remote update; if fails, still respond with updated local record
    // Supabase branch removed
    return res.json(updated);
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('order.write'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.orders.findIndex((x) => x.id === id);
    let removed = null;
    if (idx !== -1) {
        removed = store_1.db.orders[idx];
        store_1.db.orders.splice(idx, 1);
    }
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgDelete)('orders', id);
            removed = removed || row;
            try {
                (0, events_1.broadcastOrdersUpdated)({ action: 'delete', id });
            }
            catch (_a) { }
            return res.json({ ok: true, id });
        }
        catch (e) {
            return res.status(500).json({ message: '数据库删除失败' });
        }
    }
    // Supabase branch removed
    if (!removed)
        return res.status(404).json({ message: 'order not found' });
    try {
        (0, events_1.broadcastOrdersUpdated)({ action: 'delete', id });
    }
    catch (_b) { }
    return res.json({ ok: true, id: removed.id });
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('order.write'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.orders.findIndex((x) => x.id === id);
    if (idx === -1)
        return res.status(404).json({ message: 'order not found' });
    const removed = store_1.db.orders[idx];
    store_1.db.orders.splice(idx, 1);
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('orders', id);
        }
        catch (_a) { }
    }
    return res.json({ ok: true, id: removed.id });
});
// 清洁任务模块已移除
exports.router.post('/:id/generate-cleaning', (0, auth_1.requireAnyPerm)(['order.manage', 'cleaning.schedule.manage']), async (req, res) => {
    const { id } = req.params;
    try {
        const { deriveCleaningTaskFromOrder } = require('../services/cleaningDerive');
        const row = await deriveCleaningTaskFromOrder(String(id));
        return res.json({ ok: true, task: row });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'derive_failed' });
    }
});
exports.router.post('/import', (0, auth_1.requirePerm)('order.manage'), (0, express_1.text)({ type: ['text/csv', 'text/plain'] }), async (req, res) => {
    var _a, _b;
    function toNumber(v) {
        if (v == null || v === '')
            return undefined;
        const n = Number(v);
        return isNaN(n) ? undefined : n;
    }
    async function parseCsv(s) {
        try {
            const parse = require('csv-parse').parse;
            const records = await new Promise((resolve) => {
                parse(s || '', { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, relax_quotes: true, trim: true }, (err, recs) => {
                    if (err)
                        resolve([]);
                    else
                        resolve(Array.isArray(recs) ? recs : []);
                });
            });
            return records;
        }
        catch (_a) {
            const lines = (s || '').split(/\r?\n/).filter(l => l.trim().length);
            if (!lines.length)
                return [];
            const header = lines[0].split(',').map(h => h.trim());
            const rows = lines.slice(1).map(l => {
                const cols = l.split(',');
                const obj = {};
                header.forEach((h, i) => { const v = (cols[i] || '').trim(); obj[h] = v.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '').replace(/""/g, '"'); });
                return obj;
            });
            return rows;
        }
    }
    function getField(obj, keys) {
        const map = {};
        Object.keys(obj || {}).forEach((kk) => { const nk = String(kk).toLowerCase().replace(/\s+/g, '_').trim(); map[nk] = obj[kk]; });
        for (const k of keys) {
            const v1 = obj[k];
            if (v1 != null && String(v1).trim() !== '')
                return String(v1);
            const nk = String(k).toLowerCase().replace(/\s+/g, '_').trim();
            const v2 = map[nk];
            if (v2 != null && String(v2).trim() !== '')
                return String(v2);
        }
        return undefined;
    }
    function normalizeName(s) {
        const v = String(s || '');
        return v.replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const rowsInput = Array.isArray(req.body) ? req.body : await parseCsv(rawBody);
    const channel = String((((_a = req.query) === null || _a === void 0 ? void 0 : _a.channel) || ((_b = req.body) === null || _b === void 0 ? void 0 : _b.channel) || '')).toLowerCase();
    function mapChannel(s) {
        const v = String(s || '').trim().toLowerCase();
        if (v.startsWith('airbnb'))
            return 'airbnb';
        if (v.startsWith('booking'))
            return 'booking';
        return v;
    }
    function isBlankRecord(rec) {
        const vals = Object.values(rec || {}).map(v => String(v !== null && v !== void 0 ? v : '').trim());
        return vals.every(v => v === '');
    }
    function shouldSkipPayout(rec) {
        const t = (getField(rec, ['Type', 'type']) || '').toLowerCase().trim();
        const cur = (getField(rec, ['Currency', 'currency']) || '').toUpperCase().trim();
        if (!t.includes('payout'))
            return false;
        if (cur && cur !== 'AUD')
            return false;
        const fields = [
            'Confirmation Code', 'confirmation_code', 'Reservation Number', 'Reservation number',
            'Listing', 'Listing name', 'Property Name', 'property_name',
            'Guest', 'guest_name', 'Booker Name', 'booker_name',
            'Amount', 'Total Payment',
            'Start date', 'End date', 'Arrival', 'Departure'
        ];
        const hasAny = fields.some(k => { const v = rec[k]; return v != null && String(v).trim() !== ''; });
        return !hasAny;
    }
    function isBlankOrPayoutRow(rec) {
        return isBlankRecord(rec) || shouldSkipPayout(rec);
    }
    const byName = {};
    const byId = {};
    const byCode = {};
    const idToCode = {};
    try {
        if (dbAdapter_1.hasPg) {
            const propsRaw = (await (0, dbAdapter_1.pgSelect)('properties', 'id,code,airbnb_listing_name,booking_listing_name,airbnb_listing_id,booking_listing_id')) || [];
            propsRaw.forEach((p) => {
                const id = String(p.id);
                const code = String(p.code || '');
                if (code)
                    byCode[code.toLowerCase().trim()] = id;
                if (code)
                    idToCode[id] = code;
                const an = String(p.airbnb_listing_name || '');
                const bn = String(p.booking_listing_name || '');
                const ai = String(p.airbnb_listing_id || '');
                const bi = String(p.booking_listing_id || '');
                if (an)
                    byName[`airbnb:${normalizeName(an)}`] = id;
                if (bn)
                    byName[`booking:${normalizeName(bn)}`] = id;
                if (ai)
                    byId[`airbnb:${ai.toLowerCase().trim()}`] = id;
                if (bi)
                    byId[`booking:${bi.toLowerCase().trim()}`] = id;
            });
        }
        else {
            (store_1.db.properties || []).forEach((p) => {
                const id = String(p.id);
                const code = String(p.code || '');
                if (code)
                    byCode[code.toLowerCase().trim()] = id;
                if (code)
                    idToCode[id] = code;
                const an = String(p.airbnb_listing_name || '');
                const bn = String(p.booking_listing_name || '');
                const ai = String(p.airbnb_listing_id || '');
                const bi = String(p.booking_listing_id || '');
                if (an)
                    byName[`airbnb:${normalizeName(an)}`] = id;
                if (bn)
                    byName[`booking:${normalizeName(bn)}`] = id;
                if (ai)
                    byId[`airbnb:${ai.toLowerCase().trim()}`] = id;
                if (bi)
                    byId[`booking:${bi.toLowerCase().trim()}`] = id;
                const ln = ((p === null || p === void 0 ? void 0 : p.listing_names) || {});
                Object.entries(ln || {}).forEach(([plat, name]) => {
                    if (name)
                        byName[`${String(plat).toLowerCase()}:${normalizeName(String(name))}`] = id;
                });
            });
        }
    }
    catch (_c) { }
    const results = [];
    let inserted = 0;
    let skipped = 0;
    const existingByCc = new Set();
    const existingProps = new Set();
    try {
        if (dbAdapter_1.hasPg) {
            const rowsCc = (await (0, dbAdapter_1.pgSelect)('orders', 'confirmation_code')) || [];
            for (const r of (rowsCc || [])) {
                const cc = String((r === null || r === void 0 ? void 0 : r.confirmation_code) || '').trim();
                if (cc)
                    existingByCc.add(cc);
            }
            const propsAll = (await (0, dbAdapter_1.pgSelect)('properties', 'id')) || [];
            for (const p of (propsAll || [])) {
                const id = String((p === null || p === void 0 ? void 0 : p.id) || '').trim();
                if (id)
                    existingProps.add(id);
            }
            await ensureOrdersIndexes();
        }
    }
    catch (_d) { }
    for (let idx = 0; idx < rowsInput.length; idx++) {
        const r = rowsInput[idx];
        if (isBlankOrPayoutRow(r)) {
            continue;
        }
        try {
            const platform = mapChannel(String(r.source || channel || ''));
            const source = platform || 'offline';
            const property_code_raw = r.property_code || r.propertyCode || undefined;
            const property_code = property_code_raw ? String(property_code_raw).trim() : undefined;
            const listing_name_raw = getField(r, ['Listing', 'listing', 'Listing name', 'listing_name']);
            let listing_name = listing_name_raw ? String(listing_name_raw).trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '').replace(/""/g, '"') : undefined;
            if (platform === 'booking' && listing_name) {
                const parts = listing_name.split('#');
                listing_name = (parts[0] || '').trim();
            }
            const listing_id = getField(r, ['Listing ID', 'listing_id', 'ListingId', 'ID']);
            const confirmation_code = getField(r, ['confirmation_code', 'Confirmation Code', 'Confirmation Code (Airbnb)', 'Reservation number', 'Reservation Number', 'Reservation number (Booking)', 'Reservation Number (Booking)']);
            let property_id = r.property_id || r.propertyId;
            if (!property_id) {
                const keyId = listing_id && platform ? `${platform}:${String(listing_id).toLowerCase().trim()}` : '';
                const keyName = listing_name && platform ? `${platform}:${normalizeName(String(listing_name))}` : '';
                property_id = (keyId && byId[keyId]) || (keyName && byName[keyName]) || (property_code ? byCode[String(property_code).toLowerCase()] : undefined);
            }
            const guest_name = getField(r, ['Guest', 'guest', 'guest_name']);
            let checkin = getField(r, ['checkin', 'check_in', 'start_date', 'Start date', 'Arrival']);
            let checkout = getField(r, ['checkout', 'check_out', 'end_date', 'End date', 'Departure']);
            const reservation_number = getField(r, ['Reservation number', 'Reservation Number', 'reservation_number']);
            const external_id = source === 'booking' ? reservation_number : undefined;
            let idempotency_key = '';
            if (source === 'airbnb') {
                idempotency_key = `airbnb|${String(confirmation_code || '').trim()}`;
            }
            else if (source === 'booking') {
                idempotency_key = `booking|${String(external_id || '').trim()}`;
            }
            else {
                idempotency_key = `${source}|${String(checkin || '').slice(0, 10)}|${String(checkout || '').slice(0, 10)}|${String(guest_name || '').trim()}`;
            }
            idempotency_key = idempotency_key.toLowerCase().trim();
            if (idx < 5) {
                try {
                    console.log('[IMPORT ROW CHECK]', {
                        platform,
                        listingName: listing_name,
                        confirmationCode: confirmation_code,
                        startDate: checkin,
                        endDate: checkout,
                        idempotencyKey: idempotency_key,
                    });
                }
                catch (_e) { }
            }
            const priceRaw = toNumber(getField(r, ['Total Payment', 'total_payment', 'Amount', 'amount', 'price']));
            const cleaningRaw = toNumber(getField(r, ['Cleaning fee', 'cleaning_fee']));
            const price = source === 'booking' && priceRaw != null ? Number(((priceRaw || 0) * 0.835).toFixed(2)) : round2(priceRaw);
            const cleaning_fee = round2(cleaningRaw);
            const currency = r.currency || 'AUD';
            const status = r.status || 'confirmed';
            if (source === 'booking' && String(status).toLowerCase() !== 'confirmed') {
                results.push({ ok: false, error: 'invalid_status', listing_name, confirmation_code });
                skipped++;
                continue;
            }
            // Airbnb 日期严格按 MM/DD/YYYY 解析，失败写入 staging
            if (platform === 'airbnb') {
                const ciIso = parseAirbnbDate(checkin || '');
                const coIso = parseAirbnbDate(checkout || '');
                if (!ciIso || !coIso) {
                    const detail = !ciIso ? 'checkin_date' : (!coIso ? 'checkout_date' : 'date');
                    const reason = detail === 'checkin_date' ? 'invalid_date:start_date' : (detail === 'checkout_date' ? 'invalid_date:end_date' : 'invalid_date:date');
                    try {
                        const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason, error_detail: detail, listing_name, listing_id, property_code, status: 'unmatched' };
                        if (dbAdapter_1.hasPg) {
                            await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                        }
                        else {
                            store_1.db.orderImportStaging.push(payload);
                        }
                        results.push({ ok: false, error: reason, id: payload.id, listing_name, confirmation_code, source, property_id });
                    }
                    catch (_f) {
                        results.push({ ok: false, error: reason });
                    }
                    skipped++;
                    continue;
                }
                checkin = ciIso;
                checkout = coIso;
            }
            // 不再因缺少确认码阻断，后续以 idempotency_key 与时间段冲突进行保护
            if (source === 'booking' && !external_id) {
                const reason = 'missing_field:reservation_number';
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason, listing_name, listing_id, property_code, status: 'unmatched' };
                    if (dbAdapter_1.hasPg) {
                        await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                    }
                    else {
                        store_1.db.orderImportStaging.push(payload);
                    }
                    results.push({ ok: false, error: reason, id: payload.id, listing_name, confirmation_code, source, property_id });
                }
                catch (_g) {
                    results.push({ ok: false, error: reason });
                }
                skipped++;
                continue;
            }
            const parsed = createOrderSchema.safeParse({ source, property_id, property_code, external_id, guest_name, checkin, checkout, price, cleaning_fee, currency, status, confirmation_code, idempotency_key });
            if (!parsed.success) {
                const reason = 'invalid_row';
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason, listing_name, listing_id, property_code, status: 'unmatched' };
                    if (dbAdapter_1.hasPg) {
                        await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                    }
                    else {
                        store_1.db.orderImportStaging.push(payload);
                    }
                    results.push({ ok: false, error: reason, id: payload.id, listing_name, confirmation_code });
                }
                catch (_h) {
                    results.push({ ok: false, error: reason, listing_name, confirmation_code });
                }
                skipped++;
                continue;
            }
            const o = parsed.data;
            const ciDay = dayOnly(o.checkin);
            const coDay = dayOnly(o.checkout);
            const ciIso = ciDay ? `${ciDay}T12:00:00` : undefined;
            const coIso = coDay ? `${coDay}T11:59:59` : undefined;
            const key = o.idempotency_key || idempotency_key;
            if (idx < 5) {
                try {
                    console.log('[IMPORT NORMALIZED]', {
                        platform: source,
                        listing_name,
                        confirmation_code,
                        property_id: o.property_id,
                        check_in: o.checkin,
                        check_out: o.checkout,
                        idempotency_key: key,
                    });
                }
                catch (_j) { }
            }
            if (!o.property_id) {
                const reason = 'unmatched_property';
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason, listing_name, listing_id, property_code, status: 'unmatched' };
                    if (dbAdapter_1.hasPg) {
                        await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                    }
                    else {
                        store_1.db.orderImportStaging.push(payload);
                    }
                    results.push({ ok: false, error: reason, id: payload.id, listing_name, confirmation_code });
                }
                catch (_k) {
                    results.push({ ok: false, error: reason, listing_name, confirmation_code });
                }
                skipped++;
                continue;
            }
            const { v4: uuid } = require('uuid');
            let nights = o.nights;
            if (!nights && ciIso && coIso) {
                try {
                    const ci = new Date(ciIso);
                    const co = new Date(coIso);
                    const ms = co.getTime() - ci.getTime();
                    nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
                }
                catch (_l) {
                    nights = 0;
                }
            }
            const cleaning = round2(o.cleaning_fee || 0) || 0;
            const total = round2(o.price || 0) || 0;
            const net = o.net_income != null ? (round2(o.net_income) || 0) : ((round2(total - cleaning) || 0));
            const avg = o.avg_nightly_price != null ? (round2(o.avg_nightly_price) || 0) : (nights && nights > 0 ? (round2(net / nights) || 0) : 0);
            const newOrder = { id: uuid(), ...o, checkin: ciIso, checkout: coIso, external_id, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key };
            if (newOrder.property_id && idToCode[newOrder.property_id])
                newOrder.property_code = idToCode[newOrder.property_id];
            const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
            if (conflict) {
                results.push({ ok: false, error: 'overlap', confirmation_code: newOrder.confirmation_code, source: newOrder.source, property_id: newOrder.property_id });
                skipped++;
                continue;
            }
            try {
                if (dbAdapter_1.hasPg) {
                    const cc = newOrder.confirmation_code;
                    if (cc) {
                        const sig = `${String(newOrder.source || '').toLowerCase()}|${String(cc).trim()}|${String(newOrder.property_id || '')}`;
                        if (existingByCc.has(sig)) {
                            results.push({ ok: false, error: 'duplicate', confirmation_code: cc, source: newOrder.source, property_id: newOrder.property_id });
                            skipped++;
                            continue;
                        }
                    }
                }
            }
            catch (_m) { }
            let writeOk = false;
            if (dbAdapter_1.hasPg) {
                try {
                    if (newOrder.property_id && !existingProps.has(String(newOrder.property_id))) {
                        const payload = { id: newOrder.property_id };
                        const codeGuess = idToCode[newOrder.property_id || ''];
                        if (codeGuess)
                            payload.code = codeGuess;
                        await (0, dbAdapter_1.pgInsert)('properties', payload);
                        existingProps.add(String(newOrder.property_id));
                    }
                    const insertPayload = { ...newOrder };
                    delete insertPayload.property_code;
                    await (0, dbAdapter_1.pgInsert)('orders', insertPayload);
                    writeOk = true;
                }
                catch (e) {
                    const code = (e && e.code) || '';
                    if (code === '23505') {
                        try {
                            const cc = newOrder.confirmation_code;
                            const dup = (await (0, dbAdapter_1.pgSelect)('orders', 'id', { confirmation_code: cc })) || [];
                            if (Array.isArray(dup) && dup[0]) {
                                const allow = ['source', 'external_id', 'property_id', 'guest_name', 'guest_phone', 'checkin', 'checkout', 'price', 'cleaning_fee', 'net_income', 'avg_nightly_price', 'nights', 'currency', 'status', 'confirmation_code'];
                                const payload = {};
                                for (const k of allow) {
                                    if (newOrder[k] !== undefined)
                                        payload[k] = newOrder[k];
                                }
                                await (0, dbAdapter_1.pgUpdate)('orders', String(dup[0].id), payload);
                                continue;
                            }
                        }
                        catch (_o) { }
                        results.push({ ok: false, error: 'duplicate', confirmation_code: newOrder.confirmation_code, source: newOrder.source, property_id: newOrder.property_id });
                        skipped++;
                        continue;
                    }
                    const detail = String((e === null || e === void 0 ? void 0 : e.message) || e);
                    results.push({ ok: false, error: 'write_failed', id: newOrder.id, confirmation_code: newOrder.confirmation_code, source: newOrder.source, property_id: newOrder.property_id, ...(detail ? { detail } : {}) });
                    skipped++;
                    continue;
                }
            }
            else {
                const localPayload = { ...newOrder };
                delete localPayload.property_code;
                store_1.db.orders.push(localPayload);
                writeOk = true;
            }
            if (writeOk) {
                inserted++;
                const pc = idToCode[newOrder.property_id || ''];
                results.push({ ok: true, id: newOrder.id, property_id: newOrder.property_id, property_code: pc });
            }
        }
        catch (e) {
            results.push({ ok: false, error: (e === null || e === void 0 ? void 0 : e.message) || 'error' });
            skipped++;
        }
    }
    const reason_counts = {};
    for (const r of results) {
        if (!r.ok && r.error)
            reason_counts[r.error] = (reason_counts[r.error] || 0) + 1;
    }
    res.json({ inserted, skipped, reason_counts, results });
});
exports.router.post('/import/resolve/:id', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
    var _a;
    const { id } = req.params;
    const body = req.body || {};
    const property_id = String(body.property_id || '').trim() || undefined;
    try {
        let row = null;
        if (dbAdapter_1.hasPg) {
            const rows = (await (0, dbAdapter_1.pgSelect)('order_import_staging', '*', { id })) || [];
            row = Array.isArray(rows) ? rows[0] : null;
            if (!row) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    const ln = String(body.listing_name || '').trim();
                    if (ln) {
                        const sql = 'SELECT * FROM order_import_staging WHERE status=\'unmatched\' AND listing_name=$1 ORDER BY created_at DESC LIMIT 1';
                        const rs = await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(sql, [ln]));
                        row = ((_a = rs === null || rs === void 0 ? void 0 : rs.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
                    }
                }
                catch (_b) { }
                if (!row) {
                    try {
                        row = store_1.db.orderImportStaging.find((x) => x.id === id);
                    }
                    catch (_c) { }
                }
            }
        }
        else {
            row = store_1.db.orderImportStaging.find((x) => x.id === id);
        }
        if (!row)
            return res.status(404).json({ message: 'staging not found' });
        const r = row.raw_row || {};
        function getVal(obj, keys) { for (const k of keys) {
            const v = obj[k];
            if (v != null && String(v).trim() !== '')
                return String(v);
        } return undefined; }
        function mapPlatform(s, rec) {
            const v = String(s || '').trim().toLowerCase();
            if (v)
                return v;
            if (rec && (rec['Property Name'] || rec.property_name))
                return 'booking';
            if (rec && (rec['Listing'] || rec.listing))
                return 'airbnb';
            return 'offline';
        }
        const source = mapPlatform(String(row.channel || r.source || ''), r);
        const confirmation_code = String((row.confirmation_code || getVal(r, ['confirmation_code', 'Confirmation Code', 'Reservation Number'])) || '').trim();
        const guest_name = getVal(r, ['Guest', 'guest', 'guest_name', 'Booker Name']);
        const checkinRaw = getVal(r, ['checkin', 'check_in', 'start_date', 'Start date', 'Arrival']);
        const checkoutRaw = getVal(r, ['checkout', 'check_out', 'end_date', 'End date', 'Departure']);
        const checkinDayStr = dayOnly(checkinRaw);
        const checkoutDayStr = dayOnly(checkoutRaw);
        const priceRaw = getVal(r, ['price', 'Amount', 'Total Payment']);
        const cleaningRaw = getVal(r, ['cleaning_fee', 'Cleaning fee']);
        const price = priceRaw != null ? Number(priceRaw) : undefined;
        const cleaning_fee = cleaningRaw != null ? Number(cleaningRaw) : undefined;
        const currency = getVal(r, ['currency', 'Currency']) || 'AUD';
        const stRaw = getVal(r, ['status', 'Status']) || '';
        const stLower = stRaw.toLowerCase();
        const status = stLower === 'ok' ? 'confirmed' : (stLower.includes('cancel') ? 'cancelled' : (stRaw ? stRaw : 'confirmed'));
        const parsed = createOrderSchema.safeParse({ source, property_id, guest_name, checkin: checkinDayStr, checkout: checkoutDayStr, price, cleaning_fee, currency, status, confirmation_code });
        if (!parsed.success)
            return res.status(400).json(parsed.error.format());
        const o = parsed.data;
        const ciIso = o.checkin ? `${String(o.checkin).slice(0, 10)}T12:00:00` : undefined;
        const coIso = o.checkout ? `${String(o.checkout).slice(0, 10)}T11:59:59` : undefined;
        let key = o.idempotency_key || '';
        if (!key) {
            const defaultKey = `${source}|${String(o.checkin || '').slice(0, 10)}|${String(o.checkout || '').slice(0, 10)}|${String(o.guest_name || '').trim()}`;
            if (source === 'airbnb' && o.confirmation_code) {
                key = `airbnb|${String(o.confirmation_code || '').trim()}`;
            }
            else if (source === 'booking' && o.confirmation_code) {
                key = `booking|${String(o.confirmation_code || '').trim()}`;
            }
            else {
                key = defaultKey;
            }
            key = key.toLowerCase().trim();
        }
        const { v4: uuid } = require('uuid');
        let nights = o.nights;
        if (!nights && ciIso && coIso) {
            try {
                const ci = new Date(ciIso);
                const co = new Date(coIso);
                const ms = co.getTime() - ci.getTime();
                nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
            }
            catch (_d) {
                nights = 0;
            }
        }
        const cleaning = o.cleaning_fee || 0;
        const total = o.price || 0;
        const net = o.net_income != null ? o.net_income : (total - cleaning);
        const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
        const ciDay = String(o.checkin || '').slice(0, 10) || undefined;
        const coDay = String(o.checkout || '').slice(0, 10) || undefined;
        const newOrder = { id: uuid(), ...o, checkin: ciDay, checkout: coDay, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key };
        // duplicate by confirmation_code
        try {
            await ensureOrdersColumns();
            if (dbAdapter_1.hasPg && newOrder.confirmation_code) {
                const dup = (await (0, dbAdapter_1.pgSelect)('orders', 'id', { confirmation_code: newOrder.confirmation_code })) || [];
                if (Array.isArray(dup) && dup[0]) {
                    try {
                        const allow = ['source', 'external_id', 'property_id', 'guest_name', 'guest_phone', 'checkin', 'checkout', 'price', 'cleaning_fee', 'net_income', 'avg_nightly_price', 'nights', 'currency', 'status', 'confirmation_code'];
                        const payload = {};
                        for (const k of allow) {
                            if (newOrder[k] !== undefined)
                                payload[k] = newOrder[k];
                        }
                        const row = await (0, dbAdapter_1.pgUpdate)('orders', String(dup[0].id), payload);
                        try {
                            (0, events_1.broadcastOrdersUpdated)({ action: 'update', id: String(dup[0].id) });
                        }
                        catch (_e) { }
                        return res.status(200).json(row || dup[0]);
                    }
                    catch (_f) { }
                }
            }
        }
        catch (_g) { }
        const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
        if (conflict)
            return res.status(409).json({ message: 'overlap' });
        if (dbAdapter_1.hasPg) {
            let insertedOk = false;
            try {
                await ensureOrdersColumns();
                await ensureOrdersIndexes();
                await (0, dbAdapter_1.pgInsert)('orders', newOrder);
                insertedOk = true;
            }
            catch (e) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                    if (/column\s+"confirmation_code"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                        await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
                    }
                    await ensureOrdersIndexes();
                    await (0, dbAdapter_1.pgInsert)('orders', newOrder);
                    insertedOk = true;
                }
                catch (e2) {
                    return res.status(500).json({ message: (e2 === null || e2 === void 0 ? void 0 : e2.message) || 'insert failed' });
                }
            }
            if (insertedOk) {
                try {
                    await (0, dbAdapter_1.pgUpdate)('order_import_staging', id, { status: 'resolved', property_id, resolved_at: new Date().toISOString() });
                }
                catch (_h) { }
                try {
                    (0, events_1.broadcastOrdersUpdated)({ action: 'create', id: newOrder.id });
                }
                catch (_j) { }
            }
        }
        else {
            const idx = store_1.db.orderImportStaging.findIndex((x) => x.id === id);
            if (idx !== -1)
                store_1.db.orderImportStaging[idx] = { ...store_1.db.orderImportStaging[idx], status: 'resolved', property_id, resolved_at: new Date().toISOString() };
            try {
                (0, events_1.broadcastOrdersUpdated)({ action: 'create', id: newOrder.id });
            }
            catch (_k) { }
        }
        return res.status(201).json(newOrder);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'resolve failed' });
    }
});
exports.router.post('/actions/importBookings', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
    var _a, _b;
    try {
        const body = req.body || {};
        const platformRaw = String(body.platform || '').trim().toLowerCase();
        const platform = platformRaw.startsWith('airbnb') ? 'airbnb' : (platformRaw.startsWith('booking') ? 'booking' : 'other');
        const fileType = String(body.fileType || '').trim().toLowerCase();
        const fileContent = String(body.fileContent || '');
        if (!fileType || !fileContent)
            return res.status(400).json({ message: 'missing fileType/fileContent' });
        function decodeBase64DataUrl(dataUrl) {
            const m = /^data:[^;]+;base64,(.*)$/i.exec(dataUrl);
            const b64 = m ? m[1] : dataUrl;
            return Buffer.from(b64, 'base64');
        }
        async function parseCsvText(text) {
            try {
                const parse = require('csv-parse').parse;
                return await new Promise((resolve, reject) => {
                    parse(text, { columns: true, skip_empty_lines: true }, (err, records) => {
                        if (err)
                            reject(err);
                        else
                            resolve(records || []);
                    });
                });
            }
            catch (_a) {
                const lines = (text || '').split(/\r?\n/).filter(l => l.trim().length);
                if (!lines.length)
                    return [];
                const header = lines[0].split(',').map(h => h.trim());
                const rows = lines.slice(1).map(l => l.split(',')).map(cols => {
                    const obj = {};
                    header.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
                    return obj;
                });
                return rows;
            }
        }
        async function parseExcelBase64(b64) {
            try {
                const xlsx = require('xlsx');
                const buf = decodeBase64DataUrl(b64);
                const wb = xlsx.read(buf, { type: 'buffer' });
                const firstSheetName = wb.SheetNames[0];
                const ws = wb.Sheets[firstSheetName];
                const records = xlsx.utils.sheet_to_json(ws, { defval: '' });
                return Array.isArray(records) ? records : [];
            }
            catch (_a) {
                return [];
            }
        }
        function getField(obj, keys) {
            const map = {};
            Object.keys(obj || {}).forEach((kk) => { const nk = String(kk).toLowerCase().replace(/\s+/g, '_').trim(); map[nk] = obj[kk]; });
            for (const k of keys) {
                const v1 = obj[k];
                if (v1 != null && String(v1).trim() !== '')
                    return String(v1);
                const nk = String(k).toLowerCase().replace(/\s+/g, '_').trim();
                const v2 = map[nk];
                if (v2 != null && String(v2).trim() !== '')
                    return String(v2);
            }
            return undefined;
        }
        function normalizeName(s) {
            const v = String(s || '');
            return v.replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        }
        function toNumber(v) { if (v == null || v === '')
            return undefined; const n = Number(v); return isNaN(n) ? undefined : n; }
        function normAirbnb(r) {
            const confirmation_code = getField(r, ['confirmation_code', 'Confirmation Code', 'Confirmation Code (Airbnb)']);
            const check_in_raw = getField(r, ['Start date', 'start_date', 'check_in']);
            const check_out_raw = getField(r, ['End date', 'end_date', 'check_out']);
            const check_in = parseAirbnbDate(check_in_raw || '');
            const check_out = parseAirbnbDate(check_out_raw || '');
            const guest_name = getField(r, ['Guest', 'guest', 'guest_name']);
            const listing_name = getField(r, ['Listing', 'listing', 'Listing name', 'listing_name']);
            const amount = toNumber(getField(r, ['Amount', 'amount', 'Total', 'price']));
            const cleaning_fee = toNumber(getField(r, ['Cleaning fee', 'cleaning_fee']));
            const status = 'confirmed';
            return { confirmation_code, check_in, check_out, guest_name, listing_name, amount, cleaning_fee, status };
        }
        function normBooking(r) {
            const confirmation_code = getField(r, ['Reservation Number', 'reservation_number', 'confirmation_code']);
            const check_in = getField(r, ['Arrival', 'arrival', 'check_in']);
            const check_out = getField(r, ['Departure', 'departure', 'check_out']);
            const guest_name = getField(r, ['Booker Name', 'booker_name', 'guest_name']);
            const listing_name = getField(r, ['Property Name', 'property_name', 'listing_name']);
            const amount = toNumber(getField(r, ['Total Payment', 'total_payment', 'Amount', 'amount']));
            const stRaw = getField(r, ['Status', 'status']) || '';
            const stLower = stRaw.toLowerCase();
            const status = stLower === 'ok' ? 'confirmed' : (stLower.includes('cancel') ? 'cancelled' : 'other');
            return { confirmation_code, check_in, check_out, guest_name, listing_name, amount, cleaning_fee: undefined, status };
        }
        function normOther(r) {
            const confirmation_code = getField(r, ['confirmation_code', 'Confirmation Code', 'Reservation Number', '订单号']);
            const check_in = getField(r, ['check_in', 'checkin', 'Start date', 'Arrival', '入住']);
            const check_out = getField(r, ['check_out', 'checkout', 'End date', 'Departure', '退房']);
            const guest_name = getField(r, ['guest_name', 'Guest', 'Booker Name', '客人']);
            const listing_name = getField(r, ['listing_name', 'Listing', 'Property Name', '房号']);
            const amount = toNumber(getField(r, ['Amount', 'Total Payment', 'price', '总金额']));
            const status = (getField(r, ['status', '状态']) || 'confirmed').toLowerCase();
            return { confirmation_code, check_in, check_out, guest_name, listing_name, amount, cleaning_fee: undefined, status };
        }
        // parse to records
        const recordsAll = fileType === 'csv' ? (await parseCsvText(fileContent)) : (await parseExcelBase64(fileContent));
        const buildVersion = (process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || 'unknown');
        try {
            console.log('IMPORT_BUILD', buildVersion);
        }
        catch (_c) { }
        const normalize = platform === 'airbnb' ? normAirbnb : (platform === 'booking' ? normBooking : normOther);
        await ensureOrdersColumns();
        // build property match indexes
        const byName = {};
        const idToCode = {};
        try {
            if (dbAdapter_1.hasPg) {
                const cols = platform === 'airbnb' ? 'id,code,airbnb_listing_name' : (platform === 'booking' ? 'id,code,booking_listing_name' : 'id,code,listing_names');
                const propsRaw = (await (0, dbAdapter_1.pgSelect)('properties', cols)) || [];
                propsRaw.forEach((p) => {
                    const id = String(p.id);
                    const code = String(p.code || '');
                    if (code)
                        idToCode[id] = code;
                    if (platform === 'airbnb' || platform === 'booking') {
                        const nm = String((platform === 'airbnb' ? p.airbnb_listing_name : p.booking_listing_name) || '');
                        if (nm)
                            byName[`name:${normalizeName(nm)}`] = id;
                    }
                    else {
                        const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {};
                        Object.values(ln || {}).forEach((nm) => { if (nm)
                            byName[`name:${normalizeName(String(nm))}`] = id; });
                    }
                });
            }
            else {
                (store_1.db.properties || []).forEach((p) => {
                    const id = String(p.id);
                    const code = String(p.code || '');
                    if (code)
                        idToCode[id] = code;
                    if (platform === 'airbnb' || platform === 'booking') {
                        const nm = String((platform === 'airbnb' ? p.airbnb_listing_name : p.booking_listing_name) || '');
                        if (nm)
                            byName[`name:${normalizeName(nm)}`] = id;
                    }
                    else {
                        const ln = ((p === null || p === void 0 ? void 0 : p.listing_names) || {});
                        Object.values(ln || {}).forEach((nm) => { if (nm)
                            byName[`name:${normalizeName(String(nm))}`] = id; });
                    }
                });
            }
        }
        catch (_d) { }
        function isBlankRecord(rec) {
            const vals = Object.values(rec || {}).map(v => String(v || '').trim());
            return vals.every(v => v === '');
        }
        function shouldSkipPayout(rec) {
            const t = (getField(rec, ['Type', 'type']) || '').toLowerCase().trim();
            const cur = (getField(rec, ['Currency', 'currency']) || '').toUpperCase().trim();
            if (t !== 'payout')
                return false;
            if (cur !== 'AUD')
                return false;
            const fields = [
                'Confirmation Code', 'confirmation_code', 'Reservation Number', 'Reservation number',
                'Listing', 'Listing name', 'Property Name', 'property_name',
                'Guest', 'guest_name', 'Booker Name', 'booker_name',
                'Amount', 'Total Payment',
                'Start date', 'End date', 'Arrival', 'Departure'
            ];
            const hasAny = fields.some(k => { const v = rec[k]; return v != null && String(v).trim() !== ''; });
            return !hasAny;
        }
        const errors = [];
        let createdCount = 0;
        let updatedCount = 0;
        let rowIndexBase = 2; // 首行数据通常为第2行
        const tStart = Date.now();
        for (let i = 0; i < recordsAll.length; i++) {
            const r = recordsAll[i] || {};
            if (isBlankRecord(r))
                continue;
            if (shouldSkipPayout(r))
                continue;
            const n = normalize(r);
            const cc = String(n.confirmation_code || '').trim();
            const ln = String(n.listing_name || '').trim();
            // 确认码缺失不再阻断，后续使用时间段冲突与可选内容重复校验保障
            const pid = ln ? byName[`name:${normalizeName(ln)}`] : undefined;
            if (!pid) {
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason: 'unmatched_property', listing_name: ln, confirmation_code: cc, status: 'unmatched' };
                    if (dbAdapter_1.hasPg) {
                        try {
                            await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                        }
                        catch (e) {
                            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                            try {
                                const { pgPool } = require('../dbAdapter');
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(`CREATE TABLE IF NOT EXISTS order_import_staging (
                  id text PRIMARY KEY,
                  channel text,
                  raw_row jsonb,
                  reason text,
                  listing_name text,
                  confirmation_code text,
                  listing_id text,
                  property_code text,
                  property_id text REFERENCES properties(id) ON DELETE SET NULL,
                  status text DEFAULT 'unmatched',
                  created_at timestamptz DEFAULT now(),
                  resolved_at timestamptz
                )`));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_import_staging ADD COLUMN IF NOT EXISTS confirmation_code text'));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_import_staging_status ON order_import_staging(status)'));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_import_staging_created ON order_import_staging(created_at)'));
                                await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                            }
                            catch (_e) { }
                        }
                    }
                    else {
                        store_1.db.orderImportStaging.push(payload);
                    }
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: '找不到房号', stagingId: payload.id });
                }
                catch (_f) {
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: '找不到房号' });
                }
                continue;
            }
            const source = platform;
            const checkin = n.check_in || undefined;
            const checkout = n.check_out || undefined;
            const checkinDay = dayOnly(checkin);
            const checkoutDay = dayOnly(checkout);
            if ((!checkinDay || !checkoutDay)) {
                const det = !checkin ? 'invalid_date:Start date' : 'invalid_date:End date';
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason: det, listing_name: ln, confirmation_code: cc, status: 'unmatched' };
                    if (dbAdapter_1.hasPg) {
                        try {
                            await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                        }
                        catch (e) {
                            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                            try {
                                const { pgPool } = require('../dbAdapter');
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(`CREATE TABLE IF NOT EXISTS order_import_staging (
                  id text PRIMARY KEY,
                  channel text,
                  raw_row jsonb,
                  reason text,
                  listing_name text,
                  confirmation_code text,
                  listing_id text,
                  property_code text,
                  property_id text REFERENCES properties(id) ON DELETE SET NULL,
                  status text DEFAULT 'unmatched',
                  created_at timestamptz DEFAULT now(),
                  resolved_at timestamptz
                )`));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_import_staging ADD COLUMN IF NOT EXISTS confirmation_code text'));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_import_staging_status ON order_import_staging(status)'));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_import_staging_created ON order_import_staging(created_at)'));
                                await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                            }
                            catch (_g) { }
                        }
                    }
                    else {
                        store_1.db.orderImportStaging.push(payload);
                    }
                }
                catch (_h) { }
                errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'invalid_date' });
                continue;
            }
            const tpRawStr = getField(r, ['Total Payment', 'total_payment', 'Amount', 'amount']);
            const tpRawNum = tpRawStr != null ? Number(tpRawStr) : NaN;
            let price = undefined;
            if (platform === 'booking') {
                if (tpRawStr == null || String(tpRawStr).trim() === '') {
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'missing_data' });
                    continue;
                }
                if (!isFinite(tpRawNum)) {
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'invalid_format' });
                    continue;
                }
                const p = Number((tpRawNum * 0.835).toFixed(2));
                if (!(p > 0) || p > 1000000) {
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'amount_out_of_range' });
                    continue;
                }
                price = p;
            }
            else {
                price = n.amount != null ? round2(Number(n.amount)) : undefined;
            }
            const cleaning_fee = n.cleaning_fee != null ? round2(Number(n.cleaning_fee)) : undefined;
            const status = n.status || 'confirmed';
            const guest_name = n.guest_name || undefined;
            if (platform === 'booking' && status !== 'confirmed') {
                errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'invalid_status' });
                continue;
            }
            if (platform === 'booking') {
                if (!cc || !guest_name || !checkinDay || !checkoutDay) {
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'missing_data' });
                    continue;
                }
            }
            // upsert by confirmation_code
            let exists = null;
            try {
                if (dbAdapter_1.hasPg) {
                    const dup = (await (0, dbAdapter_1.pgSelect)('orders', '*', { confirmation_code: cc })) || [];
                    exists = Array.isArray(dup) ? dup[0] : null;
                }
                else {
                    exists = store_1.db.orders.find(o => o.confirmation_code === cc);
                }
            }
            catch (_j) { }
            const payload = { source, confirmation_code: cc, status, property_id: pid, guest_name, checkin: (checkinDay || undefined), checkout: (checkoutDay || undefined), price, cleaning_fee, total_payment_raw: (platform === 'booking' ? Number(tpRawStr) : undefined), processed_status: (platform === 'booking' ? 'computed_0_835' : undefined) };
            try {
                if (dbAdapter_1.hasPg) {
                    if (exists && exists.id) {
                        try {
                            await (0, dbAdapter_1.pgUpdate)('orders', exists.id, payload);
                        }
                        catch (e) {
                            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                            try {
                                const { pgPool } = require('../dbAdapter');
                                if (/column\s+"confirmation_code"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
                                }
                                if (/column\s+"total_payment_raw"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_payment_raw numeric'));
                                }
                                if (/column\s+"processed_status"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS processed_status text'));
                                }
                                await (0, dbAdapter_1.pgUpdate)('orders', exists.id, payload);
                            }
                            catch (e2) {
                                throw e2;
                            }
                        }
                        updatedCount++;
                    }
                    else {
                        let row;
                        try {
                            await ensureOrdersIndexes();
                            row = await (0, dbAdapter_1.pgInsert)('orders', { id: require('uuid').v4(), ...payload });
                        }
                        catch (e) {
                            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                            try {
                                const { pgPool } = require('../dbAdapter');
                                if (/column\s+"confirmation_code"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_code text'));
                                }
                                if (/column\s+"total_payment_raw"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_payment_raw numeric'));
                                }
                                if (/column\s+"processed_status"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(msg)) {
                                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS processed_status text'));
                                }
                                await ensureOrdersIndexes();
                                row = await (0, dbAdapter_1.pgInsert)('orders', { id: require('uuid').v4(), ...payload });
                            }
                            catch (e2) {
                                throw e2;
                            }
                        }
                        if ((row === null || row === void 0 ? void 0 : row.id) && idToCode[pid])
                            row.property_code = idToCode[pid];
                        store_1.db.orders.push(row);
                        createdCount++;
                    }
                    try {
                        (0, events_1.broadcastOrdersUpdated)({ action: exists ? 'update' : 'create', id: ((exists === null || exists === void 0 ? void 0 : exists.id) || undefined) });
                    }
                    catch (_k) { }
                }
                else {
                    if (exists)
                        Object.assign(exists, payload);
                    else
                        store_1.db.orders.push({ id: require('uuid').v4(), ...payload });
                    try {
                        (0, events_1.broadcastOrdersUpdated)({ action: exists ? 'update' : 'create' });
                    }
                    catch (_l) { }
                    if (exists)
                        updatedCount++;
                    else
                        createdCount++;
                }
                try {
                    (0, store_1.addAudit)('OrderImportAudit', ((exists === null || exists === void 0 ? void 0 : exists.id) || (payload === null || payload === void 0 ? void 0 : payload.confirmation_code) || 'unknown'), 'process', null, { source_platform: platform, external_id: cc, total_payment_raw: (platform === 'booking' ? Number(tpRawStr) : undefined), price, status: 'ok', actor_id: (_a = req.user) === null || _a === void 0 ? void 0 : _a.sub, processed_at: new Date().toISOString() }, (_b = req.user) === null || _b === void 0 ? void 0 : _b.sub);
                }
                catch (_m) { }
            }
            catch (e) {
                errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: '写入失败: ' + String((e === null || e === void 0 ? void 0 : e.message) || '') });
            }
        }
        const tSpent = Date.now() - tStart;
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        const successCount = createdCount + updatedCount;
        return res.json({ successCount, createdCount, updatedCount, errorCount: errors.length, errors, buildVersion, metrics: { ms: tSpent, rss: mem.rss, heapUsed: mem.heapUsed, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system } });
    }
    catch (e) {
        try {
            const payload = { id: require('uuid').v4(), channel: 'unknown', raw_row: {}, reason: 'runtime_error', error_detail: String((e === null || e === void 0 ? void 0 : e.stack) || (e === null || e === void 0 ? void 0 : e.message) || '') };
            if (dbAdapter_1.hasPg)
                await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
            else
                store_1.db.orderImportStaging.push(payload);
        }
        catch (_o) { }
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'import failed', buildVersion: (process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || 'unknown') });
    }
});
exports.router.post('/actions/dedupeByConfirmationCode', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
    try {
        const body = req.body || {};
        const dryRun = String(body.dry_run || '').toLowerCase() === 'true' || body.dry_run === true;
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        await ensureOrdersColumns();
        const rows = (await (0, dbAdapter_1.pgSelect)('orders', 'id,confirmation_code,source,property_id,guest_name,guest_phone,checkin,checkout,price,cleaning_fee,net_income,avg_nightly_price,nights,currency,status,email_header_at,created_at')) || [];
        const groups = new Map();
        for (const r of rows) {
            const cc = String(r.confirmation_code || '').trim();
            if (!cc)
                continue;
            const arr = groups.get(cc) || [];
            arr.push(r);
            groups.set(cc, arr);
        }
        const pickLonger = (a, b) => { const s = String(a || ''); const t = String(b || ''); return (t.length > s.length) ? (t || undefined) : (s || undefined); };
        const pickDefined = (a, b) => (a !== undefined && a !== null && String(a) !== '' ? a : (b !== undefined && b !== null && String(b) !== '' ? b : undefined));
        const srcPriority = (s) => {
            const v = String(s || '').toLowerCase();
            if (v === 'airbnb')
                return 0;
            if (v === 'booking')
                return 1;
            if (v === 'airbnb_email' || v === 'booking_email' || v.endsWith('_email'))
                return 2;
            if (v === 'offline')
                return 3;
            return 9;
        };
        const results = [];
        await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
            for (const [cc, arr] of groups.entries()) {
                if (!arr || arr.length <= 1)
                    continue;
                const sorted = arr.slice().sort((a, b) => srcPriority(a.source) - srcPriority(b.source) || new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
                const master = sorted[0];
                const others = sorted.slice(1);
                const merged = { id: master.id };
                for (const r of others) {
                    merged.source = master.source;
                    merged.property_id = pickDefined(master.property_id, r.property_id);
                    merged.guest_name = pickLonger(master.guest_name, r.guest_name);
                    merged.guest_phone = pickDefined(master.guest_phone, r.guest_phone);
                    merged.checkin = pickDefined(master.checkin, r.checkin);
                    merged.checkout = pickDefined(master.checkout, r.checkout);
                    merged.price = pickDefined(master.price, r.price);
                    merged.cleaning_fee = pickDefined(master.cleaning_fee, r.cleaning_fee);
                    merged.net_income = pickDefined(master.net_income, r.net_income);
                    merged.avg_nightly_price = pickDefined(master.avg_nightly_price, r.avg_nightly_price);
                    merged.nights = pickDefined(master.nights, r.nights);
                    merged.currency = pickDefined(master.currency, r.currency);
                    merged.status = pickDefined(master.status, r.status);
                    const e1 = master.email_header_at ? new Date(master.email_header_at) : null;
                    const e2 = r.email_header_at ? new Date(r.email_header_at) : null;
                    merged.email_header_at = (e1 && e2) ? (e1 < e2 ? master.email_header_at : r.email_header_at) : (master.email_header_at || r.email_header_at || undefined);
                }
                if (!dryRun) {
                    const payload = {};
                    for (const k of ['source', 'property_id', 'guest_name', 'guest_phone', 'checkin', 'checkout', 'price', 'cleaning_fee', 'net_income', 'avg_nightly_price', 'nights', 'currency', 'status', 'email_header_at']) {
                        if (merged[k] !== undefined)
                            payload[k] = merged[k];
                    }
                    await (0, dbAdapter_1.pgUpdate)('orders', master.id, payload, client);
                    for (const r of others) {
                        await (0, dbAdapter_1.pgDelete)('orders', r.id, client);
                    }
                }
                results.push({ confirmation_code: cc, kept_id: master.id, deleted_ids: others.map(o => o.id) });
            }
        });
        if (!dryRun) {
            await ensureOrdersIndexes();
        }
        return res.json({ ok: true, deduped: results.length, items: results });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'dedupe_failed' });
    }
});
const deductionSchema = zod_1.z.object({ amount: zod_1.z.coerce.number().positive(), currency: zod_1.z.string().optional(), item_desc: zod_1.z.string().min(1), note: zod_1.z.string().optional() });
function monthKeyOfDate(s) {
    const d = s ? new Date(s) : null;
    if (!d || isNaN(d.getTime()))
        return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}
async function isOrderMonthLocked(order) {
    var _a;
    try {
        if (!dbAdapter_1.hasPg)
            return false;
        const co = String((order === null || order === void 0 ? void 0 : order.checkout) || '').slice(0, 10);
        if (!co)
            return false;
        const mm = monthKeyOfDate(co);
        let landlordId;
        if (order === null || order === void 0 ? void 0 : order.property_id) {
            const ps = await (0, dbAdapter_1.pgSelect)('properties', 'id,landlord_id', { id: order.property_id }) || [];
            landlordId = (_a = ps[0]) === null || _a === void 0 ? void 0 : _a.landlord_id;
        }
        const rows = await (0, dbAdapter_1.pgSelect)('payouts') || [];
        const locked = rows.some((p) => {
            const pf = String(p.period_from || '').slice(0, 10);
            const pt = String(p.period_to || '').slice(0, 10);
            if (!pf || !pt)
                return false;
            const kmf = monthKeyOfDate(pf);
            const kmt = monthKeyOfDate(pt);
            const sameMonth = kmf === mm && kmt === mm;
            const landlordMatch = landlordId ? String(p.landlord_id || '') === String(landlordId) : true;
            return sameMonth && landlordMatch && String(p.status || '').toLowerCase() !== 'pending';
        });
        return locked;
    }
    catch (_b) {
        return false;
    }
}
exports.router.get('/:id/internal-deductions', (0, auth_1.requireAnyPerm)(['order.view', 'order.deduction.manage']), async (req, res) => {
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('order_internal_deductions', '*', { order_id: id }) || [];
            return res.json(rows);
        }
        const rows = store_1.db.orderInternalDeductions.filter((d) => d.order_id === id);
        return res.json(rows);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'query failed' });
    }
});
exports.router.post('/:id/internal-deductions', (0, auth_1.requirePerm)('order.deduction.manage'), async (req, res) => {
    var _a, _b, _c, _d, _e;
    const { id } = req.params;
    const parsed = deductionSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    let order = store_1.db.orders.find(o => o.id === id);
    if (!order && dbAdapter_1.hasPg) {
        try {
            const rows = await (0, dbAdapter_1.pgSelect)('orders', '*', { id }) || [];
            order = rows[0];
        }
        catch (_f) { }
    }
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    const role = String(((_a = req.user) === null || _a === void 0 ? void 0 : _a.role) || '');
    const singleLimit = 100;
    const totalLimit = 150;
    const amount = Number(parsed.data.amount);
    if (role !== 'admin' && role !== 'finance_staff') {
        if (amount > singleLimit)
            return res.status(403).json({ message: 'amount exceeds single limit' });
    }
    let existingTotal = 0;
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            const rs = await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('SELECT COALESCE(SUM(amount),0) AS total FROM order_internal_deductions WHERE is_active=true AND order_id=$1', [id]));
            existingTotal = Number(((_c = (_b = rs === null || rs === void 0 ? void 0 : rs.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.total) || 0);
        }
        else {
            existingTotal = store_1.db.orderInternalDeductions.filter((d) => d.order_id === id && d.is_active).reduce((s, x) => s + Number(x.amount || 0), 0);
        }
    }
    catch (_g) { }
    if (role !== 'admin' && role !== 'finance_staff') {
        if (existingTotal + amount > totalLimit)
            return res.status(403).json({ message: 'amount exceeds order total limit' });
    }
    const net = Number(order.net_income || 0);
    if (existingTotal + amount > net && role !== 'admin' && role !== 'finance_staff')
        return res.status(403).json({ message: 'amount exceeds order net income' });
    const locked = await isOrderMonthLocked(order);
    if (locked && role === 'customer_service')
        return res.status(403).json({ message: 'payout locked, customer_service cannot change amount' });
    const now = new Date().toISOString();
    const row = { id: uuid(), order_id: id, amount, currency: parsed.data.currency || 'AUD', item_desc: parsed.data.item_desc, note: parsed.data.note, created_by: (_d = req.user) === null || _d === void 0 ? void 0 : _d.sub, created_at: now, is_active: true };
    (0, store_1.addAudit)('OrderInternalDeduction', row.id, 'create', null, row, (_e = req.user) === null || _e === void 0 ? void 0 : _e.sub);
    if (dbAdapter_1.hasPg) {
        try {
            const inserted = await (0, dbAdapter_1.pgInsert)('order_internal_deductions', row);
            return res.status(201).json(inserted || row);
        }
        catch (e) {
            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
            try {
                const { pgPool } = require('../dbAdapter');
                if (/relation\s+"order_internal_deductions"\s+does\s+not\s+exist/i.test(msg)) {
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(`CREATE TABLE IF NOT EXISTS order_internal_deductions (
            id text PRIMARY KEY,
            order_id text REFERENCES orders(id) ON DELETE CASCADE,
            amount numeric NOT NULL,
            currency text,
            item_desc text,
            note text,
            created_by text,
            created_at timestamptz DEFAULT now(),
            is_active boolean DEFAULT true
          )`));
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_deductions_order_active ON order_internal_deductions(order_id, is_active)'));
                }
                if (/column\s+"item_desc"\s+of\s+relation\s+"order_internal_deductions"\s+does\s+not\s+exist/i.test(msg)) {
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_internal_deductions ADD COLUMN IF NOT EXISTS item_desc text'));
                }
                if (/column\s+"note"\s+of\s+relation\s+"order_internal_deductions"\s+has\s+no\s+default/i.test(msg) || /null value in column "note" violates not-null constraint/i.test(msg)) {
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_internal_deductions ALTER COLUMN note DROP NOT NULL'));
                }
                const inserted2 = await (0, dbAdapter_1.pgInsert)('order_internal_deductions', row);
                return res.status(201).json(inserted2 || row);
            }
            catch (e2) {
                return res.status(500).json({ message: (e2 === null || e2 === void 0 ? void 0 : e2.message) || msg || 'insert failed' });
            }
        }
    }
    ;
    store_1.db.orderInternalDeductions.push(row);
    return res.status(201).json(row);
});
exports.router.patch('/:id/internal-deductions/:did', (0, auth_1.requirePerm)('order.deduction.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const { id, did } = req.params;
    const parsed = deductionSchema.partial().extend({ is_active: zod_1.z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    let order = store_1.db.orders.find(o => o.id === id);
    if (!order && dbAdapter_1.hasPg) {
        try {
            const rows = await (0, dbAdapter_1.pgSelect)('orders', '*', { id }) || [];
            order = rows[0];
        }
        catch (_e) { }
    }
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    const role = String(((_a = req.user) === null || _a === void 0 ? void 0 : _a.role) || '');
    const locked = await isOrderMonthLocked(order);
    if (locked && role === 'customer_service' && parsed.data.amount != null)
        return res.status(403).json({ message: 'payout locked, customer_service cannot change amount' });
    let prev = null;
    if (dbAdapter_1.hasPg) {
        try {
            const rows = await (0, dbAdapter_1.pgSelect)('order_internal_deductions', '*', { id: did }) || [];
            prev = rows[0];
        }
        catch (_f) { }
    }
    else {
        prev = store_1.db.orderInternalDeductions.find((d) => d.id === did);
    }
    if (!prev)
        return res.status(404).json({ message: 'deduction not found' });
    const amountNew = parsed.data.amount != null ? Number(parsed.data.amount) : undefined;
    const singleLimit = 100;
    const totalLimit = 150;
    if (amountNew != null && role !== 'admin' && role !== 'finance_staff') {
        if (amountNew > singleLimit)
            return res.status(403).json({ message: 'amount exceeds single limit' });
    }
    let existingTotal = 0;
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            const rs = await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('SELECT COALESCE(SUM(amount),0) AS total FROM order_internal_deductions WHERE is_active=true AND order_id=$1 AND id<>$2', [id, did]));
            existingTotal = Number(((_c = (_b = rs === null || rs === void 0 ? void 0 : rs.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.total) || 0);
        }
        else {
            existingTotal = store_1.db.orderInternalDeductions.filter((d) => d.order_id === id && d.is_active && d.id !== did).reduce((s, x) => s + Number(x.amount || 0), 0);
        }
    }
    catch (_g) { }
    if (amountNew != null && role !== 'admin' && role !== 'finance_staff') {
        if (existingTotal + amountNew > totalLimit)
            return res.status(403).json({ message: 'amount exceeds order total limit' });
    }
    const net = Number(order.net_income || 0);
    if (amountNew != null && existingTotal + amountNew > net && role !== 'admin' && role !== 'finance_staff')
        return res.status(403).json({ message: 'amount exceeds order net income' });
    const updated = { ...prev, ...parsed.data };
    (0, store_1.addAudit)('OrderInternalDeduction', did, 'update', prev, updated, (_d = req.user) === null || _d === void 0 ? void 0 : _d.sub);
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('order_internal_deductions', did, updated);
            return res.json(row || updated);
        }
        catch (e) {
            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
            try {
                const { pgPool } = require('../dbAdapter');
                if (/column\s+"item_desc"\s+of\s+relation\s+"order_internal_deductions"\s+does\s+not\s+exist/i.test(msg)) {
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_internal_deductions ADD COLUMN IF NOT EXISTS item_desc text'));
                }
                if (/null value in column "note" violates not-null constraint/i.test(msg)) {
                    await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_internal_deductions ALTER COLUMN note DROP NOT NULL'));
                }
                const row2 = await (0, dbAdapter_1.pgUpdate)('order_internal_deductions', did, updated);
                return res.json(row2 || updated);
            }
            catch (e2) {
                try {
                    await (0, dbAdapter_1.pgInsert)('order_internal_deductions', updated);
                    return res.json(updated);
                }
                catch (e3) {
                    return res.status(500).json({ message: (e3 === null || e3 === void 0 ? void 0 : e3.message) || (e2 === null || e2 === void 0 ? void 0 : e2.message) || msg || 'update failed' });
                }
            }
        }
    }
    const idx = store_1.db.orderInternalDeductions.findIndex((d) => d.id === did);
    if (idx !== -1)
        store_1.db.orderInternalDeductions[idx] = updated;
    return res.json(updated);
});
exports.router.delete('/:id/internal-deductions/:did', (0, auth_1.requirePerm)('order.deduction.manage'), async (req, res) => {
    var _a, _b;
    const { id, did } = req.params;
    let order = store_1.db.orders.find(o => o.id === id);
    if (!order && dbAdapter_1.hasPg) {
        try {
            const rows = await (0, dbAdapter_1.pgSelect)('orders', '*', { id }) || [];
            order = rows[0];
        }
        catch (_c) { }
    }
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    const role = String(((_a = req.user) === null || _a === void 0 ? void 0 : _a.role) || '');
    const locked = await isOrderMonthLocked(order);
    if (locked && role === 'customer_service')
        return res.status(403).json({ message: 'payout locked, customer_service cannot delete physically' });
    let prev = null;
    if (dbAdapter_1.hasPg) {
        try {
            const rows = await (0, dbAdapter_1.pgSelect)('order_internal_deductions', '*', { id: did }) || [];
            prev = rows[0];
        }
        catch (_d) { }
    }
    else {
        prev = store_1.db.orderInternalDeductions.find((d) => d.id === did);
    }
    if (!prev)
        return res.status(404).json({ message: 'deduction not found' });
    (0, store_1.addAudit)('OrderInternalDeduction', did, 'delete', prev, null, (_b = req.user) === null || _b === void 0 ? void 0 : _b.sub);
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('order_internal_deductions', did);
            return res.json({ ok: true });
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'delete failed' });
        }
    }
    const idx = store_1.db.orderInternalDeductions.findIndex((d) => d.id === did);
    if (idx !== -1)
        store_1.db.orderInternalDeductions.splice(idx, 1);
    return res.json({ ok: true });
});
exports.router.post('/:id/confirm-payment', (0, auth_1.requirePerm)('order.confirm_payment'), async (req, res) => {
    const { id } = req.params;
    let base = store_1.db.orders.find(o => o.id === id);
    if (!base && dbAdapter_1.hasPg) {
        try {
            const rows = await (0, dbAdapter_1.pgSelect)('orders', '*', { id }) || [];
            base = rows[0];
        }
        catch (_a) { }
    }
    if (!base)
        return res.status(404).json({ message: 'order not found' });
    const before = { ...base };
    base.payment_received = true;
    (0, store_1.addAudit)('Order', id, 'confirm_payment', before, base);
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('orders', id, { payment_received: true });
            return res.json(row || base);
        }
        catch (_b) { }
    }
    return res.json(base);
});
const importJobs = {};
function normalizePlatform(s) {
    const v = String(s || '').trim().toLowerCase();
    if (v.startsWith('airbnb'))
        return 'airbnb';
    if (v.startsWith('booking'))
        return 'booking';
    return v || 'offline';
}
async function startImportJob(csv, channel) {
    const parse = require('csv-parse').parse;
    const rows = await new Promise((resolve) => {
        parse(csv || '', { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, relax_quotes: true, trim: true }, (err, recs) => {
            if (err)
                resolve([]);
            else
                resolve(Array.isArray(recs) ? recs : []);
        });
    });
    const id = require('uuid').v4();
    importJobs[id] = { id, channel: normalizePlatform(channel), total: rows.length, parsed: 0, inserted: 0, skipped: 0, reason_counts: {}, started_at: Date.now() };
    const job = importJobs[id];
    const platform = job.channel || 'offline';
    const byName = {};
    const idToCode = {};
    try {
        if (dbAdapter_1.hasPg) {
            const cols = platform === 'airbnb' ? 'id,code,airbnb_listing_name' : (platform === 'booking' ? 'id,code,booking_listing_name' : 'id,code,listing_names');
            const propsRaw = (await (0, dbAdapter_1.pgSelect)('properties', cols)) || [];
            propsRaw.forEach((p) => {
                const idp = String(p.id);
                const code = String(p.code || '');
                if (code)
                    idToCode[idp] = code;
                if (platform === 'airbnb' || platform === 'booking') {
                    const nm = String((platform === 'airbnb' ? p.airbnb_listing_name : p.booking_listing_name) || '');
                    if (nm)
                        byName[`name:${String(nm).toLowerCase().replace(/\s+/g, ' ').trim()}`] = idp;
                }
                else {
                    const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {};
                    Object.values(ln || {}).forEach((nm) => { if (nm)
                        byName[`name:${String(nm).toLowerCase().replace(/\s+/g, ' ').trim()}`] = idp; });
                }
            });
        }
    }
    catch (_a) { }
    const existingByCc = new Set();
    try {
        if (dbAdapter_1.hasPg) {
            const rowsCc = (await (0, dbAdapter_1.pgSelect)('orders', 'confirmation_code')) || [];
            for (const r of (rowsCc || [])) {
                const cc = String((r === null || r === void 0 ? void 0 : r.confirmation_code) || '').trim();
                if (cc)
                    existingByCc.add(cc);
            }
        }
    }
    catch (_b) { }
    let i = 0;
    const inc = (k) => { job.reason_counts[k] = (job.reason_counts[k] || 0) + 1; };
    function getField(obj, keys) {
        const map = {};
        Object.keys(obj || {}).forEach((kk) => { const nk = String(kk).toLowerCase().replace(/\s+/g, '_').trim(); map[nk] = obj[kk]; });
        for (const k of keys) {
            const v1 = obj[k];
            if (v1 != null && String(v1).trim() !== '')
                return String(v1);
            const nk = String(k).toLowerCase().replace(/\s+/g, '_').trim();
            const v2 = map[nk];
            if (v2 != null && String(v2).trim() !== '')
                return String(v2);
        }
        return undefined;
    }
    function toAmount(v) {
        if (v == null)
            return undefined;
        const s = String(v).trim();
        if (!s)
            return undefined;
        const t = s.replace(/[,]/g, '').replace(/[A-Za-z$\s]/g, '');
        const n = Number(t);
        return isNaN(n) ? undefined : Number(n.toFixed(2));
    }
    function toName(v) {
        if (v == null)
            return undefined;
        const s = String(v).trim();
        if (!s)
            return undefined;
        return s.replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
    }
    const chunk = async () => {
        const end = Math.min(i + 100, rows.length);
        for (; i < end; i++) {
            const r = rows[i] || {};
            const ln = String((r['Listing'] || r['Listing name'] || r['Property Name'] || r['listing'] || r['listing_name'] || '')).trim();
            const pid = ln ? byName[`name:${String(ln).toLowerCase().replace(/\s+/g, ' ').trim()}`] : undefined;
            const cc = String((r['Confirmation Code'] || r['confirmation_code'] || r['Reservation Number'] || '') || '').trim();
            const ciRaw = String((r['Start date'] || r['Arrival'] || r['checkin'] || '') || '').trim();
            const coRaw = String((r['End date'] || r['Departure'] || r['checkout'] || '') || '').trim();
            const ci = dayOnly(ciRaw);
            const co = dayOnly(coRaw);
            if (!pid) {
                job.skipped++;
                inc('unmatched_property');
                job.parsed++;
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason: 'unmatched_property', listing_name: ln, confirmation_code: cc, status: 'unmatched' };
                    if (dbAdapter_1.hasPg) {
                        try {
                            await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                        }
                        catch (e) {
                            try {
                                const { pgPool } = require('../dbAdapter');
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(`CREATE TABLE IF NOT EXISTS order_import_staging (
                  id text PRIMARY KEY,
                  channel text,
                  raw_row jsonb,
                  reason text,
                  listing_name text,
                  confirmation_code text,
                  listing_id text,
                  property_code text,
                  property_id text REFERENCES properties(id) ON DELETE SET NULL,
                  status text DEFAULT 'unmatched',
                  created_at timestamptz DEFAULT now(),
                  resolved_at timestamptz
                )`));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('ALTER TABLE order_import_staging ADD COLUMN IF NOT EXISTS confirmation_code text'));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_import_staging_status ON order_import_staging(status)'));
                                await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query('CREATE INDEX IF NOT EXISTS idx_order_import_staging_created ON order_import_staging(created_at)'));
                                await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                            }
                            catch (_a) { }
                        }
                    }
                    else {
                        store_1.db.orderImportStaging.push(payload);
                    }
                }
                catch (_b) { }
                continue;
            }
            if (!ci || !co) {
                job.skipped++;
                inc('invalid_date');
                job.parsed++;
                continue;
            }
            if (cc && existingByCc.has(cc)) {
                job.skipped++;
                inc('duplicate');
                job.parsed++;
                continue;
            }
            const amtStr = getField(r, ['Amount', 'Total', 'Total Payment', 'price', 'you_earn']);
            const cleanStr = getField(r, ['Cleaning fee', 'cleaning_fee']);
            const currency = (getField(r, ['Currency', 'payment_currency']) || 'AUD').toUpperCase();
            let price = undefined;
            if (platform === 'booking') {
                const tpRaw = getField(r, ['Total Payment', 'total_payment', 'Amount', 'amount']);
                const tpNum = tpRaw != null ? Number(String(tpRaw).replace(/[,]/g, '')) : NaN;
                if (!isFinite(tpNum)) {
                    job.skipped++;
                    inc('invalid_amount');
                    job.parsed++;
                    continue;
                }
                const p = Number((tpNum * 0.835).toFixed(2));
                if (!(p > 0)) {
                    job.skipped++;
                    inc('missing_amount');
                    job.parsed++;
                    continue;
                }
                price = p;
            }
            else {
                price = toAmount(amtStr);
                if (!(price > 0)) {
                    job.skipped++;
                    inc('missing_amount');
                    job.parsed++;
                    continue;
                }
            }
            const cleaning_fee = toAmount(cleanStr) || 0;
            const guestRaw = platform === 'booking' ? getField(r, ['Booker Name', 'booker_name', 'Guest', 'guest', 'guest_name']) : getField(r, ['Guest', 'guest', 'guest_name', 'Booker Name', 'booker_name']);
            const guest_name = toName(guestRaw);
            let nights = 0;
            try {
                const a = new Date(`${ci}T00:00:00`);
                const b = new Date(`${co}T00:00:00`);
                const ms = b.getTime() - a.getTime();
                nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
            }
            catch (_c) { }
            const net = Number(((price || 0) - (cleaning_fee || 0)).toFixed(2));
            const avg = nights > 0 ? Number((net / nights).toFixed(2)) : 0;
            try {
                const payload = { source: platform, confirmation_code: cc || undefined, property_id: pid, guest_name, checkin: ci, checkout: co, status: 'confirmed', price, cleaning_fee, currency, net_income: net, avg_nightly_price: avg, nights };
                const parsed = createOrderSchema.safeParse(payload);
                if (!parsed.success) {
                    job.skipped++;
                    inc('invalid_row');
                    job.parsed++;
                    continue;
                }
                const o = parsed.data;
                const ciIso = `${String(o.checkin).slice(0, 10)}T12:00:00`;
                const coIso = `${String(o.checkout).slice(0, 10)}T11:59:59`;
                const newOrder = { id: require('uuid').v4(), ...o, checkin: ciIso, checkout: coIso };
                if (dbAdapter_1.hasPg) {
                    const insertPayload = { ...newOrder };
                    try {
                        await (0, dbAdapter_1.pgInsert)('orders', insertPayload);
                        job.inserted++;
                    }
                    catch (_d) {
                        job.skipped++;
                        inc('write_failed');
                    }
                }
                else {
                    job.inserted++;
                }
            }
            catch (_e) {
                job.skipped++;
            }
            job.parsed++;
        }
        if (i < rows.length) {
            setTimeout(chunk, 0);
        }
        else {
            job.finished_at = Date.now();
        }
    };
    setTimeout(chunk, 0);
    return id;
}
exports.router.post('/import/start', (0, auth_1.requirePerm)('order.manage'), (0, express_1.text)({ type: ['text/csv', 'text/plain'] }), async (req, res) => {
    var _a;
    try {
        const channel = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.channel) || '');
        const body = typeof req.body === 'string' ? req.body : '';
        const jobId = await startImportJob(body || '', channel);
        return res.json({ job_id: jobId });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'start_failed' });
    }
});
// Fallback alias to support old clients posting to /orders/import
exports.router.post('/import', (0, auth_1.requirePerm)('order.manage'), (0, express_1.text)({ type: ['text/csv', 'text/plain', '*/*'] }), async (req, res) => {
    var _a;
    try {
        const channel = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.channel) || '');
        const body = typeof req.body === 'string' ? req.body : '';
        const jobId = await startImportJob(body || '', channel);
        return res.json({ job_id: jobId });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'start_failed' });
    }
});
exports.router.get('/import/jobs/:id/progress', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
    const { id } = req.params;
    const j = importJobs[id];
    if (!j)
        return res.status(404).json({ message: 'job_not_found' });
    const dur = (j.finished_at || Date.now()) - j.started_at;
    return res.json({ parsed: j.parsed, total: j.total, inserted: j.inserted, skipped: j.skipped, duration_ms: dur, reason_counts: j.reason_counts });
});
exports.router.get('/import/unmatched', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
    const q = req.query || {};
    const since = Math.max(1, Number(q.since_minutes || 60));
    const limit = Math.max(1, Math.min(500, Number(q.limit || 200)));
    const channel = String(q.channel || '').trim() || undefined;
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            const condChan = channel ? 'AND channel = $1' : '';
            const sql = `SELECT id, channel, listing_name, confirmation_code, raw_row, created_at FROM order_import_staging WHERE status='unmatched' ${condChan} AND created_at > now() - interval '${since} minutes' ORDER BY created_at DESC LIMIT ${limit}`;
            const rs = await (pgPool === null || pgPool === void 0 ? void 0 : pgPool.query(sql, channel ? [channel] : []));
            const arr = ((rs === null || rs === void 0 ? void 0 : rs.rows) || []);
            return res.json(arr);
        }
        const arr = (store_1.db.orderImportStaging || []).filter((x) => String((x === null || x === void 0 ? void 0 : x.status) || '') === 'unmatched').slice(0, limit);
        return res.json(arr);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'list_failed' });
    }
});
