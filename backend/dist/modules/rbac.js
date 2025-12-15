"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const persistence_1 = require("../persistence");
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
exports.router.get('/role-permissions', async (req, res) => {
    const { role_id } = req.query;
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('role_permissions', '*', role_id ? { role_id } : undefined) || [];
            return res.json(rows);
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    const list = role_id ? store_1.db.rolePermissions.filter(rp => rp.role_id === role_id) : store_1.db.rolePermissions;
    res.json(list);
});
const setSchema = zod_1.z.object({ role_id: zod_1.z.string(), permissions: zod_1.z.array(zod_1.z.string().min(1)) });
exports.router.post('/role-permissions', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { role_id, permissions } = parsed.data;
    const set = new Set(permissions);
    const submenuToResources = {
        'menu.properties.list.visible': ['properties'],
        'menu.properties.maintenance.visible': ['property_maintenance'],
        'menu.properties.keys.visible': [], // 动作型留在“其他功能”
        'menu.landlords.visible': ['landlords'],
        'menu.cleaning.visible': ['cleaning_tasks'],
        'menu.finance.expenses.visible': ['property_expenses'],
        'menu.finance.recurring.visible': ['recurring_payments'],
        'menu.finance.orders.visible': ['orders'],
        'menu.finance.company_overview.visible': ['finance_transactions', 'orders', 'properties', 'property_expenses'],
        'menu.finance.company_revenue.visible': ['company_incomes', 'company_expenses'],
        'menu.cms.visible': ['cms_pages'],
        'menu.rbac.visible': ['users'],
    };
    // 仅当勾选“查看数据/编辑/删除/归档”时派生资源权限；父级 group 不派生
    // 注：可见本身不派生任何资源 view
    Object.entries(submenuToResources).forEach(([menuVisible, resources]) => {
        const base = menuVisible.replace(/\.visible$/, '');
        const wantView = set.has(`${base}.view`);
        const wantWrite = set.has(`${base}.write`);
        const wantDelete = set.has(`${base}.delete`);
        const wantArchive = set.has(`${base}.archive`);
        if (wantView || wantWrite || wantDelete || wantArchive) {
            // 自动确保可见
            set.add(menuVisible);
            resources.forEach((res) => {
                if (wantView)
                    set.add(`${res}.view`);
                if (wantWrite)
                    set.add(`${res}.write`);
                if (wantDelete)
                    set.add(`${res}.delete`);
                if (wantArchive)
                    set.add(`${res}.archive`);
            });
            // 将菜单层面的操作位移除，仅保留资源位与 .visible
            set.delete(`${base}.view`);
            set.delete(`${base}.write`);
            set.delete(`${base}.delete`);
            set.delete(`${base}.archive`);
        }
    });
    try {
        if (dbAdapter_1.hasPg) {
            try {
                const conn = process.env.DATABASE_URL || '';
                let host = '';
                let dbname = '';
                try {
                    const u = new URL(conn);
                    host = u.hostname;
                    dbname = (u.pathname || '').replace(/^\//, '');
                }
                catch (_a) { }
                console.log(`[RBAC] write start env=${process.env.NODE_ENV} hasPg=${dbAdapter_1.hasPg} host=${host} db=${dbname} role_id=${role_id} count=${set.size}`);
            }
            catch (_b) { }
            const { pgRunInTransaction, pgDeleteWhere, pgInsertOnConflictDoNothing } = require('../dbAdapter');
            const { v4: uuid } = require('uuid');
            await pgRunInTransaction(async (client) => {
                try {
                    await pgDeleteWhere('role_permissions', { role_id }, client);
                    let inserted = 0;
                    for (const code of Array.from(set)) {
                        const r = await pgInsertOnConflictDoNothing('role_permissions', { id: uuid(), role_id, permission_code: code }, ['role_id', 'permission_code'], client);
                        if (r)
                            inserted++;
                    }
                    console.log(`[RBAC] write done role_id=${role_id} inserted=${inserted}`);
                }
                catch (e) {
                    console.error(`[RBAC] write error role_id=${role_id} message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    throw e;
                }
            });
            return res.json({ ok: true });
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    store_1.db.rolePermissions = store_1.db.rolePermissions.filter(rp => rp.role_id !== role_id);
    Array.from(set).forEach(code => store_1.db.rolePermissions.push({ role_id, permission_code: code }));
    try {
        if (!dbAdapter_1.hasPg && !supabase_1.hasSupabase)
            (0, persistence_1.saveRolePermissions)(store_1.db.rolePermissions);
    }
    catch (_c) { }
    res.json({ ok: true });
});
// current user's permissions
exports.router.get('/my-permissions', auth_1.auth, async (req, res) => {
    const user = req.user;
    if (!user)
        return res.status(401).json({ message: 'unauthorized' });
    const roleName = String(user.role || '');
    const role = store_1.db.roles.find(r => r.name === roleName);
    if (!role)
        return res.json([]);
    try {
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('role_permissions', 'permission_code', { role_id: role.id }) || [];
            const list = rows.map((r) => r.permission_code);
            return res.json(list);
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    const list = store_1.db.rolePermissions.filter(rp => rp.role_id === role.id).map(rp => rp.permission_code);
    return res.json(list);
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
