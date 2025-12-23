"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const r2_1 = require("../r2");
const auth_1 = require("../auth");
const store_2 = require("../store");
const dbAdapter_1 = require("../dbAdapter");
const uuid_1 = require("uuid");
exports.router = (0, express_1.Router)();
exports.router.get('/', async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const sets = (await (0, dbAdapter_1.pgSelect)('key_sets')) || [];
            const items = (await (0, dbAdapter_1.pgSelect)('key_items')) || [];
            const grouped = sets.map((s) => ({ ...s, items: items.filter((it) => it.key_set_id === s.id) }));
            return res.json(grouped);
        }
        // Supabase branch removed
    }
    catch (e) { }
    const codes = (store_1.db.properties || []).map((p) => p.code).filter(Boolean);
    const types = ['guest', 'spare_1', 'spare_2', 'other'];
    codes.forEach((code) => {
        types.forEach((t) => {
            if (!store_1.db.keySets.find((s) => s.code === code && s.set_type === t)) {
                store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code, items: [] });
            }
        });
    });
    res.json(store_1.db.keySets);
});
const createSetSchema = zod_1.z.object({
    set_type: zod_1.z.enum(['guest', 'spare_1', 'spare_2', 'other']),
    code: zod_1.z.string().min(1).optional(),
    property_code: zod_1.z.string().min(1).optional(),
}).transform((v) => ({
    set_type: v.set_type,
    code: v.code || v.property_code || '',
}));
exports.router.post('/sets', (0, auth_1.requirePerm)('keyset.manage'), async (req, res) => {
    const parsed = createSetSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg) {
            const existed = (await (0, dbAdapter_1.pgSelect)('key_sets', '*', { code: parsed.data.code, set_type: parsed.data.set_type })) || [];
            if (existed && existed[0]) {
                const row = await (0, dbAdapter_1.pgUpdate)('key_sets', existed[0].id, { status: 'available', code: parsed.data.code });
                return res.status(200).json({ ...row, items: [] });
            }
            const row = await (0, dbAdapter_1.pgInsert)('key_sets', { id: (0, uuid_1.v4)(), set_type: parsed.data.set_type, status: 'available', code: parsed.data.code });
            return res.status(201).json({ ...row, items: [] });
        }
        // Supabase branch removed
    }
    catch (e) { }
    const set = { id: (0, uuid_1.v4)(), set_type: parsed.data.set_type, status: 'available', code: parsed.data.code || '', items: [] };
    store_1.db.keySets.push(set);
    res.status(201).json(set);
});
const flowSchema = zod_1.z.object({
    action: zod_1.z.enum(['borrow', 'return', 'lost', 'replace']),
    note: zod_1.z.string().optional(),
    new_code: zod_1.z.string().optional(),
});
exports.router.post('/sets/:id/flows', (0, auth_1.requirePerm)('key.flow'), async (req, res) => {
    const { id } = req.params;
    const parsed = flowSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('key_sets', '*', { id });
            const set = rows && rows[0];
            if (!set)
                return res.status(404).json({ message: 'set not found' });
            const oldCode = set.code;
            let newStatus = set.status;
            if (parsed.data.action === 'borrow')
                newStatus = 'in_transit';
            else if (parsed.data.action === 'return')
                newStatus = 'available';
            else if (parsed.data.action === 'lost')
                newStatus = 'lost';
            else if (parsed.data.action === 'replace')
                newStatus = 'replaced';
            const newCode = parsed.data.action === 'replace' && parsed.data.new_code ? parsed.data.new_code : set.code;
            const updated = await (0, dbAdapter_1.pgUpdate)('key_sets', id, { status: newStatus, code: newCode }) || { id, status: newStatus, code: newCode };
            const flow = await (0, dbAdapter_1.pgInsert)('key_flows', { id: require('uuid').v4(), key_set_id: id, action: parsed.data.action, timestamp: new Date().toISOString(), note: parsed.data.note, old_code: oldCode, new_code: newCode });
            (0, store_2.addAudit)('KeySet', id, 'flow', { status: set.status, code: oldCode }, { status: updated.status, code: updated.code });
            return res.status(201).json({ set: updated, flow });
        }
        // Supabase branch removed
    }
    catch (e) { }
    const set = store_1.db.keySets.find((s) => s.id === id);
    if (!set)
        return res.status(404).json({ message: 'set not found' });
    const oldCode = set.code;
    if (parsed.data.action === 'borrow')
        set.status = 'in_transit';
    else if (parsed.data.action === 'return')
        set.status = 'available';
    else if (parsed.data.action === 'lost')
        set.status = 'lost';
    else if (parsed.data.action === 'replace') {
        set.status = 'replaced';
        if (parsed.data.new_code)
            set.code = parsed.data.new_code;
    }
    const flow = {
        id: (0, uuid_1.v4)(),
        key_set_id: set.id,
        action: parsed.data.action,
        timestamp: new Date().toISOString(),
        note: parsed.data.note,
        old_code: oldCode,
        new_code: set.code,
    };
    store_1.db.keyFlows.push(flow);
    (0, store_2.addAudit)('KeySet', set.id, 'flow', { status: set.status, code: oldCode }, { status: set.status, code: set.code });
    res.status(201).json({ set, flow });
});
exports.router.get('/sets/:id/history', async (req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const flows = await (0, dbAdapter_1.pgSelect)('key_flows', '*', { key_set_id: req.params.id });
            return res.json(flows || []);
        }
        // Supabase branch removed
    }
    catch (e) { }
    const { id } = req.params;
    const flows = store_1.db.keyFlows.filter((f) => f.key_set_id === id);
    res.json(flows);
});
exports.router.get('/sets/:id', async (req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('key_sets', '*', { id: req.params.id });
            const set = rows && rows[0];
            if (!set)
                return res.status(404).json({ message: 'set not found' });
            const items = await (0, dbAdapter_1.pgSelect)('key_items', '*', { key_set_id: set.id });
            return res.json({ ...set, items: items || [] });
        }
        // Supabase branch removed
    }
    catch (e) { }
    const set = store_1.db.keySets.find((s) => s.id === req.params.id);
    if (!set)
        return res.status(404).json({ message: 'set not found' });
    res.json(set);
});
const upload = r2_1.hasR2 ? (0, multer_1.default)({ storage: multer_1.default.memoryStorage() }) : (0, multer_1.default)({ storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => cb(null, path_1.default.join(process.cwd(), 'uploads')),
        filename: (_req, file, cb) => {
            const ext = path_1.default.extname(file.originalname);
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        },
    }) });
