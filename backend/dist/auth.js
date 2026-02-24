"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.users = void 0;
exports.login = login;
exports.auth = auth;
exports.requirePerm = requirePerm;
exports.requireAnyPerm = requireAnyPerm;
exports.allowCronTokenOrPerm = allowCronTokenOrPerm;
exports.me = me;
exports.setDeletePassword = setDeletePassword;
exports.requireResourcePerm = requireResourcePerm;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const uuid_1 = require("uuid");
const store_1 = require("./store");
const dbAdapter_1 = require("./dbAdapter");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const SESSION_MAX_AGE_HOURS = Number(process.env.SESSION_MAX_AGE_HOURS || 5);
const SESSION_IDLE_TIMEOUT_MINUTES = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES || 60);
const sessionCache = new Map();
const sessionLastSeenUpdateAt = new Map();
const permsCache = new Map();
const SESSION_CACHE_TTL_MS = Number(process.env.SESSION_CACHE_TTL_MS || 15000);
const SESSION_TOUCH_INTERVAL_MS = Number(process.env.SESSION_TOUCH_INTERVAL_MS || 60000);
const PERM_CACHE_TTL_MS = Number(process.env.PERM_CACHE_TTL_MS || 5 * 60 * 1000);
exports.users = {
    admin: { id: 'u-admin', username: 'admin', role: 'admin', password: process.env.ADMIN_PASSWORD || 'admin' },
    cs: { id: 'u-cs', username: 'cs', role: 'customer_service', password: process.env.CS_PASSWORD || 'cs' },
    cleaning_mgr: { id: 'u-cleaning-mgr', username: 'cleaning_mgr', role: 'cleaning_manager', password: process.env.CLEANING_MGR_PASSWORD || 'cleaning_mgr' },
    cleaner: { id: 'u-cleaner', username: 'cleaner', role: 'cleaner_inspector', password: process.env.CLEANER_PASSWORD || 'cleaner' },
    finance: { id: 'u-finance', username: 'finance', role: 'finance_staff', password: process.env.FINANCE_PASSWORD || 'finance' },
    inventory: { id: 'u-inventory', username: 'inventory', role: 'inventory_manager', password: process.env.INVENTORY_PASSWORD || 'inventory' },
    maintenance: { id: 'u-maintenance', username: 'maintenance', role: 'maintenance_staff', password: process.env.MAINTENANCE_PASSWORD || 'maintenance' },
};
async function login(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ message: 'missing credentials' });
    const isDev = String(process.env.APP_ENV || '').toLowerCase() === 'dev' && String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
    // DB first（Postgres；容错）
    let row = null;
    // Supabase branch removed
    if (!row && dbAdapter_1.hasPg) {
        try {
            const byUser = await (0, dbAdapter_1.pgSelect)('users', '*', { username });
            row = byUser && byUser[0];
            if (!row) {
                const byEmail = await (0, dbAdapter_1.pgSelect)('users', '*', { email: username });
                row = byEmail && byEmail[0];
            }
        }
        catch (_a) { }
    }
    if (row) {
        let ok = false;
        try {
            const hash = typeof row.password_hash === 'string' ? row.password_hash : '';
            if (hash)
                ok = await bcryptjs_1.default.compare(password, hash);
        }
        catch (_b) { }
        if (!ok && isDev) {
            const alias = { ops: 'cs', field: 'cleaner' };
            const k = alias[String(username)] || String(username);
            const u = exports.users[k];
            if (u && u.password === String(password)) {
                ok = true;
                try {
                    if (dbAdapter_1.hasPg) {
                        const { pgPool } = require('./dbAdapter');
                        if (pgPool) {
                            const newHash = await bcryptjs_1.default.hash(String(password), 10);
                            await pgPool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [newHash, row.id]);
                            row.password_hash = newHash;
                        }
                    }
                }
                catch (_c) { }
            }
        }
        if (!ok)
            return res.status(401).json({ message: 'invalid credentials' });
        let sid = null;
        if (dbAdapter_1.hasPg) {
            try {
                const { pgRunInTransaction } = require('./dbAdapter');
                const sidNew = await pgRunInTransaction(async (client) => {
                    var _a;
                    await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [row.id]);
                    const newSid = (0, uuid_1.v4)();
                    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 3600 * 1000).toISOString();
                    const ua = String(req.headers['user-agent'] || '');
                    const ip = String((req.ip || ((_a = req.socket) === null || _a === void 0 ? void 0 : _a.remoteAddress) || '')).slice(0, 255);
                    await client.query('INSERT INTO sessions(id, user_id, created_at, last_seen_at, expires_at, revoked, ip, user_agent) VALUES($1,$2,now(),now(),$3,false,$4,$5)', [newSid, row.id, expiresAt, ip, ua]);
                    return newSid;
                });
                sid = String(sidNew);
            }
            catch (_d) { }
        }
        const payload = { sub: row.id, role: row.role, username: row.username };
        if (sid)
            payload.sid = sid;
        const token = jsonwebtoken_1.default.sign(payload, SECRET, { expiresIn: `${SESSION_MAX_AGE_HOURS}h` });
        return res.json({ token, role: row.role });
    }
    if (!row && store_1.db.users.length) {
        const byUser = store_1.db.users.find(u => u.username === username);
        const byEmail = store_1.db.users.find(u => u.email === username);
        const found = byUser || byEmail;
        if (found) {
            const ok = found.password_hash ? await bcryptjs_1.default.compare(password, found.password_hash) : false;
            if (!ok)
                return res.status(401).json({ message: 'invalid credentials' });
            let sid = null;
            if (dbAdapter_1.hasPg) {
                try {
                    const { pgRunInTransaction } = require('./dbAdapter');
                    const sidNew = await pgRunInTransaction(async (client) => {
                        var _a;
                        await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [found.id]);
                        const newSid = (0, uuid_1.v4)();
                        const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 3600 * 1000).toISOString();
                        const ua = String(req.headers['user-agent'] || '');
                        const ip = String((req.ip || ((_a = req.socket) === null || _a === void 0 ? void 0 : _a.remoteAddress) || '')).slice(0, 255);
                        await client.query('INSERT INTO sessions(id, user_id, created_at, last_seen_at, expires_at, revoked, ip, user_agent) VALUES($1,$2,now(),now(),$3,false,$4,$5)', [newSid, found.id, expiresAt, ip, ua]);
                        return newSid;
                    });
                    sid = String(sidNew);
                }
                catch (_e) { }
            }
            const payload = { sub: found.id, role: found.role, username: found.username || found.email };
            if (sid)
                payload.sid = sid;
            const token = jsonwebtoken_1.default.sign(payload, SECRET, { expiresIn: `${SESSION_MAX_AGE_HOURS}h` });
            return res.json({ token, role: found.role });
        }
    }
    // Fallback static users
    const u = exports.users[username];
    if (!u || u.password !== password)
        return res.status(401).json({ message: 'invalid credentials' });
    const token = jsonwebtoken_1.default.sign({ sub: u.id, role: u.role, username: u.username }, SECRET, { expiresIn: `${SESSION_MAX_AGE_HOURS}h` });
    res.json({ token, role: u.role });
}
async function auth(req, res, next) {
    const hRaw = String(req.headers.authorization || '');
    const h = hRaw.trim();
    let token = '';
    if (/^bearer\s+/i.test(h))
        token = h.replace(/^bearer\s+/i, '').trim();
    if (!token) {
        const cookie = String(req.headers.cookie || '');
        const m = cookie.match(/(?:^|;\s*)auth=([^;]+)/);
        if (m && m[1]) {
            try {
                token = decodeURIComponent(m[1]);
            }
            catch (_a) {
                token = m[1];
            }
        }
    }
    if (token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, SECRET);
            const sid = decoded === null || decoded === void 0 ? void 0 : decoded.sid;
            if (sid && dbAdapter_1.hasPg) {
                try {
                    const now = Date.now();
                    const cached = sessionCache.get(String(sid));
                    let s = null;
                    if (cached && now - cached.at <= SESSION_CACHE_TTL_MS) {
                        s = cached.row;
                    }
                    else {
                        const rows = await (0, dbAdapter_1.pgSelect)('sessions', '*', { id: sid });
                        s = rows && rows[0];
                        sessionCache.set(String(sid), { row: s || null, at: now });
                    }
                    if (!s)
                        return res.status(401).json({ message: 'session not found' });
                    const exp = new Date(s.expires_at).getTime();
                    const last = new Date(s.last_seen_at || s.created_at).getTime();
                    const idleMs = SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;
                    if (s.revoked)
                        return res.status(401).json({ message: 'session revoked' });
                    if (exp < now)
                        return res.status(401).json({ message: 'session expired' });
                    if (now - last > idleMs)
                        return res.status(401).json({ message: 'session idle timeout' });
                    req.user = decoded;
                    try {
                        const lastTouch = sessionLastSeenUpdateAt.get(String(sid)) || 0;
                        if (now - lastTouch >= SESSION_TOUCH_INTERVAL_MS) {
                            const { pgPool } = require('./dbAdapter');
                            if (pgPool)
                                await pgPool.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [sid]);
                            sessionLastSeenUpdateAt.set(String(sid), now);
                        }
                    }
                    catch (_b) { }
                }
                catch (e) {
                    ;
                    req.user = decoded;
                    req.session_unverified = true;
                }
            }
            else {
                ;
                req.user = decoded;
            }
        }
        catch (_c) { }
    }
    next();
}
async function hasAnyPermViaPg(roleName, codes) {
    var _a;
    const now = Date.now();
    const cached = permsCache.get(roleName);
    if (cached && now - cached.at <= PERM_CACHE_TTL_MS) {
        for (const c of codes) {
            if (cached.okSet.has(c))
                return true;
        }
        return false;
    }
    const { pgPool } = require('./dbAdapter');
    if (!pgPool)
        return false;
    let roleId = (_a = store_1.db.roles.find(r => r.name === roleName)) === null || _a === void 0 ? void 0 : _a.id;
    try {
        const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName]);
        if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id)
            roleId = String(r0.rows[0].id);
    }
    catch (_b) { }
    const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)));
    const okSet = new Set();
    try {
        const r = await pgPool.query('SELECT permission_code FROM role_permissions WHERE role_id = ANY($1::text[])', [roleIds]);
        for (const row of ((r === null || r === void 0 ? void 0 : r.rows) || []))
            okSet.add(String(row.permission_code));
    }
    catch (_c) { }
    permsCache.set(roleName, { okSet, at: now });
    for (const c of codes) {
        if (okSet.has(c))
            return true;
    }
    return false;
}
function requirePerm(code) {
    return async (req, res, next) => {
        const user = req.user;
        if (!user)
            return res.status(401).json({ message: 'unauthorized' });
        const roleName = String(user.role || '');
        if (roleName === 'admin')
            return next();
        let ok = false;
        try {
            const { hasPg, pgPool } = require('./dbAdapter');
            if (hasPg && pgPool) {
                ok = await hasAnyPermViaPg(roleName, [code]);
            }
        }
        catch (_a) { }
        if (!ok)
            ok = (0, store_1.roleHasPermission)(roleName, code);
        if (!ok)
            return res.status(403).json({ message: 'forbidden' });
        next();
    };
}
function requireAnyPerm(codes) {
    return async (req, res, next) => {
        const user = req.user;
        if (!user)
            return res.status(401).json({ message: 'unauthorized' });
        const roleName = String(user.role || '');
        if (roleName === 'admin')
            return next();
        let ok = false;
        try {
            const { hasPg, pgPool } = require('./dbAdapter');
            if (hasPg && pgPool) {
                ok = await hasAnyPermViaPg(roleName, codes);
            }
        }
        catch (_a) { }
        if (!ok)
            ok = codes.some((c) => (0, store_1.roleHasPermission)(roleName, c));
        if (!ok)
            return res.status(403).json({ message: 'forbidden' });
        next();
    };
}
function allowCronTokenOrPerm(code) {
    return (req, res, next) => {
        const h = String(req.headers.authorization || '');
        const hasBearer = h.startsWith('Bearer ');
        const token = hasBearer ? h.slice(7) : '';
        const cron = String(process.env.JOB_CRON_TOKEN || '');
        if (cron && token && token === cron) {
            return next();
        }
        const user = req.user;
        if (!user)
            return res.status(401).json({ message: 'unauthorized' });
        const role = String(user.role || '');
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
        // Supabase branch removed
        return res.status(200).json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
}
function requireResourcePerm(kind) {
    return async (req, res, next) => {
        var _a, _b;
        const user = req.user;
        if (!user)
            return res.status(401).json({ message: 'unauthorized' });
        const roleName = String(user.role || '');
        const resource = String(((_a = req.params) === null || _a === void 0 ? void 0 : _a.resource) || '');
        if (!resource)
            return res.status(400).json({ message: 'missing resource' });
        const code = `${resource}.${kind}`;
        let ok = false;
        const altWritePerms = {
            recurring_payments: ['finance.tx.write'],
            fixed_expenses: ['finance.tx.write'],
            property_expenses: ['finance.tx.write'],
            company_expenses: ['finance.tx.write'],
        };
        const pluralSingular = { orders: 'order', order: 'orders', properties: 'property', property: 'properties' };
        const legacyByResource = {
            landlords: { view: ['landlord.manage'], write: ['landlord.manage'], delete: ['landlord.manage'] },
            finance_transactions: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
            recurring_payments: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
            fixed_expenses: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
            property_expenses: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
            company_expenses: { view: ['finance.tx.write'], write: ['finance.tx.write'] },
            properties: { view: ['property.view'], write: ['property.write'] },
            orders: { view: ['order.view'], write: ['order.write'] },
        };
        const candidates = (() => {
            var _a;
            const s = new Set();
            s.add(code);
            const alt = pluralSingular[resource];
            if (alt)
                s.add(`${alt}.${kind}`);
            (((_a = legacyByResource[resource]) === null || _a === void 0 ? void 0 : _a[kind]) || []).forEach((c) => s.add(c));
            return Array.from(s);
        })();
        try {
            const { hasPg, pgPool } = require('./dbAdapter');
            if (hasPg && pgPool) {
                let roleId = (_b = store_1.db.roles.find(r => r.name === roleName)) === null || _b === void 0 ? void 0 : _b.id;
                try {
                    const r0 = await pgPool.query('SELECT id FROM roles WHERE name=$1 LIMIT 1', [roleName]);
                    if (r0 && r0.rows && r0.rows[0] && r0.rows[0].id)
                        roleId = String(r0.rows[0].id);
                }
                catch (_c) { }
                const roleIds = Array.from(new Set([roleId, roleName, roleName.startsWith('role.') ? roleName.replace(/^role\./, '') : `role.${roleName}`].filter(Boolean)));
                const r = await pgPool.query('SELECT 1 FROM role_permissions WHERE role_id = ANY($1::text[]) AND permission_code = ANY($2::text[]) LIMIT 1', [roleIds, candidates]);
                ok = !!(r === null || r === void 0 ? void 0 : r.rowCount);
            }
        }
        catch (_d) { }
        if (!ok) {
            ok = candidates.some((c) => (0, store_1.roleHasPermission)(roleName, c));
            if (!ok && kind === 'write') {
                const alts = altWritePerms[resource] || [];
                for (const c of alts) {
                    if ((0, store_1.roleHasPermission)(roleName, c)) {
                        ok = true;
                        break;
                    }
                }
            }
        }
        if (!ok)
            return res.status(403).json({ message: 'forbidden' });
        next();
    };
}
