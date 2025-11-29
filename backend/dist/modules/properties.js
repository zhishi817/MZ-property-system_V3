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
        (0, supabase_1.supaSelect)('properties', '*', includeArchived ? undefined : { archived: false })
            .then(handle)
            .catch(() => {
            (0, supabase_1.supaSelect)('properties')
                .then(handle)
                .catch((err) => res.status(500).json({ message: err.message }));
        });
        return;
    }
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
    region: zod_1.z.string().optional(),
    area_sqm: zod_1.z.number().optional(),
    building_name: zod_1.z.string().optional(),
    building_facilities: zod_1.z.array(zod_1.z.string()).optional(),
    building_facility_floor: zod_1.z.string().optional(),
    building_contact_name: zod_1.z.string().optional(),
    building_contact_phone: zod_1.z.string().optional(),
    building_contact_email: zod_1.z.string().optional(),
    building_notes: zod_1.z.string().optional(),
    bed_config: zod_1.z.string().optional(),
    tv_model: zod_1.z.string().optional(),
    aircon_model: zod_1.z.string().optional(),
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
});
exports.router.post('/', (0, auth_1.requirePerm)('property.write'), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const autoCode = `PM-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-4)}`;
    const pFull = { id: (0, uuid_1.v4)(), code: parsed.data.code || autoCode, ...parsed.data };
    const baseKeys = ['id', 'address', 'type', 'capacity', 'region', 'area_sqm', 'building_name', 'building_facilities', 'building_facility_floor', 'building_contact_name', 'building_contact_phone', 'building_contact_email', 'building_notes', 'bed_config', 'tv_model', 'aircon_model', 'access_guide_link', 'keybox_location', 'keybox_code', 'garage_guide_link', 'floor', 'parking_type', 'parking_space', 'access_type', 'orientation', 'fireworks_view', 'notes', 'landlord_id'];
    const pBase = Object.fromEntries(Object.entries(pFull).filter(([k]) => baseKeys.includes(k)));
    const minimalKeys = ['id', 'address', 'type', 'capacity', 'region', 'area_sqm', 'notes'];
    const pMinimal = Object.fromEntries(Object.entries(pFull).filter(([k]) => minimalKeys.includes(k)));
    try {
        if (supabase_1.hasSupabase) {
            try {
                const row = await (0, supabase_1.supaInsert)('properties', pFull);
                (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                ['guest', 'spare_1', 'spare_2', 'other'].forEach(async (t) => {
                    try {
                        await require('../supabase').supaUpsertConflict('key_sets', { id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '' }, 'code,set_type');
                    }
                    catch (_a) {
                        if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                            store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                        }
                    }
                });
                return res.status(201).json(row);
            }
            catch (e) {
                try {
                    const row = await (0, supabase_1.supaInsert)('properties', pBase);
                    (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                    ['guest', 'spare_1', 'spare_2', 'other'].forEach(async (t) => {
                        try {
                            await require('../supabase').supaUpsertConflict('key_sets', { id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '' }, 'code,set_type');
                        }
                        catch (_a) {
                            if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                            }
                        }
                    });
                    return res.status(201).json(row);
                }
                catch (e2) {
                    const row = await (0, supabase_1.supaInsert)('properties', pMinimal);
                    (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                    ['guest', 'spare_1', 'spare_2', 'other'].forEach(async (t) => {
                        try {
                            await require('../supabase').supaUpsertConflict('key_sets', { id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '' }, 'code,set_type');
                        }
                        catch (_a) {
                            if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                            }
                        }
                    });
                    return res.status(201).json(row);
                }
            }
        }
        if (dbAdapter_1.hasPg) {
            const row = await (0, dbAdapter_1.pgInsert)('properties', pFull);
            (0, store_1.addAudit)('Property', row.id, 'create', null, row);
            ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                    store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                }
            });
            return res.status(201).json(row);
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
    const baseKeys = ['address', 'type', 'capacity', 'region', 'area_sqm', 'building_name', 'building_facilities', 'building_facility_floor', 'building_contact_name', 'building_contact_phone', 'building_contact_email', 'building_notes', 'bed_config', 'tv_model', 'aircon_model', 'access_guide_link', 'keybox_location', 'keybox_code', 'garage_guide_link', 'floor', 'parking_type', 'parking_space', 'access_type', 'orientation', 'fireworks_view', 'notes', 'landlord_id'];
    const bodyBase = Object.fromEntries(Object.entries(cleanedBody).filter(([k]) => baseKeys.includes(k)));
    try {
        if (supabase_1.hasSupabase) {
            const rows = await (0, supabase_1.supaSelect)('properties', '*', { id });
            const before = rows && rows[0];
            const minimalKeys = ['address', 'type', 'capacity', 'region', 'area_sqm', 'notes'];
            const cleaned = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'bedrooms'));
            const bodyMinimal = Object.fromEntries(Object.entries(cleaned).filter(([k]) => minimalKeys.includes(k)));
            try {
                const row = await (0, supabase_1.supaUpdate)('properties', id, cleaned);
                (0, store_1.addAudit)('Property', id, 'update', before, row);
                return res.json(row);
            }
            catch (e) {
                try {
                    const row = await (0, supabase_1.supaUpdate)('properties', id, bodyBase);
                    (0, store_1.addAudit)('Property', id, 'update', before, row);
                    return res.json(row);
                }
                catch (e2) {
                    const row = await (0, supabase_1.supaUpdate)('properties', id, bodyMinimal);
                    (0, store_1.addAudit)('Property', id, 'update', before, row);
                    return res.json(row);
                }
            }
        }
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('properties', '*', { id });
            const before = rows && rows[0];
            const row = await (0, dbAdapter_1.pgUpdate)('properties', id, cleanedBody);
            (0, store_1.addAudit)('Property', id, 'update', before, row);
            return res.json(row);
        }
        const p = store_1.db.properties.find((x) => x.id === id);
        if (!p)
            return res.status(404).json({ message: 'not found' });
        const beforeLocal = { ...p };
        Object.assign(p, cleanedBody);
        (0, store_1.addAudit)('Property', id, 'update', beforeLocal, p);
        return res.json(p);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.get('/:id', (req, res) => {
    const { id } = req.params;
    if (supabase_1.hasSupabase) {
        (0, supabase_1.supaSelect)('properties', '*', { id })
            .then((rows) => { if (!rows || !rows[0])
            return res.status(404).json({ message: 'not found' }); res.json(rows[0]); })
            .catch((err) => res.status(500).json({ message: err.message }));
        return;
    }
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgSelect)('properties', '*', { id })
            .then((rows) => { if (!rows || !rows[0])
            return res.status(404).json({ message: 'not found' }); res.json(rows[0]); })
            .catch((err) => res.status(500).json({ message: err.message }));
        return;
    }
    const p = store_1.db.properties.find((x) => x.id === id);
    if (!p)
        return res.status(404).json({ message: 'not found' });
    return res.json(p);
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('property.write'), async (req, res) => {
    const { id } = req.params;
    const actor = req.user;
    try {
        if (supabase_1.hasSupabase) {
            const rows = await (0, supabase_1.supaSelect)('properties', '*', { id });
            const before = rows && rows[0];
            try {
                const row = await (0, supabase_1.supaUpdate)('properties', id, { archived: true });
                (0, store_1.addAudit)('Property', id, 'archive', before, row, actor === null || actor === void 0 ? void 0 : actor.sub);
                return res.json({ id, archived: true });
            }
            catch (e) {
                return res.status(400).json({ message: '数据库缺少 archived 列，请先执行迁移：ALTER TABLE properties ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;' });
            }
        }
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
