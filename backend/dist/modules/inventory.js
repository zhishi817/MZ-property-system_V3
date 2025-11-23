"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
exports.router = (0, express_1.Router)();
exports.router.get('/items', (req, res) => {
    res.json(store_1.db.inventoryItems);
});
exports.router.get('/warnings', (req, res) => {
    res.json(store_1.db.inventoryItems.filter(i => i.quantity < i.threshold));
});
const itemSchema = zod_1.z.object({ name: zod_1.z.string(), sku: zod_1.z.string(), unit: zod_1.z.string(), threshold: zod_1.z.number().int().min(0), bin_location: zod_1.z.string().optional(), quantity: zod_1.z.number().int().min(0) });
exports.router.post('/items', (0, auth_1.requirePerm)('inventory.move'), (req, res) => {
    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const item = { id: uuid(), ...parsed.data };
    store_1.db.inventoryItems.push(item);
    (0, store_1.addAudit)('InventoryItem', item.id, 'create', null, item);
    res.status(201).json(item);
});
const moveSchema = zod_1.z.object({ item_id: zod_1.z.string(), type: zod_1.z.enum(['in', 'out']), quantity: zod_1.z.number().int().min(1) });
exports.router.post('/movements', (0, auth_1.requirePerm)('inventory.move'), (req, res) => {
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const item = store_1.db.inventoryItems.find(i => i.id === parsed.data.item_id);
    if (!item)
        return res.status(404).json({ message: 'item not found' });
    const before = { ...item };
    if (parsed.data.type === 'in')
        item.quantity += parsed.data.quantity;
    else {
        if (item.quantity < parsed.data.quantity)
            return res.status(409).json({ message: 'insufficient stock' });
        item.quantity -= parsed.data.quantity;
    }
    const { v4: uuid } = require('uuid');
    store_1.db.stockMovements.push({ id: uuid(), item_id: item.id, type: parsed.data.type, quantity: parsed.data.quantity, timestamp: new Date().toISOString() });
    (0, store_1.addAudit)('InventoryItem', item.id, 'movement', before, item);
    res.json(item);
});
