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
            let rows = await (0, dbAdapter_1.pgSelect)('role_permissions', '*', role_id ? { role_id } : undefined) || [];
            if (role_id && (!rows || rows.length === 0)) {
                const alt = role_id.startsWith('role.') ? role_id.replace(/^role\./, '') : `role.${role_id}`;
                const altRows = await (0, dbAdapter_1.pgSelect)('role_permissions', '*', { role_id: alt }) || [];
                if (altRows && altRows.length)
                    rows = altRows;
            }
            return res.json(rows);
        }
    }
    catch (e) {
        try {
            console.error(`[RBAC] outer error role_id=${role_id} message=${String((e === null || e === void 0 ? void 0 : e.message) || '')} stack=${String((e === null || e === void 0 ? void 0 : e.stack) || '')}`);
        }
        catch (_a) { }
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
        'menu.properties.deep_cleaning.visible': ['property_deep_cleaning'],
        'menu.properties.keys.visible': [], // 动作型留在“其他功能”
        'menu.landlords.visible': ['landlords'],
        'menu.cleaning.visible': ['cleaning_tasks'],
        'menu.finance.expenses.visible': ['property_expenses'],
        'menu.finance.recurring.visible': ['recurring_payments'],
        'menu.finance.orders.visible': ['order'],
        'menu.finance.company_overview.visible': ['finance_transactions', 'order', 'properties', 'property_expenses'],
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
            if (menuVisible === 'menu.finance.orders.visible' && (wantWrite || wantDelete || wantArchive)) {
                set.add('order.deduction.manage');
            }
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
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    await pgPool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
            id text PRIMARY KEY,
            role_id text NOT NULL,
            permission_code text NOT NULL,
            created_at timestamptz DEFAULT now()
          );`);
                    await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);');
                }
            }
            catch (e) {
                console.error(`[RBAC] schema ensure error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')} stack=${String((e === null || e === void 0 ? void 0 : e.stack) || '')}`);
            }
            const { pgPool } = require('../dbAdapter');
            const { v4: uuid } = require('uuid');
            if (!pgPool) {
                console.error('[RBAC] no pgPool');
                return res.status(500).json({ message: 'database not available' });
            }
            const client = await pgPool.connect();
            let inserted = 0;
            try {
                console.log(`[RBAC] txn begin role_id=${role_id}`);
                await client.query('BEGIN');
                const normalizedId = role_id.startsWith('role.') ? role_id : `role.${role_id}`;
                const altId = role_id.startsWith('role.') ? role_id.replace(/^role\./, '') : role_id;
                await client.query('DELETE FROM role_permissions WHERE role_id = $1 OR role_id = $2', [normalizedId, altId]);
                for (const code of Array.from(set)) {
                    const id = uuid();
                    const sql = 'INSERT INTO role_permissions (id, role_id, permission_code) VALUES ($1,$2,$3) ON CONFLICT (role_id, permission_code) DO NOTHING RETURNING id';
                    const r = await client.query(sql, [id, normalizedId, code]);
                    if (r && r.rows && r.rows[0])
                        inserted++;
                }
                await client.query('COMMIT');
                console.log(`[RBAC] write done role_id=${role_id} inserted=${inserted}`);
            }
            catch (e) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (_c) { }
                console.error(`[RBAC] write error role_id=${role_id} message=${String((e === null || e === void 0 ? void 0 : e.message) || '')} stack=${String((e === null || e === void 0 ? void 0 : e.stack) || '')}`);
                return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'write failed' });
            }
            finally {
                client.release();
            }
            return res.json({ ok: true });
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    store_1.db.rolePermissions = store_1.db.rolePermissions.filter(rp => rp.role_id !== role_id);
    Array.from(set).forEach(code => store_1.db.rolePermissions.push({ role_id, permission_code: code }));
    try {
        if (!dbAdapter_1.hasPg)
            (0, persistence_1.saveRolePermissions)(store_1.db.rolePermissions);
    }
    catch (_d) { }
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
            let rows = await (0, dbAdapter_1.pgSelect)('role_permissions', 'permission_code', { role_id: role.id }) || [];
            if (!rows || rows.length === 0) {
                const altRows = await (0, dbAdapter_1.pgSelect)('role_permissions', 'permission_code', { role_id: role.name }) || [];
                if (altRows && altRows.length)
                    rows = altRows;
            }
            const list = rows.map((r) => r.permission_code);
            const normalized = new Set(list);
            ['view', 'write', 'delete', 'archive'].forEach(act => {
                const plural = `orders.${act}`;
                const singular = `order.${act}`;
                if (normalized.has(plural) && !normalized.has(singular))
                    normalized.add(singular);
            });
            return res.json(Array.from(normalized));
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    const list = store_1.db.rolePermissions.filter(rp => rp.role_id === role.id).map(rp => rp.permission_code);
    const normalized = new Set(list);
    ['view', 'write', 'delete', 'archive'].forEach(act => {
        const plural = `orders.${act}`;
        const singular = `order.${act}`;
        if (normalized.has(plural) && !normalized.has(singular))
            normalized.add(singular);
    });
    return res.json(Array.from(normalized));
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
        // Supabase branch removed
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
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    await pgPool.query(`CREATE TABLE IF NOT EXISTS users (
            id text PRIMARY KEY,
            username text UNIQUE,
            email text UNIQUE,
            password_hash text NOT NULL,
            role text NOT NULL,
            created_at timestamptz DEFAULT now()
          );`);
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);');
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
                    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;');
                }
            }
            catch (e) {
                try {
                    console.error(`[RBAC] ensure users table error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                }
                catch (_a) { }
            }
            try {
                const created = await (0, dbAdapter_1.pgInsert)('users', row);
                return res.status(201).json(created || row);
            }
            catch (e) {
                const code = String((e && e.code) || '');
                const msg = String((e && e.message) || '');
                if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) {
                    return res.status(409).json({ message: '用户名或邮箱已存在' });
                }
                if (code === '42P01' || /relation .* does not exist/i.test(msg)) {
                    return res.status(500).json({ message: '数据库未初始化，请重试或联系管理员' });
                }
                return res.status(500).json({ message: msg || '创建失败' });
            }
        }
        // Supabase branch removed
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
        // Supabase branch removed
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
        // Supabase branch removed
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
