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
const fingerprint_1 = require("../fingerprint");
const auth_1 = require("../auth");
const pdf_lib_1 = require("pdf-lib");
const dbAdapter_2 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
const upload = r2_1.hasR2 ? (0, multer_1.default)({ storage: multer_1.default.memoryStorage() }) : (0, multer_1.default)({ dest: path_1.default.join(process.cwd(), 'uploads') });
const memUpload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
const mergeMaxMb = Math.max(5, Math.min(200, Number(process.env.MERGE_PDF_MAX_MB || 50)));
const mergeUpload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: mergeMaxMb * 1024 * 1024 } });
function toReportCat(raw, detail) {
    const v = String(raw || '').toLowerCase();
    const d = String(detail || '').toLowerCase();
    const s = v + ' ' + d;
    if (['carpark'].includes(v) || s.includes('车位'))
        return 'parking_fee';
    if (['owners_corp', 'ownerscorp', 'body_corp', 'bodycorp'].includes(v) || s.includes('物业'))
        return 'body_corp';
    if (['internet', 'nbn'].includes(v) || s.includes('internet') || s.includes('nbn') || s.includes('网'))
        return 'internet';
    if (['electricity'].includes(v) || s.includes('electric') || s.includes('电'))
        return 'electricity';
    if (['water'].includes(v) || ((s.includes('water') || s.includes('水')) && !s.includes('热')))
        return 'water';
    if (['gas', 'gas_hot_water', 'hot_water'].includes(v) || s.includes('gas') || s.includes('热水') || s.includes('煤气'))
        return 'gas';
    if (['consumables'].includes(v) || s.includes('consumable') || s.includes('消耗'))
        return 'consumables';
    if (['council_rate', 'council'].includes(v) || s.includes('council') || s.includes('市政'))
        return 'council';
    if (s.includes('management_fee') || s.includes('管理费'))
        return 'management_fee';
    return 'other';
}
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
            const cat0 = String(tx.category || '').toLowerCase();
            if (String(tx.kind) === 'income' && cat0 === 'cancel_fee' && String(tx.ref_type || '') === 'order' && String(tx.ref_id || '')) {
                const dup = await (0, dbAdapter_1.pgSelect)('finance_transactions', '*', { ref_type: 'order', ref_id: String(tx.ref_id), category: 'cancel_fee' });
                if (Array.isArray(dup) && dup[0]) {
                    return res.status(200).json(dup[0]);
                }
            }
            const row = await (0, dbAdapter_1.pgInsert)('finance_transactions', tx);
            try {
                const cat = String(tx.category || '').toLowerCase();
                if (String(tx.kind) === 'income' && (cat === 'cancel_fee' || cat === 'late_checkout' || cat === 'other' || cat === 'cleaning_fee' || cat === 'mgmt_fee')) {
                    const occurred = String(tx.occurred_at || '').slice(0, 10);
                    const rec = { id: uuid(), occurred_at: occurred || new Date().toISOString().slice(0, 10), amount: Number(tx.amount || 0), currency: String(tx.currency || 'AUD'), category: cat || 'other', note: String(tx.note || ''), property_id: tx.property_id || null };
                    try {
                        const dup2 = await (0, dbAdapter_1.pgSelect)('company_incomes', '*', { occurred_at: rec.occurred_at, category: rec.category, amount: rec.amount, note: rec.note, property_id: rec.property_id });
                        if (!(Array.isArray(dup2) && dup2[0])) {
                            await (0, dbAdapter_1.pgInsert)('company_incomes', rec);
                        }
                    }
                    catch (e) {
                        const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                        try {
                            if (/relation\s+"?company_incomes"?\s+does\s+not\s+exist/i.test(msg)) {
                                await (dbAdapter_2.pgPool === null || dbAdapter_2.pgPool === void 0 ? void 0 : dbAdapter_2.pgPool.query(`CREATE TABLE IF NOT EXISTS company_incomes (
                  id text PRIMARY KEY,
                  occurred_at date NOT NULL,
                  amount numeric NOT NULL,
                  currency text NOT NULL,
                  category text,
                  note text,
                  created_at timestamptz DEFAULT now()
                );`));
                                await (dbAdapter_2.pgPool === null || dbAdapter_2.pgPool === void 0 ? void 0 : dbAdapter_2.pgPool.query('CREATE INDEX IF NOT EXISTS idx_company_incomes_date ON company_incomes(occurred_at);'));
                                await (dbAdapter_2.pgPool === null || dbAdapter_2.pgPool === void 0 ? void 0 : dbAdapter_2.pgPool.query('CREATE INDEX IF NOT EXISTS idx_company_incomes_cat ON company_incomes(category);'));
                            }
                            if (/column\s+"?property_id"?\s+of\s+relation\s+"?company_incomes"?\s+does\s+not\s+exist/i.test(msg)) {
                                await (dbAdapter_2.pgPool === null || dbAdapter_2.pgPool === void 0 ? void 0 : dbAdapter_2.pgPool.query('ALTER TABLE company_incomes ADD COLUMN IF NOT EXISTS property_id text REFERENCES properties(id) ON DELETE SET NULL;'));
                                await (dbAdapter_2.pgPool === null || dbAdapter_2.pgPool === void 0 ? void 0 : dbAdapter_2.pgPool.query('CREATE INDEX IF NOT EXISTS idx_company_incomes_property ON company_incomes(property_id);'));
                            }
                        }
                        catch (_a) { }
                        const dup3 = await (0, dbAdapter_1.pgSelect)('company_incomes', '*', { occurred_at: rec.occurred_at, category: rec.category, amount: rec.amount, note: rec.note, property_id: rec.property_id });
                        if (!(Array.isArray(dup3) && dup3[0])) {
                            await (0, dbAdapter_1.pgInsert)('company_incomes', rec);
                        }
                    }
                    (0, store_1.addAudit)('CompanyIncome', rec.id, 'create', null, rec);
                }
            }
            catch (_b) { }
            return res.status(201).json(row || tx);
        }
        catch (e) {
            return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'pg insert failed' });
        }
    }
    return res.status(201).json(tx);
});
// Backfill company_incomes from finance_transactions for a given month
exports.router.post('/company-incomes/backfill', (0, auth_1.requireAnyPerm)(['finance.tx.write', 'company_incomes.write']), async (req, res) => {
    try {
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        const month = String(((req.body || {}).month) || ((req.query || {}).month) || '');
        if (!/^\d{4}-\d{2}$/.test(month))
            return res.status(400).json({ message: 'invalid month format' });
        const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
        const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
        const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        const cats = ['cancel_fee'];
        const rs = await dbAdapter_2.pgPool.query(`SELECT id, occurred_at, amount, currency, category, note, property_id
       FROM finance_transactions
       WHERE kind='income' AND category = ANY($1) AND occurred_at BETWEEN to_date($2,'YYYY-MM-DD') AND to_date($3,'YYYY-MM-DD')`, [cats, start, end]);
        const rows = rs.rows || [];
        let inserted = 0, skipped = 0;
        for (const t of rows) {
            const occ = String(t.occurred_at || '').slice(0, 10);
            const chk = await (0, dbAdapter_1.pgSelect)('company_incomes', '*', { occurred_at: occ, category: t.category, amount: Number(t.amount || 0), note: String(t.note || '') });
            if (Array.isArray(chk) && chk[0]) {
                skipped++;
                continue;
            }
            const rec = { id: require('uuid').v4(), occurred_at: occ, amount: Number(t.amount || 0), currency: String(t.currency || 'AUD'), category: String(t.category || 'other'), note: String(t.note || ''), property_id: String(t.property_id || '') || null };
            await (0, dbAdapter_1.pgInsert)('company_incomes', rec);
            (0, store_1.addAudit)('CompanyIncome', rec.id, 'create', null, rec);
            inserted++;
        }
        return res.status(201).json({ month, scanned: rows.length, inserted, skipped });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'backfill_failed' });
    }
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
exports.router.post('/merge-pdf', (0, auth_1.requireAnyPerm)(['finance.payout', 'finance.tx.write', 'property_expenses.view', 'invoice.view']), mergeUpload.single('statement'), async (req, res) => {
    try {
        const { statement_pdf_base64, statement_pdf_url, invoice_urls } = req.body || {};
        const statementFile = req.file;
        if (!(statementFile === null || statementFile === void 0 ? void 0 : statementFile.buffer) && !statement_pdf_base64 && !statement_pdf_url)
            return res.status(400).json({ message: 'missing statement pdf' });
        let urls = [];
        if (Array.isArray(invoice_urls)) {
            urls = invoice_urls.filter((u) => typeof u === 'string');
        }
        else if (typeof invoice_urls === 'string') {
            try {
                const parsed = JSON.parse(invoice_urls);
                if (Array.isArray(parsed))
                    urls = parsed.filter((u) => typeof u === 'string');
                else if (typeof parsed === 'string')
                    urls = [parsed];
            }
            catch (_a) {
                urls = invoice_urls.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        const allowedHosts = (() => {
            const hosts = new Set();
            const addHost = (h) => { if (h)
                hosts.add(h.toLowerCase()); };
            try {
                const apiBase = String(process.env.API_BASE || '');
                if (apiBase)
                    addHost(new URL(apiBase).host);
            }
            catch (_a) { }
            try {
                const r2Base = String(process.env.R2_PUBLIC_BASE_URL || process.env.R2_PUBLIC_BASE || '');
                if (r2Base)
                    addHost(new URL(r2Base).host);
            }
            catch (_b) { }
            const reqHost = String(req.headers.host || '');
            if (reqHost)
                addHost(reqHost);
            return hosts;
        })();
        function normalizeFetchUrl(input) {
            const raw = String(input || '').trim();
            if (!raw)
                throw new Error('invalid url');
            if (raw.startsWith('/')) {
                const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http');
                const host = String(req.headers.host || '');
                if (!host)
                    throw new Error('invalid host');
                return `${proto}://${host}${raw}`;
            }
            return raw;
        }
        function assertAllowed(urlStr) {
            const u = new URL(urlStr);
            const proto = u.protocol.toLowerCase();
            if (proto !== 'http:' && proto !== 'https:')
                throw new Error('invalid protocol');
            const host = u.host.toLowerCase();
            if (!allowedHosts.has(host))
                throw new Error('disallowed host');
        }
        async function fetchBytes(u) {
            const url = normalizeFetchUrl(u);
            assertAllowed(url);
            const r = await fetch(url);
            if (!r.ok)
                throw new Error(`fetch failed: ${r.status}`);
            const ab = await r.arrayBuffer();
            return new Uint8Array(ab);
        }
        let merged = await pdf_lib_1.PDFDocument.create();
        // append statement
        if ((statementFile === null || statementFile === void 0 ? void 0 : statementFile.buffer) && Buffer.isBuffer(statementFile.buffer)) {
            let src;
            try {
                src = await pdf_lib_1.PDFDocument.load(new Uint8Array(statementFile.buffer));
            }
            catch (e) {
                return res.status(400).json({ message: `invalid statement pdf: ${String((e === null || e === void 0 ? void 0 : e.message) || 'load failed')}` });
            }
            const copied = await merged.copyPages(src, src.getPageIndices());
            copied.forEach(p => merged.addPage(p));
        }
        else if (statement_pdf_base64 && typeof statement_pdf_base64 === 'string') {
            const b64 = statement_pdf_base64.replace(/^data:application\/pdf;base64,/, '');
            const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
            let src;
            try {
                src = await pdf_lib_1.PDFDocument.load(bytes);
            }
            catch (e) {
                return res.status(400).json({ message: `invalid statement pdf: ${String((e === null || e === void 0 ? void 0 : e.message) || 'load failed')}` });
            }
            const copied = await merged.copyPages(src, src.getPageIndices());
            copied.forEach(p => merged.addPage(p));
        }
        else if (statement_pdf_url && typeof statement_pdf_url === 'string') {
            const bytes = await fetchBytes(statement_pdf_url);
            let src;
            try {
                src = await pdf_lib_1.PDFDocument.load(bytes);
            }
            catch (e) {
                return res.status(400).json({ message: `invalid statement pdf: ${String((e === null || e === void 0 ? void 0 : e.message) || 'load failed')}` });
            }
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
            catch (_b) { }
        }
        const out = await merged.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="statement-merged.pdf"');
        return res.status(200).send(Buffer.from(out));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'merge failed' });
    }
}, (err, _req, res, _next) => {
    const code = String((err === null || err === void 0 ? void 0 : err.code) || '');
    if (code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: `报表PDF过大（最大 ${mergeMaxMb}MB）` });
    }
    if (code)
        return res.status(400).json({ message: (err === null || err === void 0 ? void 0 : err.message) || `upload failed (${code})` });
    return res.status(500).json({ message: (err === null || err === void 0 ? void 0 : err.message) || 'merge failed' });
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
const revenueStatusGetMonthRe = /^\d{4}-\d{2}$/;
exports.router.get('/property-revenue-status', async (req, res) => {
    var _a, _b, _c;
    try {
        const from = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.from) || '');
        const to = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.to) || '');
        const property_id = String(((_c = req.query) === null || _c === void 0 ? void 0 : _c.property_id) || '');
        const hasRange = !!(from && to);
        if (hasRange && (!revenueStatusGetMonthRe.test(from) || !revenueStatusGetMonthRe.test(to))) {
            return res.status(400).json({ message: 'invalid month range' });
        }
        if (dbAdapter_1.hasPg) {
            const wh = [];
            const vals = [];
            if (hasRange) {
                wh.push(`month_key >= $${vals.length + 1} AND month_key <= $${vals.length + 2}`);
                vals.push(from, to);
            }
            if (property_id) {
                wh.push(`property_id = $${vals.length + 1}`);
                vals.push(property_id);
            }
            const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
            const sql = `SELECT * FROM property_revenue_statuses ${where} ORDER BY month_key ASC`;
            const rs = await dbAdapter_2.pgPool.query(sql, vals);
            return res.json(rs.rows || []);
        }
        const list = store_1.db.propertyRevenueStatuses || [];
        const filtered = list.filter((r) => {
            if (property_id && String(r.property_id) !== property_id)
                return false;
            if (hasRange && (String(r.month_key) < from || String(r.month_key) > to))
                return false;
            return true;
        });
        filtered.sort((a, b) => String(a.month_key).localeCompare(String(b.month_key)));
        return res.json(filtered);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'get status failed' });
    }
});
const revenueStatusPatchSchema = zod_1.z.object({
    property_id: zod_1.z.string().min(1),
    month_key: zod_1.z.string().regex(revenueStatusGetMonthRe),
    scheduled_email_set: zod_1.z.boolean().optional(),
    transferred: zod_1.z.boolean().optional(),
});
exports.router.patch('/property-revenue-status', (0, auth_1.requirePerm)('finance.payout'), async (req, res) => {
    var _a, _b, _c, _d, _e;
    const parsed = revenueStatusPatchSchema.safeParse(req.body || {});
    if (!parsed.success) {
        const msg = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        return res.status(400).json({ message: msg || 'invalid payload' });
    }
    const actor = String(((_a = req === null || req === void 0 ? void 0 : req.user) === null || _a === void 0 ? void 0 : _a.sub) || '');
    try {
        const nowIso = new Date().toISOString();
        const { property_id, month_key, scheduled_email_set, transferred } = parsed.data;
        if (dbAdapter_1.hasPg) {
            const exists = await (0, dbAdapter_1.pgSelect)('property_revenue_statuses', '*', { property_id, month_key });
            const before = Array.isArray(exists) ? exists[0] : null;
            if (before === null || before === void 0 ? void 0 : before.id) {
                const updated = {
                    scheduled_email_set: (_b = scheduled_email_set !== null && scheduled_email_set !== void 0 ? scheduled_email_set : before.scheduled_email_set) !== null && _b !== void 0 ? _b : false,
                    transferred: (_c = transferred !== null && transferred !== void 0 ? transferred : before.transferred) !== null && _c !== void 0 ? _c : false,
                    updated_at: nowIso,
                    updated_by: actor || null,
                };
                const row = await (0, dbAdapter_1.pgUpdate)('property_revenue_statuses', String(before.id), updated);
                try {
                    (0, store_1.addAudit)('PropertyRevenueStatus', String(before.id), 'update', before, row || { ...before, ...updated }, actor || undefined);
                }
                catch (_f) { }
                return res.json(row || { ...before, ...updated });
            }
            const id = require('uuid').v4();
            const created = {
                id,
                property_id,
                month_key,
                scheduled_email_set: scheduled_email_set !== null && scheduled_email_set !== void 0 ? scheduled_email_set : false,
                transferred: transferred !== null && transferred !== void 0 ? transferred : false,
                updated_at: nowIso,
                updated_by: actor || undefined,
            };
            const row = await (0, dbAdapter_1.pgInsert)('property_revenue_statuses', created);
            try {
                (0, store_1.addAudit)('PropertyRevenueStatus', id, 'create', null, row || created, actor || undefined);
            }
            catch (_g) { }
            return res.status(201).json(row || created);
        }
        const list = store_1.db.propertyRevenueStatuses || (store_1.db.propertyRevenueStatuses = []);
        const idx = list.findIndex(r => String(r.property_id) === property_id && String(r.month_key) === month_key);
        if (idx >= 0) {
            const before = list[idx];
            const after = {
                ...before,
                scheduled_email_set: (_d = scheduled_email_set !== null && scheduled_email_set !== void 0 ? scheduled_email_set : before.scheduled_email_set) !== null && _d !== void 0 ? _d : false,
                transferred: (_e = transferred !== null && transferred !== void 0 ? transferred : before.transferred) !== null && _e !== void 0 ? _e : false,
                updated_at: nowIso,
                updated_by: actor || undefined,
            };
            list[idx] = after;
            try {
                (0, store_1.addAudit)('PropertyRevenueStatus', String(after.id), 'update', before, after, actor || undefined);
            }
            catch (_h) { }
            return res.json(after);
        }
        const id = require('uuid').v4();
        const created = {
            id,
            property_id,
            month_key,
            scheduled_email_set: scheduled_email_set !== null && scheduled_email_set !== void 0 ? scheduled_email_set : false,
            transferred: transferred !== null && transferred !== void 0 ? transferred : false,
            updated_at: nowIso,
            updated_by: actor || undefined,
        };
        list.push(created);
        try {
            (0, store_1.addAudit)('PropertyRevenueStatus', id, 'create', null, created, actor || undefined);
        }
        catch (_j) { }
        return res.status(201).json(created);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'update status failed' });
    }
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
        const cols = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0, management_fee: 0 };
        let rentIncome = 0;
        let warnings = [];
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
                    const status = String(o.status || '').toLowerCase();
                    const isCanceled = status.includes('cancel');
                    const include = (!isCanceled) || !!o.count_in_income;
                    if (include && ov > 0 && nights > 0)
                        rentIncome += (visNet * ov) / nights;
                }
                let peRows = [];
                try {
                    const { pgPool } = require('../dbAdapter');
                    if (pgPool) {
                        const sql = `SELECT * FROM property_expenses
              WHERE (property_id = $1 OR lower(property_id) = lower($2))
                AND (
                  month_key = $3 OR
                  date_trunc('month', COALESCE(paid_date, occurred_at)::date) = date_trunc('month', to_date($3,'YYYY-MM'))
                )`;
                        const rs = await pgPool.query(sql, [pid || null, pcode || null, ym]);
                        peRows = rs.rows || [];
                    }
                }
                catch (_d) { }
                const rp = await (0, dbAdapter_1.pgSelect)('recurring_payments', '*');
                const rpRows = Array.isArray(rp) ? rp : [];
                const map = Object.fromEntries(rpRows.map(r => [String(r.id), String(r.report_category || 'other')]));
                function toReportCat(raw, detail) {
                    const v = String(raw || '').toLowerCase();
                    const d = String(detail || '').toLowerCase();
                    const s = v + ' ' + d;
                    // explicit category values
                    if (['carpark'].includes(v))
                        return 'parking_fee';
                    if (['owners_corp', 'ownerscorp', 'body_corp', 'bodycorp'].includes(v))
                        return 'body_corp';
                    if (['internet', 'nbn'].includes(v))
                        return 'internet';
                    if (['electricity'].includes(v))
                        return 'electricity';
                    if (['water'].includes(v))
                        return 'water';
                    if (['gas', 'gas_hot_water', 'hot_water'].includes(v))
                        return 'gas';
                    if (['consumables'].includes(v))
                        return 'consumables';
                    if (['council_rate', 'council'].includes(v))
                        return 'council';
                    // heuristics & Chinese labels
                    if (s.includes('车位'))
                        return 'parking_fee';
                    if (s.includes('物业'))
                        return 'body_corp';
                    if (s.includes('internet') || s.includes('nbn') || s.includes('网'))
                        return 'internet';
                    if (s.includes('electric') || s.includes('电'))
                        return 'electricity';
                    if ((s.includes('water') || s.includes('水')) && !s.includes('热'))
                        return 'water';
                    if (s.includes('gas') || s.includes('热水') || s.includes('煤气'))
                        return 'gas';
                    if (s.includes('consumable') || s.includes('消耗'))
                        return 'consumables';
                    if (s.includes('council') || s.includes('市政'))
                        return 'council';
                    if (s.includes('管理费') || s.includes('management'))
                        return 'management_fee';
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
                const missingMonthKey = peRows.filter((e) => !e.month_key).length;
                if (missingMonthKey > 0)
                    warnings.push(`expenses_without_month_key=${missingMonthKey}`);
                // Auto compute management fee from landlord config
                try {
                    const props = await (0, dbAdapter_1.pgSelect)('properties', 'id,landlord_id', { id: pid });
                    const prop = Array.isArray(props) ? props[0] : null;
                    let rate = 0;
                    if (prop === null || prop === void 0 ? void 0 : prop.landlord_id) {
                        const lrows = await (0, dbAdapter_1.pgSelect)('landlords', 'id,management_fee_rate', { id: prop.landlord_id });
                        const ll = Array.isArray(lrows) ? lrows[0] : null;
                        rate = Number((ll === null || ll === void 0 ? void 0 : ll.management_fee_rate) || 0);
                    }
                    if (rate && rentIncome) {
                        const fee = Number(((rentIncome * rate)).toFixed(2));
                        cols.management_fee += fee;
                    }
                }
                catch (_e) { }
            }
        }
        catch (_f) { }
        const totalExpense = Object.entries(cols).reduce((s, [k, v]) => s + (k === 'management_fee' ? Number(v || 0) : Number(v || 0)), 0);
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
            management_fee: -Number(cols.management_fee || 0),
            total_expense: -Number(totalExpense || 0),
            net_income: Number(rentIncome || 0) - Number(totalExpense || 0)
        };
        if (warnings.length)
            payload.warnings = warnings;
        return res.json(payload);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'property-revenue failed' });
    }
});
// Auto-calc management fee for a property and month, persist into property_expenses and finance_transactions
exports.router.post('/management-fee/calc', (0, auth_1.requireAnyPerm)(['property_expenses.write', 'finance.tx.write']), async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g;
    try {
        const { property_id, property_code, month } = (req.body || {});
        if (!month || (!(property_id) && !(property_code)))
            return res.status(400).json({ message: 'missing month or property' });
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        const ym = String(month);
        const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
        if (!y || !m)
            return res.status(400).json({ message: 'invalid month format' });
        const start = new Date(Date.UTC(y, m - 1, 1));
        const end = new Date(Date.UTC(y, m, 0));
        let pid = String(property_id || '');
        let pcode = String(property_code || '');
        const { pgPool } = require('../dbAdapter');
        // resolve property id by code
        if (!pid && pcode) {
            const qr = await pgPool.query('SELECT id, landlord_id FROM properties WHERE lower(code)=lower($1) LIMIT 1', [pcode]);
            pid = ((_b = (_a = qr.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.id) || '';
        }
        if (!pid)
            return res.status(404).json({ message: 'property_not_found' });
        // compute rent income for target month
        const orders = await (0, dbAdapter_1.pgSelect)('orders', '*', { property_id: pid });
        const ords = Array.isArray(orders) ? orders : [];
        function toDate(s) { try {
            return s ? new Date(String(s)) : null;
        }
        catch (_a) {
            return null;
        } }
        function overlapNights(ci, co) {
            const a = toDate(ci), b = toDate(co);
            if (!a || !b)
                return 0;
            const A = a > start ? a : start;
            const B = b < end ? b : end;
            const ms = B.getTime() - A.getTime();
            return ms > 0 ? Math.floor(ms / (24 * 3600 * 1000)) : 0;
        }
        let rentIncome = 0;
        for (const o of ords) {
            const ov = overlapNights(o.checkin, o.checkout);
            const nights = Number(o.nights || 0) || 0;
            const visNet = Number((_d = (_c = o.visible_net_income) !== null && _c !== void 0 ? _c : o.net_income) !== null && _d !== void 0 ? _d : 0);
            const status = String(o.status || '').toLowerCase();
            const isCanceled = status.includes('cancel');
            const include = (!isCanceled) || !!o.count_in_income;
            if (include && ov > 0 && nights > 0)
                rentIncome += (visNet * ov) / nights;
        }
        // read landlord rate
        const propRows = await (0, dbAdapter_1.pgSelect)('properties', 'id,landlord_id,code', { id: pid });
        const prop = Array.isArray(propRows) ? propRows[0] : null;
        const lid = prop === null || prop === void 0 ? void 0 : prop.landlord_id;
        if (!lid)
            return res.status(400).json({ message: 'landlord_not_linked' });
        const llRows = await (0, dbAdapter_1.pgSelect)('landlords', 'id,management_fee_rate', { id: lid });
        const landlord = Array.isArray(llRows) ? llRows[0] : null;
        const rate = Number((landlord === null || landlord === void 0 ? void 0 : landlord.management_fee_rate) || 0);
        if (!rate)
            return res.status(400).json({ message: 'management_fee_rate_missing' });
        if (!rentIncome)
            return res.status(400).json({ message: 'rent_income_zero' });
        const fee = Number(((rentIncome * rate)).toFixed(2));
        // upsert property_expenses
        const { v4: uuid } = require('uuid');
        const occurred = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
        const existing = await (0, dbAdapter_1.pgSelect)('property_expenses', '*', { property_id: pid, month_key: ym, category: 'management_fee' });
        let expRow;
        if (Array.isArray(existing) && existing[0]) {
            const id = existing[0].id;
            expRow = await (0, dbAdapter_1.pgUpdate)('property_expenses', id, { amount: fee, occurred_at: occurred, note: `auto management fee ${ym}` });
        }
        else {
            expRow = await (0, dbAdapter_1.pgInsert)('property_expenses', { id: uuid(), property_id: pid, amount: fee, category: 'management_fee', occurred_at: occurred, month_key: ym, note: `auto management fee ${ym}` });
        }
        // write finance transaction for integration
        const tx = { id: uuid(), kind: 'expense', amount: fee, currency: 'AUD', occurred_at: new Date().toISOString(), ref_type: 'property_expense', ref_id: (expRow === null || expRow === void 0 ? void 0 : expRow.id) || (((_e = existing === null || existing === void 0 ? void 0 : existing[0]) === null || _e === void 0 ? void 0 : _e.id) || null), property_id: pid, category: 'management_fee', note: `management fee ${(prop === null || prop === void 0 ? void 0 : prop.code) || pid} ${ym}` };
        await (0, dbAdapter_1.pgInsert)('finance_transactions', tx);
        (0, store_1.addAudit)('FinanceTransaction', tx.id, 'create', null, tx);
        // return with double-check snapshot
        const recorded = await (0, dbAdapter_1.pgSelect)('property_expenses', '*', { property_id: pid, month_key: ym, category: 'management_fee' });
        const diff = Math.abs(Number((((_f = recorded === null || recorded === void 0 ? void 0 : recorded[0]) === null || _f === void 0 ? void 0 : _f.amount) || 0)) - fee);
        return res.status(201).json({ property_id: pid, month: ym, rent_income: Number(rentIncome.toFixed(2)), rate, fee, recorded_fee: Number((((_g = recorded === null || recorded === void 0 ? void 0 : recorded[0]) === null || _g === void 0 ? void 0 : _g.amount) || 0)), diff });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'calc_failed' });
    }
});
exports.router.get('/management-fee/history', (0, auth_1.requireAnyPerm)(['property_expenses.view', 'finance.tx.write']), async (req, res) => {
    try {
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        const { property_id, month_from, month_to } = (req.query || {});
        const conds = [];
        const where = ["category = 'management_fee'"];
        if (property_id) {
            where.push('property_id = $1');
            conds.push(property_id);
        }
        if (month_from && month_to) {
            where.push('month_key BETWEEN $2 AND $3');
            conds.push(month_from, month_to);
        }
        const { pgPool } = require('../dbAdapter');
        const rs = await pgPool.query(`SELECT * FROM property_expenses WHERE ${where.join(' AND ')} ORDER BY month_key DESC`, conds);
        return res.json(rs.rows || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'history_failed' });
    }
});
// Validation endpoint: compare raw expenses aggregation for a property and month
exports.router.get('/property-revenue/validate', async (req, res) => {
    try {
        const { property_id, property_code, month } = (req.query || {});
        if (!month || (!(property_id) && !(property_code)))
            return res.status(400).json({ message: 'missing month or property' });
        const ym = String(month);
        let pid = String(property_id || '');
        let pcode = String(property_code || '');
        if (dbAdapter_1.hasPg) {
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    if (!pid && pcode) {
                        const qr = await pgPool.query('SELECT id,code FROM properties WHERE lower(code) = lower($1) LIMIT 1', [pcode]);
                        if (qr.rows && qr.rows[0])
                            pid = qr.rows[0].id;
                    }
                }
            }
            catch (_a) { }
        }
        const totals = { parking_fee: 0, electricity: 0, water: 0, gas: 0, internet: 0, consumables: 0, body_corp: 0, council: 0, other: 0 };
        if (dbAdapter_1.hasPg) {
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    const sql = `SELECT * FROM property_expenses
            WHERE (property_id = $1 OR lower(property_id) = lower($2))
              AND (
                month_key = $3 OR
                date_trunc('month', COALESCE(paid_date, occurred_at)::date) = date_trunc('month', to_date($3,'YYYY-MM'))
              )`;
                    const rs = await pgPool.query(sql, [pid || null, pcode || null, ym]);
                    const rows = rs.rows || [];
                    for (const e of rows) {
                        const fid = String(e.fixed_expense_id || '');
                        const amt = Number(e.amount || 0);
                        let cat = 'other';
                        if (fid) {
                            try {
                                const rp = await (0, dbAdapter_1.pgSelect)('recurring_payments', '*', { id: fid });
                                const r = Array.isArray(rp) ? rp[0] : null;
                                cat = String((r === null || r === void 0 ? void 0 : r.report_category) || 'other');
                            }
                            catch (_b) { }
                        }
                        else {
                            cat = toReportCat(String(e.category || ''), String(e.category_detail || ''));
                        }
                        if (totals[cat] === undefined)
                            totals[cat] = 0;
                        totals[cat] += amt;
                    }
                }
            }
            catch (e) {
                return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'validate failed' });
            }
        }
        return res.json({ property_id: pid, property_code: pcode, month: ym, totals });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'validate failed' });
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
// Deduplicate property_expenses by (property_id, month_key, category, amount)
exports.router.post('/dedup-property-expenses', (0, auth_1.requireAnyPerm)(['property_expenses.write', 'finance.tx.write']), async (_req, res) => {
    try {
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        const { pgPool } = require('../dbAdapter');
        if (!pgPool)
            return res.status(500).json({ message: 'pg pool unavailable' });
        const dupSql = `
      SELECT property_id, month_key, category, amount, array_agg(id ORDER BY coalesce(updated_at, created_at, now()) DESC) AS ids
      FROM property_expenses
      WHERE month_key IS NOT NULL
      GROUP BY property_id, month_key, category, amount
      HAVING COUNT(*) > 1
    `;
        const qr = await pgPool.query(dupSql);
        const groups = qr.rows || [];
        let merged = 0, removed = 0, marked = 0;
        for (const g of groups) {
            const ids = g.ids || [];
            if (!ids.length)
                continue;
            const keep = ids[0];
            const drop = ids.slice(1);
            if (drop.length) {
                await pgPool.query('DELETE FROM property_expenses WHERE id = ANY($1::text[])', [drop]);
                removed += drop.length;
            }
            merged++;
        }
        return res.json({ merged_groups: merged, removed_records: removed, marked_conflicts: marked });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'dedup failed' });
    }
});
exports.router.post('/expenses/validate-duplicate', (0, auth_1.requireAnyPerm)(['property_expenses.write', 'finance.tx.write']), async (req, res) => {
    var _a;
    try {
        const body = req.body || {};
        const mode = String(body.mode || 'exact') === 'fuzzy' ? 'fuzzy' : 'exact';
        const fp = (0, fingerprint_1.buildExpenseFingerprint)(body, mode);
        const started = Date.now();
        const result = { verification_id: fp, is_duplicate: false, reasons: [], similar: [] };
        if (await (0, fingerprint_1.hasFingerprint)(fp)) {
            result.is_duplicate = true;
            result.reasons.push('fingerprint_recent');
        }
        if (dbAdapter_1.hasPg) {
            const occ = String(body.paid_date || body.occurred_at || '');
            const whereExact = { property_id: body.property_id, month_key: (occ ? occ.slice(0, 7) : body.month_key), category: body.category, amount: Number(body.amount || 0) };
            const ex = await (0, dbAdapter_1.pgSelect)('property_expenses', '*', whereExact);
            if (Array.isArray(ex) && ex[0]) {
                result.is_duplicate = true;
                result.reasons.push('unique_match');
                result.similar.push(ex[0]);
            }
            try {
                const { pgPool } = require('../dbAdapter');
                const sql = `SELECT * FROM property_expenses WHERE property_id=$1 AND category=$2 AND abs(amount - $3) <= 1 AND occurred_at BETWEEN (to_date($4,'YYYY-MM-DD') - interval '1 day') AND (to_date($4,'YYYY-MM-DD') + interval '1 day') LIMIT 10`;
                const rs = await pgPool.query(sql, [body.property_id, body.category, Number(body.amount || 0), occ.slice(0, 10)]);
                if (rs.rowCount) {
                    result.is_duplicate = true;
                    result.reasons.push('fuzzy_window');
                    result.similar.push(...rs.rows);
                }
            }
            catch (_b) { }
        }
        await (0, fingerprint_1.addDedupLog)({ resource: 'property_expenses', fingerprint: fp, mode: mode, result: result.is_duplicate ? 'hit' : 'miss', operator_id: ((_a = req.user) === null || _a === void 0 ? void 0 : _a.sub) || null, reasons: result.reasons, latency_ms: Date.now() - started });
        return res.json(result);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'validate_failed' });
    }
});
exports.router.post('/expenses/scan-duplicates', (0, auth_1.requireAnyPerm)(['property_expenses.write', 'finance.tx.write']), async (_req, res) => {
    try {
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        const { pgPool } = require('../dbAdapter');
        const sql = `SELECT property_id, month_key, category, amount, COUNT(*) AS cnt FROM property_expenses WHERE month_key IS NOT NULL GROUP BY property_id, month_key, category, amount HAVING COUNT(*) > 1 ORDER BY cnt DESC LIMIT 100`;
        const rs = await pgPool.query(sql);
        const groups = rs.rows || [];
        return res.json({ groups });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'scan_failed' });
    }
});
exports.router.get('/duplicates/metrics', (0, auth_1.requireAnyPerm)(['property_expenses.view', 'finance.tx.write']), async (_req, res) => {
    var _a, _b, _c, _d;
    try {
        if (!dbAdapter_1.hasPg)
            return res.json({ duplicate_rate_24h: 0, hits_24h: 0, validations_24h: 0 });
        const { pgPool } = require('../dbAdapter');
        const rs = await pgPool.query(`SELECT count(*) FILTER (WHERE result='hit') AS hits, count(*) AS total FROM expense_dedup_logs WHERE created_at > now() - interval '24 hours'`);
        const hits = Number(((_b = (_a = rs.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.hits) || 0);
        const total = Number(((_d = (_c = rs.rows) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.total) || 0);
        const rate = total ? Number(((hits / total) * 100).toFixed(2)) : 0;
        return res.json({ duplicate_rate_24h: rate, hits_24h: hits, validations_24h: total });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'metrics_failed' });
    }
});
