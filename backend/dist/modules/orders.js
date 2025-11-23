"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const supabase_1 = require("../supabase");
exports.router = (0, express_1.Router)();
exports.router.get('/', (req, res) => {
    if (!supabase_1.hasSupabase)
        return res.json(store_1.db.orders);
    (0, supabase_1.supaSelect)('orders')
        .then((data) => res.json(data))
        .catch((err) => res.status(500).json({ message: err.message }));
});
const createOrderSchema = zod_1.z.object({
    source: zod_1.z.string(),
    external_id: zod_1.z.string().optional(),
    property_id: zod_1.z.string().optional(),
    guest_name: zod_1.z.string().optional(),
    checkin: zod_1.z.string().optional(),
    checkout: zod_1.z.string().optional(),
    price: zod_1.z.number().optional(),
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
    const newOrder = { id: uuid(), ...o, idempotency_key: key, status: 'confirmed' };
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
    (0, supabase_1.supaInsert)('orders', newOrder)
        .then((row) => res.status(201).json(row))
        .catch((err) => res.status(500).json({ message: err.message }));
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
