"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasPg = exports.pgPool = void 0;
exports.pgSelect = pgSelect;
exports.pgInsert = pgInsert;
exports.pgUpdate = pgUpdate;
exports.pgDelete = pgDelete;
exports.pgRunInTransaction = pgRunInTransaction;
exports.pgInsertOnConflictDoNothing = pgInsertOnConflictDoNothing;
exports.pgDeleteWhere = pgDeleteWhere;
const pg_1 = require("pg");
const conn = process.env.DATABASE_URL || '';
exports.pgPool = conn ? new pg_1.Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } }) : null;
exports.hasPg = !!exports.pgPool;
function buildWhere(filters) {
    const keys = Object.keys(filters || {});
    if (!keys.length)
        return { clause: '', values: [] };
    const parts = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => filters[k]);
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
    const cols = keys.join(',');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const values = keys.map((k) => payload[k]);
    const sql = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`;
    const res = await executor.query(sql, values);
    return res.rows[0];
}
async function pgUpdate(table, id, payload, client) {
    const executor = client || exports.pgPool;
    if (!executor)
        return null;
    const keys = Object.keys(payload);
    const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map((k) => payload[k]);
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
    try {
        await client.query('BEGIN');
        const result = await cb(client);
        await client.query('COMMIT');
        return result;
    }
    catch (e) {
        try {
            await client.query('ROLLBACK');
        }
        catch (_a) { }
        throw e;
    }
    finally {
        client.release();
    }
}
async function pgInsertOnConflictDoNothing(table, payload, conflictColumns, client) {
    if (!exports.pgPool)
        return null;
    const keys = Object.keys(payload);
    const cols = keys.join(',');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const values = keys.map((k) => payload[k]);
    const conflict = conflictColumns.join(',');
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
