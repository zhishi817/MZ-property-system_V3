export type SupabaseClientLike = { from: (table: string) => any }
export const supabase: SupabaseClientLike | null = null
export const hasSupabase = false

export async function supaSelect(_table: string, _columns = '*', _filters?: Record<string, any>): Promise<any[] | null> { return null }

export async function supaInsert(_table: string, _payload: any): Promise<any | null> { return null }

export async function supaUpdate(_table: string, _id: string, _payload: any): Promise<any | null> { return null }

export async function supaDelete(_table: string, _id: string): Promise<any | null> { return null }

export async function supaUpsert(_table: string, _payload: any): Promise<any | null> { return null }

export async function supaUpsertConflict(_table: string, _payload: any, _onConflict: string): Promise<any | null> { return null }