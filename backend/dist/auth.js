"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.users = void 0;
exports.login = login;
exports.auth = auth;
exports.requirePerm = requirePerm;
exports.me = me;
exports.setDeletePassword = setDeletePassword;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const store_1 = require("./store");
const dbAdapter_1 = require("./dbAdapter");
const supabase_1 = require("./supabase");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const SECRET = process.env.JWT_SECRET || 'dev-secret';
exports.users = {
    admin: { id: 'u-admin', username: 'admin', role: 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
    ops: { id: 'u-ops', username: 'ops', role: 'ops', password: process.env.OPS_PASSWORD || 'ops' },
    field: { id: 'u-field', username: 'field', role: 'field', password: process.env.FIELD_PASSWORD || 'field' },
};
async function login(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ message: 'missing credentials' });
    // DB first
    try {
        let row = null;
        if (dbAdapter_1.hasPg) {
            const byUser = await (0, dbAdapter_1.pgSelect)('users', '*', { username });
            row = byUser && byUser[0];
            if (!row) {
                const byEmail = await (0, dbAdapter_1.pgSelect)('users', '*', { email: username });
                row = byEmail && byEmail[0];
            }
        }
        if (!row && supabase_1.hasSupabase) {
            const byUser = await (0, supabase_1.supaSelect)('users', '*', { username });
            row = byUser && byUser[0];
            if (!row) {
                const byEmail = await (0, supabase_1.supaSelect)('users', '*', { email: username });
                row = byEmail && byEmail[0];
            }
        }
        if (row) {
            const ok = await bcryptjs_1.default.compare(password, row.password_hash);
            if (!ok)
                return res.status(401).json({ message: 'invalid credentials' });
            const token = jsonwebtoken_1.default.sign({ sub: row.id, role: row.role, username: row.username }, SECRET, { expiresIn: '7d' });
            return res.json({ token, role: row.role });
        }
    }
    catch (e) {
        // fall through to static
    }
    // Fallback static users
    const u = exports.users[username];
    if (!u || u.password !== password)
        return res.status(401).json({ message: 'invalid credentials' });
    const token = jsonwebtoken_1.default.sign({ sub: u.id, role: u.role, username: u.username }, SECRET, { expiresIn: '7d' });
    res.json({ token, role: u.role });
}
function auth(req, _res, next) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) {
        const token = h.slice(7);
        try {
            ;
            req.user = jsonwebtoken_1.default.verify(token, SECRET);
        }
        catch { }
    }
    next();
}
function requirePerm(code) {
    return (req, res, next) => {
        const user = req.user;
        if (!user)
            return res.status(401).json({ message: 'unauthorized' });
        const role = user.role;
        if (!(0, store_1.roleHasPermission)(role, code))
            return res.status(403).json({ message: 'forbidden' });
        next();
    };
}
function me(req, res) {
    const user = req.user;
    if (!user)
        return res.status(401).json({ message: 'unauthorized' });
    res.json({ role: user.role, username: user.username });
}
async function setDeletePassword(req, res) {
    const user = req.user;
    if (!user)
        return res.status(401).json({ message: 'unauthorized' });
    if (user.role !== 'admin')
        return res.status(403).json({ message: 'forbidden' });
    const { password } = req.body || {};
    if (!password)
        return res.status(400).json({ message: 'missing password' });
    const hash = await bcryptjs_1.default.hash(password, 10);
    try {
        if (dbAdapter_1.hasPg) {
            const { Pool } = require('pg');
            const { pgUpdate } = require('./dbAdapter');
            const row = await pgUpdate('users', user.sub, { delete_password_hash: hash });
            return res.json({ ok: true });
        }
        if (supabase_1.hasSupabase) {
            const { supaUpdate } = require('./supabase');
            await supaUpdate('users', user.sub, { delete_password_hash: hash });
            return res.json({ ok: true });
        }
        return res.status(200).json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
}
