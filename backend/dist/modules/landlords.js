"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const supabase_1 = require("../supabase");
const dbAdapter_1 = require("../dbAdapter");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const uuid_1 = require("uuid");
exports.router = (0, express_1.Router)();
exports.router.get('/', (req, res) => {
    const q = req.query || {};
    const includeArchived = String(q.include_archived || '').toLowerCase() === 'true';
    if (supabase_1.hasSupabase) {
        const handle = (rows) => {
            const arr = Array.isArray(rows) ? rows : [];
            return res.json(includeArchived ? arr : arr.filter((x) => !x.archived));
        };
        (0, supabase_1.supaSelect)('landlords', '*', includeArchived ? undefined : { archived: false })
            .then(handle)
            .catch(() => {
            (0, supabase_1.supaSelect)('landlords')
                .then(handle)
                .catch((err) => res.status(500).json({ message: err.message }));
        });
        return;
    }
    if (dbAdapter_1.hasPg) {
        const filter = includeArchived ? {} : { archived: false };
        (0, dbAdapter_1.pgSelect)('landlords', '*', filter)
            .then((data) => res.json(includeArchived ? data : (data || []).filter((x) => !x.archived)))
            .catch((err) => res.status(500).json({ message: err.message }));
        return;
    }
    return res.json((store_1.db.landlords || []).filter((l) => includeArchived ? true : !l.archived));
});
const schema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    phone: zod_1.z.string().optional(),
    email: zod_1.z.string().optional(),
    management_fee_rate: zod_1.z.number().optional(),
    payout_bsb: zod_1.z.string().optional(),
    payout_account: zod_1.z.string().optional(),
    property_ids: zod_1.z.array(zod_1.z.string()).optional(),
}).transform((v) => {
    const m = v;
    if (m.management_fee !== undefined && m.management_fee_rate === undefined)
        m.management_fee_rate = m.management_fee;
    return m;
});
exports.router.post('/', (0, auth_1.requirePerm)('landlord.manage'), (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const l = { id: (0, uuid_1.v4)(), ...parsed.data };
    if (supabase_1.hasSupabase) {
        return (0, supabase_1.supaInsert)('landlords', l)
            .then((row) => { (0, store_1.addAudit)('Landlord', row.id, 'create', null, row); res.status(201).json(row); })
            .catch((err) => res.status(500).json({ message: err.message }));
    }
    if (dbAdapter_1.hasPg) {
        return (0, dbAdapter_1.pgInsert)('landlords', l)
            .then((row) => { (0, store_1.addAudit)('Landlord', l.id, 'create', null, row); res.status(201).json(row); })
            .catch((err) => res.status(500).json({ message: err.message }));
    }
    store_1.db.landlords.push(l);
    (0, store_1.addAudit)('Landlord', l.id, 'create', null, l);
    return res.status(201).json(l);
});
exports.router.patch('/:id', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    const { id } = req.params;
    const body = req.body;
    try {
        if (supabase_1.hasSupabase) {
            const rows = await (0, supabase_1.supaSelect)('landlords', '*', { id });
            const before = rows && rows[0];
            const row = await (0, supabase_1.supaUpdate)('landlords', id, body);
            (0, store_1.addAudit)('Landlord', id, 'update', before, row);
            return res.json(row);
        }
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('landlords', '*', { id });
            const before = rows && rows[0];
            const row = await (0, dbAdapter_1.pgUpdate)('landlords', id, body);
            const out = row || { ...(before || {}), ...body, id };
            (0, store_1.addAudit)('Landlord', id, 'update', before, out);
            return res.json(out);
        }
        const l = store_1.db.landlords.find(x => x.id === id);
        if (!l)
            return res.status(404).json({ message: 'not found' });
        const beforeLocal = { ...l };
        Object.assign(l, body);
        (0, store_1.addAudit)('Landlord', id, 'update', beforeLocal, l);
        return res.json(l);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.get('/:id', (req, res) => {
    const { id } = req.params;
    if (supabase_1.hasSupabase) {
        (0, supabase_1.supaSelect)('landlords', '*', { id })
            .then(rows => { if (!rows || !rows[0])
            return res.status(404).json({ message: 'not found' }); res.json(rows[0]); })
            .catch(err => res.status(500).json({ message: err.message }));
        return;
    }
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgSelect)('landlords', '*', { id })
            .then(rows => { if (!rows || !rows[0])
            return res.status(404).json({ message: 'not found' }); res.json(rows[0]); })
            .catch(err => res.status(500).json({ message: err.message }));
        return;
    }
    const l = store_1.db.landlords.find(x => x.id === id);
    if (!l)
        return res.status(404).json({ message: 'not found' });
    return res.json(l);
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    const { id } = req.params;
    const actor = req.user;
    try {
        if (supabase_1.hasSupabase) {
            const rows = await (0, supabase_1.supaSelect)('landlords', '*', { id });
            const before = rows && rows[0];
            try {
                const row = await (0, supabase_1.supaUpdate)('landlords', id, { archived: true });
                (0, store_1.addAudit)('Landlord', id, 'archive', before, row, actor === null || actor === void 0 ? void 0 : actor.sub);
                return res.json({ id, archived: true });
            }
            catch (e) {
                return res.status(400).json({ message: '数据库缺少 archived 列，请先执行迁移：ALTER TABLE landlords ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;' });
            }
        }
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('landlords', '*', { id });
            const before = rows && rows[0];
            const row = await (0, dbAdapter_1.pgUpdate)('landlords', id, { archived: true });
            const out = row || { ...(before || {}), id, archived: true };
            (0, store_1.addAudit)('Landlord', id, 'archive', before, out, actor === null || actor === void 0 ? void 0 : actor.sub);
            return res.json({ id, archived: true });
        }
        const l = store_1.db.landlords.find(x => x.id === id);
        if (!l)
            return res.status(404).json({ message: 'not found' });
        const beforeLocal = { ...l };
        l.archived = true;
        (0, store_1.addAudit)('Landlord', id, 'archive', beforeLocal, l, actor === null || actor === void 0 ? void 0 : actor.sub);
        return res.json({ id, archived: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
