"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), '.env.local'), override: true });
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../.env.local'), override: true });
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const uuid_1 = require("uuid");
const landlords_1 = require("./modules/landlords");
const properties_1 = require("./modules/properties");
const keys_1 = require("./modules/keys");
const orders_1 = require("./modules/orders");
const inventory_1 = require("./modules/inventory");
const finance_1 = require("./modules/finance");
const cleaning_1 = require("./modules/cleaning");
const config_1 = require("./modules/config");
const cleaning_app_1 = __importDefault(require("./modules/cleaning_app"));
const auth_1 = require("./modules/auth");
const audits_1 = require("./modules/audits");
const rbac_1 = require("./modules/rbac");
const users_1 = require("./modules/users");
const version_1 = require("./modules/version");
const stats_1 = require("./modules/stats");
const events_1 = require("./modules/events");
const notifications_1 = __importDefault(require("./modules/notifications"));
const maintenance_1 = __importDefault(require("./modules/maintenance"));
const deep_cleaning_1 = __importDefault(require("./modules/deep_cleaning"));
const work_tasks_1 = require("./modules/work_tasks");
const task_center_1 = require("./modules/task_center");
const mzapp_1 = require("./modules/mzapp");
const propertyOnboarding_1 = require("./modules/propertyOnboarding");
const property_guides_1 = require("./modules/property_guides");
const property_guide_link_sync_1 = require("./modules/property_guide_link_sync");
const jobs_1 = require("./modules/jobs");
const node_cron_1 = __importDefault(require("node-cron"));
const crud_1 = __importDefault(require("./modules/crud"));
const recurring_1 = __importDefault(require("./modules/recurring"));
const invoices_1 = require("./modules/invoices");
const cms_company_1 = require("./modules/cms_company");
const cms_company_secrets_1 = require("./modules/cms_company_secrets");
const keyUploadReminderJob_1 = require("./lib/keyUploadReminderJob");
const auth_2 = require("./auth");
const public_1 = __importDefault(require("./modules/public"));
const public_admin_1 = __importDefault(require("./modules/public_admin"));
const r2_1 = require("./r2");
const playwright_1 = require("./lib/playwright");
const notificationQueueWorker_1 = require("./services/notificationQueueWorker");
// 环境保险锁（Render 上用 RENDER_ENV=dev/prod 显式区分，避免误判）
let appEnv = process.env.APP_ENV;
let dbRole = process.env.DATABASE_ROLE;
const renderEnv = String(process.env.RENDER_ENV || '').trim().toLowerCase();
if (!appEnv) {
    appEnv = renderEnv === 'dev' || renderEnv === 'prod' ? renderEnv : (process.env.NODE_ENV === 'production' ? 'prod' : 'dev');
    process.env.APP_ENV = appEnv;
}
if (!dbRole) {
    if (renderEnv === 'dev' || renderEnv === 'prod') {
        dbRole = renderEnv;
    }
    else {
        const url = process.env.DATABASE_URL || '';
        dbRole = url ? (/localhost/i.test(url) ? 'dev' : 'prod') : 'none';
    }
    process.env.DATABASE_ROLE = dbRole;
}
if (dbRole !== 'none') {
    if (appEnv === 'dev' && dbRole === 'prod') {
        throw new Error('❌ DEV backend cannot connect to PROD database');
    }
    if (appEnv === 'prod' && dbRole === 'dev') {
        throw new Error('❌ PROD backend cannot connect to DEV database');
    }
}
const dbAdapter_1 = require("./dbAdapter");
// Supabase removed
const fs_1 = __importDefault(require("fs"));
const isProd = process.env.NODE_ENV === 'production';
if (isProd && dbAdapter_1.hasPg) {
    const url = process.env.DATABASE_URL || '';
    if (!url)
        throw new Error('DATABASE_URL 未设置');
    if (/localhost/i.test(url))
        throw new Error('DATABASE_URL 不能使用 localhost');
    if (!/[?&](sslmode=require|sslmode=verify-full|ssl=true|ssl=1)\b/i.test(url))
        throw new Error('DATABASE_URL 需开启 SSL（例如 sslmode=require）');
}
const app = (0, express_1.default)();
const allowList = String(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOpts = {
    origin: (origin, cb) => {
        if (!allowList.length)
            return cb(null, true);
        const ok = !origin || allowList.includes(origin);
        cb(null, ok);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Guide-Session'],
    exposedHeaders: ['X-Total-Count', 'x-auto-expense-sync', 'x-auto-expense-reason', 'x-auto-expense-error']
};
app.use((0, cors_1.default)(corsOpts));
app.options('*', (0, cors_1.default)(corsOpts));
const jsonLimit = String(process.env.JSON_BODY_LIMIT || '25mb');
app.use(express_1.default.json({ limit: jsonLimit }));
app.use(express_1.default.urlencoded({ extended: true, limit: jsonLimit }));
app.use((0, morgan_1.default)('dev'));
// Health endpoints should NOT require auth
app.get('/health', (req, res) => { res.json({ status: 'ok' }); });
app.get('/health/db', async (_req, res) => {
    var _a, _b;
    const result = { status: 'ok', appEnv, databaseRole: dbRole, pg: false };
    try {
        const url = process.env.DATABASE_URL || '';
        if (url) {
            const u = new URL(url);
            result.pg_host = u.hostname;
            const db = (u.pathname || '').replace(/^\//, '');
            result.pg_database = db;
        }
    }
    catch (_c) { }
    try {
        if (dbAdapter_1.pgPool) {
            const r = await dbAdapter_1.pgPool.query('SELECT current_database() as db, 1 as ok');
            result.pg = !!(r && r.rows && r.rows[0] && r.rows[0].ok);
            result.pg_database = result.pg_database || ((_b = (_a = r.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.db);
        }
    }
    catch (e) {
        result.pg = false;
        result.pg_error = e === null || e === void 0 ? void 0 : e.message;
    }
    res.json(result);
});
app.get('/health/config', (_req, res) => {
    const cfg = {
        app_env: process.env.APP_ENV || 'unknown',
        node_env: process.env.NODE_ENV || 'unknown',
        database_role: process.env.DATABASE_ROLE || 'none',
        api_base: process.env.API_BASE || '',
        port: process.env.PORT || '4001',
    };
    try {
        const url = process.env.DATABASE_URL || '';
        if (url) {
            const u = new URL(url);
            cfg.pg_host = u.hostname;
            cfg.pg_db = (u.pathname || '').replace(/^\//, '');
        }
    }
    catch (_a) { }
    res.json(cfg);
});
app.get('/health/r2', (_req, res) => {
    try {
        return res.json((0, r2_1.r2Status)());
    }
    catch (_a) {
        return res.json({ hasR2: false });
    }
});
app.get('/health/migrations', async (_req, res) => {
    const mig = { status: 'ok' };
    try {
        if (dbAdapter_1.pgPool) {
            const qcol = async (table, col) => {
                const r = await dbAdapter_1.pgPool.query(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2 limit 1`, [table, col]);
                return !!r.rowCount;
            };
            mig.recurring_frequency_months = await qcol('recurring_payments', 'frequency_months');
            mig.orders_checkin = await qcol('orders', 'checkin');
            mig.orders_checkout = await qcol('orders', 'checkout');
        }
    }
    catch (e) {
        mig.status = 'error';
        mig.error = e === null || e === void 0 ? void 0 : e.message;
    }
    res.json(mig);
});
app.get('/health/version', (_req, res) => {
    let pkg = {};
    try {
        pkg = require('../package.json');
    }
    catch (_a) { }
    const build = process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || 'unknown';
    res.json({ build, version: pkg.version || 'unknown', node_env: process.env.NODE_ENV || 'unknown', started_at: new Date().toISOString() });
});
app.get('/health/playwright', (_req, res) => {
    try {
        return res.json((0, playwright_1.getPlaywrightDiagnostics)());
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || '') });
    }
});
app.post('/internal/bootstrap-admin', async (req, res) => {
    var _a;
    const token = String(process.env.ADMIN_BOOTSTRAP_TOKEN || '');
    if (!token)
        return res.status(401).json({ message: 'unauthorized' });
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ') || h.slice(7) !== token)
        return res.status(401).json({ message: 'unauthorized' });
    if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool)
        return res.status(400).json({ message: 'pg_not_configured' });
    const body = req.body || {};
    const username = String(body.username || process.env.ADMIN_USERNAME || 'admin').trim();
    const email = String(body.email || process.env.ADMIN_EMAIL || 'admin@example.com').trim();
    const role = String(body.role || process.env.ADMIN_ROLE || 'admin').trim() || 'admin';
    const password = String(body.password || process.env.ADMIN_PASSWORD || '').trim();
    if (!username)
        return res.status(400).json({ message: 'missing_username' });
    if (!email)
        return res.status(400).json({ message: 'missing_email' });
    if (!password)
        return res.status(400).json({ message: 'missing_password' });
    try {
        const hash = await bcryptjs_1.default.hash(password, 10);
        const r = await dbAdapter_1.pgPool.query('SELECT id, username, email FROM users WHERE username=$1 OR email=$2 LIMIT 1', [username, email]);
        const existing = ((_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0]) || null;
        if (!existing) {
            const id = (0, uuid_1.v4)();
            await dbAdapter_1.pgPool.query('INSERT INTO users(id, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)', [id, username, email, hash, role]);
            return res.json({ ok: true, action: 'created', id, username, email, role });
        }
        const id = String(existing.id);
        await dbAdapter_1.pgPool.query('UPDATE users SET password_hash=$1, role=$2 WHERE id=$3', [hash, role, id]);
        try {
            await dbAdapter_1.pgPool.query('UPDATE sessions SET revoked=true WHERE user_id=$1 AND revoked=false', [id]);
        }
        catch (_b) { }
        return res.json({ ok: true, action: 'reset', id, username: existing.username, email: existing.email, role });
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || 'bootstrap_failed') });
    }
});
app.post('/internal/trigger-email-sync', async (req, res) => {
    const h = String(req.headers.authorization || '');
    const hasBearer = h.startsWith('Bearer ');
    const token = hasBearer ? h.slice(7) : '';
    const cron = String(process.env.JOB_CRON_TOKEN || '');
    if (!cron || token !== cron)
        return res.status(401).json({ message: 'unauthorized' });
    try {
        const body = req.body || {};
        const account = String(body.account || '') || undefined;
        const maxPer = Math.min(50, Number(body.max_per_run || 50));
        const maxMsgs = Math.min(50, Number(body.max_messages || 50));
        const r = await (0, jobs_1.runEmailSyncJob)({ mode: 'incremental', account, max_per_run: maxPer, max_messages: maxMsgs, batch_size: Math.min(20, Number(body.batch_size || 20)), concurrency: 1, batch_sleep_ms: 0, min_interval_ms: 0, trigger_source: 'internal_web_cron' });
        return res.json({ ok: true, stats: (r === null || r === void 0 ? void 0 : r.stats) || {}, schedule_runs: (r === null || r === void 0 ? void 0 : r.schedule_runs) || [] });
    }
    catch (e) {
        return res.status(Number((e === null || e === void 0 ? void 0 : e.status) || 500)).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'trigger_failed', reason: (e === null || e === void 0 ? void 0 : e.reason) || 'unknown' });
    }
});
app.get('/__routes', (_req, res) => {
    var _a, _b;
    try {
        const list = [];
        function add(path, methodsObj) {
            const methods = Object.keys(methodsObj || {}).filter(k => !!methodsObj[k]).map(k => k.toUpperCase());
            list.push({ path, methods });
        }
        function base(layer) {
            var _a;
            const s = String(((_a = layer === null || layer === void 0 ? void 0 : layer.regexp) === null || _a === void 0 ? void 0 : _a.source) || '');
            const m = s.match(/^\\\/([A-Za-z0-9_\-]+)(?:\\\/)?/) || s.match(/^\^\\\/([A-Za-z0-9_\-]+)(?:\\\/)?/);
            return m ? `/${m[1]}` : '';
        }
        const stack = ((_a = app === null || app === void 0 ? void 0 : app._router) === null || _a === void 0 ? void 0 : _a.stack) || [];
        for (const layer of stack) {
            if (layer === null || layer === void 0 ? void 0 : layer.route) {
                add(String(layer.route.path || ''), layer.route.methods || {});
            }
            else if ((layer === null || layer === void 0 ? void 0 : layer.name) === 'router' && ((_b = layer === null || layer === void 0 ? void 0 : layer.handle) === null || _b === void 0 ? void 0 : _b.stack)) {
                const b = base(layer);
                for (const h of layer.handle.stack) {
                    if (h === null || h === void 0 ? void 0 : h.route)
                        add(`${b}${String(h.route.path || '')}`, h.route.methods || {});
                }
            }
        }
        res.json(list);
    }
    catch (e) {
        res.status(500).json({ message: (e === null || e === void 0 ? void 0 : e.message) || 'route list failed' });
    }
});
app.use('/public', auth_2.auth, public_admin_1.default);
app.use('/public', public_1.default);
app.use(auth_2.auth);
const uploadDir = path_1.default.join(process.cwd(), 'uploads');
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir);
app.use('/uploads', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});
app.use('/uploads', express_1.default.static(uploadDir));
app.use('/landlords', landlords_1.router);
app.use('/properties', properties_1.router);
app.use('/keys', keys_1.router);
app.use('/orders', orders_1.router);
app.use('/inventory', inventory_1.router);
app.use('/finance', finance_1.router);
app.use('/crud', crud_1.default);
app.use('/recurring', recurring_1.default);
app.use('/cleaning', cleaning_1.router);
app.use('/cleaning-app', cleaning_app_1.default);
app.use('/config', config_1.router);
app.use('/auth', auth_1.router);
app.use('/audits', audits_1.router);
app.use('/rbac', rbac_1.router);
app.use('/users', users_1.router);
app.use('/version', version_1.router);
app.use('/stats', stats_1.router);
app.use('/events', events_1.router);
app.use('/notifications', notifications_1.default);
app.use('/maintenance', maintenance_1.default);
app.use('/deep-cleaning', deep_cleaning_1.default);
app.use('/work-tasks', work_tasks_1.router);
app.use('/task-center', task_center_1.router);
app.use('/mzapp', mzapp_1.router);
app.use('/property-guides', property_guides_1.router);
app.use('/property-guide-link-sync', property_guide_link_sync_1.router);
app.use('/jobs', jobs_1.router);
app.use('/onboarding', propertyOnboarding_1.router);
app.use('/invoices', invoices_1.router);
app.use('/cms', cms_company_1.router);
app.use('/cms', cms_company_secrets_1.router);
const port = process.env.PORT_OVERRIDE ? Number(process.env.PORT_OVERRIDE) : (process.env.PORT ? Number(process.env.PORT) : 4001);
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`[DataSources] pg=${dbAdapter_1.hasPg}`);
    try {
        const url = process.env.DATABASE_URL || '';
        if (url) {
            const u = new URL(url);
            const db = (u.pathname || '').replace(/^\//, '');
            console.log(`[PG] host=${u.hostname} db=${db}`);
        }
    }
    catch (_a) { }
    try {
        const defaultEnabled = (process.env.NODE_ENV === 'production');
        const enabled = String(process.env.EMAIL_SYNC_SCHEDULE_ENABLED || (defaultEnabled ? 'true' : 'false')).toLowerCase() === 'true';
        const expr = String(process.env.EMAIL_SYNC_CRON || '0 */3 * * *');
        if (enabled && dbAdapter_1.hasPg) {
            console.log(`[email-sync][schedule] enabled cron=${expr}`);
            const task = node_cron_1.default.schedule(expr, async () => {
                var _a, _b;
                const started = Date.now();
                try {
                    const key = 987654321;
                    const lock = await dbAdapter_1.pgPool.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
                    const ok = !!((_b = (_a = lock === null || lock === void 0 ? void 0 : lock.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.ok);
                    if (!ok) {
                        console.log('[email-sync][schedule] skipped_reason=already_running');
                        return;
                    }
                    const res = await (0, jobs_1.runEmailSyncJob)({ mode: 'incremental', trigger_source: 'schedule', max_per_run: Math.min(50, Number(process.env.EMAIL_SYNC_MAX_PER_RUN || 50)), batch_size: Math.min(20, Number(process.env.EMAIL_SYNC_BATCH_SIZE || 20)), concurrency: Math.min(1, Number(process.env.EMAIL_SYNC_CONCURRENCY || 1)), batch_sleep_ms: Number(process.env.EMAIL_SYNC_BATCH_SLEEP_MS || 0), min_interval_ms: Number(process.env.EMAIL_SYNC_MIN_INTERVAL_MS || 60000) });
                    const dur = Date.now() - started;
                    const s = ((res === null || res === void 0 ? void 0 : res.stats) || {});
                    console.log(`[email-sync][schedule] scanned=${s.scanned || 0} inserted=${s.inserted || 0} skipped=${s.skipped_duplicate || 0} failed=${s.failed || 0} duration_ms=${dur}`);
                    try {
                        await dbAdapter_1.pgPool.query('SELECT pg_advisory_unlock($1)', [key]);
                    }
                    catch (_c) { }
                }
                catch (e) {
                    console.error(`[email-sync][schedule] error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                }
            }, { scheduled: true });
            task.start();
            const wdEnabled = String(process.env.EMAIL_SYNC_WATCHDOG_ENABLED || 'true').toLowerCase() === 'true';
            if (wdEnabled) {
                const wd = node_cron_1.default.schedule('*/10 * * * *', async () => {
                    var _a, _b;
                    try {
                        const key = 987654321;
                        const lock = await dbAdapter_1.pgPool.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
                        const ok = !!((_b = (_a = lock === null || lock === void 0 ? void 0 : lock.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.ok);
                        if (!ok)
                            return;
                        // collect recent failed uids per account; exclude duplicates/already_running
                        const sql = `
            WITH cand AS (
              SELECT account, uid FROM email_orders_raw WHERE status IN ('failed','unmatched_property') AND created_at > now() - interval '12 hours' AND uid IS NOT NULL AND account IS NOT NULL
              UNION ALL
              SELECT account, uid FROM email_sync_items WHERE status='failed' AND created_at > now() - interval '12 hours' AND uid IS NOT NULL AND account IS NOT NULL
            )
            SELECT DISTINCT c.account, c.uid
            FROM cand c
            WHERE NOT EXISTS (
              SELECT 1 FROM email_sync_items e
              WHERE e.account = c.account AND e.uid = c.uid AND e.status='skipped' AND e.reason IN ('duplicate','already_running','db_error')
            )
            ORDER BY c.account DESC, c.uid DESC
            LIMIT 200`;
                        const rs = await dbAdapter_1.pgPool.query(sql);
                        const groups = {};
                        for (const r of ((rs === null || rs === void 0 ? void 0 : rs.rows) || [])) {
                            const acc = String(r.account || '');
                            const uid = Number(r.uid || 0);
                            if (!acc || !uid)
                                continue;
                            if (!groups[acc])
                                groups[acc] = [];
                            if (groups[acc].length < 50)
                                groups[acc].push(uid);
                        }
                        for (const acc of Object.keys(groups)) {
                            const uids = groups[acc];
                            if (!uids.length)
                                continue;
                            console.log(`[email-sync][watchdog] retry account=${acc} uids=${uids.length}`);
                            try {
                                await (0, jobs_1.runEmailSyncJob)({ mode: 'incremental', trigger_source: 'watchdog_retry_failed', account: acc, uids, min_interval_ms: 0, max_per_run: uids.length, batch_size: Math.min(10, uids.length), concurrency: 1, batch_sleep_ms: 0 });
                            }
                            catch (e) {
                                console.error(`[email-sync][watchdog] account=${acc} error=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                            }
                        }
                        try {
                            await dbAdapter_1.pgPool.query('SELECT pg_advisory_unlock($1)', [key]);
                        }
                        catch (_c) { }
                    }
                    catch (e) {
                        console.error(`[email-sync][watchdog] error=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    }
                }, { scheduled: true });
                wd.start();
            }
            else {
                console.log('[email-sync][watchdog] disabled');
            }
        }
        else {
            console.log('[email-sync][schedule] disabled');
        }
    }
    catch (e) {
        console.error(`[email-sync][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
    }
    try {
        const enabled = String(process.env.NOTIFICATION_WORKER_ENABLED || 'true').toLowerCase() === 'true';
        const intervalMs = Math.max(800, Math.min(30000, Number(process.env.NOTIFICATION_WORKER_INTERVAL_MS || 2500)));
        const batchSize = Math.max(1, Math.min(200, Number(process.env.NOTIFICATION_WORKER_BATCH_SIZE || 50)));
        if (enabled && dbAdapter_1.hasPg) {
            console.log(`[notifications][worker] enabled interval_ms=${intervalMs} batch_size=${batchSize}`);
            (0, notificationQueueWorker_1.startNotificationQueueWorker)({ intervalMs, batchSize });
            const expr = String(process.env.NOTIFICATION_CLEANUP_CRON || '15 3 * * *');
            const task = node_cron_1.default.schedule(expr, async () => {
                try {
                    await (0, notificationQueueWorker_1.runNotificationQueueCleanup)();
                }
                catch (_a) { }
            }, { scheduled: true });
            task.start();
            console.log(`[notifications][cleanup] enabled cron=${expr}`);
        }
        else {
            console.log('[notifications][worker] disabled');
        }
    }
    catch (_b) { }
    ;
    (async () => {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        try {
            if (dbAdapter_1.hasPg) {
                const r1 = await dbAdapter_1.pgPool.query('SELECT current_database() AS db, current_schema AS schema');
                const r2 = await dbAdapter_1.pgPool.query('SHOW search_path');
                const r3 = await dbAdapter_1.pgPool.query('SELECT current_schemas(true) AS schemas');
                console.log(`[DBInfo] current_database=${String(((_b = (_a = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.db) || '')} current_schema=${String(((_d = (_c = r1 === null || r1 === void 0 ? void 0 : r1.rows) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.schema) || '')} search_path=${String(((_f = (_e = r2 === null || r2 === void 0 ? void 0 : r2.rows) === null || _e === void 0 ? void 0 : _e[0]) === null || _f === void 0 ? void 0 : _f.search_path) || '')} current_schemas=${JSON.stringify(((_h = (_g = r3 === null || r3 === void 0 ? void 0 : r3.rows) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.schemas) || [])}`);
            }
        }
        catch (e) {
            console.log(`[DBInfo] query failed message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const enableCleaning = String(process.env.FEATURE_CLEANING_APP || 'false').toLowerCase() === 'true';
            if (enableCleaning && dbAdapter_1.hasPg) {
                const expr = String(process.env.CLEANING_START_TIMEOUT_CRON || '*/15 * * * *');
                const threshMin = Number(process.env.CLEANING_START_TIMEOUT_MINUTES || 60);
                const task = node_cron_1.default.schedule(expr, async () => {
                    try {
                        const sql = `select id, assignee_id, scheduled_at, key_photo_uploaded_at from cleaning_tasks where date=now()::date and status='scheduled'`;
                        const rs = await dbAdapter_1.pgPool.query(sql);
                        for (const r of ((rs === null || rs === void 0 ? void 0 : rs.rows) || [])) {
                            const sch = r.scheduled_at ? new Date(r.scheduled_at) : null;
                            const hasKeyPhoto = !!r.key_photo_uploaded_at;
                            if (!sch || hasKeyPhoto)
                                continue;
                            const diff = Date.now() - sch.getTime();
                            if (diff > threshMin * 60 * 1000) {
                                console.log(`[cleaning-timeout] task=${r.id} assignee=${r.assignee_id} overdue_minutes=${Math.round(diff / 60000)}`);
                            }
                        }
                    }
                    catch (e) {
                        console.error(`[cleaning-timeout] error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    }
                }, { scheduled: true });
                task.start();
            }
        }
        catch (e) {
            console.error(`[cleaning-timeout] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const fastEnabled = String(process.env.CLEANING_BACKFILL_FAST_ENABLED || 'false').toLowerCase() === 'true';
            const slowEnabled = String(process.env.CLEANING_BACKFILL_SLOW_ENABLED || 'false').toLowerCase() === 'true';
            if (!(fastEnabled || slowEnabled)) {
                console.log('[cleaning-backfill][schedule] disabled');
                return;
            }
            if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool) {
                console.log('[cleaning-backfill][schedule] pg=false');
                return;
            }
            const lockName = String(process.env.CLEANING_BACKFILL_LOCK_NAME || 'cleaning_backfill');
            const lockTtlMs = Math.max(60000, Number(process.env.CLEANING_BACKFILL_LOCK_TTL_MS || (6 * 60 * 60 * 1000)));
            const minIntervalMs = Math.max(0, Number(process.env.CLEANING_BACKFILL_MIN_INTERVAL_MS || 0));
            const timeZone = String(process.env.CLEANING_BACKFILL_TIME_ZONE || 'Australia/Sydney');
            const renewEveryMs = Math.max(60000, Number(process.env.CLEANING_BACKFILL_LOCK_RENEW_MS || (2 * 60 * 1000)));
            const state = {};
            const { runCleaningBackfillOnce } = require('./services/cleaningBackfillRunner');
            if (fastEnabled) {
                const expr = String(process.env.CLEANING_BACKFILL_FAST_CRON || '0 */4 * * *');
                console.log(`[cleaning-backfill][fast][schedule] enabled cron=${expr}`);
                const pastDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_FAST_PAST_DAYS || 1));
                const futureDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_FAST_FUTURE_DAYS || 7));
                const concurrency = Math.max(1, Math.min(25, Number(process.env.CLEANING_BACKFILL_FAST_CONCURRENCY || 10)));
                const task = node_cron_1.default.schedule(expr, async () => {
                    const r = await runCleaningBackfillOnce({ scheduleName: 'fast', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' });
                    if (r === null || r === void 0 ? void 0 : r.skipped)
                        console.log(`[cleaning-backfill][fast][schedule] skipped_reason=${String(r.skipped_reason || '')}`);
                    else if (r === null || r === void 0 ? void 0 : r.ok)
                        console.log(`[cleaning-backfill][fast][schedule] ok run_id=${String(r.run_id || '')} scanned=${Number(r.orders_scanned || 0)} failed=${Number(r.orders_failed || 0)} duration_ms=${Number(r.duration_ms || 0)}`);
                    else
                        console.error(`[cleaning-backfill][fast][schedule] failed run_id=${String(r.run_id || '')} message=${String(r.error || '')}`);
                }, { scheduled: true });
                task.start();
            }
            else {
                console.log('[cleaning-backfill][fast][schedule] disabled');
            }
            if (slowEnabled) {
                const expr = String(process.env.CLEANING_BACKFILL_SLOW_CRON || '0 3 */2 * *');
                console.log(`[cleaning-backfill][slow][schedule] enabled cron=${expr}`);
                const pastDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_SLOW_PAST_DAYS || 14));
                const futureDays = Math.max(0, Number(process.env.CLEANING_BACKFILL_SLOW_FUTURE_DAYS || 30));
                const concurrency = Math.max(1, Math.min(25, Number(process.env.CLEANING_BACKFILL_SLOW_CONCURRENCY || 10)));
                const task = node_cron_1.default.schedule(expr, async () => {
                    const r = await runCleaningBackfillOnce({ scheduleName: 'slow', lockName, lockTtlMs, lockRenewIntervalMs: renewEveryMs, timeZone, pastDays, futureDays, concurrency, minIntervalMs, state, triggerSource: 'schedule' });
                    if (r === null || r === void 0 ? void 0 : r.skipped)
                        console.log(`[cleaning-backfill][slow][schedule] skipped_reason=${String(r.skipped_reason || '')}`);
                    else if (r === null || r === void 0 ? void 0 : r.ok)
                        console.log(`[cleaning-backfill][slow][schedule] ok run_id=${String(r.run_id || '')} scanned=${Number(r.orders_scanned || 0)} failed=${Number(r.orders_failed || 0)} duration_ms=${Number(r.duration_ms || 0)}`);
                    else
                        console.error(`[cleaning-backfill][slow][schedule] failed run_id=${String(r.run_id || '')} message=${String(r.error || '')}`);
                }, { scheduled: true });
                task.start();
            }
            else {
                console.log('[cleaning-backfill][slow][schedule] disabled');
            }
        }
        catch (e) {
            console.error(`[cleaning-backfill][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const enabled = String(process.env.CLEANING_SYNC_JOBS_ENABLED || 'true').toLowerCase() === 'true';
            if (enabled && dbAdapter_1.hasPg) {
                const expr = String(process.env.CLEANING_SYNC_JOBS_CRON || '*/1 * * * *');
                console.log(`[cleaning-sync-jobs][schedule] enabled cron=${expr}`);
                let inFlight = false;
                const task = node_cron_1.default.schedule(expr, async () => {
                    if (inFlight) {
                        try {
                            console.log('[cleaning-sync-jobs][schedule] skipped_reason=in_flight');
                        }
                        catch (_a) { }
                        ;
                        return;
                    }
                    let jr = null;
                    const startedAt = Date.now();
                    try {
                        inFlight = true;
                        try {
                            const { createJobRun } = require('./services/jobRuns');
                            jr = await createJobRun({ job_name: 'cleaning_sync_jobs', schedule_name: 'cron', trigger_source: 'schedule', run_id: (0, uuid_1.v4)() });
                        }
                        catch (_b) { }
                        const { processCleaningSyncJobsOnce } = require('./services/cleaningSyncJobsWorker');
                        const r = await processCleaningSyncJobsOnce({
                            limit: Math.min(20, Number(process.env.CLEANING_SYNC_JOBS_BATCH || 10)),
                            reclaim_timeout_minutes: Math.min(120, Math.max(1, Number(process.env.CLEANING_SYNC_JOBS_RECLAIM_MINUTES || 10))),
                        });
                        try {
                            if (jr === null || jr === void 0 ? void 0 : jr.id) {
                                const { finishJobRun } = require('./services/jobRuns');
                                await finishJobRun({
                                    id: String(jr.id),
                                    orders_scanned: Number(r.processed || 0),
                                    orders_succeeded: Number(r.ok || 0),
                                    orders_failed: Number(r.failed || 0),
                                    duration_ms: Date.now() - startedAt,
                                    result: r,
                                });
                            }
                        }
                        catch (_c) { }
                        if (((r === null || r === void 0 ? void 0 : r.processed) || 0) > 0 || ((r === null || r === void 0 ? void 0 : r.failed) || 0) > 0 || ((r === null || r === void 0 ? void 0 : r.reclaimed) || 0) > 0) {
                            console.log(`[cleaning-sync-jobs][schedule] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`);
                        }
                    }
                    catch (e) {
                        try {
                            if (jr === null || jr === void 0 ? void 0 : jr.id) {
                                const { finishJobRun } = require('./services/jobRuns');
                                await finishJobRun({ id: String(jr.id), duration_ms: Date.now() - startedAt, error_message: String((e === null || e === void 0 ? void 0 : e.message) || ''), result: { message: String((e === null || e === void 0 ? void 0 : e.message) || ''), code: String((e === null || e === void 0 ? void 0 : e.code) || '') } });
                            }
                        }
                        catch (_d) { }
                        console.error(`[cleaning-sync-jobs][schedule] error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    }
                    finally {
                        inFlight = false;
                    }
                }, { scheduled: true });
                task.start();
            }
            else {
                console.log('[cleaning-sync-jobs][schedule] disabled');
            }
        }
        catch (e) {
            console.error(`[cleaning-sync-jobs][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const enabled = String(process.env.CLEANING_SYNC_RETRY_ENABLED || 'true').toLowerCase() === 'true';
            if (enabled && dbAdapter_1.hasPg) {
                const expr = String(process.env.CLEANING_SYNC_RETRY_CRON || '*/5 * * * *');
                console.log(`[cleaning-sync-retry][schedule] enabled cron=${expr}`);
                const task = node_cron_1.default.schedule(expr, async () => {
                    var _a, _b;
                    try {
                        const key = 246813579;
                        const lock = await dbAdapter_1.pgPool.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
                        const ok = !!((_b = (_a = lock === null || lock === void 0 ? void 0 : lock.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.ok);
                        if (!ok)
                            return;
                        const { processDueCleaningSyncRetries } = require('./services/cleaningSyncRetry');
                        const r = await processDueCleaningSyncRetries({ limit: Math.min(20, Number(process.env.CLEANING_SYNC_RETRY_BATCH || 10)) });
                        if (((r === null || r === void 0 ? void 0 : r.processed) || 0) > 0 || ((r === null || r === void 0 ? void 0 : r.failed) || 0) > 0) {
                            console.log(`[cleaning-sync-retry][schedule] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0}`);
                        }
                        try {
                            await dbAdapter_1.pgPool.query('SELECT pg_advisory_unlock($1)', [key]);
                        }
                        catch (_c) { }
                    }
                    catch (e) {
                        console.error(`[cleaning-sync-retry][schedule] error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    }
                }, { scheduled: true });
                task.start();
            }
            else {
                console.log('[cleaning-sync-retry][schedule] disabled');
            }
        }
        catch (e) {
            console.error(`[cleaning-sync-retry][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const enabled = String(process.env.PDF_JOBS_SCHEDULE_ENABLED || 'true').toLowerCase() === 'true';
            if (enabled && dbAdapter_1.hasPg) {
                const expr = String(process.env.PDF_JOBS_CRON || '*/1 * * * *');
                console.log(`[pdf-jobs][schedule] enabled cron=${expr}`);
                let inFlight = false;
                const task = node_cron_1.default.schedule(expr, async () => {
                    if (inFlight) {
                        try {
                            console.log('[pdf-jobs][schedule] skipped_reason=in_flight');
                        }
                        catch (_a) { }
                        ;
                        return;
                    }
                    try {
                        inFlight = true;
                        const { processPdfJobsOnce } = require('./services/pdfJobsWorker');
                        const r = await processPdfJobsOnce({
                            limit: Math.min(5, Math.max(1, Number(process.env.PDF_JOBS_BATCH || 2))),
                        });
                        if (((r === null || r === void 0 ? void 0 : r.processed) || 0) > 0 || ((r === null || r === void 0 ? void 0 : r.failed) || 0) > 0 || ((r === null || r === void 0 ? void 0 : r.reclaimed) || 0) > 0) {
                            console.log(`[pdf-jobs][schedule] processed=${r.processed || 0} ok=${r.ok || 0} failed=${r.failed || 0} reclaimed=${r.reclaimed || 0}`);
                        }
                    }
                    catch (e) {
                        console.error(`[pdf-jobs][schedule] error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    }
                    finally {
                        inFlight = false;
                    }
                }, { scheduled: true });
                task.start();
            }
            else {
                console.log('[pdf-jobs][schedule] disabled');
            }
        }
        catch (e) {
            console.error(`[pdf-jobs][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const defaultEnabled = process.env.NODE_ENV === 'production';
            const enabled = String(process.env.KEY_UPLOAD_SLA_ENABLED || 'false').toLowerCase() === 'true';
            const featureCleaning = String(process.env.FEATURE_CLEANING_APP || 'false').toLowerCase() === 'true';
            if (!enabled) {
                console.log('[key-upload-sla][schedule] disabled');
                return;
            }
            if (!featureCleaning) {
                console.log('[key-upload-sla][schedule] skipped_reason=feature_cleaning_app_disabled');
                return;
            }
            if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool) {
                console.log('[key-upload-sla][schedule] skipped_reason=pg=false');
                return;
            }
        }
        catch (e) {
            console.error(`[key-upload-sla][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
    (async () => {
        try {
            const defaultEnabled = process.env.NODE_ENV === 'production';
            const enabled = String(process.env.KEY_UPLOAD_REMINDER_ENABLED || (defaultEnabled ? 'true' : 'false')).toLowerCase() === 'true';
            const featureCleaning = String(process.env.FEATURE_CLEANING_APP || (defaultEnabled ? 'true' : 'false')).toLowerCase() === 'true';
            if (!enabled) {
                console.log('[key-upload-reminder][schedule] disabled');
                return;
            }
            if (!featureCleaning) {
                console.log('[key-upload-reminder][schedule] skipped_reason=feature_cleaning_app_disabled');
                return;
            }
            if (!dbAdapter_1.hasPg || !dbAdapter_1.pgPool) {
                console.log('[key-upload-reminder][schedule] skipped_reason=pg=false');
                return;
            }
            const schedules = [
                { expr: '0 10 * * *', at: '10:00' },
                { expr: '30 11 * * *', at: '11:30' },
                { expr: '0 13 * * *', at: '13:00' },
                { expr: '0 14 * * *', at: '14:00' },
            ];
            for (const s of schedules) {
                console.log(`[key-upload-reminder][schedule] enabled cron=${s.expr} tz=Australia/Melbourne at=${s.at}`);
                const task = node_cron_1.default.schedule(s.expr, async () => {
                    var _a, _b;
                    const started = Date.now();
                    try {
                        const lockKey = 246802468 + Number(s.at.replace(':', ''));
                        const lock = await dbAdapter_1.pgPool.query('SELECT pg_try_advisory_lock($1) AS ok', [lockKey]);
                        const ok = !!((_b = (_a = lock === null || lock === void 0 ? void 0 : lock.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.ok);
                        if (!ok)
                            return;
                        const r = await (0, keyUploadReminderJob_1.runKeyUploadReminder)({ at: s.at });
                        const dur = Date.now() - started;
                        if (r === null || r === void 0 ? void 0 : r.skipped)
                            console.log(`[key-upload-reminder][schedule] skipped_reason=${String(r.skipped)}`);
                        else
                            console.log(`[key-upload-reminder][schedule] ok at=${s.at} duration_ms=${dur}`);
                        try {
                            await dbAdapter_1.pgPool.query('SELECT pg_advisory_unlock($1)', [lockKey]);
                        }
                        catch (_c) { }
                    }
                    catch (e) {
                        console.error(`[key-upload-reminder][schedule] error at=${s.at} message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                    }
                }, { scheduled: true, timezone: 'Australia/Melbourne' });
                task.start();
            }
        }
        catch (e) {
            console.error(`[key-upload-reminder][schedule] init error message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
});
app.get('/health/login', async (_req, res) => {
    var _a, _b;
    const started = Date.now();
    try {
        if (dbAdapter_1.hasPg) {
            const r = await dbAdapter_1.pgPool.query('SELECT 1 AS ok');
            const dur = Date.now() - started;
            return res.json({ ok: true, db_ok: !!((_b = (_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.ok), latency_ms: dur });
        }
        return res.json({ ok: true, db_ok: false, latency_ms: Date.now() - started });
    }
    catch (e) {
        return res.status(500).json({ ok: false, message: String((e === null || e === void 0 ? void 0 : e.message) || ''), latency_ms: Date.now() - started });
    }
});
app.get('/health/email-sync', async (_req, res) => {
    var _a;
    try {
        if (dbAdapter_1.hasPg) {
            const r = await dbAdapter_1.pgPool.query('SELECT id, status, scanned, inserted, failed, created_at FROM email_sync_runs ORDER BY created_at DESC LIMIT 1');
            return res.json({ last_run: ((_a = r === null || r === void 0 ? void 0 : r.rows) === null || _a === void 0 ? void 0 : _a[0]) || null });
        }
        return res.json({ last_run: null });
    }
    catch (e) {
        return res.status(500).json({ message: String((e === null || e === void 0 ? void 0 : e.message) || '') });
    }
});
