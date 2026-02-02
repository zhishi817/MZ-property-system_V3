"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const dbAdapter_1 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
exports.router.get('/', (req, res) => {
    const { entity, entity_id } = req.query;
    (async () => {
        try {
            if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
                const rows = entity && entity_id
                    ? await dbAdapter_1.pgPool.query('SELECT * FROM audit_logs WHERE entity=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 500', [entity, entity_id])
                    : entity
                        ? await dbAdapter_1.pgPool.query('SELECT * FROM audit_logs WHERE entity=$1 ORDER BY created_at DESC LIMIT 500', [entity])
                        : await dbAdapter_1.pgPool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500');
                return res.json((rows === null || rows === void 0 ? void 0 : rows.rows) || []);
            }
        }
        catch (_a) {
        }
        const list = entity
            ? store_1.db.audits.filter(a => a.entity === entity && (!entity_id || a.entity_id === entity_id))
            : store_1.db.audits;
        return res.json(list.slice(-500));
    })();
});
