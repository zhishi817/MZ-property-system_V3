"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const dbAdapter_1 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
exports.router.get('/', (req, res) => {
    const { entity, entity_id, limit: limitRaw, cursor, before } = req.query;
    (async () => {
        var _a;
        try {
            if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
                const limit = Math.max(1, Math.min(500, Number(limitRaw || 200)));
                const params = [];
                const where = [];
                if (entity) {
                    params.push(String(entity));
                    where.push(`a.entity=$${params.length}`);
                }
                if (entity_id) {
                    params.push(String(entity_id));
                    where.push(`a.entity_id=$${params.length}`);
                }
                const beforeTs = String(before || '').trim() || String(cursor || '').trim();
                if (beforeTs) {
                    params.push(beforeTs);
                    where.push(`a.created_at < $${params.length}::timestamptz`);
                }
                params.push(limit);
                const sql = `
          SELECT
            a.*,
            u.username AS actor_username,
            u.display_name AS actor_display_name,
            u.email AS actor_email
          FROM audit_logs a
          LEFT JOIN users u ON u.id = a.actor_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY a.created_at DESC
          LIMIT $${params.length}
        `;
                const r = await dbAdapter_1.pgPool.query(sql, params);
                const items = ((r === null || r === void 0 ? void 0 : r.rows) || []).map((row) => {
                    const actor = (row.actor_id || row.actor_username || row.actor_display_name || row.actor_email)
                        ? {
                            id: row.actor_id ? String(row.actor_id) : null,
                            username: row.actor_username ? String(row.actor_username) : null,
                            display_name: row.actor_display_name ? String(row.actor_display_name) : null,
                            email: row.actor_email ? String(row.actor_email) : null,
                        }
                        : null;
                    return { ...row, actor };
                });
                const nextCursor = items.length ? String(((_a = items[items.length - 1]) === null || _a === void 0 ? void 0 : _a.created_at) || '') : '';
                return res.json({ items, next_cursor: nextCursor || null });
            }
        }
        catch (_b) {
        }
        const limit = Math.max(1, Math.min(500, Number(limitRaw || 200)));
        const byId = Object.fromEntries((store_1.db.users || []).map((u) => [String(u.id), u]));
        const list = entity
            ? store_1.db.audits.filter(a => a.entity === entity && (!entity_id || a.entity_id === entity_id))
            : store_1.db.audits;
        const sliced = list.slice(-limit);
        const items = sliced.map((a) => {
            const u = a.actor_id ? byId[String(a.actor_id)] : null;
            const actor = u ? { id: String(u.id), username: u.username ? String(u.username) : null, display_name: u.display_name ? String(u.display_name) : null, email: u.email ? String(u.email) : null } : null;
            const createdAt = a.created_at || a.timestamp || null;
            const beforeJson = (a.before_json !== undefined) ? a.before_json : (a.before !== undefined ? a.before : null);
            const afterJson = (a.after_json !== undefined) ? a.after_json : (a.after !== undefined ? a.after : null);
            return { ...a, created_at: createdAt, before_json: beforeJson, after_json: afterJson, actor };
        });
        return res.json({ items, next_cursor: null });
    })();
});
