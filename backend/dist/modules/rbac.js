"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const supabase_1 = require("../supabase");
const dbAdapter_1 = require("../dbAdapter");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
exports.router = (0, express_1.Router)();
exports.router.get('/roles', (req, res) => {
    res.json(store_1.db.roles);
});
exports.router.get('/permissions', (req, res) => {
    res.json(store_1.db.permissions);
});
exports.router.get('/role-permissions', (req, res) => {
    const { role_id } = req.query;
    const list = role_id ? store_1.db.rolePermissions.filter(rp => rp.role_id === role_id) : store_1.db.rolePermissions;
    res.json(list);
});
const setSchema = zod_1.z.object({ role_id: zod_1.z.string(), permissions: zod_1.z.array(zod_1.z.string()) });
exports.router.post('/role-permissions', (0, auth_1.requirePerm)('rbac.manage'), (req, res) => {
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { role_id, permissions } = parsed.data;
    // remove old
    store_1.db.rolePermissions = store_1.db.rolePermissions.filter(rp => rp.role_id !== role_id);
    permissions.forEach(code => store_1.db.rolePermissions.push({ role_id, permission_code: code }));
    res.json({ ok: true });
});
// Users management
const userCreateSchema = zod_1.z.object({ username: zod_1.z.string().min(1), email: zod_1.z.string().email(), role: zod_1.z.string().min(1), password: zod_1.z.string().min(6) });
const userUpdateSchema = zod_1.z.object({ username: zod_1.z.string().optional(), email: zod_1.z.string().email().optional(), role: zod_1.z.string().optional(), password: zod_1.z.string().min(6).optional() });
exports.router.get('/users', (0, auth_1.requirePerm)('rbac.manage'), async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('users') || [];
            return res.json(rows);
        }
        if (supabase_1.hasSupabase) {
            const rows = await (0, supabase_1.supaSelect)('users') || [];
            return res.json(rows);
        }
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.post('/users', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const parsed = userCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const hash = await bcryptjs_1.default.hash(parsed.data.password, 10);
    const row = { id: uuid(), username: parsed.data.username, email: parsed.data.email, role: parsed.data.role, password_hash: hash };
    try {
        if (dbAdapter_1.hasPg) {
            const created = await (0, dbAdapter_1.pgInsert)('users', row);
            return res.status(201).json(created || row);
        }
        if (supabase_1.hasSupabase) {
            const created = await (0, supabase_1.supaInsert)('users', row);
            return res.status(201).json(created || row);
        }
        return res.status(201).json(row);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.patch('/users/:id', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const parsed = userUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const payload = { ...parsed.data };
    if (payload.password) {
        payload.password_hash = await bcryptjs_1.default.hash(payload.password, 10);
        delete payload.password;
    }
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            const updated = await (0, dbAdapter_1.pgUpdate)('users', id, payload);
            return res.json(updated || { id, ...payload });
        }
        if (supabase_1.hasSupabase) {
            const updated = await (0, supabase_1.supaUpdate)('users', id, payload);
            return res.json(updated || { id, ...payload });
        }
        return res.json({ id, ...payload });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.delete('/users/:id', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            await (0, dbAdapter_1.pgDelete)('users', id);
            return res.json({ ok: true });
        }
        if (supabase_1.hasSupabase) {
            await (0, supabase_1.supaDelete)('users', id);
            return res.json({ ok: true });
        }
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
