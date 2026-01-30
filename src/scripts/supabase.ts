import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseKey = import.meta.env.PUBLIC_SUPABASE_KEY || '';

// Create a mock client if credentials are missing
function createSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseKey) {
    console.warn('Supabase credentials not configured - using local storage only');
    return null;
  }
  console.log('Supabase connected:', supabaseUrl);
  return createClient(supabaseUrl, supabaseKey, {
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    }
  });
}

export const supabase = createSupabaseClient();

// Shared ID for syncing across all devices
// Use a fixed ID so all browsers share the same data
export const deviceId = 'twins_tracker_shared';

// Unique client ID to identify this browser session
export const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Realtime subscription management
let realtimeChannel: RealtimeChannel | null = null;

export type RealtimeCallback = (payload: { new: any; old: any; eventType: string }) => void;

export function subscribeToChanges(callback: RealtimeCallback): RealtimeChannel | null {
  if (!supabase) return null;
  
  // Unsubscribe from existing channel if any
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
  }
  
  // Subscribe to changes on the tracker_data table for our device_id
  realtimeChannel = supabase
    .channel('tracker_data_changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'tracker_data',
        filter: `device_id=eq.${deviceId}`
      },
      (payload) => {
        console.log('Realtime change received:', payload.eventType);
        callback({
          new: payload.new,
          old: payload.old,
          eventType: payload.eventType
        });
      }
    )
    .subscribe((status) => {
      console.log('Realtime subscription status:', status);
    });
  
  return realtimeChannel;
}

export function unsubscribeFromChanges(): void {
  if (supabase && realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}
