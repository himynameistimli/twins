import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseKey = import.meta.env.PUBLIC_SUPABASE_KEY || '';

// Create a mock client if credentials are missing
function createSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) {
    console.warn('Supabase credentials not configured - using local storage only');
    return null;
  }
  console.log('Supabase connected:', supabaseUrl);
  return createClient(supabaseUrl, supabaseKey);
}

export const supabase = createSupabaseClient();

// Shared ID for syncing across all devices
// Use a fixed ID so all browsers share the same data
export const deviceId = 'twins_tracker_shared';
