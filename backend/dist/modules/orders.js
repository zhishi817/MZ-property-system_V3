"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
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
            return res.json(labeled);
        }
        // Supabase branch removed
        return res.json(store_1.db.orders.map((o) => {
            const prop = store_1.db.properties.find((p) => String(p.id) === String(o.property_id)) || store_1.db.properties.find((p) => String(p.code || '') === String(o.property_id || '')) || store_1.db.properties.find((p) => { const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {}; return Object.values(ln || {}).map(String).map(s => s.toLowerCase()).includes(String(o.listing_name || '').toLowerCase()); });
            const property_name = (prop === null || prop === void 0 ? void 0 : prop.address) || undefined;
            const label = (o.property_code || (prop === null || prop === void 0 ? void 0 : prop.code) || (prop === null || prop === void 0 ? void 0 : prop.address) || o.property_id || '');
            const base = { ...o, checkin: dayOnly(o.checkin), checkout: dayOnly(o.checkout) };
            return property_name ? { ...base, property_code: label, property_name } : { ...base, property_code: label };
        }));
    }
    catch (_b) {
        return res.json(store_1.db.orders.map((o) => {
            const prop = store_1.db.properties.find((p) => String(p.id) === String(o.property_id)) || store_1.db.properties.find((p) => String(p.code || '') === String(o.property_id || '')) || store_1.db.properties.find((p) => { const ln = (p === null || p === void 0 ? void 0 : p.listing_names) || {}; return Object.values(ln || {}).map(String).map(s => s.toLowerCase()).includes(String(o.listing_name || '').toLowerCase()); });
            const property_name = (prop === null || prop === void 0 ? void 0 : prop.address) || undefined;
            const label = (o.property_code || (prop === null || prop === void 0 ? void 0 : prop.code) || (prop === null || prop === void 0 ? void 0 : prop.address) || o.property_id || '');
            const base = { ...o, checkin: dayOnly(o.checkin), checkout: dayOnly(o.checkout) };
            return property_name ? { ...base, property_code: label, property_name } : { ...base, property_code: label };
        }));
    }
});
exports.router.get('/:id', async (req, res) => {
    const { id } = req.params;
    const local = store_1.db.orders.find((o) => o.id === id);
    if (local)
        return res.json(local);
    try {
        if (dbAdapter_1.hasPg) {
            const remote = await (0, dbAdapter_1.pgSelect)('orders', '*', { id });
            const row = Array.isArray(remote) ? remote[0] : null;
            if (row) {
                return res.json({ ...row, checkin: dayOnly(row.checkin), checkout: dayOnly(row.checkout) });
            }
        }
        // Supabase branch removed
    }
    catch (_a) { }
    return res.status(404).json({ message: 'order not found' });
});
exports.router.get('/:id', (req, res) => {
    const { id } = req.params;
    const order = store_1.db.orders.find((o) => o.id === id);
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    return res.json({ ...order, checkin: dayOnly(order.checkin), checkout: dayOnly(order.checkout) });
});
const createOrderSchema = zod_1.z.object({
    source: zod_1.z.string(),
    external_id: zod_1.z.string().optional(),
    property_id: zod_1.z.string().optional(),
    property_code: zod_1.z.string().optional(),
    confirmation_code: zod_1.z.coerce.string().min(1),
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
    status: zod_1.z.string().optional(),
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
    var _a, _b;
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    try {
        const ci = normalizeStart(o.checkin || '');
        const co = normalizeEnd(o.checkout || '');
        if (ci && co && !(ci < co))
            return res.status(400).json({ message: '入住日期必须早于退房日期' });
    }
    catch (_c) { }
    let propertyId = o.property_id || (o.property_code ? ((_a = store_1.db.properties.find(p => (p.code || '') === o.property_code)) === null || _a === void 0 ? void 0 : _a.id) : undefined);
    // 如果传入的 property_id 不存在于 PG，则尝试用房号 code 在 PG 中查找并替换
    if (dbAdapter_1.hasPg) {
        try {
            const byId = propertyId ? (await (0, dbAdapter_1.pgSelect)('properties', 'id', { id: propertyId })) || [] : [];
            const existsById = Array.isArray(byId) && !!byId[0];
            if (!existsById && o.property_code) {
                const byCode = (await (0, dbAdapter_1.pgSelect)('properties', '*', { code: o.property_code })) || [];
                if (Array.isArray(byCode) && ((_b = byCode[0]) === null || _b === void 0 ? void 0 : _b.id))
                    propertyId = byCode[0].id;
            }
        }
        catch (_d) { }
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
        catch (_e) {
            nights = 0;
        }
    }
    const cleaning = round2(o.cleaning_fee || 0) || 0;
    const price = round2(o.price || 0) || 0;
    const net = o.net_income != null ? (round2(o.net_income) || 0) : ((round2(price - cleaning) || 0));
    const avg = o.avg_nightly_price != null ? (round2(o.avg_nightly_price) || 0) : (nights && nights > 0 ? (round2(net / nights) || 0) : 0);
    const newOrder = { id: uuid(), ...o, property_id: propertyId, price, cleaning_fee: cleaning, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key, status: 'confirmed' };
    // overlap guard
    const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
    if (conflict)
        return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' });
    // confirmation_code 唯一性（PG）
    try {
        const cc = newOrder.confirmation_code;
        if (dbAdapter_1.hasPg && cc) {
            const dup = (await (0, dbAdapter_1.pgSelect)('orders', 'id', { source: newOrder.source, confirmation_code: cc })) || [];
            if (Array.isArray(dup) && dup[0])
                return res.status(409).json({ message: '确认码已存在' });
        }
    }
    catch (_f) { }
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
                catch (_g) { }
            }
            const insertOrder = { ...newOrder };
            delete insertOrder.property_code;
            const row = await (0, dbAdapter_1.pgInsert)('orders', insertOrder);
            if (newOrder.checkout) {
                const date = newOrder.checkout;
                const hasTask = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id);
                if (!hasTask) {
                    const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' };
                    store_1.db.cleaningTasks.push(task);
                }
            }
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
                    const ins = { ...newOrder };
                    delete ins.property_code;
                    const row = await (0, dbAdapter_1.pgInsert)('orders', ins);
                    if (newOrder.checkout) {
                        const date = newOrder.checkout;
                        const hasTask = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id);
                        if (!hasTask) {
                            const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' };
                            store_1.db.cleaningTasks.push(task);
                        }
                    }
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
    if (newOrder.checkout) {
        const date = newOrder.checkout;
        const hasTask = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id);
        if (!hasTask) {
            const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' };
            store_1.db.cleaningTasks.push(task);
        }
    }
    return res.status(201).json(newOrder);
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('order.write'), async (req, res) => {
    var _a, _b;
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
        catch (_c) { }
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
    catch (_d) { }
    if (!nights && checkin && checkout) {
        try {
            const ci = new Date(checkin);
            const co = new Date(checkout);
            const ms = co.getTime() - ci.getTime();
            nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
        }
        catch (_e) {
            nights = 0;
        }
    }
    const price = o.price != null ? (round2(o.price) || 0) : (round2(base.price || 0) || 0);
    const cleaning = o.cleaning_fee != null ? (round2(o.cleaning_fee) || 0) : (round2(base.cleaning_fee || 0) || 0);
    const net = o.net_income != null ? (round2(o.net_income) || 0) : ((round2(price - cleaning) || 0));
    const avg = o.avg_nightly_price != null ? (round2(o.avg_nightly_price) || 0) : (nights && nights > 0 ? (round2(net / nights) || 0) : 0);
    const updated = { ...base, ...o, id, price, cleaning_fee: cleaning, nights, net_income: net, avg_nightly_price: avg };
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
            const payload = {};
            for (const k of allow) {
                if (updated[k] !== undefined)
                    payload[k] = updated[k];
            }
            const row = await (0, dbAdapter_1.pgUpdate)('orders', id, payload);
            if (idx !== -1)
                store_1.db.orders[idx] = row;
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
                    const payload2 = {};
                    for (const k of allow) {
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
            return res.json({ ok: true, id });
        }
        catch (e) {
            return res.status(500).json({ message: '数据库删除失败' });
        }
    }
    // Supabase branch removed
    if (!removed)
        return res.status(404).json({ message: 'order not found' });
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
exports.router.post('/:id/generate-cleaning', (0, auth_1.requirePerm)('order.write'), (req, res) => {
    const { id } = req.params;
    const order = store_1.db.orders.find((o) => o.id === id);
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    const { v4: uuid } = require('uuid');
    const date = order.checkout || new Date().toISOString().slice(0, 10);
    const exists = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === order.property_id);
    if (exists)
        return res.status(200).json(exists);
    const task = { id: uuid(), property_id: order.property_id, date, status: 'pending' };
    store_1.db.cleaningTasks.push(task);
    res.status(201).json(task);
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
        for (const k of keys) {
            if (obj[k] != null && String(obj[k]).trim() !== '')
                return String(obj[k]);
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
            let checkin = getField(r, ['checkin', 'check_in', 'start_date', 'Start date']);
            let checkout = getField(r, ['checkout', 'check_out', 'end_date', 'End date']);
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
                catch (_d) { }
            }
            const priceRaw = toNumber(getField(r, ['Amount', 'amount', 'price']));
            const cleaningRaw = toNumber(getField(r, ['Cleaning fee', 'cleaning_fee']));
            const price = round2(priceRaw);
            const cleaning_fee = round2(cleaningRaw);
            const currency = r.currency || 'AUD';
            const status = r.status || 'confirmed';
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
                    catch (_e) {
                        results.push({ ok: false, error: reason });
                    }
                    skipped++;
                    continue;
                }
                checkin = ciIso;
                checkout = coIso;
            }
            if (source === 'airbnb' && !confirmation_code) {
                const reason = 'missing_field:confirmation_code';
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
                catch (_f) {
                    results.push({ ok: false, error: reason });
                }
                skipped++;
                continue;
            }
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
            const ciIso = o.checkin ? `${String(o.checkin).slice(0, 10)}T12:00:00` : undefined;
            const coIso = o.checkout ? `${String(o.checkout).slice(0, 10)}T11:59:59` : undefined;
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
                        const dup = (await (0, dbAdapter_1.pgSelect)('orders', 'id', { source: newOrder.source, confirmation_code: cc, property_id: newOrder.property_id })) || [];
                        if (Array.isArray(dup) && dup[0]) {
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
                    if (newOrder.property_id) {
                        const existsPropRows = (await (0, dbAdapter_1.pgSelect)('properties', 'id', { id: newOrder.property_id })) || [];
                        const existsProp = Array.isArray(existsPropRows) && !!existsPropRows[0];
                        if (!existsProp) {
                            const payload = { id: newOrder.property_id };
                            const codeGuess = idToCode[newOrder.property_id || ''];
                            if (codeGuess)
                                payload.code = codeGuess;
                            await (0, dbAdapter_1.pgInsert)('properties', payload);
                        }
                    }
                    const insertPayload = { ...newOrder };
                    delete insertPayload.property_code;
                    await (0, dbAdapter_1.pgInsert)('orders', insertPayload);
                    writeOk = true;
                }
                catch (e) {
                    const code = (e && e.code) || '';
                    if (code === '23505') {
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
    const { id } = req.params;
    const body = req.body || {};
    const property_id = String(body.property_id || '').trim() || undefined;
    try {
        let row = null;
        if (dbAdapter_1.hasPg) {
            const rows = (await (0, dbAdapter_1.pgSelect)('order_import_staging', '*', { id })) || [];
            row = Array.isArray(rows) ? rows[0] : null;
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
        if (!confirmation_code)
            return res.status(400).json({ message: '确认码为空' });
        const guest_name = getVal(r, ['Guest', 'guest', 'guest_name', 'Booker Name']);
        const checkin = getVal(r, ['checkin', 'check_in', 'start_date', 'Start date', 'Arrival']);
        const checkout = getVal(r, ['checkout', 'check_out', 'end_date', 'End date', 'Departure']);
        const priceRaw = getVal(r, ['price', 'Amount', 'Total Payment']);
        const cleaningRaw = getVal(r, ['cleaning_fee', 'Cleaning fee']);
        const price = priceRaw != null ? Number(priceRaw) : undefined;
        const cleaning_fee = cleaningRaw != null ? Number(cleaningRaw) : undefined;
        const currency = getVal(r, ['currency', 'Currency']) || 'AUD';
        const stRaw = getVal(r, ['status', 'Status']) || '';
        const stLower = stRaw.toLowerCase();
        const status = stLower === 'ok' ? 'confirmed' : (stLower.includes('cancel') ? 'cancelled' : (stRaw ? stRaw : 'confirmed'));
        const parsed = createOrderSchema.safeParse({ source, property_id, guest_name, checkin, checkout, price, cleaning_fee, currency, status, confirmation_code });
        if (!parsed.success)
            return res.status(400).json(parsed.error.format());
        const o = parsed.data;
        const ciIso = o.checkin ? `${String(o.checkin).slice(0, 10)}T12:00:00` : undefined;
        const coIso = o.checkout ? `${String(o.checkout).slice(0, 10)}T11:59:59` : undefined;
        let key = o.idempotency_key || '';
        if (!key) {
            if (source === 'airbnb') {
                key = `airbnb|${String(o.confirmation_code || '').trim()}`;
            }
            else if (source === 'booking') {
                key = `booking|${String(o.confirmation_code || '').trim()}`;
            }
            else {
                key = `${source}|${String(o.checkin || '').slice(0, 10)}|${String(o.checkout || '').slice(0, 10)}|${String(o.guest_name || '').trim()}`;
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
            catch (_a) {
                nights = 0;
            }
        }
        const cleaning = o.cleaning_fee || 0;
        const total = o.price || 0;
        const net = o.net_income != null ? o.net_income : (total - cleaning);
        const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
        const newOrder = { id: uuid(), ...o, checkin: ciIso, checkout: coIso, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key };
        // duplicate by (source, confirmation_code)
        try {
            if (dbAdapter_1.hasPg && newOrder.confirmation_code) {
                const dup = (await (0, dbAdapter_1.pgSelect)('orders', 'id', { source: newOrder.source, confirmation_code: newOrder.confirmation_code, property_id: newOrder.property_id })) || [];
                if (Array.isArray(dup) && dup[0])
                    return res.status(409).json({ message: '确认码已存在', confirmation_code: newOrder.confirmation_code, source: newOrder.source, property_id: newOrder.property_id });
            }
        }
        catch (_b) { }
        const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
        if (conflict)
            return res.status(409).json({ message: 'overlap' });
        if (dbAdapter_1.hasPg) {
            try {
                await (0, dbAdapter_1.pgInsert)('orders', newOrder);
            }
            catch (_c) { }
            try {
                await (0, dbAdapter_1.pgUpdate)('order_import_staging', id, { status: 'resolved', property_id, resolved_at: new Date().toISOString() });
            }
            catch (_d) { }
        }
        else {
            const idx = store_1.db.orderImportStaging.findIndex((x) => x.id === id);
            if (idx !== -1)
                store_1.db.orderImportStaging[idx] = { ...store_1.db.orderImportStaging[idx], status: 'resolved', property_id, resolved_at: new Date().toISOString() };
        }
        return res.status(201).json(newOrder);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'resolve failed' });
    }
});
exports.router.post('/actions/importBookings', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
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
            for (const k of keys) {
                if (obj[k] != null && String(obj[k]).trim() !== '')
                    return String(obj[k]);
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
        catch (_a) { }
        const normalize = platform === 'airbnb' ? normAirbnb : (platform === 'booking' ? normBooking : normOther);
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
        catch (_b) { }
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
        let successCount = 0;
        let rowIndexBase = 2; // 首行数据通常为第2行
        for (let i = 0; i < recordsAll.length; i++) {
            const r = recordsAll[i] || {};
            if (isBlankRecord(r))
                continue;
            if (shouldSkipPayout(r))
                continue;
            const n = normalize(r);
            const cc = String(n.confirmation_code || '').trim();
            const ln = String(n.listing_name || '').trim();
            if (!cc) {
                errors.push({ rowIndex: rowIndexBase + i, listing_name: ln || undefined, reason: '确认码为空' });
                continue;
            }
            const pid = ln ? byName[`name:${normalizeName(ln)}`] : undefined;
            if (!pid) {
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason: 'unmatched_property', listing_name: ln, confirmation_code: cc, status: 'unmatched' };
                    if (dbAdapter_1.hasPg)
                        await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                    else
                        store_1.db.orderImportStaging.push(payload);
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: '找不到房号', stagingId: payload.id });
                }
                catch (_c) {
                    errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: '找不到房号' });
                }
                continue;
            }
            const source = platform;
            const checkin = n.check_in || undefined;
            const checkout = n.check_out || undefined;
            if (platform === 'airbnb' && (!checkin || !checkout)) {
                const det = !checkin ? 'invalid_date:Start date' : 'invalid_date:End date';
                try {
                    const payload = { id: require('uuid').v4(), channel: platform, raw_row: r, reason: det, listing_name: ln, confirmation_code: cc, status: 'unmatched' };
                    if (dbAdapter_1.hasPg)
                        await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
                    else
                        store_1.db.orderImportStaging.push(payload);
                }
                catch (_d) { }
                errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: 'invalid_date' });
                continue;
            }
            const price = n.amount != null ? round2(Number(n.amount)) : undefined;
            const cleaning_fee = n.cleaning_fee != null ? round2(Number(n.cleaning_fee)) : undefined;
            const status = n.status || 'confirmed';
            const guest_name = n.guest_name || undefined;
            // upsert by (source, confirmation_code)
            let exists = null;
            try {
                if (dbAdapter_1.hasPg) {
                    const dup = (await (0, dbAdapter_1.pgSelect)('orders', '*', { source, confirmation_code: cc, property_id: pid })) || [];
                    exists = Array.isArray(dup) ? dup[0] : null;
                }
                else {
                    exists = store_1.db.orders.find(o => o.confirmation_code === cc && o.source === source);
                }
            }
            catch (_e) { }
            const payload = { source, confirmation_code: cc, status, property_id: pid, guest_name, checkin: (checkin ? `${String(checkin).slice(0, 10)}T12:00:00` : undefined), checkout: (checkout ? `${String(checkout).slice(0, 10)}T11:59:59` : undefined), price, cleaning_fee };
            try {
                if (dbAdapter_1.hasPg) {
                    if (exists && exists.id) {
                        await (0, dbAdapter_1.pgUpdate)('orders', exists.id, payload);
                    }
                    else {
                        const row = await (0, dbAdapter_1.pgInsert)('orders', { id: require('uuid').v4(), ...payload });
                        if ((row === null || row === void 0 ? void 0 : row.id) && idToCode[pid])
                            row.property_code = idToCode[pid];
                        store_1.db.orders.push(row);
                    }
                }
                else {
                    if (exists)
                        Object.assign(exists, payload);
                    else
                        store_1.db.orders.push({ id: require('uuid').v4(), ...payload });
                }
                successCount++;
            }
            catch (e) {
                errors.push({ rowIndex: rowIndexBase + i, confirmation_code: cc, listing_name: ln, reason: '写入失败: ' + String((e === null || e === void 0 ? void 0 : e.message) || '') });
            }
        }
        return res.json({ successCount, errorCount: errors.length, errors, buildVersion });
    }
    catch (e) {
        try {
            const payload = { id: require('uuid').v4(), channel: 'unknown', raw_row: {}, reason: 'runtime_error', error_detail: String((e === null || e === void 0 ? void 0 : e.stack) || (e === null || e === void 0 ? void 0 : e.message) || '') };
            if (dbAdapter_1.hasPg)
                await (0, dbAdapter_1.pgInsert)('order_import_staging', payload);
            else
                store_1.db.orderImportStaging.push(payload);
        }
        catch (_f) { }
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'import failed', buildVersion: (process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || 'unknown') });
    }
});
