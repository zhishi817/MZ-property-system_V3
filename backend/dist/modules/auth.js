"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const auth_1 = require("../auth");
const dbAdapter_1 = require("../dbAdapter");
const zod_1 = require("zod");
const crypto_1 = __importDefault(require("crypto"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const mailer_1 = require("../services/mailer");
exports.router = (0, express_1.Router)();
exports.router.post('/login', auth_1.login);
exports.router.get('/me', auth_1.me);
exports.router.post('/delete-password', auth_1.setDeletePassword);
function sha256Hex(s) {
    return crypto_1.default.createHash('sha256').update(s).digest('hex');
}
async function ensurePasswordResetTables() {
    if (!dbAdapter_1.hasPg)
        return;
    try {
        const { pgPool } = require('../dbAdapter');
        if (!pgPool)
            return;
        await pgPool.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL,
      created_at timestamptz DEFAULT now(),
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      ip text,
      user_agent text
    );`);
        await pgPool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_password_resets_token_hash ON password_resets(token_hash);');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);');
        await pgPool.query('CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets(expires_at);');
    }
    catch (_a) { }
}
const forgotSchema = zod_1.z.object({ email: zod_1.z.string().email() });
const resetSchema = zod_1.z.object({ token: zod_1.z.string().min(16), password: zod_1.z.string().min(6) });
exports.router.post('/forgot', async (req, res) => {
    var _a;
    const parsed = forgotSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json({ message: 'invalid email' });
    const email = String(parsed.data.email || '').trim();
    if (!dbAdapter_1.hasPg)
        return res.status(500).json({ message: 'database_not_configured' });
    await ensurePasswordResetTables();
    let user = null;
    try {
        const rows = await (0, dbAdapter_1.pgSelect)('users', '*', { email });
        user = rows && rows[0];
    }
    catch (_b) { }
    if (!user || !user.id)
        return res.json({ ok: true });
    const token = crypto_1.default.randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const ttlMin = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 60);
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();
    const ip = String((req.ip || ((_a = req.socket) === null || _a === void 0 ? void 0 : _a.remoteAddress) || '')).slice(0, 255);
    const ua = String(req.headers['user-agent'] || '').slice(0, 255);
    try {
        const { pgInsert } = require('../dbAdapter');
        const { v4: uuid } = require('uuid');
        await pgInsert('password_resets', { id: uuid(), user_id: user.id, token_hash: tokenHash, expires_at: expiresAt, ip, user_agent: ua });
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'reset_create_failed') });
    }
    const front = String(process.env.FRONTEND_BASE_URL || req.headers.origin || '').trim().replace(/\/+$/g, '');
    if (!front)
        return res.status(500).json({ message: 'missing FRONTEND_BASE_URL' });
    const link = `${front}/reset-password?token=${encodeURIComponent(token)}`;
    try {
        const subject = 'MZ Property - 重置密码';
        const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">
        <p>你好，</p>
        <p>我们收到了你的密码重置请求。请点击下面的链接设置新密码（${ttlMin} 分钟内有效）：</p>
        <p><a href="${link}">${link}</a></p>
        <p>如果你并未发起此请求，请忽略本邮件。</p>
      </div>
    `;
        await (0, mailer_1.sendMail)({ to: email, subject, html, text: `重置密码链接（${ttlMin} 分钟内有效）：${link}` });
        return res.json({ ok: true });
    }
    catch (e) {
        try {
            console.error(`[auth] forgot_send_failed message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
        catch (_c) { }
        return res.status(500).json({ message: 'send_failed' });
    }
});
exports.router.post('/reset', async (req, res) => {
    const parsed = resetSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json({ message: 'invalid payload' });
    if (!dbAdapter_1.hasPg)
        return res.status(500).json({ message: 'database_not_configured' });
    await ensurePasswordResetTables();
    const tokenHash = sha256Hex(String(parsed.data.token));
    const pwHash = await bcryptjs_1.default.hash(parsed.data.password, 10);
    try {
        const { pgRunInTransaction } = require('../dbAdapter');
        const result = await pgRunInTransaction(async (client) => {
            var _a;
            const r = await client.query('SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash=$1 LIMIT 1', [tokenHash]);
            const row = (_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0];
            if (!row || row.used_at)
                return { ok: false, reason: 'invalid' };
            const exp = new Date(row.expires_at).getTime();
            if (!Number.isFinite(exp) || exp < Date.now())
                return { ok: false, reason: 'expired' };
            await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [pwHash, String(row.user_id)]);
            await client.query('UPDATE password_resets SET used_at=now() WHERE id=$1', [String(row.id)]);
            try {
                await client.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [String(row.user_id)]);
            }
            catch (_b) { }
            return { ok: true };
        });
        if (!(result === null || result === void 0 ? void 0 : result.ok))
            return res.status(400).json({ message: 'invalid_or_expired' });
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'reset_failed') });
    }
});
