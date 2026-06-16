"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasPg = exports.pgPool = void 0;
exports.getPgPoolStats = getPgPoolStats;
exports.pgRunWithAdvisoryLock = pgRunWithAdvisoryLock;
exports.pgRunAfterCommit = pgRunAfterCommit;
exports.pgSelect = pgSelect;
exports.pgInsert = pgInsert;
exports.pgUpdate = pgUpdate;
exports.pgDelete = pgDelete;
exports.pgRunInTransaction = pgRunInTransaction;
exports.pgInsertOnConflictDoNothing = pgInsertOnConflictDoNothing;
exports.pgDeleteWhere = pgDeleteWhere;
const pg_1 = require("pg");
pg_1.types.setTypeParser(1082, (val) => val);
pg_1.types.setTypeParser(1114, (val) => val);
pg_1.types.setTypeParser(1184, (val) => val);
const conn = process.env.DATABASE_URL || '';
const pgPoolMax = Number(process.env.PG_POOL_MAX || 10);
const pgPoolConfig = {
    connectionString: conn,
    ssl: { rejectUnauthorized: false },
    max: pgPoolMax,
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
    keepAlive: true,
    keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10000),
    maxLifetimeSeconds: Number(process.env.PG_MAX_LIFETIME_SECONDS || 300),
    query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 60000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 45000),
    idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_TIMEOUT_MS || 60000),
};
exports.pgPool = conn ? new pg_1.Pool(pgPoolConfig) : null;
exports.hasPg = !!exports.pgPool;
const afterCommitCallbacksKey = Symbol.for('mz_pg_after_commit_callbacks');
const checkedOutClients = new Map();
let checkedOutSeq = 0;
function normalizeBoolEnv(value, fallback = false) {
    const s = String(value !== null && value !== void 0 ? value : '').trim().toLowerCase();
    if (!s)
        return fallback;
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
function trackCheckedOutClient(client) {
    var _a;
    if (!client)
        return client;
    const id = ++checkedOutSeq;
    const stack = String(new Error().stack || '').split('\n').slice(2, 10).join(' | ');
    checkedOutClients.set(id, { id, at: Date.now(), stack });
    // pg-pool replaces client.release with a fresh single-use closure on every
    // checkout. Always wrap that current closure; reusing an older one leaks the
    // client after its first trip through the pool.
    const rawRelease = (_a = client.release) === null || _a === void 0 ? void 0 : _a.bind(client);
    let released = false;
    client.release = (err) => {
        if (released)
            return;
        released = true;
        checkedOutClients.delete(id);
        return rawRelease === null || rawRelease === void 0 ? void 0 : rawRelease(err);
    };
    return client;
}
function installPoolInstrumentation() {
    if (!exports.pgPool)
        return;
    const poolAny = exports.pgPool;
    if (poolAny.__mz_pool_instrumented)
        return;
    poolAny.__mz_pool_instrumented = true;
    const originalConnect = exports.pgPool.connect.bind(exports.pgPool);
    poolAny.connect = (callback) => {
        if (typeof callback === 'function') {
            return originalConnect((err, client, done) => {
                if (err || !client)
                    return callback(err, client, done);
                const tracked = trackCheckedOutClient(client);
                return callback(null, tracked, (releaseErr) => tracked.release(releaseErr));
            });
        }
        return originalConnect().then((client) => trackCheckedOutClient(client));
    };
}
function getPgPoolStats(includeStack = false) {
    var _a, _b;
    const now = Date.now();
    const active = Array.from(checkedOutClients.values())
        .map((item) => ({ id: item.id, held_ms: now - item.at, stack: item.stack }))
        .sort((a, b) => b.held_ms - a.held_ms);
    return {
        configured_max: pgPoolMax,
        total: Number((exports.pgPool === null || exports.pgPool === void 0 ? void 0 : exports.pgPool.totalCount) || 0),
        idle: Number((exports.pgPool === null || exports.pgPool === void 0 ? void 0 : exports.pgPool.idleCount) || 0),
        waiting: Number((exports.pgPool === null || exports.pgPool === void 0 ? void 0 : exports.pgPool.waitingCount) || 0),
        checked_out: active.length,
        oldest_checked_out_ms: ((_a = active[0]) === null || _a === void 0 ? void 0 : _a.held_ms) || 0,
        ...(includeStack ? { oldest_checked_out_stack: ((_b = active[0]) === null || _b === void 0 ? void 0 : _b.stack) || '' } : {}),
    };
}
try {
    if (exports.pgPool) {
        installPoolInstrumentation();
        if (pgPoolMax < 3) {
            console.warn(`[pg] pool_max_low configured_max=${pgPoolMax} recommended_min=3`);
        }
        exports.pgPool.on('error', (err) => {
            try {
                console.error(`[pg] pool_error message=${String((err === null || err === void 0 ? void 0 : err.message) || '')} code=${String((err === null || err === void 0 ? void 0 : err.code) || '')}`);
            }
            catch (_a) { }
        });
        const warnMs = Math.max(30000, Number(process.env.PG_POOL_HOLD_WARN_MS || 60000));
        const stuckMs = Math.max(30000, Number(process.env.PG_POOL_STUCK_RESTART_MS || 120000));
        const exitOnStuck = normalizeBoolEnv(process.env.PG_POOL_EXIT_ON_STUCK, false);
        let stuckSince = 0;
        const interval = setInterval(() => {
            try {
                const stats = getPgPoolStats(true);
                if (stats.oldest_checked_out_ms >= warnMs) {
                    console.warn(`[pg] checked_out_long held_ms=${stats.oldest_checked_out_ms} checked_out=${stats.checked_out} total=${stats.total} idle=${stats.idle} waiting=${stats.waiting} stack=${stats.oldest_checked_out_stack}`);
                }
                const saturated = stats.waiting > 0 && stats.idle === 0 && stats.total >= pgPoolMax;
                if (saturated) {
                    if (!stuckSince)
                        stuckSince = Date.now();
                    const stuckFor = Date.now() - stuckSince;
                    console.error(`[pg] pool_saturated waiting=${stats.waiting} total=${stats.total} checked_out=${stats.checked_out} oldest_ms=${stats.oldest_checked_out_ms} stuck_ms=${stuckFor}`);
                    if (exitOnStuck && stuckFor >= stuckMs) {
                        console.error(`[pg] pool_saturated_restart stuck_ms=${stuckFor} threshold_ms=${stuckMs}`);
                        process.exit(1);
                    }
                }
                else {
                    stuckSince = 0;
                }
            }
            catch (_a) { }
        }, Math.max(15000, Number(process.env.PG_POOL_WATCHDOG_INTERVAL_MS || 30000)));
        try {
            (_a = interval.unref) === null || _a === void 0 ? void 0 : _a.call(interval);
        }
        catch (_b) { }
    }
}
catch (_c) { }
async function pgRunWithAdvisoryLock(key, label, cb) {
    var _a, _b;
    if (!exports.pgPool)
        return { locked: false };
    const client = await exports.pgPool.connect();
    let locked = false;
    const started = Date.now();
    const params = Array.isArray(key) ? key : [key];
    const lockSql = Array.isArray(key) ? 'SELECT pg_try_advisory_lock($1, $2) AS ok' : 'SELECT pg_try_advisory_lock($1) AS ok';
    const unlockSql = Array.isArray(key) ? 'SELECT pg_advisory_unlock($1, $2)' : 'SELECT pg_advisory_unlock($1)';
    try {
        const lock = await client.query(lockSql, params);
        locked = !!((_b = (_a = lock === null || lock === void 0 ? void 0 : lock.rows) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.ok);
        if (!locked)
            return { locked: false };
        const result = await cb();
        return { locked: true, result };
    }
    finally {
        if (locked) {
            try {
                await client.query(unlockSql, params);
            }
            catch (e) {
                try {
                    console.error(`[pg] advisory_unlock_failed label=${label} message=${String((e === null || e === void 0 ? void 0 : e.message) || '')}`);
                }
                catch (_c) { }
            }
        }
        try {
            const heldMs = Date.now() - started;
            if (heldMs >= Number(process.env.PG_ADVISORY_LOCK_WARN_MS || 60000))
                console.warn(`[pg] advisory_lock_long label=${label} held_ms=${heldMs}`);
        }
        catch (_d) { }
        client.release();
    }
}
function pgRunAfterCommit(client, callback) {
    const callbacks = client === null || client === void 0 ? void 0 : client[afterCommitCallbacksKey];
    if (!(callbacks instanceof Set))
        return false;
    callbacks.add(callback);
    return true;
}
function buildWhere(filters) {
    const keys = Object.keys(filters || {});
    if (!keys.length)
        return { clause: '', values: [] };
    const parts = keys.map((k, i) => `"${k}" = $${i + 1}`);
    const rawValues = keys.map((k) => filters[k]);
    const values = rawValues.map((v) => (v === undefined ? null : v));
    return { clause: ` WHERE ${parts.join(' AND ')}`, values };
}
async function pgSelect(table, columns = '*', filters, client) {
    const executor = client || exports.pgPool;
    if (!executor)
        return null;
    const w = buildWhere(filters);
    const sql = `SELECT ${columns} FROM ${table}${w.clause}`;
    const res = await executor.query(sql, w.values);
    return res.rows;
}
async function pgInsert(table, payload, client) {
    const executor = client || exports.pgPool;
    if (!executor)
        return null;
    const keys = Object.keys(payload);
    const cols = keys.map(k => `"${k}"`).join(',');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const values = keys.map((k) => payload[k]).map(v => (v === undefined ? null : v));
    const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`;
    const res = await executor.query(sql, values);
    return res.rows[0];
}
async function pgUpdate(table, id, payload, client) {
    const executor = client || exports.pgPool;
    if (!executor)
        return null;
    const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
    if (!keys.length) {
        const res0 = await executor.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
        return res0.rows[0] || null;
    }
    const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const values = keys.map((k) => payload[k]).map(v => (v === undefined ? null : v));
    const sql = `UPDATE ${table} SET ${set} WHERE id = $${keys.length + 1} RETURNING *`;
    const res = await executor.query(sql, [...values, id]);
    return res.rows[0];
}
async function pgDelete(table, id, client) {
    const executor = client || exports.pgPool;
    if (!executor)
        return null;
    const sql = `DELETE FROM ${table} WHERE id = $1 RETURNING *`;
    const res = await executor.query(sql, [id]);
    return res.rows[0];
}
async function pgRunInTransaction(cb) {
    if (!exports.pgPool)
        return null;
    const client = await exports.pgPool.connect();
    client[afterCommitCallbacksKey] = new Set();
    try {
        const k = Symbol.for('mz_pg_client_error_listener_attached');
        if (!client[k]) {
            ;
            client[k] = true;
            client.on('error', (err) => {
                try {
                    console.error(`[pg] client_error message=${String((err === null || err === void 0 ? void 0 : err.message) || '')} code=${String((err === null || err === void 0 ? void 0 : err.code) || '')}`);
                }
                catch (_a) { }
            });
        }
    }
    catch (_a) { }
    try {
        await client.query('BEGIN');
        const result = await cb(client);
        await client.query('COMMIT');
        const callbacks = Array.from(client[afterCommitCallbacksKey] || []);
        client[afterCommitCallbacksKey] = new Set();
        for (const callback of callbacks) {
            try {
                callback();
            }
            catch (_b) { }
        }
        return result;
    }
    catch (e) {
        try {
            await client.query('ROLLBACK');
        }
        catch (_c) { }
        throw e;
    }
    finally {
        try {
            delete client[afterCommitCallbacksKey];
        }
        catch (_d) { }
        client.release();
    }
}
async function pgInsertOnConflictDoNothing(table, payload, conflictColumns, client) {
    if (!exports.pgPool)
        return null;
    const keys = Object.keys(payload);
    const cols = keys.map(k => `"${k}"`).join(',');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const values = keys.map((k) => payload[k]).map(v => (v === undefined ? null : v));
    const conflict = conflictColumns.map(k => `"${k}"`).join(',');
    const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) ON CONFLICT (${conflict}) DO NOTHING RETURNING *`;
    const executor = client || exports.pgPool;
    const res = await executor.query(sql, values);
    return res.rows[0] || null;
}
async function pgDeleteWhere(table, filters, client) {
    if (!exports.pgPool)
        return null;
    const w = buildWhere(filters);
    const sql = `DELETE FROM ${table}${w.clause}`;
    const executor = client || exports.pgPool;
    await executor.query(sql, w.values);
}
