"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
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
