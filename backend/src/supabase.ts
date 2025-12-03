export const supabase = null
export const hasSupabase = false

export async function supaSelect(_table: string, _columns = '*', _filters?: Record<string, any>) { return null }

export async function supaInsert(_table: string, _payload: any) { return null }

export async function supaUpdate(_table: string, _id: string, _payload: any) { return null }

export async function supaDelete(_table: string, _id: string) { return null }

export async function supaUpsert(_table: string, _payload: any) { return null }

export async function supaUpsertConflict(_table: string, _payload: any, _onConflict: string) { return null }