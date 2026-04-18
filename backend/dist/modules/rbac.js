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
const permissionsCatalog_1 = require("../permissionsCatalog");
const notificationRules_1 = require("../services/notificationRules");
exports.router = (0, express_1.Router)();
function expandPermissionSynonyms(codes) {
    const acts = ['view', 'write', 'delete', 'archive'];
    const s = new Set((codes || []).map((c) => String(c || '')).filter(Boolean));
    acts.forEach((a) => {
        if (s.has(`orders.${a}`) && !s.has(`order.${a}`))
            s.add(`order.${a}`);
        if (s.has(`order.${a}`) && !s.has(`orders.${a}`))
            s.add(`orders.${a}`);
        if (s.has(`properties.${a}`) && !s.has(`property.${a}`))
            s.add(`property.${a}`);
        if (s.has(`property.${a}`) && !s.has(`properties.${a}`))
            s.add(`properties.${a}`);
    });
    return Array.from(s);
}
async function resolveRolePermissionBinding(rawRoleId) {
    var _a;
    const reqId = String(rawRoleId || '').trim();
    const normalizedId = reqId.startsWith('role.') ? reqId : `role.${reqId}`;
    const altId = reqId.startsWith('role.') ? reqId.replace(/^role\./, '') : reqId;
    const variants = new Set([reqId, normalizedId, altId].filter(Boolean));
    let targetRoleId = normalizedId;
    if (dbAdapter_1.hasPg) {
        try {
            await ensureRolesTable();
            const { pgPool } = require('../dbAdapter');
            if (pgPool) {
                const found = await pgPool.query('SELECT id, name FROM roles WHERE id = ANY($1::text[]) OR name = ANY($1::text[]) LIMIT 1', [Array.from(variants)]);
                const row = (_a = found === null || found === void 0 ? void 0 : found.rows) === null || _a === void 0 ? void 0 : _a[0];
                if (row) {
                    const id = String(row.id || '').trim();
                    const name = String(row.name || '').trim();
                    if (id) {
                        targetRoleId = id;
                        variants.add(id);
                        variants.add(id.replace(/^role\./, ''));
                    }
                    if (name) {
                        variants.add(name);
                        variants.add(`role.${name}`);
                    }
                }
            }
        }
        catch (_b) { }
    }
    return { normalizedId, altId, targetRoleId, variants: Array.from(variants) };
}
async function ensureRolesTable() {
    if (!dbAdapter_1.hasPg)
        return;
    try {
        const { pgPool } = require('../dbAdapter');
        if (!pgPool)
            return;
        await pgPool.query(`CREATE TABLE IF NOT EXISTS roles (
      id text PRIMARY KEY,
      name text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now()
    );`);
        await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_roles_name ON roles(name);');
    }
    catch (_a) { }
}
exports.router.get('/roles', async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            await ensureRolesTable();
            let rows = await (0, dbAdapter_1.pgSelect)('roles', '*') || [];
            if (!rows || rows.length === 0) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    if (pgPool) {
                        for (const r of store_1.db.roles) {
                            await pgPool.query('INSERT INTO roles(id, name, description) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING', [r.id, r.name, r.description || null]);
                        }
                    }
                }
                catch (_a) { }
                rows = await (0, dbAdapter_1.pgSelect)('roles', '*') || [];
            }
            return res.json(rows);
        }
    }
    catch (_b) { }
    return res.json(store_1.db.roles);
});
const roleCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(64).transform((s) => s.trim()),
    description: zod_1.z.string().max(200).optional().transform((s) => (typeof s === 'string' ? s.trim() : s)),
});
exports.router.post('/roles', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const parsed = roleCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const name = parsed.data.name;
    if (!/^[a-z][a-z0-9_]*$/i.test(name))
        return res.status(400).json({ message: '角色名仅支持字母/数字/下划线，且需以字母开头' });
    const role = { id: `role.${name}`, name, description: parsed.data.description || undefined };
    try {
        if (dbAdapter_1.hasPg) {
            await ensureRolesTable();
            try {
                const created = await (0, dbAdapter_1.pgInsert)('roles', role);
                return res.status(201).json(created || role);
            }
            catch (e) {
                const code = String((e && e.code) || '');
                const msg = String((e && e.message) || '');
                if (code === '23505' || /duplicate key value|unique constraint/i.test(msg)) {
                    return res.status(409).json({ message: '角色名已存在' });
                }
                return res.status(500).json({ message: msg || '创建失败' });
            }
        }
        if (store_1.db.roles.find((r) => r.name === name || r.id === role.id))
            return res.status(409).json({ message: '角色名已存在' });
        store_1.db.roles.push(role);
        try {
            (0, persistence_1.saveRoles)(store_1.db.roles);
        }
        catch (_a) { }
        return res.status(201).json(role);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
const roleUpdateSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(64).optional().transform((s) => (typeof s === 'string' ? s.trim() : s)),
    description: zod_1.z.string().max(200).optional().transform((s) => (typeof s === 'string' ? s.trim() : s)),
});
exports.router.patch('/roles/:id', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    var _a, _b;
    const parsed = roleUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const reqId = String(req.params.id || '').trim();
    if (!reqId)
        return res.status(400).json({ message: 'id required' });
    const normalizedId = reqId.startsWith('role.') ? reqId : `role.${reqId}`;
    const altId = reqId.startsWith('role.') ? reqId.replace(/^role\./, '') : reqId;
    const nextName = parsed.data.name;
    if (nextName && !/^[a-z][a-z0-9_]*$/i.test(nextName)) {
        return res.status(400).json({ message: '角色名仅支持字母/数字/下划线，且需以字母开头' });
    }
    try {
        if (dbAdapter_1.hasPg) {
            await ensureRolesTable();
            const { pgPool } = require('../dbAdapter');
            if (!pgPool)
                return res.status(500).json({ message: 'database not available' });
            const found = await pgPool.query('SELECT * FROM roles WHERE id = $1 OR id = $2 LIMIT 1', [normalizedId, altId]);
            const old = (_a = found === null || found === void 0 ? void 0 : found.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!old)
                return res.status(404).json({ message: '角色不存在' });
            const oldId = String(old.id);
            const oldName = String(old.name);
            const newName = nextName ? String(nextName) : oldName;
            const newId = nextName ? `role.${newName}` : oldId;
            const payload = {};
            if (parsed.data.description !== undefined)
                payload.description = parsed.data.description;
            if (nextName)
                payload.name = newName;
            if (!Object.keys(payload).length && newId === oldId)
                return res.json(old);
            const client = await pgPool.connect();
            try {
                await client.query('BEGIN');
                if (newId !== oldId) {
                    await client.query('UPDATE roles SET id=$1, name=$2, description=$3 WHERE id=$4', [
                        newId,
                        newName,
                        parsed.data.description !== undefined ? parsed.data.description : old.description,
                        oldId,
                    ]);
                    try {
                        await client.query('UPDATE users SET role=$1 WHERE role=$2', [newName, oldName]);
                    }
                    catch (_c) { }
                    try {
                        await client.query(`CREATE TABLE IF NOT EXISTS user_roles (
                user_id text NOT NULL,
                role_name text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (user_id, role_name)
              );`);
                        await client.query('UPDATE user_roles SET role_name=$1 WHERE role_name=$2', [newName, oldName]);
                    }
                    catch (_d) { }
                    try {
                        await client.query('UPDATE role_permissions SET role_id=$1 WHERE role_id=$2 OR role_id=$3 OR role_id=$4', [newId, oldId, oldId.replace(/^role\./, ''), oldName]);
                    }
                    catch (_e) { }
                }
                else {
                    const nextDesc = parsed.data.description !== undefined ? parsed.data.description : old.description;
                    await client.query('UPDATE roles SET name=$1, description=$2 WHERE id=$3', [newName, nextDesc, oldId]);
                }
                const after = await client.query('SELECT * FROM roles WHERE id = $1 LIMIT 1', [newId]);
                await client.query('COMMIT');
                return res.json(((_b = after === null || after === void 0 ? void 0 : after.rows) === null || _b === void 0 ? void 0 : _b[0]) || { ...old, ...payload, id: newId, name: newName });
            }
            catch (e) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (_f) { }
                const code = String((e === null || e === void 0 ? void 0 : e.code) || '');
                const msg = String((e === null || e === void 0 ? void 0 : e.message) || '');
                if (code === '23505' || /duplicate key value|unique constraint/i.test(msg))
                    return res.status(409).json({ message: '角色名已存在' });
                return res.status(500).json({ message: msg || '更新失败' });
            }
            finally {
                client.release();
            }
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    const idx = store_1.db.roles.findIndex((r) => r.id === normalizedId || r.id === altId || r.name === altId);
    if (idx < 0)
        return res.status(404).json({ message: '角色不存在' });
    const old = store_1.db.roles[idx];
    const oldId = old.id;
    const oldName = old.name;
    const newName = nextName ? String(nextName) : oldName;
    const newId = nextName ? `role.${newName}` : oldId;
    if (newId !== oldId && store_1.db.roles.some((r, i) => i !== idx && (r.id === newId || r.name === newName)))
        return res.status(409).json({ message: '角色名已存在' });
    store_1.db.roles[idx] = { ...old, id: newId, name: newName, description: parsed.data.description !== undefined ? parsed.data.description : old.description };
    if (newId !== oldId) {
        store_1.db.rolePermissions = store_1.db.rolePermissions.map((rp) => ((rp.role_id === oldId || rp.role_id === oldId.replace(/^role\./, '') || rp.role_id === oldName) ? { ...rp, role_id: newId } : rp));
        try {
            (0, persistence_1.saveRolePermissions)(store_1.db.rolePermissions);
        }
        catch (_g) { }
    }
    try {
        (0, persistence_1.saveRoles)(store_1.db.roles);
    }
    catch (_h) { }
    return res.json(store_1.db.roles[idx]);
});
exports.router.delete('/roles/:id', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    var _a, _b, _c;
    const reqId = String(req.params.id || '').trim();
    if (!reqId)
        return res.status(400).json({ message: 'id required' });
    const normalizedId = reqId.startsWith('role.') ? reqId : `role.${reqId}`;
    const altId = reqId.startsWith('role.') ? reqId.replace(/^role\./, '') : reqId;
    try {
        if (dbAdapter_1.hasPg) {
            await ensureRolesTable();
            const { pgPool } = require('../dbAdapter');
            if (!pgPool)
                return res.status(500).json({ message: 'database not available' });
            const found = await pgPool.query('SELECT * FROM roles WHERE id = $1 OR id = $2 LIMIT 1', [normalizedId, altId]);
            const role = (_a = found === null || found === void 0 ? void 0 : found.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!role)
                return res.status(404).json({ message: '角色不存在' });
            const roleId = String(role.id || '');
            const roleName = String(role.name || '');
            if (roleId === 'role.admin' || roleName === 'admin')
                return res.status(400).json({ message: 'admin 角色不可删除' });
            try {
                const cntRes = await pgPool.query('SELECT COUNT(*)::int AS cnt FROM users WHERE role = $1', [roleName]);
                const cnt = Number(((_c = (_b = cntRes === null || cntRes === void 0 ? void 0 : cntRes.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.cnt) || 0);
                if (cnt > 0)
                    return res.status(409).json({ message: `该角色仍被 ${cnt} 个用户使用，无法删除` });
            }
            catch (_d) { }
            const variants = Array.from(new Set([roleId, roleId.replace(/^role\./, ''), roleName, normalizedId, altId].filter(Boolean)));
            const client = await pgPool.connect();
            try {
                await client.query('BEGIN');
                try {
                    await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1)', [variants]);
                }
                catch (_e) { }
                await client.query('DELETE FROM roles WHERE id = $1', [roleId]);
                await client.query('COMMIT');
                return res.json({ ok: true });
            }
            catch (e) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (_f) { }
                return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'delete failed' });
            }
            finally {
                client.release();
            }
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    const idx = store_1.db.roles.findIndex((r) => r.id === normalizedId || r.id === altId || r.name === altId);
    if (idx < 0)
        return res.status(404).json({ message: '角色不存在' });
    const role = store_1.db.roles[idx];
    const roleId = String(role.id || '');
    const roleName = String(role.name || '');
    if (roleId === 'role.admin' || roleName === 'admin')
        return res.status(400).json({ message: 'admin 角色不可删除' });
    const cnt = (store_1.db.users || []).filter((u) => String((u === null || u === void 0 ? void 0 : u.role) || '') === roleName).length;
    if (cnt > 0)
        return res.status(409).json({ message: `该角色仍被 ${cnt} 个用户使用，无法删除` });
    const variants = new Set([roleId, roleId.replace(/^role\./, ''), roleName, normalizedId, altId].filter(Boolean));
    store_1.db.rolePermissions = store_1.db.rolePermissions.filter((rp) => !variants.has(String(rp.role_id || '')));
    store_1.db.roles.splice(idx, 1);
    try {
        (0, persistence_1.saveRolePermissions)(store_1.db.rolePermissions);
    }
    catch (_g) { }
    try {
        (0, persistence_1.saveRoles)(store_1.db.roles);
    }
    catch (_h) { }
    return res.json({ ok: true });
});
exports.router.get('/permissions', (req, res) => {
    res.json(store_1.db.permissions.map((p) => {
        const code = String(p.code || '');
        const meta = (0, permissionsCatalog_1.getPermissionMeta)(code);
        return { ...p, name: (p === null || p === void 0 ? void 0 : p.name) || meta.displayName, meta };
    }));
});
exports.router.get('/role-permissions', async (req, res) => {
    const { role_id } = req.query;
    try {
        if (dbAdapter_1.hasPg) {
            let rows = [];
            if (role_id) {
                const binding = await resolveRolePermissionBinding(String(role_id));
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    const rr = await pgPool.query('SELECT * FROM role_permissions WHERE role_id = ANY($1::text[])', [binding.variants]);
                    rows = (rr === null || rr === void 0 ? void 0 : rr.rows) || [];
                }
            }
            else {
                rows = await (0, dbAdapter_1.pgSelect)('role_permissions', '*') || [];
            }
            if (role_id) {
                const codes = expandPermissionSynonyms(rows.map((r) => String((r === null || r === void 0 ? void 0 : r.permission_code) || '')));
                return res.json(codes.map((permission_code) => ({ role_id, permission_code })));
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
    if (role_id) {
        const codes = expandPermissionSynonyms(store_1.db.rolePermissions.filter(rp => rp.role_id === role_id).map(rp => rp.permission_code));
        return res.json(codes.map((permission_code) => ({ role_id, permission_code })));
    }
    res.json(store_1.db.rolePermissions);
});
exports.router.get('/notification-rules', (0, auth_1.requirePerm)('rbac.manage'), async (_req, res) => {
    try {
        const roles = await (async () => {
            if (dbAdapter_1.hasPg) {
                await ensureRolesTable();
                const rows = await (0, dbAdapter_1.pgSelect)('roles', '*') || [];
                return rows.map((x) => ({ id: String(x.id || ''), name: String(x.name || ''), description: x.description == null ? null : String(x.description || '') }));
            }
            return (store_1.db.roles || []).map((x) => ({ id: String(x.id || ''), name: String(x.name || ''), description: x.description == null ? null : String(x.description || '') }));
        })();
        const users = await (async () => {
            if (dbAdapter_1.hasPg) {
                const { pgPool } = require('../dbAdapter');
                if (!pgPool)
                    return [];
                const ur = await pgPool.query(`SELECT u.id::text AS id,
                  COALESCE(NULLIF(TRIM(u.username), ''), NULLIF(TRIM(u.legal_name), ''), NULLIF(TRIM(u.email), ''), u.id::text) AS username,
                  u.role::text AS role,
                  COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL), NULL), ARRAY[]::text[]) AS roles
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id::text
           GROUP BY u.id, u.username, u.legal_name, u.email, u.role
           ORDER BY username ASC`);
                return ((ur === null || ur === void 0 ? void 0 : ur.rows) || []).map((x) => ({
                    id: String(x.id || ''),
                    username: String(x.username || ''),
                    role: String(x.role || ''),
                    roles: Array.isArray(x.roles) ? x.roles.map((v) => String(v || '').trim()).filter(Boolean) : [],
                }));
            }
            return (store_1.db.users || []).map((x) => ({ id: String(x.id || ''), username: String(x.username || x.email || x.id || ''), role: String(x.role || ''), roles: [String(x.role || '')].filter(Boolean) }));
        })();
        const rules = await (0, notificationRules_1.listNotificationRules)();
        return res.json({ rules, roles, users, event_types: notificationRules_1.ALL_NOTIFICATION_EVENT_TYPES, audience_options: notificationRules_1.NOTIFICATION_AUDIENCE_OPTIONS });
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'load_failed') });
    }
});
exports.router.get('/notification-rules/:eventType', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const eventType = String(req.params.eventType || '').trim();
    if (!(0, notificationRules_1.isManagedNotificationEventType)(eventType))
        return res.status(404).json({ message: 'event_type_not_found' });
    try {
        return res.json(await (0, notificationRules_1.getNotificationRule)(eventType));
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'load_failed') });
    }
});
const notificationRuleSetSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    note: zod_1.z.string().max(500).nullable().optional(),
    selectors: zod_1.z.array(zod_1.z.object({
        recipient_type: zod_1.z.enum(['role', 'audience', 'user']),
        recipient_value: zod_1.z.string().min(1).max(120),
    })).optional(),
});
exports.router.put('/notification-rules/:eventType', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    var _a;
    const eventType = String(req.params.eventType || '').trim();
    if (!(0, notificationRules_1.isManagedNotificationEventType)(eventType))
        return res.status(404).json({ message: 'event_type_not_found' });
    const parsed = notificationRuleSetSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        const saved = await (0, notificationRules_1.saveNotificationRule)(eventType, parsed.data, String(((_a = req === null || req === void 0 ? void 0 : req.user) === null || _a === void 0 ? void 0 : _a.sub) || '').trim() || null);
        return res.json(saved);
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'save_failed') });
    }
});
exports.router.post('/notification-rules/:eventType/reset', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    var _a;
    const eventType = String(req.params.eventType || '').trim();
    if (!(0, notificationRules_1.isManagedNotificationEventType)(eventType))
        return res.status(404).json({ message: 'event_type_not_found' });
    try {
        return res.json(await (0, notificationRules_1.resetNotificationRule)(eventType, String(((_a = req === null || req === void 0 ? void 0 : req.user) === null || _a === void 0 ? void 0 : _a.sub) || '').trim() || null));
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'reset_failed') });
    }
});
const setSchema = zod_1.z.object({ role_id: zod_1.z.string(), permissions: zod_1.z.array(zod_1.z.string().min(1)) });
exports.router.post('/role-permissions', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { role_id, permissions } = parsed.data;
    const set = new Set(expandPermissionSynonyms(permissions));
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
    const finalCodes = expandPermissionSynonyms(Array.from(set));
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
            const binding = await resolveRolePermissionBinding(role_id);
            const client = await pgPool.connect();
            let inserted = 0;
            try {
                console.log(`[RBAC] txn begin role_id=${role_id}`);
                await client.query('BEGIN');
                await client.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [binding.variants]);
                for (const code of finalCodes) {
                    const id = uuid();
                    const sql = 'INSERT INTO role_permissions (id, role_id, permission_code) VALUES ($1,$2,$3) ON CONFLICT (role_id, permission_code) DO NOTHING RETURNING id';
                    const r = await client.query(sql, [id, binding.targetRoleId, code]);
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
    finalCodes.forEach(code => store_1.db.rolePermissions.push({ role_id, permission_code: code }));
    try {
        if (!dbAdapter_1.hasPg)
            (0, persistence_1.saveRolePermissions)(store_1.db.rolePermissions);
    }
    catch (_d) { }
    res.json({ ok: true });
});
exports.router.delete('/role-permissions', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    var _a;
    const role_id = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.role_id) || '').trim();
    if (!role_id)
        return res.status(400).json({ message: 'role_id required' });
    const binding = await resolveRolePermissionBinding(role_id);
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            if (!pgPool)
                return res.status(500).json({ message: 'database not available' });
            try {
                await pgPool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
          id text PRIMARY KEY,
          role_id text NOT NULL,
          permission_code text NOT NULL,
          created_at timestamptz DEFAULT now()
        );`);
                await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);');
            }
            catch (_b) { }
            await pgPool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [binding.variants]);
            return res.json({ ok: true });
        }
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
    const variants = new Set(binding.variants);
    store_1.db.rolePermissions = store_1.db.rolePermissions.filter((rp) => !variants.has(String(rp.role_id || '')));
    try {
        if (!dbAdapter_1.hasPg)
            (0, persistence_1.saveRolePermissions)(store_1.db.rolePermissions);
    }
    catch (_c) { }
    return res.json({ ok: true });
});
// current user's permissions
exports.router.get('/my-permissions', auth_1.auth, async (req, res) => {
    var _a;
    const user = req.user;
    if (!user)
        return res.status(401).json({ message: 'unauthorized' });
    const roleNames = Array.from(new Set((Array.isArray(user.roles) ? user.roles : [user.role])
        .map((x) => String(x || '').trim())
        .filter(Boolean)));
    if (roleNames.includes('admin')) {
        const all = (store_1.db.permissions || []).map((p) => String((p === null || p === void 0 ? void 0 : p.code) || '')).filter(Boolean);
        const list = expandPermissionSynonyms(all);
        return res.json(Array.from(new Set(list)));
    }
    const out = new Set();
    try {
        if (dbAdapter_1.hasPg) {
            const rolePerms = async (roleName) => {
                var _a;
                let roleId = (_a = store_1.db.roles.find(r => r.name === roleName)) === null || _a === void 0 ? void 0 : _a.id;
                try {
                    await ensureRolesTable();
                    const rr = (await (0, dbAdapter_1.pgSelect)('roles', 'id,name', { name: roleName })) || [];
                    if (rr && rr[0] && rr[0].id)
                        roleId = String(rr[0].id);
                }
                catch (_b) { }
                const roleIds = Array.from(new Set([roleId, roleName].filter(Boolean)));
                if (!roleIds.length)
                    return [];
                let rows = [];
                for (const rid of roleIds) {
                    const r0 = (await (0, dbAdapter_1.pgSelect)('role_permissions', 'permission_code', { role_id: rid })) || [];
                    if (r0 && r0.length) {
                        rows = r0;
                        break;
                    }
                }
                if (!rows || rows.length === 0) {
                    const altCandidates = roleIds.flatMap((rid) => (String(rid).startsWith('role.') ? [String(rid).replace(/^role\./, '')] : [`role.${rid}`]));
                    for (const rid of altCandidates) {
                        const r0 = (await (0, dbAdapter_1.pgSelect)('role_permissions', 'permission_code', { role_id: rid })) || [];
                        if (r0 && r0.length) {
                            rows = r0;
                            break;
                        }
                    }
                }
                return rows.map((r) => String(r.permission_code || '')).filter(Boolean);
            };
            try {
                await (0, dbAdapter_1.pgSelect)('roles', 'id', { id: 'role.admin' });
            }
            catch (_b) { }
            for (const rn of roleNames) {
                const codes = await rolePerms(rn);
                const list = expandPermissionSynonyms(codes);
                for (const c of list)
                    out.add(String(c));
            }
            ;
            ['view', 'write', 'delete', 'archive'].forEach(act => {
                const plural = `orders.${act}`;
                const singular = `order.${act}`;
                if (out.has(plural) && !out.has(singular))
                    out.add(singular);
            });
            return res.json(Array.from(out));
        }
    }
    catch (_c) {
        return res.json([]);
    }
    for (const rn of roleNames) {
        const roleId = (_a = store_1.db.roles.find(r => r.name === rn)) === null || _a === void 0 ? void 0 : _a.id;
        if (!roleId)
            continue;
        const list = expandPermissionSynonyms(store_1.db.rolePermissions.filter(rp => rp.role_id === roleId).map(rp => rp.permission_code));
        for (const c of list)
            out.add(String(c));
    }
    ;
    ['view', 'write', 'delete', 'archive'].forEach(act => {
        const plural = `orders.${act}`;
        const singular = `order.${act}`;
        if (out.has(plural) && !out.has(singular))
            out.add(singular);
    });
    return res.json(Array.from(out));
});
// Users management
function normalizeAuPhone(v) {
    const raw = String(v || '').trim();
    if (!raw)
        return null;
    let s = raw.replace(/[\s()-]/g, '').replace(/-+/g, '');
    if (s.startsWith('00'))
        s = `+${s.slice(2)}`;
    if (s.startsWith('+')) {
        const d = s.slice(1).replace(/\D/g, '');
        if (!d.startsWith('61'))
            return null;
        const rest = d.slice(2);
        if (!/^\d{9}$/.test(rest))
            return null;
        return `+61${rest}`;
    }
    const d = s.replace(/\D/g, '');
    if (d.startsWith('61')) {
        const rest = d.slice(2);
        if (!/^\d{9}$/.test(rest))
            return null;
        return `+61${rest}`;
    }
    if (d.startsWith('0') && d.length === 10)
        return `+61${d.slice(1)}`;
    return null;
}
const userCreateSchema = zod_1.z.object({
    username: zod_1.z.string().min(1),
    email: zod_1.z.preprocess((v) => {
        if (v === null || v === undefined)
            return undefined;
        const s = String(v).trim();
        return s ? s : undefined;
    }, zod_1.z.string().email().optional()),
    phone_au: zod_1.z.string().min(1),
    role: zod_1.z.string().min(1),
    roles: zod_1.z.array(zod_1.z.string().min(1)).optional(),
    password: zod_1.z.string().min(6),
    color_hex: zod_1.z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).transform((v) => {
    const phone = normalizeAuPhone(v.phone_au);
    if (!phone)
        throw new Error('invalid_phone_au');
    return { ...v, phone_au: phone };
});
const userUpdateSchema = zod_1.z.object({
    username: zod_1.z.string().optional(),
    email: zod_1.z.preprocess((v) => {
        if (v === null || v === undefined)
            return undefined;
        const s = String(v).trim();
        return s ? s : undefined;
    }, zod_1.z.string().email().optional()),
    phone_au: zod_1.z.string().optional(),
    role: zod_1.z.string().optional(),
    roles: zod_1.z.array(zod_1.z.string().min(1)).optional(),
    password: zod_1.z.string().min(6).optional(),
    color_hex: zod_1.z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).transform((v) => {
    const out = { ...v };
    if (out.phone_au !== undefined) {
        const phone = normalizeAuPhone(out.phone_au);
        if (!phone)
            throw new Error('invalid_phone_au');
        out.phone_au = phone;
    }
    return out;
});
async function ensureUserRolesTable() {
    if (!dbAdapter_1.hasPg)
        return;
    const { pgPool } = require('../dbAdapter');
    if (!pgPool)
        return;
    await pgPool.query(`CREATE TABLE IF NOT EXISTS user_roles (
      user_id text NOT NULL,
      role_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, role_name)
    );`);
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);');
    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles(role_name);');
}
function normalizeRolesInput(params) {
    var _a;
    const primary = String((_a = params.role) !== null && _a !== void 0 ? _a : '').trim();
    const rolesArr = Array.isArray(params.roles) ? params.roles : [];
    const roles = rolesArr.map((x) => String(x || '').trim()).filter(Boolean);
    if (primary)
        roles.unshift(primary);
    const uniq = Array.from(new Set(roles));
    return { role: primary, roles: uniq };
}
exports.router.get('/users', (0, auth_1.requirePerm)('rbac.manage'), async (_req, res) => {
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            if (!pgPool)
                return res.json([]);
            await ensureUserRolesTable().catch(() => null);
            const r = await pgPool.query(`SELECT
           u.*,
           COALESCE(
             ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
             ARRAY[]::text[]
           ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id::text
         GROUP BY u.id
         ORDER BY u.created_at DESC NULLS LAST, u.username ASC`);
            const rows = ((r === null || r === void 0 ? void 0 : r.rows) || []).map((x) => ({ ...x, roles: Array.isArray(x.roles) ? x.roles : [] }));
            return res.json(rows);
        }
        // Supabase branch removed
        return res.json([]);
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
exports.router.get('/users/:id', (0, auth_1.requirePerm)('rbac.manage'), async (req, res) => {
    var _a;
    const id = String(req.params.id || '').trim();
    if (!id)
        return res.status(400).json({ message: 'id required' });
    try {
        if (dbAdapter_1.hasPg) {
            const { pgPool } = require('../dbAdapter');
            if (!pgPool)
                return res.status(500).json({ message: 'pg not available' });
            await ensureUserRolesTable().catch(() => null);
            const r = await pgPool.query(`SELECT
           u.*,
           COALESCE(
             ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
             ARRAY[]::text[]
           ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id::text
         WHERE u.id::text = $1
         GROUP BY u.id
         LIMIT 1`, [id]);
            const row = ((_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!row)
                return res.status(404).json({ message: 'user not found' });
            return res.json({ ...row, roles: Array.isArray(row.roles) ? row.roles : [] });
        }
        const row = store_1.db.users.find((u) => String(u.id) === id);
        if (!row)
            return res.status(404).json({ message: 'user not found' });
        return res.json(row);
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
    const norm = normalizeRolesInput({ role: parsed.data.role, roles: parsed.data.roles });
    const rolePrimary = norm.role || norm.roles[0] || parsed.data.role;
    const rolesAll = Array.from(new Set([rolePrimary, ...norm.roles].map((x) => String(x || '').trim()).filter(Boolean)));
    const row = { id: uuid(), username: parsed.data.username, email: parsed.data.email, phone_au: parsed.data.phone_au, role: rolePrimary, password_hash: hash, color_hex: parsed.data.color_hex || '#3B82F6' };
    try {
        if (dbAdapter_1.hasPg) {
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    await pgPool.query(`CREATE TABLE IF NOT EXISTS users (
            id text PRIMARY KEY,
            username text UNIQUE,
            email text UNIQUE,
            phone_au text,
            password_hash text NOT NULL,
            role text NOT NULL,
            color_hex text NOT NULL DEFAULT '#3B82F6',
            created_at timestamptz DEFAULT now()
          );`);
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);');
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_phone_au ON users(phone_au);');
                    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_password_hash text;');
                    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6';`);
                    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_au text;');
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
                try {
                    await ensureUserRolesTable();
                    const { pgPool } = require('../dbAdapter');
                    if (pgPool && rolesAll.length) {
                        for (const rn of rolesAll) {
                            await pgPool.query('INSERT INTO user_roles (user_id, role_name) VALUES ($1,$2) ON CONFLICT (user_id, role_name) DO NOTHING', [String(row.id), rn]);
                        }
                    }
                }
                catch (_b) { }
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
    var _a, _b;
    const parsed = userUpdateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const didResetPassword = !!parsed.data.password;
    const payload = { ...parsed.data };
    if (payload.password) {
        payload.password_hash = await bcryptjs_1.default.hash(payload.password, 10);
        delete payload.password;
    }
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg) {
            try {
                const { pgPool } = require('../dbAdapter');
                if (pgPool) {
                    await pgPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS color_hex text NOT NULL DEFAULT '#3B82F6';`);
                    await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_au text;');
                    await pgPool.query('CREATE INDEX IF NOT EXISTS idx_users_phone_au ON users(phone_au);');
                }
            }
            catch (_c) { }
            const rolesPayload = payload.roles;
            delete payload.roles;
            if (rolesPayload !== undefined) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    if (pgPool) {
                        const cur = await pgPool.query('SELECT role FROM users WHERE id::text=$1 LIMIT 1', [String(id)]);
                        const curRole = String(((_b = (_a = cur === null || cur === void 0 ? void 0 : cur.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.role) || '').trim();
                        const norm = normalizeRolesInput({ role: payload.role != null ? payload.role : curRole, roles: rolesPayload });
                        const nextPrimary = String(payload.role || '').trim() || (norm.roles.includes(curRole) ? curRole : (norm.roles[0] || curRole));
                        payload.role = nextPrimary;
                        const rolesAll = Array.from(new Set([nextPrimary, ...norm.roles].map((x) => String(x || '').trim()).filter(Boolean)));
                        await ensureUserRolesTable();
                        await pgPool.query('DELETE FROM user_roles WHERE user_id::text=$1', [String(id)]);
                        for (const rn of rolesAll) {
                            await pgPool.query('INSERT INTO user_roles (user_id, role_name) VALUES ($1,$2) ON CONFLICT (user_id, role_name) DO NOTHING', [String(id), rn]);
                        }
                    }
                }
                catch (_d) { }
            }
            const updated = await (0, dbAdapter_1.pgUpdate)('users', id, payload);
            if (payload.role) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    if (pgPool) {
                        await ensureUserRolesTable();
                        await pgPool.query('INSERT INTO user_roles (user_id, role_name) VALUES ($1,$2) ON CONFLICT (user_id, role_name) DO NOTHING', [String(id), String(payload.role)]);
                    }
                }
                catch (_e) { }
            }
            if (didResetPassword) {
                try {
                    const { pgPool } = require('../dbAdapter');
                    if (pgPool) {
                        await pgPool.query(`CREATE TABLE IF NOT EXISTS sessions (
              id text PRIMARY KEY,
              user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created_at timestamptz DEFAULT now(),
              last_seen_at timestamptz DEFAULT now(),
              expires_at timestamptz NOT NULL,
              revoked boolean NOT NULL DEFAULT false,
              ip text,
              user_agent text,
              device text
            );`);
                        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);');
                        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);');
                        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id) WHERE revoked = false;');
                        await pgPool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [id]);
                    }
                }
                catch (_f) { }
            }
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
