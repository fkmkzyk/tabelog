import { createClient } from '@supabase/supabase-js';

// Use placeholder credentials during build time to prevent compilation crashes.
// Real environment variables will be used when running the server or in the browser.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder-project-id.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';

// Client-side Supabase instance (uses Anonymous key, respects RLS)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side Admin Supabase instance (uses Service Role key, bypasses RLS)
let supabaseAdminInstance: ReturnType<typeof createClient> | null = null;

export const getSupabaseAdmin = () => {
  if (!supabaseAdminInstance) {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('Warning: SUPABASE_SERVICE_ROLE_KEY is not defined. Using placeholder admin client.');
    }
    supabaseAdminInstance = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return supabaseAdminInstance;
};

