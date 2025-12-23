"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const auth_1 = require("../auth");
const dbAdapter_1 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
exports.router.post('/login', auth_1.login);
exports.router.get('/me', auth_1.me);
exports.router.post('/delete-password', auth_1.setDeletePassword);
exports.router.post('/forgot', async (req, res) => {
    const { email } = req.body || {};
    if (!email)
        return res.status(400).json({ message: 'missing email' });
    try {
        let user = null;
        if (dbAdapter_1.hasPg) {
            const rows = await (0, dbAdapter_1.pgSelect)('users', '*', { email });
            user = rows && rows[0];
        }
        const exists = !!user;
        // Normally generate token and send email; here we store a timestamp hint if user exists
        const payload = { reset_requested_at: new Date().toISOString() };
        if (exists && dbAdapter_1.hasPg) {
            await (0, dbAdapter_1.pgUpdate)('users', user.id, payload);
        }
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: e.message });
    }
});
