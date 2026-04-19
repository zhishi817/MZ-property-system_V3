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
const notificationEvents_1 = require("../services/notificationEvents");
const workTaskEvents_1 = require("../services/workTaskEvents");
const cleaningInspection_1 = require("../lib/cleaningInspection");
exports.router = (0, express_1.Router)();
const DEFAULT_SUMMARY_CHECKOUT_TIME = '10am';
const DEFAULT_SUMMARY_CHECKIN_TIME = '3pm';
function auDayStr(d) {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t) => { var _a; return ((_a = parts.find((p) => p.type === t)) === null || _a === void 0 ? void 0 : _a.value) || ''; };
    return `${get('year')}-${get('month')}-${get('day')}`;
}
function dayOnly(s) {
    const v = String(s || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function assignedStatusFromAssignees(cleanerId, inspectorId) {
    return String(cleanerId || '').trim() || String(inspectorId || '').trim() ? 'assigned' : 'pending';
}
function validateAndApplyInspectionPatch(params) {
    const patch = params.patch || {};
    const current = params.current || {};
    const taskType = params.taskType != null ? params.taskType : current === null || current === void 0 ? void 0 : current.task_type;
    const currentMode = (0, cleaningInspection_1.effectiveInspectionMode)({
        task_type: taskType,
        inspection_mode: current === null || current === void 0 ? void 0 : current.inspection_mode,
        status: current === null || current === void 0 ? void 0 : current.status,
        inspector_id: current === null || current === void 0 ? void 0 : current.inspector_id,
    });
    const requestedMode = patch.inspection_mode !== undefined ? (0, cleaningInspection_1.normalizeInspectionMode)(patch.inspection_mode) : null;
    if (patch.inspection_mode !== undefined && patch.inspection_mode !== null && !requestedMode) {
        const err = new Error('invalid_inspection_mode');
        err.statusCode = 400;
        err.exposeMessage = '无效的检查安排';
        throw err;
    }
    const nextMode = requestedMode || currentMode || (0, cleaningInspection_1.defaultInspectionModeForTaskType)(taskType);
    const nextDue = patch.inspection_due_date !== undefined ? dayOnly(patch.inspection_due_date) : dayOnly(current === null || current === void 0 ? void 0 : current.inspection_due_date);
    if (nextMode === 'deferred' && !nextDue) {
        const err = new Error('inspection_due_date_required');
        err.statusCode = 400;
        err.exposeMessage = '延后检查必须选择检查日期';
        throw err;
    }
    if (patch.inspection_mode !== undefined)
        patch.inspection_mode = nextMode;
    if (patch.inspection_due_date !== undefined || nextMode !== 'deferred') {
        patch.inspection_due_date = nextMode === 'deferred' ? nextDue : null;
    }
    if ((patch.inspection_mode !== undefined || patch.inspection_due_date !== undefined) && (nextMode === 'pending_decision' || nextMode === 'self_complete') && patch.inspector_id === undefined) {
        patch.inspector_id = null;
    }
    return { inspection_mode: nextMode, inspection_due_date: nextMode === 'deferred' ? nextDue : null };
}
function offlineWorkTaskId(taskId) {
    return `cleaning_offline_tasks:${String(taskId || '').trim()}`;
}
function offlineTaskTypeLabel(taskType) {
    const raw = String(taskType || '').trim().toLowerCase();
    if (raw === 'property')
        return '房源任务';
    if (raw === 'company')
        return '公司任务';
    return '其他任务';
}
function offlineTaskCompletedTitle(row) {
    const typeLabel = offlineTaskTypeLabel(row === null || row === void 0 ? void 0 : row.task_type);
    const title = String((row === null || row === void 0 ? void 0 : row.title) || '').trim();
    return title ? `${typeLabel}已完成：${title}` : `${typeLabel}已完成`;
}
function offlineTaskCompletedBody(row) {
    const title = String((row === null || row === void 0 ? void 0 : row.title) || '').trim();
    return title ? `${title} 已标记完成` : '任务已标记完成';
}
function enqueueNotification(task) {
    setImmediate(() => {
        task().catch((e) => {
            try {
                console.error(`[cleaning][notification_async_failed] message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
            }
            catch (_a) { }
        });
    });
}
async function ensureOfflineTasksTable() {
    var _a, _b;
    if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
        return;
    const r = await dbAdapter_1.pgPool.query(`SELECT to_regclass('public.cleaning_offline_tasks') AS t`);
    const t = (_b = (_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.t;
    if (!t) {
        const err = new Error('cleaning_offline_tasks_missing');
        err.code = 'CLEANING_SCHEMA_MISSING';
        throw err;
    }
}
async function ensureWorkTasksTable() {
    if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
        return;
    await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS work_tasks (
    id text PRIMARY KEY,
    task_kind text NOT NULL,
    source_type text NOT NULL,
    source_id text NOT NULL,
    property_id text,
    title text NOT NULL DEFAULT '',
    summary text,
    scheduled_date date,
    start_time text,
    end_time text,
    assignee_id text,
    status text NOT NULL DEFAULT 'todo',
    urgency text NOT NULL DEFAULT 'medium',
    created_by text,
    updated_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );`);
    try {
        await dbAdapter_1.pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_work_tasks_source ON work_tasks(source_type, source_id);`);
    }
    catch (_a) { }
    try {
        await dbAdapter_1.pgPool.query(`CREATE INDEX IF NOT EXISTS idx_work_tasks_day_assignee ON work_tasks(scheduled_date, assignee_id, status);`);
    }
    catch (_b) { }
}
async function upsertWorkTaskFromOfflineTask(row) {
    if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
        return;
    const id = String((row === null || row === void 0 ? void 0 : row.id) || '').trim();
    if (!id)
        return;
    await ensureWorkTasksTable();
    const workId = `cleaning_offline_tasks:${id}`;
    const scheduled = (row === null || row === void 0 ? void 0 : row.date) ? String(row.date).slice(0, 10) : null;
    const assignee = String((row === null || row === void 0 ? void 0 : row.assignee_id) || '').trim() || null;
    const status = String((row === null || row === void 0 ? void 0 : row.status) || '').trim() === 'done' ? 'done' : 'todo';
    const urgency = String((row === null || row === void 0 ? void 0 : row.urgency) || '').trim() || 'medium';
    await dbAdapter_1.pgPool.query(`INSERT INTO work_tasks(id, task_kind, source_type, source_id, property_id, title, summary, scheduled_date, assignee_id, status, urgency, created_at, updated_at)
     VALUES($1,'offline','cleaning_offline_tasks',$2,$3,$4,$5,$6::date,$7,$8,$9,COALESCE($10::timestamptz, now()), now())
     ON CONFLICT (source_type, source_id) DO UPDATE SET
       property_id=EXCLUDED.property_id,
       title=EXCLUDED.title,
       summary=EXCLUDED.summary,
       scheduled_date=EXCLUDED.scheduled_date,
       assignee_id=EXCLUDED.assignee_id,
       status=EXCLUDED.status,
       urgency=EXCLUDED.urgency,
       updated_at=now()`, [workId, id, (row === null || row === void 0 ? void 0 : row.property_id) || null, String((row === null || row === void 0 ? void 0 : row.title) || ''), String((row === null || row === void 0 ? void 0 : row.content) || '') || null, scheduled, assignee, status, urgency, (row === null || row === void 0 ? void 0 : row.created_at) || null]);
}
exports.router.get('/staff', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a;
    const kind = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.kind) || '').trim().toLowerCase();
    const rolesForKind = (k) => {
        if (k === 'cleaner')
            return ['cleaner', 'cleaner_inspector'];
        if (k === 'inspector')
            return ['cleaning_inspector', 'cleaner_inspector'];
        return ['cleaner', 'cleaning_inspector', 'cleaner_inspector'];
    };
    const kindsForRoles = (roleNames, requestedKind) => {
        const out = new Set();
        const all = Array.from(new Set(roleNames.map((x) => String(x || '').trim()).filter(Boolean)));
        if (all.includes('cleaner') || all.includes('cleaner_inspector')) {
            if (requestedKind !== 'inspector')
                out.add('cleaner');
        }
        if (all.includes('cleaning_inspector') || all.includes('cleaner_inspector')) {
            if (requestedKind !== 'cleaner')
                out.add('inspector');
        }
        return Array.from(out);
    };
    const roles = rolesForKind(kind);
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const r = await dbAdapter_1.pgPool.query(`SELECT
           u.id,
           u.username,
           u.email,
           u.role,
           (u.color_hex::text) AS color_hex,
           COALESCE(
             ARRAY_AGG(DISTINCT ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
             ARRAY[]::text[]
           ) AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id::text
         GROUP BY u.id
         ORDER BY COALESCE(u.username, u.email) ASC, u.id ASC`);
            const out = [];
            for (const u of ((r === null || r === void 0 ? void 0 : r.rows) || [])) {
                const roleNames = Array.from(new Set([
                    String(u.role || '').trim(),
                    ...((Array.isArray(u.roles) ? u.roles : []).map((x) => String(x || '').trim())),
                ].filter(Boolean)));
                if (!roleNames.some((role) => roles.includes(role)))
                    continue;
                const name = String(u.username || u.email || u.id || '').trim() || String(u.id);
                const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String(u.color_hex || '#3B82F6') };
                for (const resolvedKind of kindsForRoles(roleNames, kind)) {
                    out.push({ ...base, kind: resolvedKind });
                }
            }
            return res.json(out);
        }
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'staff_failed' });
    }
    const users = (store_1.db.users || []).filter((u) => roles.includes(String(u.role || '')));
    const out = [];
    for (const u of users) {
        const role = String(u.role || '');
        const name = String(u.username || u.email || u.id || '').trim() || String(u.id);
        const base = { id: String(u.id), name, capacity_per_day: 0, is_active: true, color_hex: String(u.color_hex || '#3B82F6') };
        if (role === 'cleaner' && kind !== 'inspector')
            out.push({ ...base, kind: 'cleaner' });
        else if (role === 'cleaning_inspector' && kind !== 'cleaner')
            out.push({ ...base, kind: 'inspector' });
        else if (role === 'cleaner_inspector') {
            if (kind === 'cleaner')
                out.push({ ...base, kind: 'cleaner' });
            else if (kind === 'inspector')
                out.push({ ...base, kind: 'inspector' });
            else
                out.push({ ...base, kind: 'cleaner' }, { ...base, kind: 'inspector' });
        }
    }
    return res.json(out);
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
    var _a, _b, _c, _d;
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
            const out = ((_c = r === null || r === void 0 ? void 0 : r.rows) === null || _c === void 0 ? void 0 : _c[0]) || row;
            try {
                await upsertWorkTaskFromOfflineTask(out);
            }
            catch (_e) { }
            if (String(out.status || '').trim().toLowerCase() === 'done') {
                const workTaskId = offlineWorkTaskId(String(out.id || row.id));
                try {
                    await (0, workTaskEvents_1.emitWorkTaskEvent)({
                        taskId: `work_task:${workTaskId}`,
                        sourceType: 'work_tasks',
                        sourceRefIds: [workTaskId],
                        eventType: 'TASK_COMPLETED',
                        changeScope: 'list',
                        changedFields: ['status'],
                        patch: { status: 'done' },
                        causedByUserId: String(((_d = req.user) === null || _d === void 0 ? void 0 : _d.sub) || '').trim() || null,
                        visibilityHints: (0, workTaskEvents_1.buildWorkTaskVisibilityHints)({ assignee_id: out.assignee_id }),
                    });
                }
                catch (_f) { }
                enqueueNotification(() => {
                    var _a;
                    return (0, notificationEvents_1.emitNotificationEvent)({
                        type: 'WORK_TASK_COMPLETED',
                        entity: 'work_task',
                        entityId: workTaskId,
                        propertyId: out.property_id ? String(out.property_id) : undefined,
                        updatedAt: String(out.updated_at || '').trim() || new Date().toISOString(),
                        title: offlineTaskCompletedTitle(out),
                        body: offlineTaskCompletedBody(out),
                        data: {
                            entity: 'work_task',
                            entityId: workTaskId,
                            action: 'open_work_task',
                            kind: 'work_task_completed',
                            task_id: workTaskId,
                            offline_task_id: String(out.id || ''),
                            task_type: String(out.task_type || ''),
                        },
                        actorUserId: String(((_a = req.user) === null || _a === void 0 ? void 0 : _a.sub) || '').trim() || null,
                    }, { operationId: (0, uuid_1.v4)() });
                });
            }
            return res.status(201).json(out);
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
    var _a, _b, _c;
    const { id } = req.params;
    const parsed = offlineTaskSchema.partial().safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const patch = parsed.data;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await ensureOfflineTasksTable();
            const beforeRes = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_offline_tasks WHERE id=$1 LIMIT 1', [String(id)]);
            const before = ((_a = beforeRes === null || beforeRes === void 0 ? void 0 : beforeRes.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!before)
                return res.status(404).json({ message: 'task not found' });
            const keys = Object.keys(patch || {}).filter((k) => patch[k] !== undefined);
            if (!keys.length) {
                return res.json(before);
            }
            const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]));
            const sql = `UPDATE cleaning_offline_tasks SET ${set}, updated_at=now() WHERE id=$${keys.length + 1} RETURNING *`;
            const r1 = await dbAdapter_1.pgPool.query(sql, [...values, String(id)]);
            const row = ((_b = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _b === void 0 ? void 0 : _b[0]) || null;
            if (!row)
                return res.status(404).json({ message: 'task not found' });
            try {
                await upsertWorkTaskFromOfflineTask(row);
            }
            catch (_d) { }
            const completedChanged = String(before.status || '').trim().toLowerCase() !== 'done' && String(row.status || '').trim().toLowerCase() === 'done';
            if (completedChanged) {
                const workTaskId = offlineWorkTaskId(String(row.id || id));
                try {
                    await (0, workTaskEvents_1.emitWorkTaskEvent)({
                        taskId: `work_task:${workTaskId}`,
                        sourceType: 'work_tasks',
                        sourceRefIds: [workTaskId],
                        eventType: 'TASK_COMPLETED',
                        changeScope: 'list',
                        changedFields: ['status'],
                        patch: { status: 'done' },
                        causedByUserId: String(((_c = req.user) === null || _c === void 0 ? void 0 : _c.sub) || '').trim() || null,
                        visibilityHints: (0, workTaskEvents_1.buildWorkTaskVisibilityHints)({ assignee_id: row.assignee_id }),
                    });
                }
                catch (_e) { }
                enqueueNotification(() => {
                    var _a;
                    return (0, notificationEvents_1.emitNotificationEvent)({
                        type: 'WORK_TASK_COMPLETED',
                        entity: 'work_task',
                        entityId: workTaskId,
                        propertyId: row.property_id ? String(row.property_id) : undefined,
                        updatedAt: String(row.updated_at || '').trim() || new Date().toISOString(),
                        title: offlineTaskCompletedTitle(row),
                        body: offlineTaskCompletedBody(row),
                        data: {
                            entity: 'work_task',
                            entityId: workTaskId,
                            action: 'open_work_task',
                            kind: 'work_task_completed',
                            task_id: workTaskId,
                            offline_task_id: String(row.id || ''),
                            task_type: String(row.task_type || ''),
                        },
                        actorUserId: String(((_a = req.user) === null || _a === void 0 ? void 0 : _a.sub) || '').trim() || null,
                    }, { operationId: (0, uuid_1.v4)() });
                });
            }
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
            if (date) {
                const r = await dbAdapter_1.pgPool.query(`SELECT t.*, o.keys_required AS order_keys_required
           FROM cleaning_tasks t
           LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
           WHERE (COALESCE(t.task_date, t.date)::date) = ($1::date)
           ORDER BY t.property_id NULLS LAST, t.id`, [date]);
                return res.json(((r === null || r === void 0 ? void 0 : r.rows) || []).map((x) => {
                    if ((x === null || x === void 0 ? void 0 : x.order_id) && (x === null || x === void 0 ? void 0 : x.order_keys_required) != null)
                        x.keys_required = Number(x.order_keys_required);
                    delete x.order_keys_required;
                    return x;
                }));
            }
            const r = await dbAdapter_1.pgPool.query(`SELECT t.*, o.keys_required AS order_keys_required
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         ORDER BY COALESCE(t.task_date, t.date) NULLS LAST, t.property_id NULLS LAST, t.id`);
            return res.json(((r === null || r === void 0 ? void 0 : r.rows) || []).map((x) => {
                if ((x === null || x === void 0 ? void 0 : x.order_id) && (x === null || x === void 0 ? void 0 : x.order_keys_required) != null)
                    x.keys_required = Number(x.order_keys_required);
                delete x.order_keys_required;
                return x;
            }));
        }
        const rows = store_1.db.cleaningTasks.slice();
        if (!date)
            return res.json(rows);
        const orders = (store_1.db.orders || []);
        const byId = new Map();
        for (const o of orders)
            byId.set(String(o.id), o);
        return res.json(rows.filter((t) => String(t.task_date || t.date || '').slice(0, 10) === date).map((t) => {
            const out = { ...t };
            const oid = String(out.order_id || '').trim();
            const o = oid ? byId.get(oid) : null;
            if (o && o.keys_required != null)
                out.keys_required = Number(o.keys_required) >= 2 ? 2 : 1;
            return out;
        }));
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'query_failed' });
    }
});
exports.router.get('/history', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a, _b, _c, _d;
    const propertyId = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.property_id) || '').trim();
    if (!propertyId)
        return res.status(400).json({ message: 'property_id_required' });
    const dateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const parsedFrom = dateSchema.optional().safeParse((_b = req.query) === null || _b === void 0 ? void 0 : _b.from);
    const parsedTo = dateSchema.optional().safeParse((_c = req.query) === null || _c === void 0 ? void 0 : _c.to);
    const fromRaw = parsedFrom.success ? parsedFrom.data : undefined;
    const toRaw = parsedTo.success ? parsedTo.data : undefined;
    const limitRaw = Number(((_d = req.query) === null || _d === void 0 ? void 0 : _d.limit) || 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 1000) : 200;
    const today = new Date();
    const defaultTo = today.toISOString().slice(0, 10);
    const defaultFrom = new Date(today.getTime() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const from = fromRaw || defaultFrom;
    const to = toRaw || defaultTo;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const sql = `
        SELECT
          t.*,
          p.code AS property_code,
          p.region AS property_region
        FROM cleaning_tasks t
        LEFT JOIN properties p ON p.id = t.property_id
        WHERE t.property_id = $1
          AND (COALESCE(t.task_date, t.date)::date) >= ($2::date)
          AND (COALESCE(t.task_date, t.date)::date) <= ($3::date)
        ORDER BY (COALESCE(t.task_date, t.date)::date) DESC, t.id DESC
        LIMIT $4
      `;
            const r = await dbAdapter_1.pgPool.query(sql, [propertyId, from, to, limit]);
            return res.json((r === null || r === void 0 ? void 0 : r.rows) || []);
        }
        const rows = store_1.db.cleaningTasks.slice().filter((t) => String(t.property_id || '') === propertyId);
        const filtered = rows.filter((t) => {
            const d = String(t.task_date || t.date || '').slice(0, 10);
            return d && d >= from && d <= to;
        });
        filtered.sort((a, b) => String(b.task_date || b.date || '').localeCompare(String(a.task_date || a.date || '')) || String(b.id || '').localeCompare(String(a.id || '')));
        const props = (store_1.db.properties || []);
        const p = props.find((x) => String(x.id) === propertyId) || null;
        const out = filtered.slice(0, limit).map((t) => ({ ...t, property_code: (p === null || p === void 0 ? void 0 : p.code) || (t === null || t === void 0 ? void 0 : t.property_code) || null, property_region: (p === null || p === void 0 ? void 0 : p.region) || (t === null || t === void 0 ? void 0 : t.property_region) || null }));
        return res.json(out);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'history_failed' });
    }
});
const patchTaskSchema = zod_1.z.object({
    property_id: zod_1.z.string().nullable().optional(),
    task_date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: zod_1.z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']).optional(),
    assignee_id: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    cleaner_id: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    inspector_id: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    inspection_mode: zod_1.z.enum(['pending_decision', 'same_day', 'self_complete', 'deferred']).optional().nullable(),
    inspection_due_date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    keys_required: zod_1.z
        .preprocess((v) => {
        if (v == null)
            return v;
        if (typeof v === 'number')
            return v;
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
    }, zod_1.z.number().int().min(1).max(2))
        .optional()
        .nullable(),
    nights_override: zod_1.z.union([zod_1.z.number().int().nonnegative(), zod_1.z.null()]).optional(),
    old_code: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    new_code: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    checkout_time: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    checkin_time: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    scheduled_at: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    note: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
}).strict();
async function isValidStaffId(id, kind) {
    var _a, _b;
    if (!id)
        return true;
    const sid = String(id);
    const allowed = kind === 'cleaner'
        ? ['cleaner', 'cleaner_inspector']
        : ['cleaning_inspector', 'cleaner_inspector'];
    if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
        try {
            const r = await dbAdapter_1.pgPool.query('SELECT role FROM users WHERE id=$1 LIMIT 1', [sid]);
            const role = String(((_b = (_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.role) || '');
            return allowed.includes(role);
        }
        catch (_c) {
            return false;
        }
    }
    const u = (store_1.db.users || []).find((x) => String(x.id) === sid);
    if (u)
        return allowed.includes(String(u.role || ''));
    const all = (store_1.db.cleaners || []).map((x) => ({ ...x, kind: (x === null || x === void 0 ? void 0 : x.kind) || 'cleaner', is_active: (x === null || x === void 0 ? void 0 : x.is_active) !== false }));
    const found = all.find((x) => String(x.id) === sid && x.is_active !== false && x.kind === kind);
    return !!found;
}
exports.router.patch('/tasks/:id', (0, auth_1.requirePerm)('cleaning.task.assign'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const { id } = req.params;
    const operationId = (0, uuid_1.v4)();
    const opNow = new Date().toISOString();
    const parsed = patchTaskSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (!(await isValidStaffId((_a = parsed.data.cleaner_id) !== null && _a !== void 0 ? _a : null, 'cleaner')))
        return res.status(400).json({ message: '无效的清洁人员' });
    if (!(await isValidStaffId((_b = parsed.data.inspector_id) !== null && _b !== void 0 ? _b : null, 'inspector')))
        return res.status(400).json({ message: '无效的检查人员' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)]);
            const before = ((_c = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _c === void 0 ? void 0 : _c[0]) || null;
            if (!before)
                return res.status(404).json({ message: 'task not found' });
            if (parsed.data.keys_required !== undefined && before.order_id) {
                return res.status(400).json({ message: '该任务关联订单，钥匙套数请按订单更新（orders.keys_required）' });
            }
            const patch = { ...parsed.data };
            if (patch.keys_required === null)
                patch.keys_required = 1;
            if (patch.cleaner_id !== undefined && patch.assignee_id === undefined)
                patch.assignee_id = patch.cleaner_id;
            if (patch.assignee_id !== undefined && patch.cleaner_id === undefined)
                patch.cleaner_id = patch.assignee_id;
            if (patch.task_date != null)
                patch.date = patch.task_date;
            validateAndApplyInspectionPatch({ patch, current: before });
            {
                const beforeStatus = String(before.status || 'pending');
                const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned';
                const incomingStatus = parsed.data.status;
                const incomingStatusEligible = incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned';
                const touchingAssignees = parsed.data.cleaner_id !== undefined ||
                    parsed.data.inspector_id !== undefined ||
                    parsed.data.assignee_id !== undefined ||
                    parsed.data.inspection_mode !== undefined ||
                    parsed.data.inspection_due_date !== undefined;
                if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
                    const nextCleanerId = patch.cleaner_id !== undefined ? ((_d = patch.cleaner_id) !== null && _d !== void 0 ? _d : null) : ((_f = (_e = before.cleaner_id) !== null && _e !== void 0 ? _e : before.assignee_id) !== null && _f !== void 0 ? _f : null);
                    const nextInspectorId = parsed.data.inspector_id !== undefined ? ((_g = parsed.data.inspector_id) !== null && _g !== void 0 ? _g : null) : ((_h = before.inspector_id) !== null && _h !== void 0 ? _h : null);
                    patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId);
                }
            }
            patch.updated_at = new Date().toISOString();
            const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
            const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
            const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]));
            const sql = `UPDATE cleaning_tasks SET ${set} WHERE id = $${keys.length + 1} RETURNING *`;
            const r1 = await dbAdapter_1.pgPool.query(sql, [...values, String(id)]);
            const updated = ((_j = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _j === void 0 ? void 0 : _j[0]) || before;
            if (parsed.data.keys_required !== undefined) {
                const orderId = String((updated === null || updated === void 0 ? void 0 : updated.order_id) || '').trim();
                const nextK0 = (updated === null || updated === void 0 ? void 0 : updated.keys_required) == null ? null : Number(updated.keys_required);
                const nextK = Number.isFinite(nextK0) ? Math.max(1, Math.min(2, Math.trunc(nextK0))) : null;
                if (orderId && nextK != null) {
                    try {
                        await dbAdapter_1.pgPool.query(`UPDATE cleaning_tasks
               SET keys_required = $1, updated_at = now()
               WHERE order_id::text = $2::text
                 AND COALESCE(status,'') <> 'cancelled'
                 AND COALESCE(keys_required, 1) <> $1`, [nextK, orderId]);
                    }
                    catch (_p) { }
                }
            }
            try {
                const changes = [];
                if (String(before.old_code || '') !== String(updated.old_code || ''))
                    changes.push('password');
                if (String(before.new_code || '') !== String(updated.new_code || ''))
                    changes.push('password');
                if (String(before.checkout_time || '') !== String(updated.checkout_time || ''))
                    changes.push('time');
                if (String(before.checkin_time || '') !== String(updated.checkin_time || ''))
                    changes.push('time');
                if (String(before.note || '') !== String(updated.note || ''))
                    changes.push('note');
                if (String(before.status || '') !== String(updated.status || ''))
                    changes.push('status');
                if (String((_k = before.keys_required) !== null && _k !== void 0 ? _k : '') !== String((_l = updated.keys_required) !== null && _l !== void 0 ? _l : ''))
                    changes.push('keys');
                if (String(before.inspection_mode || '') !== String(updated.inspection_mode || '') || String(before.inspection_due_date || '') !== String(updated.inspection_due_date || ''))
                    changes.push('inspection');
                const propertyId = String(updated.property_id || '').trim();
                if (changes.length && propertyId) {
                    enqueueNotification(() => {
                        var _a;
                        return (0, notificationEvents_1.emitNotificationEvent)({
                            type: 'CLEANING_TASK_UPDATED',
                            entity: 'cleaning_task',
                            entityId: String(id),
                            propertyId,
                            updatedAt: opNow,
                            changes,
                            data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task' },
                            actorUserId: (_a = req.user) === null || _a === void 0 ? void 0 : _a.sub,
                        }, { operationId });
                    });
                }
            }
            catch (_q) { }
            return res.json(updated);
        }
        const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
        if (!task)
            return res.status(404).json({ message: 'task not found' });
        const before = { ...task };
        if (parsed.data.keys_required !== undefined && String(task.order_id || '').trim()) {
            return res.status(400).json({ message: '该任务关联订单，钥匙套数请按订单更新（orders.keys_required）' });
        }
        if (parsed.data.keys_required === null)
            parsed.data.keys_required = 1;
        validateAndApplyInspectionPatch({ patch: parsed.data, current: task });
        if (parsed.data.property_id !== undefined)
            task.property_id = parsed.data.property_id;
        if (parsed.data.task_date !== undefined) {
            task.task_date = parsed.data.task_date;
            task.date = parsed.data.task_date;
        }
        if (parsed.data.status !== undefined)
            task.status = parsed.data.status;
        if (parsed.data.cleaner_id !== undefined)
            task.cleaner_id = parsed.data.cleaner_id;
        if (parsed.data.inspector_id !== undefined)
            task.inspector_id = parsed.data.inspector_id;
        if (parsed.data.inspection_mode !== undefined)
            task.inspection_mode = parsed.data.inspection_mode;
        if (parsed.data.inspection_due_date !== undefined)
            task.inspection_due_date = parsed.data.inspection_due_date;
        if (parsed.data.keys_required !== undefined)
            task.keys_required = parsed.data.keys_required;
        if (parsed.data.nights_override !== undefined)
            task.nights_override = parsed.data.nights_override;
        if (parsed.data.old_code !== undefined)
            task.old_code = parsed.data.old_code;
        if (parsed.data.new_code !== undefined)
            task.new_code = parsed.data.new_code;
        if (parsed.data.checkout_time !== undefined)
            task.checkout_time = parsed.data.checkout_time;
        if (parsed.data.checkin_time !== undefined)
            task.checkin_time = parsed.data.checkin_time;
        if (parsed.data.assignee_id !== undefined)
            task.assignee_id = parsed.data.assignee_id;
        if (parsed.data.cleaner_id !== undefined && parsed.data.assignee_id === undefined)
            task.assignee_id = parsed.data.cleaner_id;
        if (parsed.data.assignee_id !== undefined && parsed.data.cleaner_id === undefined)
            task.cleaner_id = parsed.data.assignee_id;
        if (parsed.data.scheduled_at !== undefined)
            task.scheduled_at = parsed.data.scheduled_at;
        if (parsed.data.note !== undefined)
            task.note = parsed.data.note;
        {
            const beforeStatus = String(before.status || 'pending');
            const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned';
            const incomingStatus = parsed.data.status;
            const incomingStatusEligible = incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned';
            const touchingAssignees = parsed.data.cleaner_id !== undefined ||
                parsed.data.inspector_id !== undefined ||
                parsed.data.assignee_id !== undefined ||
                parsed.data.inspection_mode !== undefined ||
                parsed.data.inspection_due_date !== undefined;
            if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
                const cleaner = String(task.cleaner_id || task.assignee_id || '').trim();
                const inspector = String(task.inspector_id || '').trim();
                task.status = assignedStatusFromAssignees(cleaner, inspector);
            }
        }
        if (parsed.data.keys_required !== undefined) {
            const orderId = String(task.order_id || '').trim();
            const nextK0 = task.keys_required == null ? null : Number(task.keys_required);
            const nextK = Number.isFinite(nextK0) ? Math.max(1, Math.min(2, Math.trunc(nextK0))) : null;
            if (orderId && nextK != null) {
                for (const t of store_1.db.cleaningTasks) {
                    if (String(t.order_id || '').trim() !== orderId)
                        continue;
                    if (String(t.status || '') === 'cancelled')
                        continue;
                    t.keys_required = nextK;
                }
            }
        }
        try {
            const changes = [];
            if (String(before.old_code || '') !== String(task.old_code || ''))
                changes.push('password');
            if (String(before.new_code || '') !== String(task.new_code || ''))
                changes.push('password');
            if (String(before.checkout_time || '') !== String(task.checkout_time || ''))
                changes.push('time');
            if (String(before.checkin_time || '') !== String(task.checkin_time || ''))
                changes.push('time');
            if (String(before.note || '') !== String(task.note || ''))
                changes.push('note');
            if (String(before.status || '') !== String(task.status || ''))
                changes.push('status');
            if (String((_m = before.keys_required) !== null && _m !== void 0 ? _m : '') !== String((_o = task.keys_required) !== null && _o !== void 0 ? _o : ''))
                changes.push('keys');
            if (String(before.inspection_mode || '') !== String(task.inspection_mode || '') || String(before.inspection_due_date || '') !== String(task.inspection_due_date || ''))
                changes.push('inspection');
            const propertyId = String(task.property_id || '').trim();
            if (changes.length && propertyId) {
                enqueueNotification(() => {
                    var _a;
                    return (0, notificationEvents_1.emitNotificationEvent)({
                        type: 'CLEANING_TASK_UPDATED',
                        entity: 'cleaning_task',
                        entityId: String(id),
                        propertyId,
                        updatedAt: opNow,
                        changes,
                        data: { entity: 'cleaning_task', entityId: String(id), action: 'open_task' },
                        actorUserId: (_a = req.user) === null || _a === void 0 ? void 0 : _a.sub,
                    }, { operationId });
                });
            }
        }
        catch (_r) { }
        return res.json(task);
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'update_failed' });
    }
});
const createTaskSchema = zod_1.z.object({
    task_type: zod_1.z.enum(['checkout_clean', 'checkin_clean', 'stayover_clean']).optional(),
    create_mode: zod_1.z.enum(['checkout', 'checkin', 'turnover', 'stayover']).optional(),
    task_date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    property_id: zod_1.z.string().min(1),
    status: zod_1.z.enum(['pending', 'assigned', 'in_progress', 'completed', 'cancelled']).optional(),
    cleaner_id: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    inspector_id: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    inspection_mode: zod_1.z.enum(['pending_decision', 'same_day', 'self_complete', 'deferred']).optional().nullable(),
    inspection_due_date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    scheduled_at: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.null()]).optional(),
    old_code: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    new_code: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    checkout_time: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    checkin_time: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
    keys_required: zod_1.z
        .preprocess((v) => {
        if (v == null)
            return v;
        if (typeof v === 'number')
            return v;
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
    }, zod_1.z.number().int().min(1).max(2))
        .optional()
        .nullable(),
    nights_override: zod_1.z.union([zod_1.z.number().int().nonnegative(), zod_1.z.null()]).optional(),
    note: zod_1.z.union([zod_1.z.string(), zod_1.z.null()]).optional(),
}).strict();
exports.router.post('/tasks', (0, auth_1.requirePerm)('cleaning.task.assign'), async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u;
    const parsed = createTaskSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (!(await isValidStaffId((_a = parsed.data.cleaner_id) !== null && _a !== void 0 ? _a : null, 'cleaner')))
        return res.status(400).json({ message: '无效的清洁人员' });
    if (!(await isValidStaffId((_b = parsed.data.inspector_id) !== null && _b !== void 0 ? _b : null, 'inspector')))
        return res.status(400).json({ message: '无效的检查人员' });
    try {
        const mode = parsed.data.create_mode;
        const taskType = parsed.data.task_type;
        if (!mode && !taskType)
            return res.status(400).json({ message: 'missing task_type' });
        const types = mode === 'turnover' ? ['checkout_clean', 'checkin_clean'] :
            mode === 'checkout' ? ['checkout_clean'] :
                mode === 'checkin' ? ['checkin_clean'] :
                    mode === 'stayover' ? ['stayover_clean'] :
                        [String(taskType)];
        const createdRows = [];
        const rawPropertyId = String(parsed.data.property_id || '').trim();
        let normalizedPropertyId = rawPropertyId;
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            try {
                const r = await dbAdapter_1.pgPool.query('SELECT id::text AS id FROM properties WHERE id::text=$1 OR upper(code)=upper($1) LIMIT 1', [rawPropertyId]);
                const row = (_c = r === null || r === void 0 ? void 0 : r.rows) === null || _c === void 0 ? void 0 : _c[0];
                const id = (row === null || row === void 0 ? void 0 : row.id) ? String(row.id) : '';
                if (!id)
                    return res.status(400).json({ message: '无效的房源' });
                normalizedPropertyId = id;
            }
            catch (_v) { }
        }
        else {
            const anyDb = store_1.db;
            const props = Array.isArray(anyDb === null || anyDb === void 0 ? void 0 : anyDb.properties) ? anyDb.properties : [];
            const found = props.find((p) => String((p === null || p === void 0 ? void 0 : p.id) || '') === rawPropertyId || String((p === null || p === void 0 ? void 0 : p.code) || '').toLowerCase() === rawPropertyId.toLowerCase());
            const id = (found === null || found === void 0 ? void 0 : found.id) ? String(found.id) : '';
            if (!id)
                return res.status(400).json({ message: '无效的房源' });
            normalizedPropertyId = id;
        }
        const base = {
            order_id: null,
            property_id: normalizedPropertyId,
            task_date: parsed.data.task_date,
            date: parsed.data.task_date,
            status: parsed.data.status || assignedStatusFromAssignees((_d = parsed.data.cleaner_id) !== null && _d !== void 0 ? _d : null, (_e = parsed.data.inspector_id) !== null && _e !== void 0 ? _e : null),
            assignee_id: ((_f = parsed.data.cleaner_id) !== null && _f !== void 0 ? _f : null),
            cleaner_id: ((_g = parsed.data.cleaner_id) !== null && _g !== void 0 ? _g : null),
            inspector_id: ((_h = parsed.data.inspector_id) !== null && _h !== void 0 ? _h : null),
            scheduled_at: (_j = parsed.data.scheduled_at) !== null && _j !== void 0 ? _j : null,
            old_code: (_k = parsed.data.old_code) !== null && _k !== void 0 ? _k : null,
            new_code: (_l = parsed.data.new_code) !== null && _l !== void 0 ? _l : null,
            checkout_time: (_m = parsed.data.checkout_time) !== null && _m !== void 0 ? _m : null,
            checkin_time: (_o = parsed.data.checkin_time) !== null && _o !== void 0 ? _o : null,
            keys_required: parsed.data.keys_required == null ? 1 : parsed.data.keys_required,
            nights_override: (_p = parsed.data.nights_override) !== null && _p !== void 0 ? _p : null,
            note: (_q = parsed.data.note) !== null && _q !== void 0 ? _q : null,
            auto_sync_enabled: true,
            source: 'manual',
        };
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            const client = await dbAdapter_1.pgPool.connect();
            try {
                await client.query('BEGIN');
                for (const tt of types) {
                    const row = {
                        id: (0, uuid_1.v4)(),
                        ...base,
                        task_type: tt,
                        type: tt,
                        inspection_mode: (0, cleaningInspection_1.normalizeInspectionMode)(parsed.data.inspection_mode) || (0, cleaningInspection_1.defaultInspectionModeForTaskType)(tt),
                        inspection_due_date: (_r = parsed.data.inspection_due_date) !== null && _r !== void 0 ? _r : null,
                    };
                    validateAndApplyInspectionPatch({ patch: row, taskType: tt });
                    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
                    const cols = keys.map((k) => `"${k}"`).join(', ');
                    const args = keys.map((_, i) => `$${i + 1}`).join(', ');
                    const values = keys.map((k) => row[k]);
                    const sql = `INSERT INTO cleaning_tasks(${cols}) VALUES(${args}) RETURNING *`;
                    const r = await client.query(sql, values);
                    const created = ((_s = r === null || r === void 0 ? void 0 : r.rows) === null || _s === void 0 ? void 0 : _s[0]) || row;
                    createdRows.push(created);
                    await (0, workTaskEvents_1.emitWorkTaskEvent)({
                        taskId: `cleaning_task:${String(created.id)}`,
                        sourceType: 'cleaning_tasks',
                        sourceRefIds: [String(created.id)],
                        eventType: 'TASK_CREATED',
                        changeScope: 'list',
                        changedFields: ['task_type', 'task_date', 'date', 'status', 'assignee_id', 'cleaner_id', 'inspector_id', 'scheduled_at', 'property_id'],
                        patch: {
                            id: created.id,
                            task_type: created.task_type,
                            task_date: created.task_date,
                            date: created.date,
                            status: created.status,
                            assignee_id: created.assignee_id,
                            cleaner_id: created.cleaner_id,
                            inspector_id: created.inspector_id,
                            scheduled_at: created.scheduled_at,
                            property_id: created.property_id,
                        },
                        causedByUserId: String(((_t = req === null || req === void 0 ? void 0 : req.user) === null || _t === void 0 ? void 0 : _t.sub) || '').trim() || null,
                        visibilityHints: (0, workTaskEvents_1.buildCleaningTaskVisibilityHints)(created),
                    }, client);
                }
                await client.query('COMMIT');
            }
            catch (e) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (_w) { }
                throw e;
            }
            finally {
                client.release();
            }
            if (createdRows.length === 1)
                return res.json(createdRows[0]);
            return res.json({ ok: true, created: createdRows.length });
        }
        for (const tt of types) {
            const row = {
                id: (0, uuid_1.v4)(),
                ...base,
                task_type: tt,
                type: tt,
                inspection_mode: (0, cleaningInspection_1.normalizeInspectionMode)(parsed.data.inspection_mode) || (0, cleaningInspection_1.defaultInspectionModeForTaskType)(tt),
                inspection_due_date: (_u = parsed.data.inspection_due_date) !== null && _u !== void 0 ? _u : null,
            };
            validateAndApplyInspectionPatch({ patch: row, taskType: tt });
            store_1.db.cleaningTasks.push(row);
            createdRows.push(row);
        }
        if (createdRows.length === 1)
            return res.json(createdRows[0]);
        return res.json({ ok: true, created: createdRows.length });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'create_failed' });
    }
});
exports.router.delete('/tasks/:id', (0, auth_1.requirePerm)('cleaning.task.assign'), async (req, res) => {
    var _a, _b;
    const { id } = req.params;
    const actor = req.user;
    const actorId = (actor === null || actor === void 0 ? void 0 : actor.sub) ? String(actor.sub) : undefined;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [String(id)]);
            const before = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!before)
                return res.status(404).json({ message: 'task not found' });
            const r1 = await dbAdapter_1.pgPool.query(`UPDATE cleaning_tasks SET status='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [String(id)]);
            const after = ((_b = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _b === void 0 ? void 0 : _b[0]) || null;
            await (0, workTaskEvents_1.emitWorkTaskEvent)({
                taskId: `cleaning_task:${String(id)}`,
                sourceType: 'cleaning_tasks',
                sourceRefIds: [String(id)],
                eventType: 'TASK_REMOVED',
                changeScope: 'membership',
                changedFields: ['status'],
                patch: { status: 'cancelled' },
                causedByUserId: actorId || null,
                visibilityHints: (0, workTaskEvents_1.buildCleaningTaskVisibilityHints)(after || before),
            });
            (0, store_1.addAudit)('cleaning_task', String(id), 'delete', before, after, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') });
            return res.json({ ok: true });
        }
        const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
        if (!task)
            return res.status(404).json({ message: 'task not found' });
        const before = { ...task };
        task.status = 'cancelled';
        task.auto_sync_enabled = false;
        (0, store_1.addAudit)('cleaning_task', String(id), 'delete', before, { ...task }, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') });
        return res.json({ ok: true });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'delete_failed' });
    }
});
const bulkDeleteSchema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1)).min(1) }).strict();
exports.router.post('/tasks/bulk-delete', (0, auth_1.requirePerm)('cleaning.task.assign'), async (req, res) => {
    var _a, _b;
    const parsed = bulkDeleteSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const actor = req.user;
    const actorId = (actor === null || actor === void 0 ? void 0 : actor.sub) ? String(actor.sub) : undefined;
    const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)));
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const client = await dbAdapter_1.pgPool.connect();
            try {
                await client.query('BEGIN');
                for (const id of ids) {
                    const r0 = await client.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id]);
                    const before = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
                    if (!before)
                        continue;
                    const r1 = await client.query(`UPDATE cleaning_tasks SET status='cancelled', auto_sync_enabled=false, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
                    const after = ((_b = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _b === void 0 ? void 0 : _b[0]) || null;
                    await (0, workTaskEvents_1.emitWorkTaskEvent)({
                        taskId: `cleaning_task:${String(id)}`,
                        sourceType: 'cleaning_tasks',
                        sourceRefIds: [String(id)],
                        eventType: 'TASK_REMOVED',
                        changeScope: 'membership',
                        changedFields: ['status'],
                        patch: { status: 'cancelled' },
                        causedByUserId: actorId || null,
                        visibilityHints: (0, workTaskEvents_1.buildCleaningTaskVisibilityHints)(after || before),
                    }, client);
                    (0, store_1.addAudit)('cleaning_task', String(id), 'delete', before, after, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') });
                }
                await client.query('COMMIT');
            }
            catch (e) {
                try {
                    await client.query('ROLLBACK');
                }
                catch (_c) { }
                throw e;
            }
            finally {
                client.release();
            }
            return res.json({ ok: true, deleted: ids.length });
        }
        let cnt = 0;
        for (const id of ids) {
            const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
            if (!task)
                continue;
            const before = { ...task };
            task.status = 'cancelled';
            task.auto_sync_enabled = false;
            (0, store_1.addAudit)('cleaning_task', String(id), 'delete', before, { ...task }, actorId, { ip: String(req.ip || ''), user_agent: String(req.headers['user-agent'] || '') });
            cnt++;
        }
        return res.json({ ok: true, deleted: cnt });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'bulk_delete_failed' });
    }
});
const bulkPatchSchema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1)).min(1), patch: patchTaskSchema }).strict();
exports.router.post('/tasks/bulk-patch', (0, auth_1.requirePerm)('cleaning.task.assign'), async (req, res) => {
    var _a, _b, _c, _d;
    const parsed = bulkPatchSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    if (!(await isValidStaffId((_a = parsed.data.patch.cleaner_id) !== null && _a !== void 0 ? _a : null, 'cleaner')))
        return res.status(400).json({ message: '无效的清洁人员' });
    if (!(await isValidStaffId((_b = parsed.data.patch.inspector_id) !== null && _b !== void 0 ? _b : null, 'inspector')))
        return res.status(400).json({ message: '无效的检查人员' });
    const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)));
    const basePatch = { ...parsed.data.patch };
    if (basePatch.keys_required === null)
        basePatch.keys_required = 1;
    if (basePatch.cleaner_id !== undefined && basePatch.assignee_id === undefined)
        basePatch.assignee_id = basePatch.cleaner_id;
    if (basePatch.assignee_id !== undefined && basePatch.cleaner_id === undefined)
        basePatch.cleaner_id = basePatch.assignee_id;
    try {
        const updated = [];
        if (basePatch.keys_required !== undefined) {
            if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
                const r = await dbAdapter_1.pgPool.query(`SELECT COUNT(1) AS cnt
           FROM cleaning_tasks
           WHERE id::text = ANY($1::text[])
             AND order_id IS NOT NULL`, [ids]);
                const cnt = ((_d = (_c = r === null || r === void 0 ? void 0 : r.rows) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.cnt) == null ? 0 : Number(r.rows[0].cnt);
                if (Number.isFinite(cnt) && cnt > 0)
                    return res.status(400).json({ message: '批量任务包含关联订单的任务，钥匙套数请按订单更新（orders.keys_required）' });
            }
            else {
                const hasOrder = ids.some((id) => {
                    const t = store_1.db.cleaningTasks.find((x) => String(x.id) === String(id));
                    return !!String((t === null || t === void 0 ? void 0 : t.order_id) || '').trim();
                });
                if (hasOrder)
                    return res.status(400).json({ message: '批量任务包含关联订单的任务，钥匙套数请按订单更新（orders.keys_required）' });
            }
        }
        for (const id of ids) {
            const r = await (async () => {
                var _a, _b, _c, _d, _e, _f, _g, _h;
                if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
                    await (0, cleaningSync_1.ensureCleaningSchemaV2)();
                    const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE id=$1 LIMIT 1', [id]);
                    const before = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
                    if (!before)
                        return null;
                    const patch = { ...basePatch };
                    if (patch.task_date != null)
                        patch.date = patch.task_date;
                    validateAndApplyInspectionPatch({ patch, current: before });
                    {
                        const beforeStatus = String(before.status || 'pending');
                        const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned';
                        const incomingStatus = basePatch.status;
                        const incomingStatusEligible = incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned';
                        const touchingAssignees = basePatch.cleaner_id !== undefined ||
                            basePatch.inspector_id !== undefined ||
                            basePatch.assignee_id !== undefined ||
                            basePatch.inspection_mode !== undefined ||
                            basePatch.inspection_due_date !== undefined;
                        if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
                            const nextCleanerId = patch.cleaner_id !== undefined ? ((_b = patch.cleaner_id) !== null && _b !== void 0 ? _b : null) : ((_d = (_c = before.cleaner_id) !== null && _c !== void 0 ? _c : before.assignee_id) !== null && _d !== void 0 ? _d : null);
                            const nextInspectorId = patch.inspector_id !== undefined ? ((_e = patch.inspector_id) !== null && _e !== void 0 ? _e : null) : ((_f = before.inspector_id) !== null && _f !== void 0 ? _f : null);
                            patch.status = assignedStatusFromAssignees(nextCleanerId, nextInspectorId);
                        }
                    }
                    patch.updated_at = new Date().toISOString();
                    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
                    if (!keys.length)
                        return before;
                    const set = keys.map((k, i) => `"${k}"=$${i + 1}`).join(', ');
                    const values = keys.map((k) => (patch[k] === undefined ? null : patch[k]));
                    const sql = `UPDATE cleaning_tasks SET ${set} WHERE id=$${keys.length + 1} RETURNING *`;
                    const r1 = await dbAdapter_1.pgPool.query(sql, [...values, id]);
                    const after = ((_g = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _g === void 0 ? void 0 : _g[0]) || before;
                    const changedFields = Object.keys(patch || {}).filter((key) => patch[key] !== undefined);
                    const assignmentChanged = ['assignee_id', 'cleaner_id', 'inspector_id'].some((key) => changedFields.includes(key));
                    await (0, workTaskEvents_1.emitWorkTaskEvent)({
                        taskId: `cleaning_task:${String(id)}`,
                        sourceType: 'cleaning_tasks',
                        sourceRefIds: [String(id)],
                        eventType: assignmentChanged ? 'TASK_ASSIGNMENT_CHANGED' : (String((after === null || after === void 0 ? void 0 : after.status) || '').trim().toLowerCase() === 'cancelled' ? 'TASK_REMOVED' : 'TASK_UPDATED'),
                        changeScope: assignmentChanged ? 'membership' : (String((after === null || after === void 0 ? void 0 : after.status) || '').trim().toLowerCase() === 'cancelled' ? 'membership' : 'list'),
                        changedFields,
                        patch: Object.fromEntries(changedFields.map((field) => [field, after === null || after === void 0 ? void 0 : after[field]])),
                        causedByUserId: String(((_h = req === null || req === void 0 ? void 0 : req.user) === null || _h === void 0 ? void 0 : _h.sub) || '').trim() || null,
                        visibilityHints: (0, workTaskEvents_1.buildCleaningTaskVisibilityHints)(after || before),
                    });
                    return after;
                }
                const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
                if (!task)
                    return null;
                const patch = { ...basePatch };
                validateAndApplyInspectionPatch({ patch, current: task });
                if (patch.property_id !== undefined)
                    task.property_id = patch.property_id;
                if (patch.task_date !== undefined) {
                    task.task_date = patch.task_date;
                    task.date = patch.task_date;
                }
                if (patch.status !== undefined)
                    task.status = patch.status;
                if (patch.cleaner_id !== undefined)
                    task.cleaner_id = patch.cleaner_id;
                if (patch.inspector_id !== undefined)
                    task.inspector_id = patch.inspector_id;
                if (patch.assignee_id !== undefined)
                    task.assignee_id = patch.assignee_id;
                if (patch.inspection_mode !== undefined)
                    task.inspection_mode = patch.inspection_mode;
                if (patch.inspection_due_date !== undefined)
                    task.inspection_due_date = patch.inspection_due_date;
                if (patch.keys_required !== undefined)
                    task.keys_required = patch.keys_required;
                if (patch.scheduled_at !== undefined)
                    task.scheduled_at = patch.scheduled_at;
                if (patch.note !== undefined)
                    task.note = patch.note;
                {
                    const beforeStatus = String(task.status || 'pending');
                    const statusAutoEligible = beforeStatus === 'pending' || beforeStatus === 'assigned';
                    const incomingStatus = patch.status;
                    const incomingStatusEligible = incomingStatus === undefined || String(incomingStatus) === 'pending' || String(incomingStatus) === 'assigned';
                    const touchingAssignees = patch.cleaner_id !== undefined ||
                        patch.inspector_id !== undefined ||
                        patch.assignee_id !== undefined ||
                        patch.inspection_mode !== undefined ||
                        patch.inspection_due_date !== undefined;
                    if (touchingAssignees && statusAutoEligible && incomingStatusEligible) {
                        const cleaner = String(task.cleaner_id || task.assignee_id || '').trim();
                        const inspector = String(task.inspector_id || '').trim();
                        task.status = assignedStatusFromAssignees(cleaner, inspector);
                    }
                }
                return task;
            })();
            if (r)
                updated.push(r);
        }
        return res.json({ ok: true, updated: updated.length });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'bulk_patch_failed' });
    }
});
const bulkIdsSchema = zod_1.z.object({ ids: zod_1.z.array(zod_1.z.string().min(1)).min(1) }).strict();
exports.router.post('/tasks/bulk-lock-auto-sync', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    const parsed = bulkIdsSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)));
    if (!ids.length)
        return res.status(400).json({ message: 'ids required' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const r = await dbAdapter_1.pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=false, updated_at=now() WHERE id = ANY($1::text[]) RETURNING id', [ids]);
            return res.json({ ok: true, updated: (r === null || r === void 0 ? void 0 : r.rowCount) || 0 });
        }
        let cnt = 0;
        for (const id of ids) {
            const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
            if (!task)
                continue;
            task.auto_sync_enabled = false;
            cnt++;
        }
        return res.json({ ok: true, updated: cnt });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'bulk_lock_failed' });
    }
});
exports.router.post('/tasks/bulk-restore-auto-sync', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    const parsed = bulkIdsSchema.safeParse(req.body || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const ids = Array.from(new Set(parsed.data.ids.map((x) => String(x).trim()).filter(Boolean)));
    if (!ids.length)
        return res.status(400).json({ message: 'ids required' });
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const r = await dbAdapter_1.pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id = ANY($1::text[]) RETURNING id, order_id', [ids]);
            const orderIds = Array.from(new Set(((r === null || r === void 0 ? void 0 : r.rows) || []).map((x) => String((x === null || x === void 0 ? void 0 : x.order_id) || '')).filter(Boolean)));
            if (orderIds.length) {
                try {
                    const { pgRunInTransaction } = require('../dbAdapter');
                    const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs');
                    const idsForJob = orderIds.slice();
                    setTimeout(() => {
                        ;
                        (async () => {
                            await pgRunInTransaction(async (client) => {
                                for (const orderId of idsForJob) {
                                    try {
                                        await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } });
                                    }
                                    catch (_a) { }
                                }
                            });
                        })().catch(() => { });
                    }, 0);
                }
                catch (_a) { }
            }
            return res.json({ ok: true, updated: (r === null || r === void 0 ? void 0 : r.rowCount) || 0 });
        }
        let cnt = 0;
        for (const id of ids) {
            const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
            if (!task)
                continue;
            task.auto_sync_enabled = true;
            cnt++;
        }
        return res.json({ ok: true, updated: cnt });
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'bulk_restore_failed' });
    }
});
exports.router.post('/tasks/:id/restore-auto-sync', (0, auth_1.requirePerm)('cleaning.schedule.manage'), async (req, res) => {
    var _a, _b;
    const { id } = req.params;
    try {
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            const r0 = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE id = $1 LIMIT 1', [String(id)]);
            const task = ((_a = r0 === null || r0 === void 0 ? void 0 : r0.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
            if (!task)
                return res.status(404).json({ message: 'task not found' });
            const r1 = await dbAdapter_1.pgPool.query('UPDATE cleaning_tasks SET auto_sync_enabled=true, updated_at=now() WHERE id=$1 RETURNING *', [String(id)]);
            const updated = ((_b = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _b === void 0 ? void 0 : _b[0]) || task;
            const orderId = (updated === null || updated === void 0 ? void 0 : updated.order_id) ? String(updated.order_id) : '';
            if (orderId) {
                try {
                    const { pgRunInTransaction } = require('../dbAdapter');
                    const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs');
                    await pgRunInTransaction(async (client) => {
                        await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } });
                    });
                }
                catch (_c) { }
            }
            return res.json({ ok: true, task: updated });
        }
        const task = store_1.db.cleaningTasks.find((t) => String(t.id) === String(id));
        if (!task)
            return res.status(404).json({ message: 'task not found' });
        task.auto_sync_enabled = true;
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
    var _a;
    const parsed = rangeSchema.safeParse(req.query || {});
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const from = parsed.data.from;
    const to = parsed.data.to;
    const includeDeferredInspection = String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.include_deferred_inspection) || '').trim() === '1';
    try {
        const items = [];
        if (dbAdapter_1.hasPg && dbAdapter_1.pgPool) {
            await (0, cleaningSync_1.ensureCleaningSchemaV2)();
            const r = await dbAdapter_1.pgPool.query(`SELECT
           t.id,
           t.order_id,
           COALESCE(p_id.id::text, p_code.id::text, t.property_id::text) AS property_id,
           COALESCE(p_id.code::text, p_code.code::text) AS property_code,
           COALESCE(p_id.region::text, p_code.region::text) AS property_region,
           t.task_type,
           COALESCE(t.task_date, t.date)::text AS task_date,
           t.status,
           t.assignee_id,
           t.cleaner_id,
           t.inspector_id,
           t.inspection_mode,
           t.inspection_due_date::text AS inspection_due_date,
           t.scheduled_at,
           t.key_photo_uploaded_at,
           EXISTS(
             SELECT 1
             FROM cleaning_task_media m
             WHERE m.task_id::text = t.id::text AND m.type = 'key_photo'
           ) AS has_key_photo,
           t.checkout_time,
           t.checkin_time,
           t.nights_override,
           t.source,
           t.auto_sync_enabled,
           t.old_code,
           t.new_code,
           (o.confirmation_code::text) AS order_code,
           COALESCE(t.nights_override, o.nights) AS nights
         FROM cleaning_tasks t
         LEFT JOIN orders o ON (o.id::text) = (t.order_id::text)
         LEFT JOIN properties p_id ON (p_id.id::text) = (t.property_id::text)
         LEFT JOIN properties p_code ON upper(p_code.code) = upper(t.property_id::text)
         WHERE (
             ((COALESCE(task_date, date)::date) >= ($1::date) AND (COALESCE(task_date, date)::date) <= ($2::date))
             OR ($3::boolean = true AND t.inspection_due_date IS NOT NULL AND (t.inspection_due_date::date) <= ($2::date))
           )
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
         ORDER BY COALESCE(task_date, date) ASC, COALESCE(p_id.code, p_code.code) NULLS LAST, t.id`, [from, to, includeDeferredInspection]);
            for (const row of ((r === null || r === void 0 ? void 0 : r.rows) || [])) {
                const d = String(row.task_date || '').slice(0, 10);
                const rawType = row.task_type ? String(row.task_type) : 'cleaning_task';
                const inspectionMode = (0, cleaningInspection_1.effectiveInspectionMode)(row);
                const inspectionDueDate = dayOnly(row.inspection_due_date);
                const label = rawType === 'checkout_clean' ? '退房' :
                    rawType === 'checkin_clean' ? '入住' :
                        rawType === 'stayover_clean' ? '入住中清洁' :
                            rawType;
                const baseItem = {
                    source: 'cleaning_tasks',
                    order_id: row.order_id ? String(row.order_id) : null,
                    order_code: row.order_code ? String(row.order_code) : null,
                    property_id: row.property_id ? String(row.property_id) : null,
                    property_code: row.property_code ? String(row.property_code) : null,
                    property_region: row.property_region ? String(row.property_region) : null,
                    task_type: row.task_type ? String(row.task_type) : null,
                    status: String(row.status || 'pending'),
                    assignee_id: row.assignee_id ? String(row.assignee_id) : null,
                    cleaner_id: row.cleaner_id ? String(row.cleaner_id) : (row.assignee_id ? String(row.assignee_id) : null),
                    inspector_id: row.inspector_id ? String(row.inspector_id) : null,
                    scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
                    key_photo_uploaded_at: row.key_photo_uploaded_at ? String(row.key_photo_uploaded_at) : null,
                    has_key_photo: !!row.has_key_photo,
                    auto_sync_enabled: row.auto_sync_enabled !== false,
                    old_code: row.old_code != null ? String(row.old_code || '') : null,
                    new_code: row.new_code != null ? String(row.new_code || '') : null,
                    nights: row.nights != null ? Number(row.nights) : null,
                    summary_checkout_time: String(row.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
                    summary_checkin_time: String(row.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
                    inspection_mode: inspectionMode,
                    inspection_due_date: inspectionDueDate,
                };
                if (d >= from && d <= to) {
                    items.push({
                        ...baseItem,
                        entity_id: String(row.id),
                        entity_ids: [String(row.id)],
                        label,
                        task_date: d,
                        cleaning_board_enabled: true,
                        inspection_board_enabled: inspectionMode === 'same_day' || inspectionMode === 'pending_decision',
                        deferred_inspection_view: false,
                    });
                }
                if (includeDeferredInspection) {
                    const projectionDate = (0, cleaningInspection_1.deferredProjectionDate)({
                        inspectionMode,
                        inspectionDueDate,
                        dateFrom: from,
                        dateTo: to,
                        status: row.status,
                    });
                    if (projectionDate) {
                        const deferredLabel = rawType === 'checkout_clean' ? '退房延后检查' :
                            rawType === 'checkin_clean' ? '入住延后检查' :
                                `${label}延后检查`;
                        items.push({
                            ...baseItem,
                            entity_id: `${String(row.id)}::deferred_inspection:${projectionDate}`,
                            entity_ids: [String(row.id)],
                            label: deferredLabel,
                            task_date: projectionDate,
                            cleaning_board_enabled: false,
                            inspection_board_enabled: true,
                            deferred_inspection_view: true,
                        });
                    }
                }
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
            const inspectionMode = (0, cleaningInspection_1.effectiveInspectionMode)(t);
            const inspectionDueDate = dayOnly(t.inspection_due_date);
            const label = rawType === 'checkout_clean' ? '退房' :
                rawType === 'checkin_clean' ? '入住' :
                    rawType === 'stayover_clean' ? '入住中清洁' :
                        rawType;
            const order = store_1.db.orders.find((o) => String(o.id) === String(t.order_id)) || null;
            const prop = store_1.db.properties.find((p) => String(p.id) === String(t.property_id)) || null;
            if (t.order_id && !order)
                continue;
            const statusLower = String((order === null || order === void 0 ? void 0 : order.status) || '').trim().toLowerCase();
            if (t.order_id && (!statusLower || statusLower === 'invalid' || statusLower.includes('cancel')))
                continue;
            const baseItem = {
                source: 'cleaning_tasks',
                order_id: t.order_id ? String(t.order_id) : null,
                order_code: (order === null || order === void 0 ? void 0 : order.confirmation_code) ? String(order.confirmation_code) : null,
                property_id: t.property_id ? String(t.property_id) : null,
                property_code: (prop === null || prop === void 0 ? void 0 : prop.code) ? String(prop.code) : null,
                property_region: (prop === null || prop === void 0 ? void 0 : prop.region) ? String(prop.region) : null,
                task_type: rawType || null,
                status: String(t.status || 'pending'),
                assignee_id: t.assignee_id ? String(t.assignee_id) : null,
                cleaner_id: t.cleaner_id ? String(t.cleaner_id) : (t.assignee_id ? String(t.assignee_id) : null),
                inspector_id: t.inspector_id ? String(t.inspector_id) : null,
                scheduled_at: t.scheduled_at ? String(t.scheduled_at) : null,
                auto_sync_enabled: t.auto_sync_enabled !== false,
                old_code: t.old_code != null ? String(t.old_code || '') : null,
                new_code: t.new_code != null ? String(t.new_code || '') : null,
                nights: t.nights_override != null ? Number(t.nights_override) : ((order === null || order === void 0 ? void 0 : order.nights) != null ? Number(order.nights) : null),
                summary_checkout_time: String(t.checkout_time || '').trim() || DEFAULT_SUMMARY_CHECKOUT_TIME,
                summary_checkin_time: String(t.checkin_time || '').trim() || DEFAULT_SUMMARY_CHECKIN_TIME,
                inspection_mode: inspectionMode,
                inspection_due_date: inspectionDueDate,
            };
            items.push({
                ...baseItem,
                entity_id: String(t.id),
                entity_ids: [String(t.id)],
                label,
                task_date: d,
                cleaning_board_enabled: true,
                inspection_board_enabled: inspectionMode === 'same_day' || inspectionMode === 'pending_decision',
                deferred_inspection_view: false,
            });
            if (includeDeferredInspection) {
                const projectionDate = (0, cleaningInspection_1.deferredProjectionDate)({
                    inspectionMode,
                    inspectionDueDate,
                    dateFrom: from,
                    dateTo: to,
                    status: t.status,
                });
                if (projectionDate) {
                    const deferredLabel = rawType === 'checkout_clean' ? '退房延后检查' :
                        rawType === 'checkin_clean' ? '入住延后检查' :
                            `${label}延后检查`;
                    items.push({
                        ...baseItem,
                        entity_id: `${String(t.id)}::deferred_inspection:${projectionDate}`,
                        entity_ids: [String(t.id)],
                        label: deferredLabel,
                        task_date: projectionDate,
                        cleaning_board_enabled: false,
                        inspection_board_enabled: true,
                        deferred_inspection_view: true,
                    });
                }
            }
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
        const beforeTasks = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId]);
        const beforeCount = Number(((_a = beforeTasks === null || beforeTasks === void 0 ? void 0 : beforeTasks.rows) === null || _a === void 0 ? void 0 : _a.length) || 0);
        let job = null;
        try {
            const { pgRunInTransaction } = require('../dbAdapter');
            const { enqueueCleaningSyncJobTx } = require('../services/cleaningSyncJobs');
            await pgRunInTransaction(async (client) => {
                job = await enqueueCleaningSyncJobTx(client, { order_id: orderId, action: 'updated', payload_snapshot: { id: orderId } });
            });
        }
        catch (e) {
            job = { error: String((e === null || e === void 0 ? void 0 : e.message) || 'enqueue_failed') };
        }
        const afterTasks = await dbAdapter_1.pgPool.query('SELECT * FROM cleaning_tasks WHERE (order_id::text)=$1 ORDER BY task_type, id', [orderId]);
        const afterCount = Number(((_b = afterTasks === null || afterTasks === void 0 ? void 0 : afterTasks.rows) === null || _b === void 0 ? void 0 : _b.length) || 0);
        const orderRow = await dbAdapter_1.pgPool.query('SELECT * FROM orders WHERE (id::text)=$1 LIMIT 1', [orderId]);
        return res.json({
            ok: true,
            order_id: orderId,
            before_count: beforeCount,
            after_count: afterCount,
            job,
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
