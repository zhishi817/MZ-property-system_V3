"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
const zod_1 = require("zod");
const auth_1 = require("../auth");
const dbAdapter_1 = require("../dbAdapter");
exports.router = (0, express_1.Router)();
function auDayStr(d) {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t) => { var _a; return ((_a = parts.find((p) => p.type === t)) === null || _a === void 0 ? void 0 : _a.value) || ''; };
    return `${get('year')}-${get('month')}-${get('day')}`;
}
async function ensureOfflineTasksTable() {
    if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
        return;
    await dbAdapter_1.pgPool.query(`CREATE TABLE IF NOT EXISTS cleaning_offline_tasks (
    id text PRIMARY KEY,
    date date NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    urgency text NOT NULL,
    property_id text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );`);
    await dbAdapter_1.pgPool.query('CREATE INDEX IF NOT EXISTS idx_cleaning_offline_tasks_date ON cleaning_offline_tasks(date);');
}
exports.router.get('/tasks', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), (req, res) => {
    const { date } = req.query;
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgSelect)('cleaning_tasks', '*', date ? { date } : undefined)
            .then((data) => res.json(data))
            .catch((err) => res.status(500).json({ message: err.message }));
        return;
    }
    if (date) {
        const d1 = date;
        const d2 = (() => { try {
            return new Date(date + 'T00:00:00').toISOString().slice(0, 10);
        }
        catch (_a) {
            return d1;
        } })();
        return res.json(store_1.db.cleaningTasks.filter((t) => t.date === d1 || t.date === d2));
    }
    return res.json(store_1.db.cleaningTasks);
});
const taskSchema = zod_1.z.object({
    property_id: zod_1.z.string().optional(),
    date: zod_1.z.string(),
});
exports.router.post('/tasks', (req, res) => {
    const parsed = taskSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const task = { id: uuid(), property_id: parsed.data.property_id, date: parsed.data.date, status: 'pending' };
    store_1.db.cleaningTasks.push(task);
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgInsert)('cleaning_tasks', task)
            .then((row) => res.status(201).json(row || task))
            .catch((_err) => res.status(201).json(task));
        return;
    }
    return res.status(201).json(task);
});
exports.router.get('/staff', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), (req, res) => {
    res.json(store_1.db.cleaners);
});
const assignSchema = zod_1.z.object({ assignee_id: zod_1.z.string(), scheduled_at: zod_1.z.string() });
exports.router.post('/tasks/:id/assign', (0, auth_1.requirePerm)('cleaning.task.assign'), (req, res) => {
    const { id } = req.params;
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const task = store_1.db.cleaningTasks.find((t) => t.id === id);
    if (!task)
        return res.status(404).json({ message: 'task not found' });
    const staff = store_1.db.cleaners.find((c) => c.id === parsed.data.assignee_id);
    if (!staff)
        return res.status(404).json({ message: 'staff not found' });
    const count = store_1.db.cleaningTasks.filter((t) => t.date === task.date && t.assignee_id === staff.id).length;
    if (count >= staff.capacity_per_day)
        return res.status(409).json({ message: 'capacity exceeded' });
    task.assignee_id = staff.id;
    task.scheduled_at = parsed.data.scheduled_at;
    task.status = 'scheduled';
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgUpdate)('cleaning_tasks', task.id, { assignee_id: task.assignee_id, scheduled_at: task.scheduled_at, status: task.status })
            .then((row) => res.json(row || task))
            .catch((_err) => res.json(task));
        return;
    }
    return res.json(task);
});
exports.router.post('/schedule/rebalance', (0, auth_1.requirePerm)('cleaning.schedule.manage'), (req, res) => {
    const pending = store_1.db.cleaningTasks.filter((t) => t.status === 'pending');
    for (const t of pending) {
        const dayStaff = store_1.db.cleaners.sort((a, b) => a.capacity_per_day - b.capacity_per_day);
        for (const s of dayStaff) {
            const count = store_1.db.cleaningTasks.filter((x) => x.date === t.date && x.assignee_id === s.id).length;
            if (count < s.capacity_per_day) {
                t.assignee_id = s.id;
                t.scheduled_at = `${t.date}T10:00:00Z`;
                t.status = 'scheduled';
                break;
            }
        }
    }
    res.json({ updated: pending.length });
});
const patchSchema = zod_1.z.object({ scheduled_at: zod_1.z.string().optional(), status: zod_1.z.enum(['pending', 'scheduled', 'in_progress', 'ready', 'canceled', 'done']).optional(), assignee_id: zod_1.z.string().optional(), old_code: zod_1.z.string().optional(), new_code: zod_1.z.string().optional(), note: zod_1.z.string().optional(), checkout_time: zod_1.z.string().optional(), checkin_time: zod_1.z.string().optional() });
exports.router.patch('/tasks/:id', (0, auth_1.requirePerm)('cleaning.task.assign'), (req, res) => {
    const { id } = req.params;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const task = store_1.db.cleaningTasks.find((t) => t.id === id);
    if (!task)
        return res.status(404).json({ message: 'task not found' });
    if (parsed.data.scheduled_at)
        task.scheduled_at = parsed.data.scheduled_at;
    if (parsed.data.status)
        task.status = (parsed.data.status === 'done' ? 'ready' : parsed.data.status);
    if (parsed.data.assignee_id)
        task.assignee_id = parsed.data.assignee_id;
    if (parsed.data.old_code !== undefined)
        task.old_code = parsed.data.old_code;
    if (parsed.data.new_code !== undefined)
        task.new_code = parsed.data.new_code;
    if (parsed.data.note !== undefined)
        task.note = parsed.data.note;
    if (parsed.data.checkout_time !== undefined)
        task.checkout_time = parsed.data.checkout_time;
    if (parsed.data.checkin_time !== undefined)
        task.checkin_time = parsed.data.checkin_time;
    if (dbAdapter_1.hasPg) {
        (0, dbAdapter_1.pgUpdate)('cleaning_tasks', task.id, parsed.data)
            .then((row) => res.json(row || task))
            .catch((_err) => res.json(task));
        return;
    }
    return res.json(task);
});
exports.router.get('/order/:orderId', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), (req, res) => {
    const order = store_1.db.orders.find(o => o.id === req.params.orderId);
    if (!order)
        return res.status(404).json({ message: 'order not found' });
    const tasks = store_1.db.cleaningTasks.filter(t => t.property_id === order.property_id && t.date === ((order.checkout || '').slice(0, 10) || t.date));
    res.json(tasks);
});
exports.router.get('/capacity', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), (req, res) => {
    const { date } = req.query;
    const dateStr = date || new Date().toISOString().slice(0, 10);
    const d2 = (() => { try {
        return new Date(dateStr + 'T00:00:00').toISOString().slice(0, 10);
    }
    catch (_a) {
        return dateStr;
    } })();
    const result = store_1.db.cleaners.map(c => {
        const assigned = store_1.db.cleaningTasks.filter(t => (t.date === dateStr || t.date === d2) && t.assignee_id === c.id).length;
        return { id: c.id, name: c.name, capacity_per_day: c.capacity_per_day, assigned, remaining: c.capacity_per_day - assigned };
    });
    res.json(result);
});
exports.router.get('/calendar', (req, res) => {
    const { date } = req.query;
    const dateStr = date || new Date().toISOString().slice(0, 10);
    const events = [];
    const getCode = (pid, fallback) => {
        const p = store_1.db.properties.find(pp => pp.id === pid);
        return (p === null || p === void 0 ? void 0 : p.code) || fallback || '';
    };
    function last4(v) { return (v || '').slice(-4) || null; }
    for (const o of store_1.db.orders) {
        const ciDay = (o.checkin || '').slice(0, 10);
        const coDay = (o.checkout || '').slice(0, 10);
        const type = ciDay === dateStr ? 'checkin' : (coDay === dateStr ? 'checkout' : null);
        if (!type)
            continue;
        const t = store_1.db.cleaningTasks.find(x => x.date === dateStr && x.property_id === o.property_id);
        const assignee = (t === null || t === void 0 ? void 0 : t.assignee_id) ? store_1.db.cleaners.find(c => c.id === t.assignee_id) : undefined;
        const nights = (() => {
            if (o.nights)
                return o.nights;
            if (o.checkin && o.checkout) {
                const ci = new Date(o.checkin);
                const co = new Date(o.checkout);
                const ms = co.getTime() - ci.getTime();
                return ms > 0 ? Math.round(ms / (1000 * 60 * 60 * 24)) : 0;
            }
            return 0;
        })();
        events.push({
            id: (t === null || t === void 0 ? void 0 : t.id) || null,
            order_id: o.id,
            property_id: o.property_id,
            property_code: getCode(o.property_id, o.property_code),
            type,
            nights,
            status: (t === null || t === void 0 ? void 0 : t.status) || 'pending',
            scheduled_at: (t === null || t === void 0 ? void 0 : t.scheduled_at) || null,
            assignee_id: (t === null || t === void 0 ? void 0 : t.assignee_id) || null,
            assignee_name: (assignee === null || assignee === void 0 ? void 0 : assignee.name) || null,
            old_code: (t === null || t === void 0 ? void 0 : t.old_code) || (type === 'checkout' ? last4(o.guest_phone) : null),
            new_code: (t === null || t === void 0 ? void 0 : t.new_code) || (type === 'checkin' ? last4(o.guest_phone) : null),
            note: (t === null || t === void 0 ? void 0 : t.note) || null,
        });
    }
    const dAlt = (() => { try {
        return new Date(dateStr + 'T00:00:00').toISOString().slice(0, 10);
    }
    catch (_a) {
        return dateStr;
    } })();
    for (const t of store_1.db.cleaningTasks.filter(x => x.date === dateStr || x.date === dAlt)) {
        const exists = events.some(e => e.id === t.id);
        if (exists)
            continue;
        const assignee = t.assignee_id ? store_1.db.cleaners.find(c => c.id === t.assignee_id) : undefined;
        events.push({
            id: t.id,
            order_id: null,
            property_id: t.property_id,
            property_code: getCode(t.property_id, ''),
            type: 'other',
            nights: null,
            status: t.status,
            scheduled_at: t.scheduled_at || null,
            assignee_id: t.assignee_id || null,
            assignee_name: (assignee === null || assignee === void 0 ? void 0 : assignee.name) || null,
            old_code: t.old_code || null,
            new_code: t.new_code || null,
            note: t.note || null,
        });
    }
    res.json(events);
});
exports.router.get('/offline-tasks', (0, auth_1.requireAnyPerm)(['cleaning.view', 'cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    var _a;
    const dateSchema = zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
    const parsed = dateSchema.safeParse((_a = req.query) === null || _a === void 0 ? void 0 : _a.date);
    const date = parsed.success ? (parsed.data || auDayStr(new Date())) : auDayStr(new Date());
    try {
        if (dbAdapter_1.hasPg) {
            await ensureOfflineTasksTable();
            const rows = await (0, dbAdapter_1.pgSelect)('cleaning_offline_tasks', '*', { date }) || [];
            return res.json(rows);
        }
    }
    catch (e) {
        return res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'offline tasks query failed' });
    }
    return res.json(store_1.db.cleaningOfflineTasks.filter((t) => String(t.date || '').slice(0, 10) === date));
});
const offlineTaskCreateSchema = zod_1.z.object({
    date: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    title: zod_1.z.string().min(1).max(200),
    kind: zod_1.z.string().min(1).max(64),
    urgency: zod_1.z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    property_id: zod_1.z.string().optional(),
});
exports.router.post('/offline-tasks', (0, auth_1.requireAnyPerm)(['cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    const parsed = offlineTaskCreateSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const { v4: uuid } = require('uuid');
    const row = {
        id: uuid(),
        date: parsed.data.date || auDayStr(new Date()),
        title: parsed.data.title,
        kind: parsed.data.kind,
        status: 'todo',
        urgency: parsed.data.urgency || 'medium',
        property_id: parsed.data.property_id || null,
    };
    store_1.db.cleaningOfflineTasks.push({ ...row, property_id: row.property_id || undefined });
    try {
        if (dbAdapter_1.hasPg) {
            await ensureOfflineTasksTable();
            const created = await (0, dbAdapter_1.pgInsert)('cleaning_offline_tasks', row);
            return res.status(201).json(created || row);
        }
    }
    catch (_e) {
        return res.status(201).json(row);
    }
    return res.status(201).json(row);
});
const offlineTaskPatchSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(200).optional(),
    kind: zod_1.z.string().min(1).max(64).optional(),
    status: zod_1.z.enum(['todo', 'done']).optional(),
    urgency: zod_1.z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    property_id: zod_1.z.string().nullable().optional(),
});
exports.router.patch('/offline-tasks/:id', (0, auth_1.requireAnyPerm)(['cleaning.schedule.manage', 'cleaning.task.assign']), async (req, res) => {
    const { id } = req.params;
    const parsed = offlineTaskPatchSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json(parsed.error.format());
    const list = store_1.db.cleaningOfflineTasks || [];
    const local = list.find((t) => String(t.id) === String(id));
    if (local) {
        if (parsed.data.title !== undefined)
            local.title = parsed.data.title;
        if (parsed.data.kind !== undefined)
            local.kind = parsed.data.kind;
        if (parsed.data.status !== undefined)
            local.status = parsed.data.status;
        if (parsed.data.urgency !== undefined)
            local.urgency = parsed.data.urgency;
        if (parsed.data.property_id !== undefined)
            local.property_id = parsed.data.property_id || undefined;
    }
    try {
        if (dbAdapter_1.hasPg) {
            await ensureOfflineTasksTable();
            const payload = { ...parsed.data, updated_at: new Date().toISOString() };
            const updated = await (0, dbAdapter_1.pgUpdate)('cleaning_offline_tasks', id, payload);
            return res.json(updated || local || { id, ...payload });
        }
    }
    catch (_e) {
        return res.json(local || { id, ...parsed.data });
    }
    if (!local)
        return res.status(404).json({ message: 'task not found' });
    return res.json(local);
});
