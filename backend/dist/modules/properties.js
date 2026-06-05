"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const dbAdapter_1 = require("../dbAdapter");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const uuid_1 = require("uuid");
exports.router = (0, express_1.Router)();
const PROPERTY_PAYABLE_TEMPLATE_KIND = 'property_payable';
exports.router.get('/', (req, res) => {
    const q = req.query || {};
    const includeArchived = String(q.include_archived || '').toLowerCase() === 'true';
    // Supabase branch removed
    if (dbAdapter_1.hasPg) {
        const filter = includeArchived ? {} : { archived: false };
        (0, dbAdapter_1.pgSelect)('properties', '*', filter)
            .then((data) => res.json(includeArchived ? data : (data || []).filter((x) => !x.archived)))
            .catch((err) => res.status(500).json({ message: err.message }));
        return;
    }
    return res.json((store_1.db.properties || []).filter((p) => includeArchived ? true : !p.archived));
});
const createSchema = zod_1.z.object({
    code: zod_1.z.string().optional(),
    address: zod_1.z.string().min(3),
    type: zod_1.z.string(),
    capacity: zod_1.z.number().int().min(1),
    room_type_code: zod_1.z.string().optional(),
    region: zod_1.z.string().optional(),
    area_sqm: zod_1.z.number().optional(),
    biz_category: zod_1.z.enum(['leased', 'management_fee']).optional(),
    building_name: zod_1.z.string().optional(),
    building_facilities: zod_1.z.array(zod_1.z.string()).optional(),
    building_facility_floor: zod_1.z.string().optional(),
    building_facility_other: zod_1.z.string().optional(),
    building_contact_name: zod_1.z.string().optional(),
    building_contact_phone: zod_1.z.string().optional(),
    building_contact_email: zod_1.z.string().optional(),
    building_notes: zod_1.z.string().optional(),
    bed_config: zod_1.z.string().optional(),
    tv_model: zod_1.z.string().optional(),
    aircon_model: zod_1.z.string().optional(),
    bedroom_ac: zod_1.z.enum(['none', 'master_only', 'both']).optional(),
    notes: zod_1.z.string().optional(),
    floor: zod_1.z.string().optional(),
    parking_type: zod_1.z.string().optional(),
    parking_space: zod_1.z.string().optional(),
    access_type: zod_1.z.string().optional(),
    access_guide_link: zod_1.z.string().optional(),
    keybox_location: zod_1.z.string().optional(),
    keybox_code: zod_1.z.string().optional(),
    garage_guide_link: zod_1.z.string().optional(),
    landlord_id: zod_1.z.string().optional(),
    orientation: zod_1.z.string().optional(),
    fireworks_view: zod_1.z.boolean().optional(),
    listing_names: zod_1.z.record(zod_1.z.string()).optional(),
    airbnb_listing_name: zod_1.z.string().optional(),
    booking_listing_name: zod_1.z.string().optional(),
    airbnb_listing_id: zod_1.z.string().optional(),
    booking_listing_id: zod_1.z.string().optional(),
    payable_templates: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string().optional(),
        vendor: zod_1.z.string().min(1),
        category: zod_1.z.string().min(1),
        category_detail: zod_1.z.string().optional(),
        amount: zod_1.z.coerce.number().optional(),
        due_day_of_month: zod_1.z.coerce.number().min(1).max(31),
        frequency_months: zod_1.z.coerce.number().min(1).max(24).optional(),
        remind_days_before: zod_1.z.coerce.number().min(0).max(30).optional(),
        payment_type: zod_1.z.enum(['bank_account', 'bpay', 'payid', 'rent_deduction', 'cash']).optional(),
        pay_account_name: zod_1.z.string().optional(),
        pay_bsb: zod_1.z.string().optional(),
        pay_account_number: zod_1.z.string().optional(),
        pay_ref: zod_1.z.string().optional(),
        bpay_code: zod_1.z.string().optional(),
        pay_mobile_number: zod_1.z.string().optional(),
        report_category: zod_1.z.string().optional(),
        start_month_key: zod_1.z.string().regex(/^\d{4}-\d{2}$/),
        bill_account_no: zod_1.z.string().optional(),
        note: zod_1.z.string().optional(),
    })).optional(),
});
function normListingName(v) {
    const s = String(v !== null && v !== void 0 ? v : '').trim();
    return s ? s : null;
}
async function ensureListingColumns() {
    if (!dbAdapter_1.pgPool)
        return;
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_name text');
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_name text');
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_names jsonb');
}
async function ensurePropertyColumns() {
    if (!dbAdapter_1.pgPool)
        return;
    await ensureListingColumns();
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text');
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text');
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text');
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text');
    await dbAdapter_1.pgPool.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false');
}
async function ensurePropertyPayableColumns(client) {
    const executor = client || dbAdapter_1.pgPool;
    if (!executor)
        return;
    await executor.query(`CREATE TABLE IF NOT EXISTS recurring_payments (
    id text PRIMARY KEY,
    property_id text REFERENCES properties(id) ON DELETE SET NULL,
    scope text,
    vendor text,
    category text,
    category_detail text,
    amount numeric,
    due_day_of_month integer,
    frequency_months integer,
    remind_days_before integer,
    status text,
    last_paid_date date,
    next_due_date date,
    start_month_key text,
    pay_account_name text,
    pay_bsb text,
    pay_account_number text,
    pay_ref text,
    expense_id text,
    expense_resource text,
    payment_type text,
    bpay_code text,
    pay_mobile_number text,
    report_category text,
    amount_mode text,
    income_base text,
    rate_percent numeric,
    property_ids text[],
    template_kind text,
    bill_account_no text,
    note text,
    created_by text,
    updated_by text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz
  );`);
    await executor.query(`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS template_kind text DEFAULT '${PROPERTY_PAYABLE_TEMPLATE_KIND}';`);
    await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS bill_account_no text;');
    await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS note text;');
    await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS created_by text;');
    await executor.query('ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS updated_by text;');
}
function normalizePayableTemplates(raw, actorId, propertyId) {
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((item) => {
        var _a;
        const id = String((item === null || item === void 0 ? void 0 : item.id) || '').trim() || (0, uuid_1.v4)();
        return {
            id,
            property_id: propertyId,
            scope: 'property',
            template_kind: PROPERTY_PAYABLE_TEMPLATE_KIND,
            vendor: String((item === null || item === void 0 ? void 0 : item.vendor) || '').trim(),
            category: String((item === null || item === void 0 ? void 0 : item.category) || '').trim(),
            category_detail: String((item === null || item === void 0 ? void 0 : item.category_detail) || '').trim() || null,
            amount: (item === null || item === void 0 ? void 0 : item.amount) == null ? 0 : Number(item.amount || 0),
            due_day_of_month: Number((item === null || item === void 0 ? void 0 : item.due_day_of_month) || 1),
            frequency_months: Math.max(1, Number((item === null || item === void 0 ? void 0 : item.frequency_months) || 1)),
            remind_days_before: Number((_a = item === null || item === void 0 ? void 0 : item.remind_days_before) !== null && _a !== void 0 ? _a : 3),
            payment_type: (item === null || item === void 0 ? void 0 : item.payment_type) ? String(item.payment_type) : 'bank_account',
            pay_account_name: String((item === null || item === void 0 ? void 0 : item.pay_account_name) || '').trim() || null,
            pay_bsb: String((item === null || item === void 0 ? void 0 : item.pay_bsb) || '').trim() || null,
            pay_account_number: String((item === null || item === void 0 ? void 0 : item.pay_account_number) || '').trim() || null,
            pay_ref: String((item === null || item === void 0 ? void 0 : item.pay_ref) || '').trim() || null,
            bpay_code: String((item === null || item === void 0 ? void 0 : item.bpay_code) || '').trim() || null,
            pay_mobile_number: String((item === null || item === void 0 ? void 0 : item.pay_mobile_number) || '').trim() || null,
            report_category: String((item === null || item === void 0 ? void 0 : item.report_category) || '').trim() || null,
            start_month_key: String((item === null || item === void 0 ? void 0 : item.start_month_key) || '').trim(),
            bill_account_no: String((item === null || item === void 0 ? void 0 : item.bill_account_no) || '').trim() || null,
            note: String((item === null || item === void 0 ? void 0 : item.note) || '').trim() || null,
            status: 'active',
            created_by: actorId,
            updated_by: actorId,
        };
    });
}
async function syncPropertyPayableTemplatesTx(client, propertyId, rawTemplates, actorId) {
    await ensurePropertyPayableColumns(client);
    const nextTemplates = normalizePayableTemplates(rawTemplates, actorId, propertyId);
    const existingRes = await client.query(`SELECT *
       FROM recurring_payments
      WHERE property_id = $1
        AND COALESCE(template_kind, $2) = $3`, [propertyId, 'fixed_expense', PROPERTY_PAYABLE_TEMPLATE_KIND]);
    const existingRows = Array.isArray(existingRes.rows) ? existingRes.rows : [];
    const existingById = new Map();
    existingRows.forEach((row) => existingById.set(String(row.id), row));
    const keepIds = new Set(nextTemplates.map((row) => String(row.id)));
    for (const tpl of nextTemplates) {
        const existing = existingById.get(String(tpl.id));
        if (existing) {
            const patch = {
                property_id: propertyId,
                scope: 'property',
                template_kind: PROPERTY_PAYABLE_TEMPLATE_KIND,
                vendor: tpl.vendor,
                category: tpl.category,
                category_detail: tpl.category_detail,
                amount: tpl.amount,
                due_day_of_month: tpl.due_day_of_month,
                frequency_months: tpl.frequency_months,
                remind_days_before: tpl.remind_days_before,
                payment_type: tpl.payment_type,
                pay_account_name: tpl.pay_account_name,
                pay_bsb: tpl.pay_bsb,
                pay_account_number: tpl.pay_account_number,
                pay_ref: tpl.pay_ref,
                bpay_code: tpl.bpay_code,
                pay_mobile_number: tpl.pay_mobile_number,
                report_category: tpl.report_category,
                start_month_key: tpl.start_month_key,
                bill_account_no: tpl.bill_account_no,
                note: tpl.note,
                updated_by: actorId,
                updated_at: new Date(),
            };
            const after = await (0, dbAdapter_1.pgUpdate)('recurring_payments', String(tpl.id), patch, client);
            (0, store_1.addAudit)('RecurringPayment', String(tpl.id), 'update', existing, after, actorId || undefined);
        }
        else {
            const created = await (0, dbAdapter_1.pgInsert)('recurring_payments', tpl, client);
            (0, store_1.addAudit)('RecurringPayment', String(tpl.id), 'create', null, created || tpl, actorId || undefined);
        }
    }
    for (const existing of existingRows) {
        if (keepIds.has(String(existing.id)))
            continue;
        if (String(existing.status || '') === 'paused')
            continue;
        const after = await (0, dbAdapter_1.pgUpdate)('recurring_payments', String(existing.id), { status: 'paused', updated_by: actorId, updated_at: new Date() }, client);
        (0, store_1.addAudit)('RecurringPayment', String(existing.id), 'pause', existing, after, actorId || undefined);
    }
    return nextTemplates.map((item) => item.id);
}
async function findListingConflictPg(listingName, excludeId) {
    var _a;
    if (!dbAdapter_1.pgPool)
        return null;
    const res = await dbAdapter_1.pgPool.query(`SELECT id, code, address
     FROM properties
     WHERE (airbnb_listing_name = $1 OR booking_listing_name = $1 OR (listing_names->>'other') = $1)
       AND ($2::text IS NULL OR id <> $2::text)
     LIMIT 1`, [listingName, excludeId || null]);
    return ((_a = res.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
}
function findListingConflictLocal(listingName, excludeId) {
    var _a;
    const name = normListingName(listingName);
    if (!name)
        return null;
    const rows = (store_1.db.properties || []).filter((p) => !excludeId || p.id !== excludeId);
    for (const p of rows) {
        const vals = [p.airbnb_listing_name, p.booking_listing_name, (_a = p.listing_names) === null || _a === void 0 ? void 0 : _a.other];
        if (vals.some((v) => normListingName(v) === name))
            return { id: p.id, code: p.code, address: p.address };
    }
    return null;
}
exports.router.post('/', (0, auth_1.requirePerm)('property.write'), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        const ln = parsed.data.listing_names || {};
        const hasAnyObj = Object.values(ln || {}).some((v) => String(v || '').trim());
        const hasAnyFlat = [
            parsed.data.airbnb_listing_name,
            parsed.data.booking_listing_name,
        ].some((v) => String(v || '').trim());
        if (!hasAnyObj && !hasAnyFlat)
            return res.status(400).json({ message: '请至少填写一个平台的 Listing 名称' });
    }
    catch (_a) { }
    const autoCode = `PM-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-4)}`;
    const actor = req.user;
    const actorId = String((actor === null || actor === void 0 ? void 0 : actor.sub) || (actor === null || actor === void 0 ? void 0 : actor.username) || '').trim() || null;
    const pFull = { id: (0, uuid_1.v4)(), code: parsed.data.code || autoCode, created_by: (actor === null || actor === void 0 ? void 0 : actor.sub) || (actor === null || actor === void 0 ? void 0 : actor.username) || null, ...parsed.data };
    const lnObj = (pFull.listing_names || {});
    pFull.airbnb_listing_name = normListingName(pFull.airbnb_listing_name || lnObj.airbnb || null);
    pFull.booking_listing_name = normListingName(pFull.booking_listing_name || lnObj.booking || null);
    pFull.listing_names = { other: String(lnObj.other || '').trim() };
    const baseKeys = ['id', 'code', 'address', 'type', 'capacity', 'room_type_code', 'region', 'area_sqm', 'biz_category', 'building_name', 'building_facilities', 'building_facility_floor', 'building_facility_other', 'building_contact_name', 'building_contact_phone', 'building_contact_email', 'building_notes', 'bed_config', 'tv_model', 'aircon_model', 'bedroom_ac', 'access_guide_link', 'keybox_location', 'keybox_code', 'garage_guide_link', 'floor', 'parking_type', 'parking_space', 'access_type', 'orientation', 'fireworks_view', 'notes', 'landlord_id', 'created_by', 'listing_names', 'airbnb_listing_name', 'booking_listing_name', 'airbnb_listing_id', 'booking_listing_id'];
    const pBase = Object.fromEntries(Object.entries(pFull).filter(([k]) => baseKeys.includes(k)));
    const minimalKeys = ['id', 'code', 'address', 'type', 'capacity', 'room_type_code', 'region', 'area_sqm', 'notes', 'listing_names'];
    const pMinimal = Object.fromEntries(Object.entries(pFull).filter(([k]) => minimalKeys.includes(k)));
    try {
        // Supabase branch removed
        if (dbAdapter_1.hasPg) {
            await ensurePropertyColumns();
            const listingCandidates = [
                pFull.airbnb_listing_name,
                pFull.booking_listing_name,
                (pFull.listing_names || {}).other,
            ].map(normListingName).filter(Boolean);
            if (listingCandidates.length) {
                try {
                    await ensureListingColumns();
                    for (const name of listingCandidates) {
                        const conflict = await findListingConflictPg(name, null);
                        if (conflict)
                            return res.status(400).json({ message: `已经存在 Listing 名称：${name}`, code: 'DUPLICATE_LISTING_NAME', listing_name: name });
                    }
                }
                catch (e) {
                    return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'listing name check failed' });
                }
            }
            const created = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
                const row = await (0, dbAdapter_1.pgInsert)('properties', pBase, client);
                if (Array.isArray(parsed.data.payable_templates) && parsed.data.payable_templates.length) {
                    await syncPropertyPayableTemplatesTx(client, String(row.id), parsed.data.payable_templates, actorId);
                }
                return row;
            });
            (0, store_1.addAudit)('Property', String((created === null || created === void 0 ? void 0 : created.id) || pFull.id), 'create', null, created, actorId || undefined);
            ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                if (!store_1.db.keySets.find((s) => s.code === ((created === null || created === void 0 ? void 0 : created.code) || '') && s.set_type === t)) {
                    store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: (created === null || created === void 0 ? void 0 : created.code) || '', items: [] });
                }
            });
            return res.status(201).json(created);
        }
        store_1.db.properties.push(pFull);
        (0, store_1.addAudit)('Property', pFull.id, 'create', null, pFull);
        ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
            if (!store_1.db.keySets.find((s) => s.code === (pFull.code || '') && s.set_type === t)) {
                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: pFull.code || '', items: [] });
            }
        });
        return res.status(201).json(pFull);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('property.write'), async (req, res) => {
    const { id } = req.params;
    const body = req.body;
    const cleanedBody = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'bedrooms'));
    if (cleanedBody.listing_names && typeof cleanedBody.listing_names === 'object') {
        const ln = cleanedBody.listing_names || {};
        cleanedBody.airbnb_listing_name = normListingName(cleanedBody.airbnb_listing_name || ln.airbnb || null);
        cleanedBody.booking_listing_name = normListingName(cleanedBody.booking_listing_name || ln.booking || null);
        cleanedBody.listing_names = { other: String(ln.other || '').trim() };
    }
    const baseKeys = ['code', 'address', 'type', 'capacity', 'room_type_code', 'region', 'area_sqm', 'biz_category', 'building_name', 'building_facilities', 'building_facility_floor', 'building_facility_other', 'building_contact_name', 'building_contact_phone', 'building_contact_email', 'building_notes', 'bed_config', 'tv_model', 'aircon_model', 'bedroom_ac', 'access_guide_link', 'keybox_location', 'keybox_code', 'garage_guide_link', 'floor', 'parking_type', 'parking_space', 'access_type', 'orientation', 'fireworks_view', 'notes', 'landlord_id', 'listing_names', 'airbnb_listing_name', 'booking_listing_name', 'airbnb_listing_id', 'booking_listing_id'];
    const actor = req.user;
    const actorId = String((actor === null || actor === void 0 ? void 0 : actor.sub) || (actor === null || actor === void 0 ? void 0 : actor.username) || '').trim() || null;
    const bodyBaseRaw = Object.fromEntries(Object.entries(cleanedBody).filter(([k]) => baseKeys.includes(k)));
    const bodyBase = { ...bodyBaseRaw, updated_at: new Date(), updated_by: (actor === null || actor === void 0 ? void 0 : actor.sub) || (actor === null || actor === void 0 ? void 0 : actor.username) || null };
    try {
        if (dbAdapter_1.hasPg) {
            await ensurePropertyColumns();
            const rows = await (0, dbAdapter_1.pgSelect)('properties', '*', { id });
            const before = rows && rows[0];
            const touchedListing = Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'airbnb_listing_name')
                || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'booking_listing_name')
                || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'listing_names');
            if (touchedListing) {
                const merged = { ...(before || {}), ...(bodyBaseRaw || {}) };
                const listingCandidates = [
                    merged.airbnb_listing_name,
                    merged.booking_listing_name,
                    (merged.listing_names || {}).other,
                ].map(normListingName).filter(Boolean);
                await ensureListingColumns();
                for (const name of listingCandidates) {
                    const conflict = await findListingConflictPg(name, id);
                    if (conflict)
                        return res.status(400).json({ message: `已经存在 Listing 名称：${name}`, code: 'DUPLICATE_LISTING_NAME', listing_name: name });
                }
            }
            const row = await (0, dbAdapter_1.pgRunInTransaction)(async (client) => {
                const updated = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase, client);
                if (Object.prototype.hasOwnProperty.call(body, 'payable_templates')) {
                    await syncPropertyPayableTemplatesTx(client, id, Array.isArray(body.payable_templates) ? body.payable_templates : [], actorId);
                }
                return updated;
            });
            (0, store_1.addAudit)('Property', id, 'update', before, row, actorId || undefined);
            return res.json(row);
        }
        const p = store_1.db.properties.find((x) => x.id === id);
        if (!p)
            return res.status(404).json({ message: 'not found' });
        const beforeLocal = { ...p };
        const touchedListingLocal = Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'airbnb_listing_name')
            || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'booking_listing_name')
            || Object.prototype.hasOwnProperty.call(bodyBaseRaw, 'listing_names');
        if (touchedListingLocal) {
            const merged = { ...p, ...(bodyBaseRaw || {}) };
            const listingCandidates = [
                merged.airbnb_listing_name,
                merged.booking_listing_name,
                (merged.listing_names || {}).other,
            ].map(normListingName).filter(Boolean);
            for (const name of listingCandidates) {
                const conflict = findListingConflictLocal(name, id);
                if (conflict)
                    return res.status(400).json({ message: `已经存在 Listing 名称：${name}`, code: 'DUPLICATE_LISTING_NAME', listing_name: name });
            }
        }
        Object.assign(p, cleanedBody);
        (0, store_1.addAudit)('Property', id, 'update', beforeLocal, p);
        return res.json(p);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.get('/:id', async (req, res) => {
    const { id } = req.params;
    // Supabase branch removed
    if (dbAdapter_1.hasPg) {
        try {
            await ensurePropertyPayableColumns();
            const rows = await (0, dbAdapter_1.pgSelect)('properties', '*', { id });
            if (!rows || !rows[0])
                return res.status(404).json({ message: 'not found' });
            const p = rows[0];
            try {
                const payables = await dbAdapter_1.pgPool.query(`SELECT *
             FROM recurring_payments
            WHERE property_id = $1
              AND COALESCE(template_kind, $2) = $3
            ORDER BY COALESCE(status, 'active') ASC, COALESCE(vendor, '') ASC, COALESCE(created_at, now()) ASC`, [id, 'fixed_expense', PROPERTY_PAYABLE_TEMPLATE_KIND]);
                p.payable_templates = Array.isArray(payables.rows) ? payables.rows : [];
            }
            catch (_a) {
                ;
                p.payable_templates = [];
            }
            if (p.updated_by) {
                try {
                    const us = await (0, dbAdapter_1.pgSelect)('users', 'username, email', { id: p.updated_by });
                    if (us && us[0]) {
                        p.updated_by_name = us[0].username || us[0].email;
                    }
                    else {
                        p.updated_by_name = p.updated_by;
                    }
                }
                catch (_b) { }
            }
            return res.json(p);
        }
        catch (err) {
            return res.status(500).json({ message: err.message });
        }
    }
    const p = store_1.db.properties.find((x) => x.id === id);
    if (!p)
        return res.status(404).json({ message: 'not found' });
    return res.json({ ...p, payable_templates: [] });
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('property.write'), async (req, res) => {
    const { id } = req.params;
    const actor = req.user;
    try {
        // Supabase branch removed
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('properties', '*', { id });
            const before = rows && rows[0];
            const row = await (0, dbAdapter_1.pgUpdate)('properties', id, { archived: true });
            (0, store_1.addAudit)('Property', id, 'archive', before, row, actor === null || actor === void 0 ? void 0 : actor.sub);
            return res.json({ id, archived: true });
        }
        const p = store_1.db.properties.find(x => x.id === id);
        if (!p)
            return res.status(404).json({ message: 'not found' });
        const beforeLocal = { ...p };
        p.archived = true;
        (0, store_1.addAudit)('Property', id, 'archive', beforeLocal, p, actor === null || actor === void 0 ? void 0 : actor.sub);
        return res.json({ id, archived: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
