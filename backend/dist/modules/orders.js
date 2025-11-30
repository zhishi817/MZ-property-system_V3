"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const supabase_1 = require("../supabase");
const dbAdapter_1 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
let pendingInsert = [];
let pendingUpdate = [];
let pendingDelete = [];
let retryTimer = null;
function startRetry() {
    if (retryTimer)
        return;
    retryTimer = setInterval(async () => {
        if (!supabase_1.hasSupabase)
            return;
        if (pendingInsert.length) {
            const rest = [];
            for (const o of pendingInsert) {
                try {
                    await (0, supabase_1.supaUpsertConflict)('orders', o, 'id');
                }
                catch (_a) {
                    rest.push(o);
                }
            }
            pendingInsert = rest;
        }
        if (pendingUpdate.length) {
            const rest = [];
            for (const u of pendingUpdate) {
                try {
                    await (0, supabase_1.supaUpdate)('orders', u.id, u.payload);
                }
                catch (_b) {
                    rest.push(u);
                }
            }
            pendingUpdate = rest;
        }
        if (pendingDelete.length) {
            const rest = [];
            for (const id of pendingDelete) {
                try {
                    await (0, supabase_1.supaDelete)('orders', id);
                }
                catch (_c) {
                    rest.push(id);
                }
            }
            pendingDelete = rest;
        }
    }, 5000);
}
startRetry();
exports.router.get('/', async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const remote = (await (0, dbAdapter_1.pgSelect)('orders')) || [];
            const local = store_1.db.orders;
            const merged = [...remote, ...local.filter((l) => !remote.some((r) => r.id === l.id))];
            return res.json(merged);
        }
        if (supabase_1.hasSupabase) {
            const remote = (await (0, supabase_1.supaSelect)('orders')) || [];
            const local = store_1.db.orders;
            const merged = [...remote, ...local.filter((l) => !remote.some((r) => r.id === l.id))];
            return res.json(merged);
        }
        return res.json(store_1.db.orders);
    }
    catch (_a) {
        return res.json(store_1.db.orders);
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
            if (row)
                return res.json(row);
        }
        if (supabase_1.hasSupabase) {
            const remote = await (0, supabase_1.supaSelect)('orders', '*', { id });
            const row = Array.isArray(remote) ? remote[0] : null;
            if (row)
                return res.json(row);
        }
    }
    catch (_a) { }
    return res.status(404).json({ message: 'order not found' });
});
exports.router.get('/:id', (req, res) => {
    const { id } = req.params;
    const order = store_1.db.orders.find((o) => o.id === id);
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    return res.json(order);
});
const createOrderSchema = zod_1.z.object({
    source: zod_1.z.string(),
    external_id: zod_1.z.string().optional(),
    property_id: zod_1.z.string().optional(),
    property_code: zod_1.z.string().optional(),
    guest_name: zod_1.z.string().optional(),
    guest_phone: zod_1.z.string().optional(),
    checkin: zod_1.z.string().optional(),
    checkout: zod_1.z.string().optional(),
    price: zod_1.z.number().optional(),
    cleaning_fee: zod_1.z.number().optional(),
    net_income: zod_1.z.number().optional(),
    avg_nightly_price: zod_1.z.number().optional(),
    nights: zod_1.z.number().optional(),
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
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    const as = normalizeStart(aStart);
    const ae = normalizeEnd(aEnd);
    const bs = normalizeStart(bStart);
    const be = normalizeEnd(bEnd);
    if (!as || !ae || !bs || !be)
        return false;
    return as < be && bs < ae;
}
async function hasOrderOverlap(propertyId, checkin, checkout, excludeId) {
    if (!propertyId || !checkin || !checkout)
        return false;
    const ciDay = (checkin || '').slice(0, 10);
    const coDay = (checkout || '').slice(0, 10);
    const localHit = store_1.db.orders.some(o => {
        if (o.property_id !== propertyId || o.id === excludeId)
            return false;
        const oCiDay = (o.checkin || '').slice(0, 10);
        const oCoDay = (o.checkout || '').slice(0, 10);
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
                const oCiDay = (o.checkin || '').slice(0, 10);
                const oCoDay = (o.checkout || '').slice(0, 10);
                if (oCoDay === ciDay || coDay === oCiDay)
                    return false;
                return rangesOverlap(checkin, checkout, o.checkin, o.checkout);
            });
            if (remoteHit)
                return true;
        }
        if (supabase_1.hasSupabase) {
            const rows = (await (0, supabase_1.supaSelect)('orders', '*', { property_id: propertyId })) || [];
            const remoteHit = rows.some((o) => {
                if (o.id === excludeId)
                    return false;
                const oCiDay = (o.checkin || '').slice(0, 10);
                const oCoDay = (o.checkout || '').slice(0, 10);
                if (oCoDay === ciDay || coDay === oCiDay)
                    return false;
                return rangesOverlap(checkin, checkout, o.checkin, o.checkout);
            });
            if (remoteHit)
                return true;
        }
    }
    catch (_a) { }
    return false;
}
exports.router.post('/sync', (0, auth_1.requirePerm)('order.create'), async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    const key = o.idempotency_key || `${o.property_id || ''}-${o.checkin || ''}-${o.checkout || ''}`;
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
        catch (_a) {
            nights = 0;
        }
    }
    const cleaning = o.cleaning_fee || 0;
    const price = o.price || 0;
    const net = o.net_income != null ? o.net_income : (price - cleaning);
    const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
    const newOrder = { id: uuid(), ...o, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key, status: 'confirmed' };
    // overlap guard
    const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
    if (conflict)
        return res.status(409).json({ message: '订单时间冲突：同一房源在该时段已有订单' });
    store_1.db.orders.push(newOrder);
    if (newOrder.checkout) {
        const date = newOrder.checkout;
        const hasTask = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id);
        if (!hasTask) {
            const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' };
            store_1.db.cleaningTasks.push(task);
        }
    }
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgInsert)('orders', newOrder);
            return res.status(201).json(row || newOrder);
        }
        catch (e) {
            const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
            if (msg.includes('duplicate') || msg.includes('unique'))
                return res.status(409).json({ message: '订单已存在：唯一键冲突', order: newOrder });
            return res.status(201).json(newOrder);
        }
    }
    if (supabase_1.hasSupabase) {
        (0, supabase_1.supaUpsertConflict)('orders', newOrder, 'id')
            .then((row) => res.status(201).json(row))
            .catch((_err) => { pendingInsert.push(newOrder); startRetry(); return res.status(201).json(newOrder); });
        return;
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
    if (!prev && !supabase_1.hasSupabase)
        return res.status(404).json({ message: 'order not found' });
    const base = prev || {};
    let nights = o.nights;
    const checkin = o.checkin || base.checkin;
    const checkout = o.checkout || base.checkout;
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
    const price = o.price != null ? o.price : (base.price || 0);
    const cleaning = o.cleaning_fee != null ? o.cleaning_fee : (base.cleaning_fee || 0);
    const net = o.net_income != null ? o.net_income : (price - cleaning);
    const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
    const updated = { ...base, ...o, id, nights, net_income: net, avg_nightly_price: avg };
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
            const row = await (0, dbAdapter_1.pgUpdate)('orders', id, updated);
            return res.json(row || updated);
        }
        catch (_d) {
            return res.json(updated);
        }
    }
    if (supabase_1.hasSupabase) {
        try {
            const row = await (0, supabase_1.supaUpdate)('orders', id, updated);
            return res.json(row || updated);
        }
        catch (_e) {
            pendingUpdate.push({ id, payload: updated });
            startRetry();
            return res.json(updated);
        }
    }
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
    if (supabase_1.hasSupabase) {
        (0, supabase_1.supaUpdate)('orders', id, updated).catch(() => { pendingUpdate.push({ id, payload: updated }); startRetry(); });
    }
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
        catch (_a) {
            return res.json({ ok: true, id });
        }
    }
    if (supabase_1.hasSupabase) {
        try {
            const row = await (0, supabase_1.supaDelete)('orders', id);
            removed = removed || row;
            return res.json({ ok: true, id });
        }
        catch (_b) {
            pendingDelete.push(id);
            startRetry();
            return res.json({ ok: true, id });
        }
    }
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
    else if (supabase_1.hasSupabase) {
        await (0, supabase_1.supaDelete)('orders', id).catch(() => { pendingDelete.push(id); startRetry(); });
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
    var _a;
    function toNumber(v) {
        if (v == null || v === '')
            return undefined;
        const n = Number(v);
        return isNaN(n) ? undefined : n;
    }
    function parseCsv(s) {
        const lines = (s || '').split(/\r?\n/).filter(l => l.trim().length);
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
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const rowsInput = Array.isArray(req.body) ? req.body : parseCsv(rawBody);
    const results = [];
    let inserted = 0;
    let skipped = 0;
    for (const r of rowsInput) {
        try {
            const source = String(r.source || 'offline');
            const property_code = r.property_code || r.propertyCode || undefined;
            const property_id = r.property_id || r.propertyId || (property_code ? ((_a = store_1.db.properties.find(p => (p.code || '') === property_code)) === null || _a === void 0 ? void 0 : _a.id) : undefined);
            const guest_name = r.guest_name || r.guest || undefined;
            const checkin = r.checkin || r.check_in || r.start_date || undefined;
            const checkout = r.checkout || r.check_out || r.end_date || undefined;
            const price = toNumber(r.price);
            const cleaning_fee = toNumber(r.cleaning_fee);
            const currency = r.currency || 'AUD';
            const status = r.status || 'confirmed';
            const parsed = createOrderSchema.safeParse({ source, property_id, property_code, guest_name, checkin, checkout, price, cleaning_fee, currency, status });
            if (!parsed.success) {
                results.push({ ok: false, error: 'invalid row' });
                skipped++;
                continue;
            }
            const o = parsed.data;
            const key = o.idempotency_key || `${o.property_id || ''}-${o.checkin || ''}-${o.checkout || ''}`;
            const exists = store_1.db.orders.find((x) => x.idempotency_key === key);
            if (exists) {
                results.push({ ok: false, error: 'duplicate' });
                skipped++;
                continue;
            }
            const { v4: uuid } = require('uuid');
            let nights = o.nights;
            if (!nights && o.checkin && o.checkout) {
                try {
                    const ci = new Date(o.checkin);
                    const co = new Date(o.checkout);
                    const ms = co.getTime() - ci.getTime();
                    nights = ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
                }
                catch (_b) {
                    nights = 0;
                }
            }
            const cleaning = o.cleaning_fee || 0;
            const total = o.price || 0;
            const net = o.net_income != null ? o.net_income : (total - cleaning);
            const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
            const newOrder = { id: uuid(), ...o, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key };
            const conflict = await hasOrderOverlap(newOrder.property_id, newOrder.checkin, newOrder.checkout);
            if (conflict) {
                results.push({ ok: false, error: 'overlap' });
                skipped++;
                continue;
            }
            store_1.db.orders.push(newOrder);
            if (newOrder.checkout) {
                const date = newOrder.checkout;
                const hasTask = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id);
                if (!hasTask) {
                    const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' };
                    store_1.db.cleaningTasks.push(task);
                }
            }
            if (dbAdapter_1.hasPg) {
                try {
                    await (0, dbAdapter_1.pgInsert)('orders', newOrder);
                }
                catch (_c) { }
            }
            else if (supabase_1.hasSupabase) {
                try {
                    await (0, supabase_1.supaUpsertConflict)('orders', newOrder, 'id');
                }
                catch (_d) {
                    pendingInsert.push(newOrder);
                    startRetry();
                }
            }
            inserted++;
            results.push({ ok: true, id: newOrder.id });
        }
        catch (e) {
            results.push({ ok: false, error: (e === null || e === void 0 ? void 0 : e.message) || 'error' });
            skipped++;
        }
    }
    res.json({ inserted, skipped, results });
});