const addItemSchema = zod_1.z.object({
    item_type: zod_1.z.enum(['key', 'fob']),
    code: zod_1.z.string().min(1),
    set_type: zod_1.z.enum(['guest', 'spare_1', 'spare_2', 'other']).optional(),
    property_code: zod_1.z.string().optional(),
});
exports.router.post('/sets/:id/items', (0, auth_1.requirePerm)('keyset.manage'), upload.single('photo'), async (req, res) => {
    const parsed = addItemSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg) {
            let rows = await (0, dbAdapter_1.pgSelect)('key_sets', '*', { id: req.params.id });
            let set = rows && rows[0];
            if (!set) {
                const local = store_1.db.keySets.find((s) => s.id === req.params.id);
                const code = (local === null || local === void 0 ? void 0 : local.code) || (req.body && req.body.property_code);
                const sType = (local === null || local === void 0 ? void 0 : local.set_type) || (req.body && req.body.set_type);
                if (!code || !sType)
                    return res.status(404).json({ message: 'set not found' });
                const byCode = await (0, dbAdapter_1.pgSelect)('key_sets', '*', { code, set_type: sType });
                set = byCode && byCode[0];
                if (!set) {
                    const { v4: uuidv4 } = require('uuid');
                    set = await (0, dbAdapter_1.pgInsert)('key_sets', { id: uuidv4(), set_type: sType, status: ((local === null || local === void 0 ? void 0 : local.status) || 'available'), code });
                }
            }
            const existed = await (0, dbAdapter_1.pgSelect)('key_items', '*', { key_set_id: set.id, item_type: parsed.data.item_type });
            const existing = existed && existed[0];
            if (existing) {
                let photoUrl = existing.photo_url;
                if (req.file) {
                    if (r2_1.hasR2 && req.file.buffer) {
                        const ext = path_1.default.extname(req.file.originalname);
                        const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                        photoUrl = await (0, r2_1.r2Upload)(key, req.file.mimetype || 'application/octet-stream', req.file.buffer);
                    }
                    else {
                        photoUrl = `/uploads/${req.file.filename}`;
                    }
                }
                const updated = await (0, dbAdapter_1.pgUpdate)('key_items', existing.id, { code: parsed.data.code, photo_url: photoUrl });
                return res.status(200).json(updated);
            }
            let photoUrl = null;
            if (req.file) {
                if (r2_1.hasR2 && req.file.buffer) {
                    const ext = path_1.default.extname(req.file.originalname);
                    const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                    photoUrl = await (0, r2_1.r2Upload)(key, req.file.mimetype || 'application/octet-stream', req.file.buffer);
                }
                else {
                    photoUrl = `/uploads/${req.file.filename}`;
                }
            }
            const created = await (0, dbAdapter_1.pgInsert)('key_items', { id: (0, uuid_1.v4)(), key_set_id: set.id, item_type: parsed.data.item_type, code: parsed.data.code, photo_url: photoUrl });
            return res.status(201).json(created);
        }
        // Supabase branch removed
    }
    catch (e) { }
    const set = store_1.db.keySets.find((s) => s.id === req.params.id);
    if (!set)
        return res.status(404).json({ message: 'set not found' });
    const existing = (set.items || []).find((it) => it.item_type === parsed.data.item_type);
    if (existing) {
        existing.code = parsed.data.code;
        if (req.file)
            existing.photo_url = `/uploads/${req.file.filename}`;
        return res.status(200).json(existing);
    }
    const created = { id: (0, uuid_1.v4)(), item_type: parsed.data.item_type, code: parsed.data.code, photo_url: req.file ? `/uploads/${req.file.filename}` : undefined };
    set.items.push(created);
    res.status(201).json(created);
});
exports.router.patch('/sets/:id/items/:itemId', (0, auth_1.requirePerm)('keyset.manage'), upload.single('photo'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const payload = {};
            if (req.body && req.body.code)
                payload.code = String(req.body.code);
            if (req.file) {
                if (r2_1.hasR2 && req.file.buffer) {
                    const ext = path_1.default.extname(req.file.originalname);
                    const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
                    payload.photo_url = await (0, r2_1.r2Upload)(key, req.file.mimetype || 'application/octet-stream', req.file.buffer);
                }
                else {
                    payload.photo_url = `/uploads/${req.file.filename}`;
                }
            }
            const item = await (0, dbAdapter_1.pgUpdate)('key_items', req.params.itemId, payload);
            return res.json(item);
        }
        // Supabase branch removed
    }
    catch (e) { }
    const set = store_1.db.keySets.find((s) => s.id === req.params.id);
    if (!set)
        return res.status(404).json({ message: 'set not found' });
    const item = set.items.find((it) => it.id === req.params.itemId);
    if (!item)
        return res.status(404).json({ message: 'item not found' });
    const code = (req.body && req.body.code) ? String(req.body.code) : undefined;
    if (code)
        item.code = code;
    if (req.file) {
        if (r2_1.hasR2 && req.file.buffer) {
            const ext = path_1.default.extname(req.file.originalname);
            const key = `key-items/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            item.photo_url = await (0, r2_1.r2Upload)(key, req.file.mimetype || 'application/octet-stream', req.file.buffer);
        }
        else {
            item.photo_url = `/uploads/${req.file.filename}`;
        }
    }
    res.json(item);
});
exports.router.delete('/sets/:id/items/:itemId', (0, auth_1.requirePerm)('keyset.manage'), async (req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            await (0, dbAdapter_1.pgDelete)('key_items', req.params.itemId);
            return res.json({ ok: true });
        }
        // Supabase branch removed
    }
    catch (e) { }
    const set = store_1.db.keySets.find((s) => s.id === req.params.id);
    if (!set)
        return res.status(404).json({ message: 'set not found' });
    const idx = set.items.findIndex((it) => it.id === req.params.itemId);
    if (idx === -1)
        return res.status(404).json({ message: 'item not found' });
    set.items.splice(idx, 1);
    res.json({ ok: true });
});
exports.router.get('/sets', async (req, res) => {
    const { property_code } = req.query;
    try {
        if (dbAdapter_1.hasPg) {
            if (!property_code) {
                const sets = await (0, dbAdapter_1.pgSelect)('key_sets');
                return res.json(sets);
            }
            const rows = await (0, dbAdapter_1.pgSelect)('key_sets', '*', { code: property_code });
            return res.json(rows);
        }
        // Supabase branch removed
    }
    catch (e) { }
    if (!property_code)
        return res.json(store_1.db.keySets);
    const types = ['guest', 'spare_1', 'spare_2', 'other'];
    types.forEach((t) => {
        if (!store_1.db.keySets.find((s) => s.code === property_code && s.set_type === t)) {
            store_1.db.keySets.push({ id: (0, uuid_1.v4)(), set_type: t, status: 'available', code: property_code, items: [] });
        }
    });
    res.json(store_1.db.keySets.filter(s => s.code === property_code));
});
