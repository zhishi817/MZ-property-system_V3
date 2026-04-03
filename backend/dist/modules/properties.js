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
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
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
    catch (_k) { }
    const autoCode = `PM-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Date.now().toString().slice(-4)}`;
    const actor = req.user;
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
            try {
                const row = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                    if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                        store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                    }
                });
                return res.status(201).json(row);
            }
            catch (e) {
                if (/column\s+"?listing_names"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    try {
                        await ((_a = require('../dbAdapter').pgPool) === null || _a === void 0 ? void 0 : _a.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_names jsonb'));
                        const row = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                        (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                        ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                            if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                            }
                        });
                        return res.status(201).json(row);
                    }
                    catch (e2) {
                        return res.status(500).json({ message: (e2 === null || e2 === void 0 ? void 0 : e2.message) || 'failed to add listing_names column' });
                    }
                }
                if (/column\s+"?airbnb_listing_name"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_b = require('../dbAdapter').pgPool) === null || _b === void 0 ? void 0 : _b.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_name text'));
                    const row2 = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                    (0, store_1.addAudit)('Property', row2.id, 'create', null, row2);
                    return res.status(201).json(row2);
                }
                if (/column\s+"?booking_listing_name"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_c = require('../dbAdapter').pgPool) === null || _c === void 0 ? void 0 : _c.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_name text'));
                    const row2 = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                    (0, store_1.addAudit)('Property', row2.id, 'create', null, row2);
                    return res.status(201).json(row2);
                }
                if (/column\s+"?airbnb_listing_id"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_d = require('../dbAdapter').pgPool) === null || _d === void 0 ? void 0 : _d.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS airbnb_listing_id text'));
                    const row2 = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                    (0, store_1.addAudit)('Property', row2.id, 'create', null, row2);
                    return res.status(201).json(row2);
                }
                if (/column\s+"?booking_listing_id"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_e = require('../dbAdapter').pgPool) === null || _e === void 0 ? void 0 : _e.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS booking_listing_id text'));
                    const row2 = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                    (0, store_1.addAudit)('Property', row2.id, 'create', null, row2);
                    return res.status(201).json(row2);
                }
                if (/column\s+"?biz_category"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    try {
                        await ((_f = require('../dbAdapter').pgPool) === null || _f === void 0 ? void 0 : _f.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text'));
                        const row = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                        (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                        ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                            if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                            }
                        });
                        return res.status(201).json(row);
                    }
                    catch (e3) {
                        return res.status(500).json({ message: (e3 === null || e3 === void 0 ? void 0 : e3.message) || 'failed to add biz_category column' });
                    }
                }
                if (/column\s+"?building_facility_other"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    try {
                        await ((_g = require('../dbAdapter').pgPool) === null || _g === void 0 ? void 0 : _g.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text'));
                        const row = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                        (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                        ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                            if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                            }
                        });
                        return res.status(201).json(row);
                    }
                    catch (e4) {
                        return res.status(500).json({ message: (e4 === null || e4 === void 0 ? void 0 : e4.message) || 'failed to add building_facility_other column' });
                    }
                }
                if (/column\s+"?bedroom_ac"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    try {
                        await ((_h = require('../dbAdapter').pgPool) === null || _h === void 0 ? void 0 : _h.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text'));
                        const row = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                        (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                        ['guest', 'spare_1', 'spare_2', 'other'].forEach((t) => {
                            if (!store_1.db.keySets.find((s) => s.code === (row.code || '') && s.set_type === t)) {
                                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: row.code || '', items: [] });
                            }
                        });
                        return res.status(201).json(row);
                    }
                    catch (e5) {
                        return res.status(500).json({ message: (e5 === null || e5 === void 0 ? void 0 : e5.message) || 'failed to add bedroom_ac column' });
                    }
                }
                if (/column\s+"?room_type_code"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    try {
                        await ((_j = require('../dbAdapter').pgPool) === null || _j === void 0 ? void 0 : _j.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text'));
                        const row = await (0, dbAdapter_1.pgInsert)('properties', pBase);
                        (0, store_1.addAudit)('Property', row.id, 'create', null, row);
                        return res.status(201).json(row);
                    }
                    catch (e6) {
                        return res.status(500).json({ message: (e6 === null || e6 === void 0 ? void 0 : e6.message) || 'failed to add room_type_code column' });
                    }
                }
                return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'create failed' });
            }
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
    var _a, _b, _c, _d, _e;
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
    const bodyBaseRaw = Object.fromEntries(Object.entries(cleanedBody).filter(([k]) => baseKeys.includes(k)));
    const bodyBase = { ...bodyBaseRaw, updated_at: new Date(), updated_by: (actor === null || actor === void 0 ? void 0 : actor.sub) || (actor === null || actor === void 0 ? void 0 : actor.username) || null };
    try {
        if (dbAdapter_1.hasPg) {
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
            try {
                const row = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase);
                (0, store_1.addAudit)('Property', id, 'update', before, row);
                return res.json(row);
            }
            catch (e) {
                if (/column\s+"?listing_names"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_a = require('../dbAdapter').pgPool) === null || _a === void 0 ? void 0 : _a.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_names jsonb'));
                    const row2 = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase);
                    (0, store_1.addAudit)('Property', id, 'update', before, row2);
                    return res.json(row2);
                }
                if (/column\s+"?biz_category"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_b = require('../dbAdapter').pgPool) === null || _b === void 0 ? void 0 : _b.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS biz_category text'));
                    const row3 = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase);
                    (0, store_1.addAudit)('Property', id, 'update', before, row3);
                    return res.json(row3);
                }
                if (/column\s+"?building_facility_other"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_c = require('../dbAdapter').pgPool) === null || _c === void 0 ? void 0 : _c.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_facility_other text'));
                    const row4 = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase);
                    (0, store_1.addAudit)('Property', id, 'update', before, row4);
                    return res.json(row4);
                }
                if (/column\s+"?bedroom_ac"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_d = require('../dbAdapter').pgPool) === null || _d === void 0 ? void 0 : _d.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS bedroom_ac text'));
                    const row5 = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase);
                    (0, store_1.addAudit)('Property', id, 'update', before, row5);
                    return res.json(row5);
                }
                if (/column\s+"?room_type_code"?\s+of\s+relation\s+"?properties"?\s+does\s+not\s+exist/i.test((e === null || e === void 0 ? void 0 : e.message) || '')) {
                    await ((_e = require('../dbAdapter').pgPool) === null || _e === void 0 ? void 0 : _e.query('ALTER TABLE properties ADD COLUMN IF NOT EXISTS room_type_code text'));
                    const row6 = await (0, dbAdapter_1.pgUpdate)('properties', id, bodyBase);
                    (0, store_1.addAudit)('Property', id, 'update', before, row6);
                    return res.json(row6);
                }
                throw e;
            }
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
            const rows = await (0, dbAdapter_1.pgSelect)('properties', '*', { id });
            if (!rows || !rows[0])
                return res.status(404).json({ message: 'not found' });
            const p = rows[0];
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
                catch (_a) { }
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
    return res.json(p);
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
