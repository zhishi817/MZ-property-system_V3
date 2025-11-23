"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
exports.router = (0, express_1.Router)();
exports.router.get('/', (req, res) => {
    res.json(store_1.db.financeTransactions);
});
const txSchema = zod_1.z.object({ kind: zod_1.z.enum(['income', 'expense']), amount: zod_1.z.number().min(0), currency: zod_1.z.string(), ref_type: zod_1.z.string().optional(), ref_id: zod_1.z.string().optional(), occurred_at: zod_1.z.string().optional(), note: zod_1.z.string().optional() });
exports.router.post('/', (0, auth_1.requirePerm)('finance.payout'), (req, res) => {
    const parsed = txSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const tx = { id: uuid(), occurred_at: parsed.data.occurred_at || new Date().toISOString(), ...parsed.data };
    store_1.db.financeTransactions.push(tx);
    (0, store_1.addAudit)('FinanceTransaction', tx.id, 'create', null, tx);
    res.status(201).json(tx);
});
exports.router.get('/payouts', (req, res) => {
    res.json(store_1.db.payouts);
});
const payoutSchema = zod_1.z.object({ landlord_id: zod_1.z.string(), period_from: zod_1.z.string(), period_to: zod_1.z.string(), amount: zod_1.z.number().min(0), invoice_no: zod_1.z.string().optional() });
exports.router.post('/payouts', (0, auth_1.requirePerm)('finance.payout'), (req, res) => {
    const parsed = payoutSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const p = { id: uuid(), status: 'pending', ...parsed.data };
    store_1.db.payouts.push(p);
    (0, store_1.addAudit)('Payout', p.id, 'create', null, p);
    res.status(201).json(p);
});
exports.router.patch('/payouts/:id', (0, auth_1.requirePerm)('finance.payout'), (req, res) => {
    const p = store_1.db.payouts.find(x => x.id === req.params.id);
    if (!p)
        return res.status(404).json({ message: 'not found' });
    const before = { ...p };
    Object.assign(p, req.body);
    (0, store_1.addAudit)('Payout', p.id, 'update', before, p);
    res.json(p);
});
