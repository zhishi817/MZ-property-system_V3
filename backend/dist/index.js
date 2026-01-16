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
const landlords_1 = require("./modules/landlords");
const properties_1 = require("./modules/properties");
const keys_1 = require("./modules/keys");
const orders_1 = require("./modules/orders");
const inventory_1 = require("./modules/inventory");
const finance_1 = require("./modules/finance");
const cleaning_1 = require("./modules/cleaning");
const config_1 = require("./modules/config");
const auth_1 = require("./modules/auth");
const audits_1 = require("./modules/audits");
const rbac_1 = require("./modules/rbac");
const version_1 = require("./modules/version");
const stats_1 = require("./modules/stats");
const events_1 = require("./modules/events");
const maintenance_1 = __importDefault(require("./modules/maintenance"));
const propertyOnboarding_1 = require("./modules/propertyOnboarding");
const jobs_1 = require("./modules/jobs");
const node_cron_1 = __importDefault(require("node-cron"));
const crud_1 = __importDefault(require("./modules/crud"));
const recurring_1 = __importDefault(require("./modules/recurring"));
const auth_2 = require("./auth");
const public_1 = __importDefault(require("./modules/public"));
const public_admin_1 = __importDefault(require("./modules/public_admin"));
// 环境保险锁（允许缺省采用智能默认，不再抛错）
let appEnv = process.env.APP_ENV;
let dbRole = process.env.DATABASE_ROLE;
if (!appEnv) {
    appEnv = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
    process.env.APP_ENV = appEnv;
}
if (!dbRole) {
    const url = process.env.DATABASE_URL || '';
    dbRole = url ? (/localhost/i.test(url) ? 'dev' : 'prod') : 'none';
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
    if (!/[?&]sslmode=require/.test(url))
        throw new Error('DATABASE_URL 需包含 sslmode=require');
}
const app = (0, express_1.default)();
const corsOpts = {
    origin: true,
    credentials: false,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
app.use((0, cors_1.default)(corsOpts));
app.options('*', (0, cors_1.default)(corsOpts));
app.use(express_1.default.json());
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
// Public endpoints (no auth)
app.use('/public', public_1.default);
// Auth middleware comes AFTER health routes
app.use(auth_2.auth);
const uploadDir = path_1.default.join(process.cwd(), 'uploads');
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir);
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
app.use('/config', config_1.router);
app.use('/auth', auth_1.router);
app.use('/audits', audits_1.router);
app.use('/rbac', rbac_1.router);
app.use('/version', version_1.router);
app.use('/stats', stats_1.router);
app.use('/events', events_1.router);
app.use('/maintenance', maintenance_1.default);
app.use('/jobs', jobs_1.router);
app.use('/public', public_admin_1.default);
app.use('/onboarding', propertyOnboarding_1.router);
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
                    const res = await (0, jobs_1.runEmailSyncJob)({ mode: 'incremental', trigger_source: 'schedule', max_per_run: Number(process.env.EMAIL_SYNC_MAX_PER_RUN || 100), batch_size: Number(process.env.EMAIL_SYNC_BATCH_SIZE || 20), concurrency: Number(process.env.EMAIL_SYNC_CONCURRENCY || 3), batch_sleep_ms: Number(process.env.EMAIL_SYNC_BATCH_SLEEP_MS || 500), min_interval_ms: Number(process.env.EMAIL_SYNC_MIN_INTERVAL_MS || 60000) });
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
              SELECT account, uid FROM email_orders_raw WHERE status='failed' AND created_at > now() - interval '12 hours' AND uid IS NOT NULL AND account IS NOT NULL
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
            console.error(`[DBInfo] query failed message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
        }
    })();
});
