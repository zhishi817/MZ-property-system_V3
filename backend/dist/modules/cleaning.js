"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const store_1 = require("../store");
const dbAdapter_1 = require("../dbAdapter");
const cleaningSync_1 = require("../services/cleaningSync");
const uuid_1 = require("uuid");
exports.router = (0, express_1.Router)();
function auDayStr(d) {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t) => { var _a; return ((_a = parts.find((p) => p.type === t)) === null || _a === void 0 ? void 0 : _a.value) || ''; };
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function dayOnly(s) {
    const v = String(s || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
async function ensureOfflineTasksTable() {
    if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
        return;
    await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_offline_tasks (
    id text PRIMARY KEY,
    date date NOT NULL,
    task_type text NOT NULL DEFAULT 'other',
    title text NOT NULL,
    content text NOT NULL DEFAULT '',
    kind text NOT NULL,
    status text NOT NULL,
    urgency text NOT NULL,
    property_id text,
    assignee_id text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );`);
    await dbAdapter_1.pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'other';`);
    await dbAdapter_1.pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT '';`);
    await dbAdapter_1.pgPool.query(`ALTER TABLE cleaning_offline_tasks ADD COLUMN IF NOT EXISTS assignee_id text;`);
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_cleaning_offline_tasks_date ON cleaning_offline_tasks(date);');
}
exports.router.get('/staff', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), (_req, res) => {
    res.json(store_1.db.cleaners);
});
const offlineTaskSchema = zod_1.z.object({
    date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    task_type: zod_1.z.enum(['property', 'company', 'other']),
    title: zod_1.z.string().min(1),
    content: zod_1.z.string().optional(),
    kind: zod_1.z.string().min(1),
    status: zod_1.z.enum(['todo', 'done']),
    urgency: zod_1.z.enum(['low', 'medium', 'high', 'urgent']),
    property_id: zod_1.z.string().nullable().optional(),
    assignee_id: zod_1.z.string().nullable().optional(),
}).strict();
exports.router.get('/offline-tasks', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a, _b;
    const dateParsed = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().safeParse((_a = req.query) === null || _a === void 0 ? void 0 : _a.date);
    const date = dateParsed.success ? dateParsed.data : undefined;
    const includeOverdue = String(((_b = req.query) === null || _b === void 0 ? void 0 : _b.include_overdue) || '').trim() === '1';
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureOfflineTasksTable();
            if (!date) {
                const r = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_offline_tasks ORDER BY date DESC, updated_at DESC, id DESC');
                return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
            }
            if (includeOverdue) {
                const r = await dbAdapter_1.pgPool.query(`SELECT * FROM cleaning_offline_tasks
           WHERE ((date::date) = ($1::date))
              OR ((date::date) < ($1::date) AND status <> 'done')
           ORDER BY date ASC, urgency DESC, updated_at DESC, id DESC`, [date]);
                return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
            }
            const r = await dbAdapter_1.pgPool.query(`SELECT * FROM cleaning_offline_tasks
         WHERE (date::date) = ($1::date)
         ORDER BY urgency DESC, updated_at DESC, id DESC`, [date]);
            return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
        }
        const rows = (store_1.db.cleaningOfflineTasks || []);
        const filtered = date
            ? rows.filter((t) => {
                const d = String(t.date || '').slice(0, 10);
                if (d === date)
                    return true;
                if (!includeOverdue)
                    return false;
                return d < date && String(t.status || '') !== 'done';
            })
            : rows;
        filtered.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')));
        return res.json(filtered);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'offline_tasks_failed' });
    }
});
exports.router.post('/offline-tasks', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b, _c;
    const parsed = offlineTaskSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const payload = parsed.data;
    try {
        const row = {
            id: (0, uuid_1.v4)(),
            date: payload.date,
            task_type: payload.task_type,
            title: payload.title,
            content: payload.content || '',
            kind: payload.kind,
            status: payload.status,
            urgency: payload.urgency,
            property_id: (_a = payload.property_id) !== null && _a !== void 0 ? _a : null,
            assignee_id: (_b = payload.assignee_id) !== null && _b !== void 0 ? _b : null,
        };
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureOfflineTasksTable();
            const r = await dbAdapter_1.pgPool.query(`INSERT INTO cleaning_offline_tasks(
          id, date, task_type, title, content, kind, status, urgency, property_id, assignee_id
        ) VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [row.id, row.date, row.task_type, row.title, row.content, row.kind, row.status, row.urgency, row.property_id, row.assignee_id]);
            return res.status(201).json(((_c = r === null || r === void 0 ? void 0 : r.rows) === null || _c === void 0 ? void 0 : _c[0]) || row);
        }
        ;
        store_1.db.cleaningOfflineTasks = store_1.db.cleaningOfflineTasks || [];
        store_1.db.cleaningOfflineTasks.unshift(row);
        return res.status(201).json(row);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'create_failed' });
    }
});
exports.router.patch('/offline-tasks/:id', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b;
    const { id } = req.params;
    const parsed = offlineTaskSchema.partial().safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const patch = parsed.data;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureOfflineTasksTable();
            const keys = Object.keys(patch || {}).filter((k) => patch[k] !== undefined);
            if (!keys.length) {
                const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_offline_tasks WHERE id=$1 LIMIT 1', [String(id)]);
                const row0 = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
                if (!row0)
                    return res.status(404).json({ message: 'task not found' });
                return res.json(row0);
            }
            const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]));
            const sql = `UPDATE cleaning_offline_tasks SET ${set}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`;
            const r1 = await dbAdapter_1.pgPool.query(sql, [...values, String(id)]);
            const row = ((_b = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _b === void 0 ? void 0 : _b[0]) || null;
            if (!row)
                return res.status(404).json({ message: 'task not found' });
            return res.json(row);
        }
        const rows = (store_1.db.cleaningOfflineTasks || []);
        const t = rows.find((x) => String(x.id) === String(id));
        if (!t)
            return res.status(404).json({ message: 'task not found' });
        Object.assign(t, patch);
        return res.json(t);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'update_failed' });
    }
});
exports.router.delete('/offline-tasks/:id', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureOfflineTasksTable();
            await dbAdapter_1.pgPool.query('DELETE FROM cleaning_offline_tasks WHERE id=$1', [String(id)]);
            return res.json({ ok: true });
        }
        const rows = (store_1.db.cleaningOfflineTasks || []);
        store_1.db.cleaningOfflineTasks = rows.filter((x) => String(x.id) !== String(id));
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'delete_failed' });
    }
});
exports.router.get('/tasks', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a;
    const dateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
    const parsed = dateSchema.safeParse((_a = req.query) === null || _a === void 0 ? void 0 : _a.date);
    const date = parsed.success ? parsed.data : undefined;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            if (date) {
                const r = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) = ($1::date) ORDER BY property_id NULLS LAST, id', [date]);
                return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
            }
            const r = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks ORDER BY COALESCE(task_date, date) NULLS LAST, property_id NULLS LAST, id');
            return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
        }
        const rows = store_1.db.cleaningTasks.slice();
        if (!date)
            return res.json(rows);
        return res.json(rows.filter((t) => String(t.task_date || t.date || '').slice(0, 10) === date));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'query_failed' });
    }
});
const patchTaskSchema = zod_1.z.object({
    property_id: zod_1.z.string().nullable().optional(),
    task_date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: zod_1.z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']).optional(),
    assignee_id: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    scheduled_at: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    note: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
}).strict();
exports.router.patch('/tasks/:id', (0, auth_1.requirePerm)('cleaning.task.assign'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const { id } = req.params;
    const parsed = patchTaskSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)]);
            const before = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!before)
                return res.status(404).json({ message: 'task not found' });
            const keyChanged = (parsed.data.task_date != null && String(parsed.data.task_date) !== String(before.task_date || before.date || '')) ||
                (parsed.data.assignee_id !== undefined && String((_b = parsed.data.assignee_id) !== null && _b !== void 0 ? _b : '') !== String((_c = before.assignee_id) !== null && _c !== void 0 ? _c : '')) ||
                (parsed.data.scheduled_at !== undefined && String((_d = parsed.data.scheduled_at) !== null && _d !== void 0 ? _d : '') !== String((_e = before.scheduled_at) !== null && _e !== void 0 ? _e : ''));
            const patch = { ...parsed.data };
            if (patch.task_date != null)
                patch.date = patch.task_date;
            if (keyChanged)
                patch.auto_sync_enabled = false;
            patch.updated_at = new Date().toISOString();
            const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
            const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]));
            const sql = `UPDATE cleaning_tasks SET ${set} WHERE id = $${keys.length + 1} RETURNING *`;
            const r1 = await dbAdapter_1.pgPool.query(sql, [...values, String(id)]);
            return res.json(((_f = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _f === void 0 ? void 0 : _f[0]) || before);
        }
        const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
        if (!task)
            return res.status(404).json({ message: 'task not found' });
        const before = { ...task };
        if (parsed.data.property_id !== undefined)
            task.property_id = parsed.data.property_id;
        if (parsed.data.task_date !== undefined) {
            task.task_date = parsed.data.task_date;
            task.date = parsed.data.task_date;
        }
        if (parsed.data.status !== undefined)
            task.status = parsed.data.status;
        if (parsed.data.assignee_id !== undefined)
            task.assignee_id = parsed.data.assignee_id;
        if (parsed.data.scheduled_at !== undefined)
            task.scheduled_at = parsed.data.scheduled_at;
        if (parsed.data.note !== undefined)
            task.note = parsed.data.note;
        const keyChanged = (parsed.data.task_date != null && String(parsed.data.task_date) !== String(before.task_date || before.date || '')) ||
            (parsed.data.assignee_id !== undefined && String((_g = parsed.data.assignee_id) !== null && _g !== void 0 ? _g : '') !== String((_h = before.assignee_id) !== null && _h !== void 0 ? _h : '')) ||
            (parsed.data.scheduled_at !== undefined && String((_j = parsed.data.scheduled_at) !== null && _j !== void 0 ? _j : '') !== String((_k = before.scheduled_at) !== null && _k !== void 0 ? _k : ''));
        if (keyChanged)
            task.auto_sync_enabled = false;
        return res.json(task);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'update_failed' });
    }
});
exports.router.post('/tasks/:id/restore-auto-sync', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b;
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)]);
            const task = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!task)
                return res.status(404).json({ message: 'task not found' });
            const r1 = await dbAdapter_1.pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id=$1 RETURNING *', [String(id)]);
            const updated = ((_b = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _b === void 0 ? void 0 : _b[0]) || task;
            const orderId = (updated === null || updated === void 0 ? void 0 : updated.order_id) ? String(updated.order_id) : '';
            if (orderId) {
                try {
                    await (0, cleaningSync_1.syncOrderToCleaningTasks)(orderId);
                }
                catch (_c) { }
            }
            return res.json({ ok: true, task: updated });
        }
        const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
        if (!task)
            return res.status(404).json({ message: 'task not found' });
        task.auto_sync_enabled = true;
        const orderId = task.order_id ? String(task.order_id) : '';
        if (orderId) {
            try {
                await (0, cleaningSync_1.syncOrderToCleaningTasks)(orderId);
            }
            catch (_d) { }
        }
        return res.json({ ok: true, task });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'restore_failed' });
    }
});
exports.router.get('/sync-logs', (0, auth_1.requireAnyPerm)(['cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a, _b;
    const orderId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.order_id) || '').trim() || null;
    const limitRaw = Number(((_b = req.query) === null || _b === void 0 ? void 0 : _b.limit) || 100);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100));
    try {
        if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
            return res.json([]);
        await (0, cleaningSync_1.ensureCleaningSchemaV2)();
        if (orderId) {
            const r = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_sync_logs WHERE (order_id::text)=$1 ORDER BY created_at DESC LIMIT $2', [orderId, limit]);
            return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
        }
        const r = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_sync_logs ORDER BY created_at DESC LIMIT $1', [limit]);
        return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'logs_failed' });
    }
});
const rangeSchema = zod_1.z.object({
    from: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
exports.router.get('/calendar-range', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    const parsed = rangeSchema.safeParse(req.query || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const from = parsed.data.from;
    const to = parsed.data.to;
    try {
        const items = [];
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            const r = await dbAdapter_1.pgPool.query(`SELECT
           t.id,
           t.order_id,
           t.property_id,
           (p.code::text) AS property_code,
           (p.region::text) AS property_region,
           t.task_type,
           COALESCE(t.task_date, t.date)::text AS task_date,
           t.status,
           t.assignee_id,
           t.scheduled_at,
           t.source,
           t.auto_sync_enabled,
           t.old_code,
           t.new_code,
           (o.confirmation_code::text) AS order_code,
           (o.nights) AS nights
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p ON (p.id::text) = (t.property_id::text)
         WHERE (COALESCE(task_date, date)::date) >= ($1::date) AND (COALESCE(task_date, date)::date) <= ($2::date)
           AND COALESCE(t.status,'') <> 'cancelled'
           AND (t.order_id IS NULL OR o.id IS NOT NULL)
           AND (
             t.order_id IS NULL
             OR (
               COALESCE(o.status, '') <> ''
               AND lower(COALESCE(o.status, '')) <> 'invalid'
               AND lower(COALESCE(o.status, '')) NOT LIKE '%cancel%'
             )
           )
         ORDER BY COALESCE(task_date, date) ASC, property_id NULLS LAST, id`, [from, to]);
            for (const row of ((r === null || r === void 0 ? void 0 : r.rows) || [])) {
                const d = String(row.task_date || '').slice(0, 10);
                const rawType = row.task_type ? String(row.task_type) : 'cleaning_task';
                const label = rawType === 'checkout_clean' ? '退房' :
                    rawType === 'checkin_clean' ? '入住' :
                        rawType;
                items.push({
                    source: 'cleaning_tasks',
                    entity_id: String(row.id),
                    order_id: row.order_id ? String(row.order_id) : null,
                    order_code: row.order_code ? String(row.order_code) : null,
                    property_id: row.property_id ? String(row.property_id) : null,
                    property_code: row.property_code ? String(row.property_code) : null,
                    property_region: row.property_region ? String(row.property_region) : null,
                    task_type: row.task_type ? String(row.task_type) : null,
                    label,
                    task_date: d,
                    status: String(row.status || 'pending'),
                    assignee_id: row.assignee_id ? String(row.assignee_id) : null,
                    scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
                    auto_sync_enabled: row.auto_sync_enabled !== false,
                    old_code: row.old_code != null ? String(row.old_code || '') : null,
                    new_code: row.new_code != null ? String(row.new_code || '') : null,
                    nights: row.nights != null ? Number(row.nights) : null,
                    summary_checkout_time: '11:30',
                    summary_checkin_time: '3pm',
                });
            }
            await ensureOfflineTasksTable();
            const r2 = await dbAdapter_1.pgPool.query(`SELECT id, date::text AS date, title, status, urgency, property_id, assignee_id
         FROM cleaning_offline_tasks
         WHERE (date::date) >= ($1::date) AND (date::date) <= ($2::date)
         ORDER BY date ASC, property_id NULLS LAST, id`, [from, to]);
            for (const row of ((r2 === null || r2 === void 0 ? void 0 : r2.rows) || [])) {
                items.push({
                    source: 'offline_tasks',
                    entity_id: String(row.id),
                    order_id: null,
                    order_code: null,
                    property_id: row.property_id ? String(row.property_id) : null,
                    property_code: null,
                    property_region: null,
                    task_type: null,
                    label: String(row.title || 'offline_task'),
                    task_date: String(row.date || '').slice(0, 10),
                    status: String(row.status || 'pending'),
                    assignee_id: row.assignee_id ? String(row.assignee_id) : null,
                    scheduled_at: null,
                    old_code: null,
                    new_code: null,
                    nights: null,
                    summary_checkout_time: null,
                    summary_checkin_time: null,
                });
            }
            return res.json(items);
        }
        const tasks = store_1.db.cleaningTasks.filter((t) => {
            const d = String(t.task_date || t.date || '').slice(0, 10);
            return d >= from && d <= to;
        });
        for (const t of tasks) {
            if (String(t.status || '') === 'cancelled')
                continue;
            const d = String(t.task_date || t.date || '').slice(0, 10);
            const rawType = String(t.task_type || t.type || 'checkout_clean');
            const label = rawType === 'checkout_clean' ? '退房' :
                rawType === 'checkin_clean' ? '入住' :
                    rawType;
            const order = store_1.db.orders.find((o) => String(o.id) === String(t.order_id)) || null;
            const prop = store_1.db.properties.find((p) => String(p.id) === String(t.property_id)) || null;
            if (t.order_id && !order)
                continue;
            const statusLower = String((order === null || order === void 0 ? void 0 : order.status) || '').trim().toLowerCase();
            if (t.order_id && (!statusLower || statusLower === 'invalid' || statusLower.includes('cancel')))
                continue;
            items.push({
                source: 'cleaning_tasks',
                entity_id: String(t.id),
                order_id: t.order_id ? String(t.order_id) : null,
                order_code: (order === null || order === void 0 ? void 0 : order.confirmation_code) ? String(order.confirmation_code) : null,
                property_id: t.property_id ? String(t.property_id) : null,
                property_code: (prop === null || prop === void 0 ? void 0 : prop.code) ? String(prop.code) : null,
                property_region: (prop === null || prop === void 0 ? void 0 : prop.region) ? String(prop.region) : null,
                task_type: rawType || null,
                label,
                task_date: d,
                status: String(t.status || 'pending'),
                assignee_id: t.assignee_id ? String(t.assignee_id) : null,
                scheduled_at: t.scheduled_at ? String(t.scheduled_at) : null,
                auto_sync_enabled: t.auto_sync_enabled !== false,
                old_code: t.old_code != null ? String(t.old_code || '') : null,
                new_code: t.new_code != null ? String(t.new_code || '') : null,
                nights: (order === null || order === void 0 ? void 0 : order.nights) != null ? Number(order.nights) : null,
                summary_checkout_time: '11:30',
                summary_checkin_time: '3pm',
            });
        }
        const offline = store_1.db.cleaningOfflineTasks || [];
        for (const t of offline) {
            const d = String(t.date || '').slice(0, 10);
            if (d < from || d > to)
                continue;
            items.push({
                source: 'offline_tasks',
                entity_id: String(t.id),
                order_id: null,
                order_code: null,
                property_id: t.property_id ? String(t.property_id) : null,
                property_code: null,
                property_region: null,
                task_type: null,
                label: String(t.title || 'offline_task'),
                task_date: d,
                status: String(t.status || 'pending'),
                assignee_id: t.assignee_id ? String(t.assignee_id) : null,
                scheduled_at: null,
                old_code: null,
                new_code: null,
                nights: null,
                summary_checkout_time: null,
                summary_checkin_time: null,
            });
        }
        items.sort((a, b) => String(a.task_date).localeCompare(String(b.task_date)) || String(a.property_id || '').localeCompare(String(b.property_id || '')));
        return res.json(items);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'calendar_failed' });
    }
});
exports.router.post('/backfill', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b;
    const dateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
    const fromParsed = dateSchema.safeParse((_a = req.query) === null || _a === void 0 ? void 0 : _a.date_from);
    const toParsed = dateSchema.safeParse((_b = req.query) === null || _b === void 0 ? void 0 : _b.date_to);
    const today = auDayStr(new Date());
    const from = (fromParsed.success ? fromParsed.data : undefined) || dayOnly(new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()) || today;
    const to = (toParsed.success ? toParsed.data : undefined) || dayOnly(new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()) || today;
    try {
        const r = await (0, cleaningSync_1.backfillCleaningTasks)({ dateFrom: from, dateTo: to });
        return res.json({ ok: true, from, to, ...r });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'backfill_failed' });
    }
});
exports.router.get('/debug/state', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (_req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
    try {
        if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool) {
            return res.json({
                pg: false,
                memory: { orders: (store_1.db.orders || []).length, cleaningTasks: (store_1.db.cleaningTasks || []).length, cleaners: (store_1.db.cleaners || []).length },
            });
        }
        const rDb = await dbAdapter_1.pgPool.query('SELECT current_database() AS db, current_schema() AS schema');
        const rPath = await dbAdapter_1.pgPool.query('SHOW search_path');
        const rTables = await dbAdapter_1.pgPool.query(`SELECT table_schema FROM information_schema.tables WHERE table_name='cleaning_tasks' ORDER BY table_schema`);
        const rCountOrders = await dbAdapter_1.pgPool.query('SELECT COUNT(*)::int AS c FROM orders');
        const rCountTasks = await dbAdapter_1.pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_tasks');
        const rCountLogs = await dbAdapter_1.pgPool.query('SELECT COUNT(*)::int AS c FROM cleaning_sync_logs');
        const rMinMax = await dbAdapter_1.pgPool.query(`SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks`);
        return res.json({
            pg: true,
            db: ((_a = rDb === null || rDb === void 0 ? void 0 : rDb.rows) === null || _a === void 0 ? void 0 : _a[0]) || null,
            search_path: String(((_c = (_b = rPath === null || rPath === void 0 ? void 0 : rPath.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.search_path) || ''),
            cleaning_tasks_schemas: ((rTables === null || rTables === void 0 ? void 0 : rTables.rows) || []).map((x) => x.table_schema),
            counts: {
                orders: (_f = (_e = (_d = rCountOrders === null || rCountOrders === void 0 ? void 0 : rCountOrders.rows) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.c) !== null && _f !== void 0 ? _f : null,
                cleaning_tasks: (_j = (_h = (_g = rCountTasks === null || rCountTasks === void 0 ? void 0 : rCountTasks.rows) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.c) !== null && _j !== void 0 ? _j : null,
                cleaning_sync_logs: (_m = (_l = (_k = rCountLogs === null || rCountLogs === void 0 ? void 0 : rCountLogs.rows) === null || _k === void 0 ? void 0 : _k[0]) === null || _l === void 0 ? void 0 : _l.c) !== null && _m !== void 0 ? _m : null,
            },
            minmax: { min: ((_p = (_o = rMinMax === null || rMinMax === void 0 ? void 0 : rMinMax.rows) === null || _o === void 0 ? void 0 : _o[0]) === null || _p === void 0 ? void 0 : _p.min) || null, max: ((_r = (_q = rMinMax === null || rMinMax === void 0 ? void 0 : rMinMax.rows) === null || _q === void 0 ? void 0 : _q[0]) === null || _r === void 0 ? void 0 : _r.max) || null },
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'debug_failed' });
    }
});
exports.router.get('/debug/order-sample', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b, _c, _d;
    const dateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
    const fromParsed = dateSchema.safeParse((_a = req.query) === null || _a === void 0 ? void 0 : _a.from);
    const toParsed = dateSchema.safeParse((_b = req.query) === null || _b === void 0 ? void 0 : _b.to);
    const from = fromParsed.success ? fromParsed.data : undefined;
    const to = toParsed.success ? toParsed.data : undefined;
    const limitRaw = Number(((_c = req.query) === null || _c === void 0 ? void 0 : _c.limit) || 5);
    const limit = Math.max(1, Math.min(20, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 5));
    try {
        if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
            return res.json({ pg: false });
        const dayExprCheckout = `CASE WHEN substring(o.checkout::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkout::text,1,10)::date END`;
        const dayExprCheckin = `CASE WHEN substring(o.checkin::text,1,10) ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN substring(o.checkin::text,1,10)::date END`;
        const whereRange = from && to
            ? `(
            ((${dayExprCheckout}) IS NOT NULL AND (${dayExprCheckout}) >= ($1::date) AND (${dayExprCheckout}) <= ($2::date))
            OR
            ((${dayExprCheckin}) IS NOT NULL AND (${dayExprCheckin}) >= ($1::date) AND (${dayExprCheckin}) <= ($2::date))
          )`
            : `(${dayExprCheckout}) IS NOT NULL OR (${dayExprCheckin}) IS NOT NULL`;
        const params = from && to ? [from, to, limit] : [limit];
        const sql = `
      SELECT
        (o.id::text) AS id,
        (o.property_id::text) AS property_id,
        COALESCE(o.status,'') AS status,
        o.checkin::text AS checkin_text,
        o.checkout::text AS checkout_text,
        o.nights AS nights,
        (${dayExprCheckin})::text AS checkin_day,
        (${dayExprCheckout})::text AS checkout_day
      FROM orders o
      WHERE ${whereRange}
      ORDER BY COALESCE((${dayExprCheckout}), (${dayExprCheckin})) ASC, o.id
      LIMIT $${from && to ? 3 : 1}
    `;
        const r = await dbAdapter_1.pgPool.query(sql, params);
        const rows = (r === null || r === void 0 ? void 0 : r.rows) || [];
        const full = [];
        for (const rr of rows) {
            const r2 = await dbAdapter_1.pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [String(rr.id)]);
            const o = ((_d = r2 === null || r2 === void 0 ? void 0 : r2.rows) === null || _d === void 0 ? void 0 : _d[0]) || null;
            const checkin = o === null || o === void 0 ? void 0 : o.checkin;
            const checkout = o === null || o === void 0 ? void 0 : o.checkout;
            full.push({
                summary: rr,
                runtime: o
                    ? {
                        checkin_type: Object.prototype.toString.call(checkin),
                        checkout_type: Object.prototype.toString.call(checkout),
                        checkin_str: String(checkin),
                        checkout_str: String(checkout),
                    }
                    : null,
            });
        }
        return res.json({ ok: true, from: from || null, to: to || null, limit, rows: full });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'order_sample_failed' });
    }
});
exports.router.post('/debug/sync-one', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b, _c;
    const schema = zod_1.z.object({ order_id: zod_1.z.string().min(1) }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const orderId = String(parsed.data.order_id);
    try {
        if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
            return res.status(400).json({ message: 'pg=false' });
        await (0, cleaningSync_1.ensureCleaningSchemaV2)();
        const beforeTasks = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId]);
        const beforeCount = Number(((_a = beforeTasks === null || beforeTasks === void 0 ? void 0 : beforeTasks.rows) === null || _a === void 0 ? void 0 : _a.length) || 0);
        let syncResult = null;
        try {
            syncResult = await (0, cleaningSync_1.syncOrderToCleaningTasks)(orderId);
        }
        catch (e) {
            syncResult = { error: String((e === null || e === void 0 ? void 0 : e.message) || 'sync_failed') };
        }
        const afterTasks = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId]);
        const afterCount = Number(((_b = afterTasks === null || afterTasks === void 0 ? void 0 : afterTasks.rows) === null || _b === void 0 ? void 0 : _b.length) || 0);
        const orderRow = await dbAdapter_1.pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [orderId]);
        return res.json({
            ok: true,
            order_id: orderId,
            before_count: beforeCount,
            after_count: afterCount,
            sync: syncResult,
            order: ((_c = orderRow === null || orderRow === void 0 ? void 0 : orderRow.rows) === null || _c === void 0 ? void 0 : _c[0]) || null,
            tasks: (afterTasks === null || afterTasks === void 0 ? void 0 : afterTasks.rows) || [],
        });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'sync_one_failed' });
    }
});
exports.router.get('/tasks/minmax', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a, _b, _c, _d, _e;
    const dateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
    const parsed = dateSchema.safeParse((_a = req.query) === null || _a === void 0 ? void 0 : _a.from);
    const from = parsed.success ? (parsed.data || auDayStr(new Date())) : auDayStr(new Date());
    try {
        if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
            return res.json({ ok: true, min: null, max: null, from });
        await (0, cleaningSync_1.ensureCleaningSchemaV2)();
        const sql = `SELECT MIN(COALESCE(task_date, date))::text AS min, MAX(COALESCE(task_date, date))::text AS max FROM cleaning_tasks WHERE (COALESCE(task_date, date)::date) >= ($1::date)`;
        const r = await dbAdapter_1.pgPool.query(sql, [from]);
        const min = ((_c = (_b = r === null || r === void 0 ? void 0 : r.rows) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.min) ? String(r.rows[0].min).slice(0, 10) : null;
        const max = ((_e = (_d = r === null || r === void 0 ? void 0 : r.rows) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.max) ? String(r.rows[0].max).slice(0, 10) : null;
        return res.json({ ok: true, min, max, from });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'minmax_failed' });
    }
});
