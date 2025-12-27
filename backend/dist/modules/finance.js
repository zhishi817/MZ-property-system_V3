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
const fs_1 = __importDefault(require("fs"));
const zod_1 = require("zod");
const auth_1 = require("../auth");
const pdf_lib_1 = require("pdf-lib");
exports.router = (0, express_1.Router)();
const upload = r2_1.hasR2 ? (0, multer_1.default)({ storage: multer_1.default.memoryStorage() }) : (0, multer_1.default)({ dest: path_1.default.join(process.cwd(), 'uploads') });
const memUpload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
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
// Expense-specific invoice resource
exports.router.get('/expense-invoices/:expenseId', (0, auth_1.requireAnyPerm)(['property_expenses.view', 'finance.tx.write', 'property_expenses.write']), async (req, res) => {
    const { expenseId } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            try {
                const rows = await (0, dbAdapter_1.pgSelect)('expense_invoices', '*', { expense_id: expenseId });
                return res.json(Array.isArray(rows) ? rows : []);
            }
            catch (e) {
                const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                const { pgPool } = require('../dbAdapter');
                if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
                    await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`);
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);');
                    const rows2 = await (0, dbAdapter_1.pgSelect)('expense_invoices', '*', { expense_id: expenseId });
                    return res.json(Array.isArray(rows2) ? rows2 : []);
                }
                throw e;
            }
        }
        const rows = store_1.db.expenseInvoices.filter((x) => String(x.expense_id) === String(expenseId));
        return res.json(rows);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'list failed' });
    }
});
exports.router.post('/expense-invoices/:expenseId/upload', (0, auth_1.requireAnyPerm)(['property_expenses.write', 'finance.tx.write']), memUpload.single('file'), async (req, res) => {
    const { expenseId } = req.params;
    if (!req.file)
        return res.status(400).json({ message: 'missing file' });
    try {
        const user = req.user || {};
        const { v4: uuid } = require('uuid');
        const ext = path_1.default.extname(req.file.originalname) || '';
        let url = '';
        if (r2_1.hasR2 && req.file.buffer) {
            const key = `expenses/${expenseId}/${uuid()}${ext}`;
            url = await (0, r2_1.r2Upload)(key, req.file.mimetype || 'application/octet-stream', req.file.buffer);
        }
        else {
            const dir = path_1.default.join(process.cwd(), 'uploads', 'expenses', expenseId);
            await fs_1.default.promises.mkdir(dir, { recursive: true });
            const name = `${uuid()}${ext}`;
            const full = path_1.default.join(dir, name);
            await fs_1.default.promises.writeFile(full, req.file.buffer);
            url = `/uploads/expenses/${expenseId}/${name}`;
        }
        if (dbAdapter_1.hasPg) {
            try {
                const row = await (0, dbAdapter_1.pgInsert)('expense_invoices', {
                    id: uuid(),
                    expense_id: expenseId,
                    url,
                    file_name: req.file.originalname,
                    mime_type: req.file.mimetype,
                    file_size: req.file.size,
                    created_by: (user === null || user === void 0 ? void 0 : user.sub) || (user === null || user === void 0 ? void 0 : user.username) || null
                });
                return res.status(201).json(row || { url });
            }
            catch (e) {
                const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                const { pgPool } = require('../dbAdapter');
                if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
                    await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`);
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);');
                    const row2 = await (0, dbAdapter_1.pgInsert)('expense_invoices', {
                        id: uuid(), expense_id: expenseId, url,
                        file_name: req.file.originalname, mime_type: req.file.mimetype,
                        file_size: req.file.size, created_by: (user === null || user === void 0 ? void 0 : user.sub) || (user === null || user === void 0 ? void 0 : user.username) || null
                    });
                    return res.status(201).json(row2 || { url });
                }
                throw e;
            }
        }
        const id = uuid();
        store_1.db.expenseInvoices.push({ id, expense_id: expenseId, url, file_name: req.file.originalname, mime_type: req.file.mimetype, file_size: req.file.size, created_at: new Date().toISOString(), created_by: (user === null || user === void 0 ? void 0 : user.sub) || (user === null || user === void 0 ? void 0 : user.username) || undefined });
        return res.status(201).json({ id, url });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'upload failed' });
    }
});
exports.router.delete('/expense-invoices/:id', (0, auth_1.requireAnyPerm)(['property_expenses.write', 'finance.tx.write']), async (req, res) => {
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            try {
                await (0, dbAdapter_1.pgDelete)('expense_invoices', id);
                return res.json({ ok: true });
            }
            catch (e) {
                const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                const { pgPool } = require('../dbAdapter');
                if (pgPool && /relation\s+"?expense_invoices"?\s+does\s+not\s+exist/i.test(msg)) {
                    await pgPool.query(`CREATE TABLE IF NOT EXISTS expense_invoices (
            id text PRIMARY KEY,
            expense_id text REFERENCES property_expenses(id) ON DELETE CASCADE,
            url text NOT NULL,
            file_name text,
            mime_type text,
            file_size integer,
            created_at timestamptz DEFAULT now(),
            created_by text
          );`);
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_expense_invoices_expense ON expense_invoices(expense_id);');
                    await (0, dbAdapter_1.pgDelete)('expense_invoices', id);
                    return res.json({ ok: true });
                }
                throw e;
            }
        }
        const idx = store_1.db.expenseInvoices.findIndex((x) => x.id === id);
        if (idx !== -1)
            store_1.db.expenseInvoices.splice(idx, 1);
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'delete failed' });
    }
});
// Query invoices by property and occurred_at range via expense join
exports.router.get('/expense-invoices/search', (0, auth_1.requireAnyPerm)(['property_expenses.view', 'finance.tx.write', 'property_expenses.write']), async (req, res) => {
    const { property_id, from, to } = (req.query || {});
    if (!property_id || !from || !to)
        return res.status(400).json({ message: 'missing property_id/from/to' });
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            if (pgPool) {
                const sql = `SELECT i.* FROM expense_invoices i JOIN property_expenses e ON i.expense_id = e.id WHERE e.property_id = $1 AND e.occurred_at >= $2 AND e.occurred_at <= $3 ORDER BY i.created_at ASC`;
                const r = await pgPool.query(sql, [property_id, from, to]);
                return res.json(r.rows || []);
            }
        }
        const rows = store_1.db.expenseInvoices.filter((ii) => {
            var _a, _b;
            const exp = (_b = (_a = store_1.db.property_expenses) === null || _a === void 0 ? void 0 : _a.find) === null || _b === void 0 ? void 0 : _b.call(_a, (e) => String(e.id) === String(ii.expense_id));
            if (!exp)
                return false;
            const pidOk = String(exp.property_id || '') === String(property_id);
            const dt = exp.occurred_at ? new Date(exp.occurred_at) : null;
            const fromD = new Date(String(from));
            const toD = new Date(String(to));
            const inRange = dt ? (dt >= fromD && dt <= toD) : false;
            return pidOk && inRange;
        });
        return res.json(rows);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'search failed' });
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
// Property revenue aggregated by fixed expenses report_category and order income
exports.router.get('/property-revenue', async (req, res) => {
    var _a, _b;
    try {
        const { property_id, property_code, month } = (req.query || {});
        if (!month || (!(property_id) && !(property_code)))
            return res.status(400).json({ message: 'missing month or property' });
        const ym = String(month);
        const y = Number(ym.slice(0, 4));
        const m = Number(ym.slice(5, 7));
        if (!y || !m)
            return res.status(400).json({ message: 'invalid month format' });
        const start = new Date(Date.UTC(y, m - 1, 1));
        const end = new Date(Date.UTC(y, m, 0));
        let pid = String(property_id || '');
        let pcode = String(property_code || '');
        let label = '';
        if (dbAdapter_1.hasPg) {
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    if (!pid && pcode) {
                        const qr = await pgPool.query('SELECT id,code,address FROM properties WHERE lower(code) = lower($1) LIMIT 1', [pcode]);
                        if (qr.rows && qr.rows[0])
                            pid = qr.rows[0].id, label = qr.rows[0].code || qr.rows[0].address || '';
                    }
                    else if (pid) {
                        const qr = await pgPool.query('SELECT id,code,address FROM properties WHERE id = $1 LIMIT 1', [pid]);
                        if (qr.rows && qr.rows[0])
                            label = qr.rows[0].code || qr.rows[0].address || '';
                    }
                }
            }
            catch (_c) { }
        }
        const cols = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0 };
        let rentIncome = 0;
        try {
            if (dbAdapter_1.hasPg) {
                const orders = await (0, dbAdapter_1.pgSelect)('orders', '*', { property_id: pid });
                const ords = Array.isArray(orders) ? orders : [];
                function toDate(s) { try {
                    return s ? new Date(String(s)) : null;
                }
                catch (_a) {
                    return null;
                } }
                function overlapNights(ci, co) {
                    const a = toDate(ci);
                    const b = toDate(co);
                    if (!a || !b)
                        return 0;
                    const A = a > start ? a : start;
                    const B = b < end ? b : end;
                    const ms = B.getTime() - A.getTime();
                    return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0;
                }
                for (const o of ords) {
                    const ov = overlapNights(o.checkin, o.checkout);
                    const nights = Number(o.nights || 0) || 0;
                    const visNet = Number((_b = (_a = o.visible_net_income) !== null && _a !== void 0 ? _a : o.net_income) !== null && _b !== void 0 ? _b : 0);
                    if (ov > 0 && nights > 0)
                        rentIncome += (visNet * ov) / nights;
                }
                const pe = await (0, dbAdapter_1.pgSelect)('property_expenses', '*', { property_id: pid, month_key: ym });
                const peRows = Array.isArray(pe) ? pe : [];
                const rp = await (0, dbAdapter_1.pgSelect)('recurring_payments', '*');
                const rpRows = Array.isArray(rp) ? rp : [];
                const map = Object.fromEntries(rpRows.map(r => [String(r.id), String(r.report_category || 'other')]));
                function toReportCat(raw, detail) {
                    const v = String(raw || '').toLowerCase();
                    const d = String(detail || '').toLowerCase();
                    const s = v + ' ' + d;
                    if (s.includes('carpark') || s.includes('车位'))
                        return 'parking_fee';
                    if (s.includes('owners') || s.includes('body') || s.includes('物业'))
                        return 'body_corp';
                    if (s.includes('internet') || s.includes('nbn') || s.includes('网'))
                        return 'internet';
                    if (s.includes('electric'))
                        return 'electricity';
                    if (s.includes('water') && !s.includes('hot'))
                        return 'water';
                    if (s.includes('gas') || s.includes('hot'))
                        return 'gas';
                    if (s.includes('consumable') || s.includes('消耗'))
                        return 'consumables';
                    if (s.includes('council') || s.includes('市政'))
                        return 'council';
                    return 'other';
                }
                for (const e of peRows) {
                    const fid = String(e.fixed_expense_id || '');
                    const amt = Number(e.amount || 0);
                    const cat = fid ? (map[fid] || 'other') : toReportCat(String(e.category || ''), String(e.category_detail || ''));
                    if (cat in cols)
                        cols[cat] += amt;
                    else
                        cols.other += amt;
                }
            }
        }
        catch (_d) { }
        const totalExpense = Object.values(cols).reduce((s, v) => s + Number(v || 0), 0);
        const payload = {
            property_code: label || pcode || pid,
            month: ym,
            parking_fee: -Number(cols.parking_fee || 0),
            electricity: -Number(cols.electricity || 0),
            water: -Number(cols.water || 0),
            gas: -Number(cols.gas || 0),
            internet: -Number(cols.internet || 0),
            consumables: -Number(cols.consumables || 0),
            body_corp: -Number(cols.body_corp || 0),
            council: -Number(cols.council || 0),
            other: -Number(cols.other || 0),
            total_expense: -Number(totalExpense || 0),
            net_income: Number(rentIncome || 0) - Number(totalExpense || 0)
        };
        return res.json(payload);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'property-revenue failed' });
    }
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
