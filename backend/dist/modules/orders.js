"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const supabase_1 = require("../supabase");
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
                catch {
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
                catch {
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
                catch {
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
        if (!supabase_1.hasSupabase)
            return res.json(store_1.db.orders);
        const remote = (await (0, supabase_1.supaSelect)('orders')) || [];
        const local = store_1.db.orders;
        const merged = [...remote, ...local.filter((l) => !remote.some((r) => r.id === l.id))];
        return res.json(merged);
    }
    catch {
        return res.json(store_1.db.orders);
    }
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
    checkin: zod_1.z.string().optional(),
    checkout: zod_1.z.string().optional(),
    price: zod_1.z.number().optional(),
    cleaning_fee: zod_1.z.number().optional(),
    net_income: zod_1.z.number().optional(),
    avg_nightly_price: zod_1.z.number().optional(),
    nights: zod_1.z.number().optional(),
    currency: zod_1.z.string().optional(),
    idempotency_key: zod_1.z.string().optional(),
});
exports.router.post('/sync', (0, auth_1.requirePerm)('order.sync'), (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
    const key = o.idempotency_key || `${o.external_id || ''}-${o.checkout || ''}`;
    const exists = store_1.db.orders.find((x) => x.idempotency_key === key);
    if (exists)
        return res.status(200).json(exists);
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
        catch {
            nights = 0;
        }
    }
    const cleaning = o.cleaning_fee || 0;
    const price = o.price || 0;
    const net = o.net_income != null ? o.net_income : (price - cleaning);
    const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
    const newOrder = { id: uuid(), ...o, nights, net_income: net, avg_nightly_price: avg, idempotency_key: key, status: 'confirmed' };
    store_1.db.orders.push(newOrder);
    if (newOrder.checkout) {
        const date = newOrder.checkout;
        const hasTask = store_1.db.cleaningTasks.find((t) => t.date === date && t.property_id === newOrder.property_id);
        if (!hasTask) {
            const task = { id: uuid(), property_id: newOrder.property_id, date, status: 'pending' };
            store_1.db.cleaningTasks.push(task);
        }
    }
    if (!supabase_1.hasSupabase)
        return res.status(201).json(newOrder);
    (0, supabase_1.supaUpsertConflict)('orders', newOrder, 'id')
        .then((row) => res.status(201).json(row))
        .catch((_err) => { pendingInsert.push(newOrder); startRetry(); return res.status(201).json(newOrder); });
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('order.manage'), (req, res) => {
    const { id } = req.params;
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const o = parsed.data;
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
        catch {
            nights = 0;
        }
    }
    const price = o.price != null ? o.price : (prev.price || 0);
    const cleaning = o.cleaning_fee != null ? o.cleaning_fee : (prev.cleaning_fee || 0);
    const net = o.net_income != null ? o.net_income : (price - cleaning);
    const avg = o.avg_nightly_price != null ? o.avg_nightly_price : (nights && nights > 0 ? Number((net / nights).toFixed(2)) : 0);
    const updated = { ...prev, ...o, nights, net_income: net, avg_nightly_price: avg };
    store_1.db.orders[idx] = updated;
    // try remote update; if fails, still respond with updated local record
    if (supabase_1.hasSupabase) {
        (0, supabase_1.supaUpdate)('orders', id, updated).catch(() => { pendingUpdate.push({ id, payload: updated }); startRetry(); });
    }
    return res.json(updated);
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('order.manage'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.orders.findIndex((x) => x.id === id);
    if (idx === -1)
        return res.status(404).json({ message: 'order not found' });
    const removed = store_1.db.orders[idx];
    store_1.db.orders.splice(idx, 1);
    if (supabase_1.hasSupabase)
        await (0, supabase_1.supaDelete)('orders', id).catch(() => { pendingDelete.push(id); startRetry(); });
    return res.json({ ok: true, id: removed.id });
});
exports.router.post('/:id/generate-cleaning', (0, auth_1.requirePerm)('order.manage'), (req, res) => {
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
