"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
// Supabase removed
const dbAdapter_1 = require("../dbAdapter");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const uuid_1 = require("uuid");
const managementFeeRules_1 = require("../lib/managementFeeRules");
exports.router = (0, express_1.Router)();
async function attachManagementFeeRules(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length || !dbAdapter_1.hasPg)
        return list;
    await (0, managementFeeRules_1.ensureManagementFeeRulesTable)();
    const byLandlord = await (0, managementFeeRules_1.listManagementFeeRulesByLandlordIds)(list.map((x) => String((x === null || x === void 0 ? void 0 : x.id) || '')));
    return list.map((row) => {
        const landlordId = String((row === null || row === void 0 ? void 0 : row.id) || '');
        const rules = byLandlord[landlordId] || [];
        const latestRate = rules[0] ? Number(rules[0].management_fee_rate || 0) : row === null || row === void 0 ? void 0 : row.management_fee_rate;
        return {
            ...row,
            management_fee_rate: latestRate == null ? row === null || row === void 0 ? void 0 : row.management_fee_rate : latestRate,
            management_fee_rules: rules,
        };
    });
}
exports.router.get('/', (req, res) => {
    const q = req.query || {};
    const includeArchived = String(q.include_archived || '').toLowerCase() === 'true';
    // Supabase branch removed
    if (dbAdapter_1.hasPg) {
        const filter = includeArchived ? {} : { archived: false };
        (0, dbAdapter_1.pgSelect)('landlords', '*', filter)
            .then(async (data) => {
            const rows = includeArchived ? (data || []) : (data || []).filter((x) => !x.archived);
            const withRules = await attachManagementFeeRules(rows);
            res.json(withRules);
        })
            .catch((err) => res.status(500).json({ message: err.message }));
        return;
    }
    return res.json((store_1.db.landlords || []).filter((l) => includeArchived ? true : !l.archived));
});
const schema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    phone: zod_1.z.string().optional(),
    emails: zod_1.z.array(zod_1.z.string()).optional(),
    email: zod_1.z.string().optional(),
    management_fee_rate: zod_1.z.number().optional(),
    payout_bsb: zod_1.z.string().optional(),
    payout_account: zod_1.z.string().optional(),
    property_ids: zod_1.z.array(zod_1.z.string()).optional(),
}).transform((v) => {
    const m = v;
    if (!Array.isArray(m.emails))
        m.emails = (m.email ? [m.email] : []);
    m.emails = (Array.isArray(m.emails) ? m.emails : []).map((s) => String(s || '').trim()).filter(Boolean);
    if (!m.email && Array.isArray(m.emails) && m.emails[0])
        m.email = m.emails[0];
    if (m.management_fee !== undefined && m.management_fee_rate === undefined)
        m.management_fee_rate = m.management_fee;
    return m;
});
exports.router.post('/', (0, auth_1.requirePerm)('landlord.manage'), (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const l = { id: (0, uuid_1.v4)(), ...parsed.data };
    // Supabase branch removed
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
    const bodyRaw = req.body;
    const body = { ...bodyRaw };
    if (Array.isArray(body.emails)) {
        body.emails = body.emails.map((s) => String(s || '').trim()).filter(Boolean);
        if (!body.email && body.emails[0])
            body.email = body.emails[0];
    }
    else if (body.email) {
        body.emails = [body.email];
    }
    try {
        // Supabase branch removed
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
    // Supabase branch removed
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgSelect)('landlords', '*', { id })
            .then(async (rows) => {
            if (!rows || !rows[0])
                return res.status(404).json({ message: 'not found' });
            const withRules = await attachManagementFeeRules(rows);
            res.json(withRules[0]);
        })
            .catch(err => res.status(500).json({ message: err.message }));
        return;
    }
    const l = store_1.db.landlords.find(x => x.id === id);
    if (!l)
        return res.status(404).json({ message: 'not found' });
    return res.json(l);
});
const ruleSchema = zod_1.z.object({
    effective_from_month: zod_1.z.string().trim().regex(/^\d{4}-\d{2}$/),
    management_fee_rate: zod_1.z.number().min(0).max(1),
    note: zod_1.z.string().trim().max(500).optional(),
});
exports.router.get('/:id/management-fee-rules', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    try {
        const { id } = req.params;
        if (!dbAdapter_1.hasPg)
            return res.json([]);
        await (0, managementFeeRules_1.ensureManagementFeeRulesTable)();
        const rows = await (0, managementFeeRules_1.listManagementFeeRulesByLandlordIds)([id]);
        return res.json(rows[String(id) || ''] || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'list_failed' });
    }
});
exports.router.post('/:id/management-fee-rules', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    var _a, _b;
    try {
        const { id } = req.params;
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        await (0, managementFeeRules_1.ensureManagementFeeRulesTable)();
        const parsed = ruleSchema.safeParse(req.body || {});
        if (!parsed.success)
            return res.status(400).json(parsed.error.format());
        const landlordRows = await (0, dbAdapter_1.pgSelect)('landlords', '*', { id });
        const landlord = Array.isArray(landlordRows) ? landlordRows[0] : null;
        if (!landlord)
            return res.status(404).json({ message: 'not found' });
        const v = parsed.data;
        const dup = await (0, dbAdapter_1.pgSelect)('landlord_management_fee_rules', '*', { landlord_id: id, effective_from_month: v.effective_from_month });
        if (Array.isArray(dup) && dup[0])
            return res.status(409).json({ message: 'duplicate_effective_from_month' });
        const actor = ((_a = req === null || req === void 0 ? void 0 : req.user) === null || _a === void 0 ? void 0 : _a.sub) || ((_b = req === null || req === void 0 ? void 0 : req.user) === null || _b === void 0 ? void 0 : _b.username) || null;
        const row = await (0, dbAdapter_1.pgInsert)('landlord_management_fee_rules', {
            id: (0, uuid_1.v4)(),
            landlord_id: id,
            effective_from_month: v.effective_from_month,
            management_fee_rate: v.management_fee_rate,
            note: v.note || null,
            created_by: actor,
        });
        await (0, managementFeeRules_1.syncLandlordCachedManagementFeeRate)(id);
        (0, store_1.addAudit)('LandlordManagementFeeRule', String((row === null || row === void 0 ? void 0 : row.id) || ''), 'create', null, row, actor);
        return res.status(201).json(row);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'create_failed' });
    }
});
exports.router.patch('/:id/management-fee-rules/:ruleId', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    var _a, _b;
    try {
        const { id, ruleId } = req.params;
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        await (0, managementFeeRules_1.ensureManagementFeeRulesTable)();
        const parsed = ruleSchema.partial().safeParse(req.body || {});
        if (!parsed.success)
            return res.status(400).json(parsed.error.format());
        const patch = parsed.data;
        if (patch.effective_from_month && !(0, managementFeeRules_1.isValidMonthKey)(patch.effective_from_month))
            return res.status(400).json({ message: 'invalid_effective_from_month' });
        const rows = await (0, dbAdapter_1.pgSelect)('landlord_management_fee_rules', '*', { id: ruleId, landlord_id: id });
        const before = Array.isArray(rows) ? rows[0] : null;
        if (!before)
            return res.status(404).json({ message: 'not found' });
        const structuralChange = (patch.effective_from_month !== undefined && String(patch.effective_from_month) !== String(before.effective_from_month || '')) ||
            (patch.management_fee_rate !== undefined && Number(patch.management_fee_rate || 0) !== Number(before.management_fee_rate || 0));
        if (structuralChange) {
            const used = await (0, managementFeeRules_1.ruleHasRecordedManagementFeeUsage)(id, String(before.effective_from_month || ''));
            if (used)
                return res.status(409).json({ message: 'rule_in_use' });
            if (patch.effective_from_month) {
                const dup = await (0, dbAdapter_1.pgSelect)('landlord_management_fee_rules', '*', { landlord_id: id, effective_from_month: patch.effective_from_month });
                const hit = Array.isArray(dup) ? dup.find((x) => String((x === null || x === void 0 ? void 0 : x.id) || '') !== String(ruleId)) : null;
                if (hit)
                    return res.status(409).json({ message: 'duplicate_effective_from_month' });
            }
        }
        const actor = ((_a = req === null || req === void 0 ? void 0 : req.user) === null || _a === void 0 ? void 0 : _a.sub) || ((_b = req === null || req === void 0 ? void 0 : req.user) === null || _b === void 0 ? void 0 : _b.username) || null;
        const row = await (0, dbAdapter_1.pgUpdate)('landlord_management_fee_rules', ruleId, {
            ...(patch.effective_from_month !== undefined ? { effective_from_month: patch.effective_from_month } : {}),
            ...(patch.management_fee_rate !== undefined ? { management_fee_rate: patch.management_fee_rate } : {}),
            ...(patch.note !== undefined ? { note: patch.note || null } : {}),
        });
        await (0, managementFeeRules_1.syncLandlordCachedManagementFeeRate)(id);
        (0, store_1.addAudit)('LandlordManagementFeeRule', String(ruleId), 'update', before, row, actor);
        return res.json(row);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'update_failed' });
    }
});
exports.router.delete('/:id/management-fee-rules/:ruleId', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    var _a, _b;
    try {
        const { id, ruleId } = req.params;
        if (!dbAdapter_1.hasPg)
            return res.status(400).json({ message: 'pg required' });
        await (0, managementFeeRules_1.ensureManagementFeeRulesTable)();
        const rows = await (0, dbAdapter_1.pgSelect)('landlord_management_fee_rules', '*', { id: ruleId, landlord_id: id });
        const before = Array.isArray(rows) ? rows[0] : null;
        if (!before)
            return res.status(404).json({ message: 'not found' });
        const all = await (0, managementFeeRules_1.listManagementFeeRulesByLandlordIds)([id]);
        const rules = all[String(id) || ''] || [];
        if (rules[0] && String(rules[0].id || '') !== String(ruleId))
            return res.status(409).json({ message: 'only_latest_rule_can_delete' });
        const used = await (0, managementFeeRules_1.ruleHasRecordedManagementFeeUsage)(id, String(before.effective_from_month || ''));
        if (used)
            return res.status(409).json({ message: 'rule_in_use' });
        const actor = ((_a = req === null || req === void 0 ? void 0 : req.user) === null || _a === void 0 ? void 0 : _a.sub) || ((_b = req === null || req === void 0 ? void 0 : req.user) === null || _b === void 0 ? void 0 : _b.username) || null;
        await (0, dbAdapter_1.pgDelete)('landlord_management_fee_rules', ruleId);
        await (0, managementFeeRules_1.syncLandlordCachedManagementFeeRate)(id);
        (0, store_1.addAudit)('LandlordManagementFeeRule', String(ruleId), 'delete', before, null, actor);
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'delete_failed' });
    }
});
exports.router.delete('/:id', (0, auth_1.requirePerm)('landlord.manage'), async (req, res) => {
    const { id } = req.params;
    const actor = req.user;
    try {
        // Supabase branch removed
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
