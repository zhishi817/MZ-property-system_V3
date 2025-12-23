"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const dbAdapter_1 = require("../dbAdapter");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const r2_1 = require("../r2");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const pdf_lib_1 = require("pdf-lib");
exports.router = (0, express_1.Router)();
const upload = r2_1.hasR2 ? (0, multer_1.default)({ storage: multer_1.default.memoryStorage() }) : (0, multer_1.default)({ dest: path_1.default.join(process.cwd(), 'uploads') });
exports.router.get('/', async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const raw = await (0, dbAdapter_1.pgSelect)('finance_transactions');
            const rows = Array.isArray(raw) ? raw : [];
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
exports.router.post('/invoices', (0, auth_1.requireAnyPerm)(['finance.tx.write', 'property_expenses.write', 'company_expenses.write']), upload.single('file'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ message: 'missing file' });
    try {
        if (r2_1.hasR2 && req.file && req.file.buffer) {
            const ext = path_1.default.extname(req.file.originalname) || '';
            const key = `invoices/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            const url = await (0, r2_1.r2Upload)(key, req.file.mimetype || 'application/octet-stream', req.file.buffer);
            return res.status(201).json({ url });
        }
        const url = `/uploads/${req.file.filename}`;
        return res.status(201).json({ url });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'upload failed' });
    }
});
// Merge monthly statement PDF with multiple invoice PDFs and return a single PDF
exports.router.post('/merge-pdf', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    try {
        const { statement_pdf_base64, statement_pdf_url, invoice_urls } = req.body || {};
        if (!statement_pdf_base64 && !statement_pdf_url)
            return res.status(400).json({ message: 'missing statement pdf' });
        const urls = Array.isArray(invoice_urls) ? invoice_urls.filter((u) => typeof u === 'string') : [];
        async function fetchBytes(u) {
            const r = await fetch(u);
            if (!r.ok)
                throw new Error(`fetch failed: ${r.status}`);
            const ab = await r.arrayBuffer();
            return new Uint8Array(ab);
        }
        let merged = await pdf_lib_1.PDFDocument.create();
        // append statement
        if (statement_pdf_base64 && typeof statement_pdf_base64 === 'string') {
            const b64 = statement_pdf_base64.replace(/^data:application\/pdf;base64,/, '');
            const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
            const src = await pdf_lib_1.PDFDocument.load(bytes);
            const copied = await merged.copyPages(src, src.getPageIndices());
            copied.forEach(p => merged.addPage(p));
        }
        else if (statement_pdf_url && typeof statement_pdf_url === 'string') {
            const bytes = await fetchBytes(statement_pdf_url);
            const src = await pdf_lib_1.PDFDocument.load(bytes);
            const copied = await merged.copyPages(src, src.getPageIndices());
            copied.forEach(p => merged.addPage(p));
        }
        for (const u of urls) {
            try {
                if (/\.pdf($|\?)/i.test(u || '')) {
                    const bytes = await fetchBytes(u);
                    const src = await pdf_lib_1.PDFDocument.load(bytes);
                    const copied = await merged.copyPages(src, src.getPageIndices());
                    copied.forEach(p => merged.addPage(p));
                }
                else if (/\.(png|jpg|jpeg)($|\?)/i.test(u || '')) {
                    const bytes = await fetchBytes(u);
                    const img = /\.png($|\?)/i.test(u || '') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
                    const page = merged.addPage([595, 842]);
                    const maxW = 595 - 60;
                    const maxH = 842 - 60;
                    const scale = Math.min(maxW / img.width, maxH / img.height);
                    const w = img.width * scale;
                    const h = img.height * scale;
                    const x = (595 - w) / 2;
                    const y = (842 - h) / 2;
                    page.drawImage(img, { x, y, width: w, height: h });
                }
            }
            catch (_a) { }
        }
        const out = await merged.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="statement-merged.pdf"');
        return res.status(200).send(Buffer.from(out));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'merge failed' });
    }
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
        if (dbAdapter_1.hasPg) {
            const raw = await (0, dbAdapter_1.pgSelect)('payouts');
            const rows = Array.isArray(raw) ? raw : [];
            return res.json(rows);
        }
        return res.json(store_1.db.payouts);
    }
    catch (_a) {
        return res.json(store_1.db.payouts);
    }
});
// Company payouts
exports.router.get('/company-payouts', async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const raw = await (0, dbAdapter_1.pgSelect)('company_payouts');
            const rows = Array.isArray(raw) ? raw : [];
            return res.json(rows);
        }
        return res.json(store_1.db.companyPayouts);
    }
    catch (_a) {
        return res.json(store_1.db.companyPayouts);
    }
});
const companyPayoutSchema = zod_1.z.object({ period_from: zod_1.z.string(), period_to: zod_1.z.string(), amount: zod_1.z.number().min(0), invoice_no: zod_1.z.string().optional(), note: zod_1.z.string().optional() });
exports.router.post('/company-payouts', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    const parsed = companyPayoutSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const p = { id: uuid(), status: 'pending', ...parsed.data };
    store_1.db.companyPayouts.push(p);
    (0, store_1.addAudit)('CompanyPayout', p.id, 'create', null, p);
    const tx = { id: uuid(), kind: 'expense', amount: p.amount, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'company_payout', ref_id: p.id, note: p.note || 'company payout', invoice_url: undefined };
    store_1.db.financeTransactions.push(tx);
    (0, store_1.addAudit)('FinanceTransaction', tx.id, 'create', null, tx);
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgInsert)('company_payouts', p);
            await (0, dbAdapter_1.pgInsert)('finance_transactions', tx);
            return res.status(201).json(p);
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'pg insert failed' });
        }
    }
    return res.status(201).json(p);
});
exports.router.patch('/company-payouts/:id', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.companyPayouts.findIndex(x => x.id === id);
    const prev = idx !== -1 ? store_1.db.companyPayouts[idx] : undefined;
    if (!prev && !dbAdapter_1.hasPg)
        return res.status(404).json({ message: 'not found' });
    const body = req.body;
    const updated = { ...(prev || {}), ...body, id };
    if (idx !== -1)
        store_1.db.companyPayouts[idx] = updated;
    (0, store_1.addAudit)('CompanyPayout', id, 'update', prev, updated);
    // sync linked transaction amount/note if provided
    const linkedIdx = store_1.db.financeTransactions.findIndex(t => t.ref_type === 'company_payout' && t.ref_id === id);
    if (linkedIdx !== -1) {
        if (body.amount != null)
            store_1.db.financeTransactions[linkedIdx].amount = Number(body.amount);
        if (body.note != null)
            store_1.db.financeTransactions[linkedIdx].note = body.note;
    }
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('company_payouts', id, updated);
            return res.json(row || updated);
        }
        catch (_a) {
            try {
                const row2 = await (0, dbAdapter_1.pgInsert)('company_payouts', updated);
                return res.json(row2 || updated);
            }
            catch (_b) { }
        }
    }
    return res.json(updated);
});
exports.router.delete('/company-payouts/:id', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.companyPayouts.findIndex(x => x.id === id);
    if (idx !== -1)
        store_1.db.companyPayouts.splice(idx, 1);
    store_1.db.financeTransactions = store_1.db.financeTransactions.filter(t => !(t.ref_type === 'company_payout' && t.ref_id === id));
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('company_payouts', id);
            const linked = await (0, dbAdapter_1.pgSelect)('finance_transactions', '*', { ref_type: 'company_payout', ref_id: id });
            for (const r of (linked || [])) {
                if (r === null || r === void 0 ? void 0 : r.id)
                    await (0, dbAdapter_1.pgDelete)('finance_transactions', r.id);
            }
            return res.json({ ok: true });
        }
        catch (_a) { }
    }
    return res.json({ ok: true });
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
    // Supabase branch removed
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
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('payouts', p.id, p);
            return res.json(row || p);
        }
        catch (_a) { }
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
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('payouts', id);
            const linked = await (0, dbAdapter_1.pgSelect)('finance_transactions', '*', { ref_type: 'payout', ref_id: id });
            for (const r of (linked || [])) {
                if (r === null || r === void 0 ? void 0 : r.id)
                    await (0, dbAdapter_1.pgDelete)('finance_transactions', r.id);
            }
            return res.json({ ok: true });
        }
        catch (_a) { }
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
    if (dbAdapter_1.hasPg) {
        try {
            const row = await (0, dbAdapter_1.pgUpdate)('finance_transactions', id, updated);
            return res.json(row || updated);
        }
        catch (_a) {
            try {
                await (0, dbAdapter_1.pgInsert)('finance_transactions', updated);
                return res.json(updated);
            }
            catch (_b) { }
        }
    }
    return res.json(updated);
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('finance.tx.write'), async (req, res) => {
    const { id } = req.params;
    const idx = store_1.db.financeTransactions.findIndex(x => x.id === id);
    if (idx !== -1)
        store_1.db.financeTransactions.splice(idx, 1);
    if (dbAdapter_1.hasPg) {
        try {
            await (0, dbAdapter_1.pgDelete)('finance_transactions', id);
            return res.json({ ok: true });
        }
        catch (_a) { }
    }
    return res.json({ ok: true });
});
