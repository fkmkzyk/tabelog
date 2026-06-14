import { createClient } from '@supabase/supabase-js';

/**
 * Verify the user's JWT token and return the authenticated user object.
 * Throws a structured error if authentication fails.
 */
export async function verifyAuth(request: Request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { message: 'Unauthorized: Missing token', status: 401 };
  }

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) {
    throw { message: 'Unauthorized: Invalid token', status: 401 };
  }

  return user;
}
