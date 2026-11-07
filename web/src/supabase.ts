import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False until the two public Supabase settings are provided (see README). */
export const configured = Boolean(url && key);

// Placeholder values keep the module importable so the app can show a setup message instead of crashing.
export const supabase = createClient(url ?? 'http://localhost:54321', key ?? 'not-configured', {
  auth: { persistSession: true, autoRefreshToken: true },
});
