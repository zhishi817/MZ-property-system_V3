"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasSupabase = exports.supabase = void 0;
exports.supaSelect = supaSelect;
exports.supaInsert = supaInsert;
exports.supaUpdate = supaUpdate;
exports.supaDelete = supaDelete;
exports.supaUpsert = supaUpsert;
exports.supaUpsertConflict = supaUpsertConflict;
exports.supabase = null;
exports.hasSupabase = false;
async function supaSelect(_table, _columns = '*', _filters) { return null; }
async function supaInsert(_table, _payload) { return null; }
async function supaUpdate(_table, _id, _payload) { return null; }
async function supaDelete(_table, _id) { return null; }
async function supaUpsert(_table, _payload) { return null; }
async function supaUpsertConflict(_table, _payload, _onConflict) { return null; }
