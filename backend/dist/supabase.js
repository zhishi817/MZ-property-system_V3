"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasSupabase = exports.supabase = void 0;
exports.supaSelect = supaSelect;
exports.supaInsert = supaInsert;
exports.supaUpdate = supaUpdate;
exports.supaDelete = supaDelete;
exports.supaUpsert = supaUpsert;
exports.supaUpsertConflict = supaUpsertConflict;
const supabase_js_1 = require("@supabase/supabase-js");
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
exports.supabase = url && key ? (0, supabase_js_1.createClient)(url, key) : null;
exports.hasSupabase = !!exports.supabase;
async function supaSelect(table, columns = '*', filters) {
    if (!exports.supabase)
        return null;
    let q = exports.supabase.from(table).select(columns);
    if (filters) {
        Object.entries(filters).forEach(([k, v]) => {
            if (v !== undefined && v !== null)
                q = q.eq(k, v);
        });
    }
    const { data, error } = await q;
    if (error)
        throw error;
    return data;
}
async function supaInsert(table, payload) {
    if (!exports.supabase)
        return null;
    const { data, error } = await exports.supabase.from(table).insert(payload).select('*').single();
    if (error)
        throw error;
    return data;
}
async function supaUpdate(table, id, payload) {
    if (!exports.supabase)
        return null;
    const { data, error } = await exports.supabase.from(table).update(payload).eq('id', id).select('*').single();
    if (error)
        throw error;
    return data;
}
async function supaDelete(table, id) {
    if (!exports.supabase)
        return null;
    const { data, error } = await exports.supabase.from(table).delete().eq('id', id).select('*').single();
    if (error)
        throw error;
    return data;
}
async function supaUpsert(table, payload) {
    if (!exports.supabase)
        return null;
    const { data, error } = await exports.supabase.from(table).upsert(payload).select('*').single();
    if (error)
        throw error;
    return data;
}
async function supaUpsertConflict(table, payload, onConflict) {
    if (!exports.supabase)
        return null;
    const { data, error } = await exports.supabase.from(table).upsert(payload, { onConflict }).select('*').single();
    if (error)
        throw error;
    return data;
}
