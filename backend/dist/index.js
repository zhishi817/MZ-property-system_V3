"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.resolve(process.cwd(), '.env.local'), override: true });
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
const maintenance_1 = __importDefault(require("./modules/maintenance"));
const crud_1 = __importDefault(require("./modules/crud"));
const recurring_1 = __importDefault(require("./modules/recurring"));
const auth_2 = require("./auth");
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
app.use('/maintenance', maintenance_1.default);
const port = process.env.PORT ? Number(process.env.PORT) : 4001;
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
});
