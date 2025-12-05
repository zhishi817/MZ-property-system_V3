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
const auth_2 = require("./auth");
const dbAdapter_1 = require("./dbAdapter");
const supabase_1 = require("./supabase");
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
app.use(auth_2.auth);
const uploadDir = path_1.default.join(process.cwd(), 'uploads');
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir);
app.use('/uploads', express_1.default.static(uploadDir));
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});
app.get('/health/db', async (_req, res) => {
    const result = { pg: false, supabase: false };
    try {
        if (dbAdapter_1.pgPool) {
            const r = await dbAdapter_1.pgPool.query('SELECT 1 as ok');
            result.pg = !!(r && r.rows && r.rows[0] && r.rows[0].ok);
        }
    }
    catch (e) {
        result.pg = false;
        result.pg_error = e === null || e === void 0 ? void 0 : e.message;
    }
    try {
        if (supabase_1.supabase) {
            const { error } = await supabase_1.supabase.from('properties').select('id').limit(1);
            result.supabase = !error;
            if (error)
                result.supabase_error = error.message;
        }
    }
    catch (e) {
        result.supabase = false;
        result.supabase_error = e === null || e === void 0 ? void 0 : e.message;
    }
    res.json(result);
});
app.use('/landlords', landlords_1.router);
app.use('/properties', properties_1.router);
app.use('/keys', keys_1.router);
app.use('/orders', orders_1.router);
app.use('/inventory', inventory_1.router);
app.use('/finance', finance_1.router);
app.use('/crud', crud_1.default);
app.use('/cleaning', cleaning_1.router);
app.use('/config', config_1.router);
app.use('/auth', auth_1.router);
app.use('/audits', audits_1.router);
app.use('/rbac', rbac_1.router);
app.use('/version', version_1.router);
app.use('/maintenance', maintenance_1.default);
const port = process.env.PORT ? Number(process.env.PORT) : 4001;
app.listen(port, () => { console.log(`Server listening on port ${port}`); console.log(`[DataSources] pg=${dbAdapter_1.hasPg} supabase=${supabase_1.hasSupabase}`); });
