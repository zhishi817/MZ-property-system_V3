import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''

export const supabase = url && key ? createClient(url, key) : null
export const hasSupabase = !!supabase

export async function supaSelect(table: string, columns = '*', filters?: Record<string, any>) {
  if (!supabase) return null
  let q = supabase.from(table).select(columns)
  if (filters) {
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null) q = q.eq(k, v)
    })
  }
  const { data, error } = await q
  if (error) throw error
  return data
}

export async function supaInsert(table: string, payload: any) {
  if (!supabase) return null
  const { data, error } = await supabase.from(table).insert(payload).select('*').single()
  if (error) throw error
  return data
}

export async function supaUpdate(table: string, id: string, payload: any) {
  if (!supabase) return null
  const { data, error } = await supabase.from(table).update(payload).eq('id', id).select('*').single()
  if (error) throw error
  return data
}

export async function supaDelete(table: string, id: string) {
  if (!supabase) return null
  const { data, error } = await supabase.from(table).delete().eq('id', id).select('*').single()
  if (error) throw error
  return data
}

export async function supaUpsert(table: string, payload: any) {
  if (!supabase) return null
  const { data, error } = await supabase.from(table).upsert(payload).select('*').single()
  if (error) throw error
  return data
}

export async function supaUpsertConflict(table: string, payload: any, onConflict: string) {
  if (!supabase) return null
  const { data, error } = await supabase.from(table).upsert(payload, { onConflict }).select('*').single()
  if (error) throw error
  return data
}