"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const supabase_1 = require("../supabase");
const dbAdapter_1 = require("../dbAdapter");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const zod_1 = require("zod");
const auth_1 = require("../auth");
exports.router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ dest: path_1.default.join(process.cwd(), 'uploads') });
exports.router.get('/', async (_req, res) => {
    try {
        if (supabase_1.hasSupabase) {
            const rows = (await (0, supabase_1.supaSelect)('finance_transactions')) || [];
            return res.json(rows);
        }
        if (dbAdapter_1.hasPg) {
            const rows = (await (0, dbAdapter_1.pgSelect)('finance_transactions')) || [];
            return res.json(rows);
        }
        return res.json(store_1.db.financeTransactions);
    }
    catch (_a) {
        return res.json(store_1.db.financeTransactions);
    }
});
const txSchema = zod_1.z.object({ kind: zod_1.z.enum(['income', 'expense']), amount: zod_1.z.coerce.number().min(0), currency: zod_1.z.string(), ref_type: zod_1.z.string().optional(), ref_id: zod_1.z.string().optional(), occurred_at: zod_1.z.string().optional(), note: zod_1.z.string().optional(), category: zod_1.z.string().optional(), property_id: zod_1.z.string().optional(), invoice_url: zod_1.z.string().optional(), category_detail: zod_1.z.string().optional() });
exports.router.post('/', (0, auth_1.requirePerm)('finance.tx.write'), async (req, res) => {
    const parsed = txSchema.safeParse(req.body);
    if (!parsed.success) {
        const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        return res.status(400).json({ message: msg || 'invalid payload' });
    }
    const { v4: uuid } = require('uuid');
    const tx = { id: uuid(), occurred_at: parsed.data.occurred_at || new Date().toISOString(), ...parsed.data };
    store_1.db.financeTransactions.push(tx);
    (0, store_1.addAudit)('FinanceTransaction', tx.id, 'create', null, tx);
    if (supabase_1.hasSupabase) {
        try {
            const row = await (0, supabase_1.supaInsert)('finance_transactions', tx);
            return res.status(201).json(row || tx);
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'supabase insert failed' });
        }
    }
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgInsert)('finance_transactions', tx);
            return res.status(201).json(row || tx);
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'pg insert failed' });
        }
    }
    return res.status(201).json(tx);
});
exports.router.post('/invoices', (0, auth_1.requirePerm)('finance.tx.write'), upload.single('file'), (req, res) => {
    if (!req.file)
        return res.status(400).json({ message: 'missing file' });
    const url = `/uploads/${req.file.filename}`;
    res.status(201).json({ url });
});
exports.router.post('/send-monthly', (0, auth_1.requirePerm)('finance.payout'), (req, res) => {
    const { landlord_id, month } = req.body || {};
    if (!landlord_id || !month)
        return res.status(400).json({ message: 'missing landlord_id or month' });
    res.json({ ok: true });
});
exports.router.post('/send-annual', (0, auth_1.requirePerm)('finance.payout'), (req, res) => {
    const { landlord_id, year } = req.body || {};
    if (!landlord_id || !year)
        return res.status(400).json({ message: 'missing landlord_id or year' });
    res.json({ ok: true });
});
exports.router.get('/payouts', async (_req, res) => {
    try {
        if (supabase_1.hasSupabase) {
            const rows = (await (0, supabase_1.supaSelect)('payouts')) || [];
            return res.json(rows);
        }
        if (dbAdapter_1.hasPg) {
            const rows = (await (0, dbAdapter_1.pgSelect)('payouts')) || [];
            return res.json(rows);
        }
        return res.json(store_1.db.payouts);
    }
    catch (_a) {
        return res.json(store_1.db.payouts);
    }
});
const payoutSchema = zod_1.z.object({ landlord_id: zod_1.z.string(), period_from: zod_1.z.string(), period_to: zod_1.z.string(), amount: zod_1.z.number().min(0), invoice_no: zod_1.z.string().optional() });
exports.router.post('/payouts', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    const parsed = payoutSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const p = { id: uuid(), status: 'pending', ...parsed.data };
    store_1.db.payouts.push(p);
    (0, store_1.addAudit)('Payout', p.id, 'create', null, p);
    const tx = { id: uuid(), kind: 'expense', amount: p.amount, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'payout', ref_id: p.id, note: `landlord payout ${p.landlord_id}` };
    store_1.db.financeTransactions.push(tx);
    (0, store_1.addAudit)('FinanceTransaction', tx.id, 'create', null, tx);
    if (supabase_1.hasSupabase) {
        try {
            await (0, supabase_1.supaInsert)('payouts', p);
            await (0, supabase_1.supaInsert)('finance_transactions', tx);
            return res.status(201).json(p);
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'supabase insert failed' });
        }
    }
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgInsert)('payouts', p);
            await (0, dbAdapter_1.pgInsert)('finance_transactions', tx);
            return res.status(201).json(p);
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'pg insert failed' });
        }
    }
    return res.status(201).json(p);
});
exports.router.patch('/payouts/:id', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    const p = store_1.db.payouts.find(x => x.id === req.params.id);
    if (!p)
        return res.status(404).json({ message: 'not found' });
    const before = { ...p };
    Object.assign(p, req.body);
    (0, store_1.addAudit)('Payout', p.id, 'update', before, p);
    if (supabase_1.hasSupabase) {
        try {
            const row = await (0, supabase_1.supaUpdate)('payouts', p.id, p);
            return res.json(row || p);
        }
        catch (_a) { }
    }
    else if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('payouts', p.id, p);
            return res.json(row || p);
        }
        catch (_b) { }
    }
    return res.json(p);
});
exports.router.get('/payouts/:id', async (req, res) => {
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('payouts', '*', { id });
            if (rows && rows[0])
                return res.json(rows[0]);
        }
        else if (supabase_1.hasSupabase) {
            const rows = await (0, supabase_1.supaSelect)('payouts', '*', { id });
            if (rows && rows[0])
                return res.json(rows[0]);
        }
    }
    catch (_a) { }
    const local = store_1.db.payouts.find(x => x.id === id);
    if (!local)
        return res.status(404).json({ message: 'not found' });
    return res.json(local);
});
exports.router.delete('/payouts/:id', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.payouts.findIndex(x => x.id === id);
    if (idx !== -1)
        store_1.db.payouts.splice(idx, 1);
    store_1.db.financeTransactions = store_1.db.financeTransactions.filter(t => !(t.ref_type === 'payout' && t.ref_id === id));
    if (supabase_1.hasSupabase) {
        try {
            await (0, supabase_1.supaDelete)('payouts', id);
            const linked = await (0, supabase_1.supaSelect)('finance_transactions', '*', { ref_type: 'payout', ref_id: id });
            for (const r of (linked || [])) {
                if (r === null || r === void 0 ? void 0 : r.id)
                    await (0, supabase_1.supaDelete)('finance_transactions', r.id);
            }
            return res.json({ ok: true });
        }
        catch (_a) { }
    }
    else if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('payouts', id);
            const linked = await (0, dbAdapter_1.pgSelect)('finance_transactions', '*', { ref_type: 'payout', ref_id: id });
            for (const r of (linked || [])) {
                if (r === null || r === void 0 ? void 0 : r.id)
                    await (0, dbAdapter_1.pgDelete)('finance_transactions', r.id);
            }
            return res.json({ ok: true });
        }
        catch (_b) { }
    }
    return res.json({ ok: true });
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('finance.tx.write'), async (req, res) => {
    const { id } = req.params;
    const parsed = txSchema.partial().safeParse(req.body);
    if (!parsed.success) {
        const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        return res.status(400).json({ message: msg || 'invalid payload' });
    }
    const idx = store_1.db.financeTransactions.findIndex(x => x.id === id);
    const prev = idx !== -1 ? store_1.db.financeTransactions[idx] : undefined;
    const updated = { ...(prev || {}), ...parsed.data, id };
    if (idx !== -1)
        store_1.db.financeTransactions[idx] = updated;
    else
        store_1.db.financeTransactions.push(updated);
    if (supabase_1.hasSupabase) {
        try {
            const row = await (0, supabase_1.supaUpdate)('finance_transactions', id, updated);
            return res.json(row || updated);
        }
        catch (_a) {
            try {
                const { supaUpsert } = require('../supabase');
                const row2 = await supaUpsert('finance_transactions', updated);
                return res.json(row2 || updated);
            }
            catch (_b) { }
        }
    }
    else if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('finance_transactions', id, updated);
            return res.json(row || updated);
        }
        catch (_c) {
            try {
                await (0, dbAdapter_1.pgInsert)('finance_transactions', updated);
                return res.json(updated);
            }
            catch (_d) { }
        }
    }
    return res.json(updated);
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('finance.tx.write'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.financeTransactions.findIndex(x => x.id === id);
    if (idx !== -1)
        store_1.db.financeTransactions.splice(idx, 1);
    if (supabase_1.hasSupabase) {
        try {
            await (0, supabase_1.supaDelete)('finance_transactions', id);
            return res.json({ ok: true });
        }
        catch (_a) { }
    }
    else if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('finance_transactions', id);
            return res.json({ ok: true });
        }
        catch (_b) { }
    }
    return res.json({ ok: true });
});
