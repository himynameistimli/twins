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

// Reconnection state
let reconnectAttempts = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
const MAX_RECONNECT_DELAY = 30000; // 30 seconds max
const BASE_RECONNECT_DELAY = 1000; // 1 second initial

// Connection status callback type
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type StatusCallback = (status: ConnectionStatus, message?: string) => void;

let statusCallback: StatusCallback | null = null;

export type RealtimeCallback = (payload: { new: any; old: any; eventType: string }) => void;

// Store the callback for reconnection
let storedCallback: RealtimeCallback | null = null;

function getReconnectDelay(): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  return delay;
}

function scheduleReconnect(): void {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  const delay = getReconnectDelay();
  reconnectAttempts++;
  
  console.log(`Scheduling reconnect attempt ${reconnectAttempts} in ${delay}ms`);
  statusCallback?.('disconnected', `Reconnecting in ${Math.round(delay / 1000)}s...`);
  
  reconnectTimeout = setTimeout(() => {
    if (storedCallback) {
      console.log('Attempting to reconnect...');
      statusCallback?.('connecting', 'Reconnecting...');
      subscribeToChanges(storedCallback, statusCallback || undefined);
    }
  }, delay);
}

export function subscribeToChanges(
  callback: RealtimeCallback,
  onStatusChange?: StatusCallback
): RealtimeChannel | null {
  if (!supabase) return null;
  
  // Store for reconnection
  storedCallback = callback;
  if (onStatusChange) {
    statusCallback = onStatusChange;
  }
  
  // Unsubscribe from existing channel if any
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
  }
  
  statusCallback?.('connecting', 'Connecting to realtime...');
  
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
    .subscribe((status, err) => {
      console.log('Realtime subscription status:', status, err || '');
      
      switch (status) {
        case 'SUBSCRIBED':
          // Successfully connected
          reconnectAttempts = 0; // Reset backoff
          if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
          }
          statusCallback?.('connected', 'Realtime sync active');
          break;
          
        case 'CHANNEL_ERROR':
          console.error('Realtime channel error:', err);
          statusCallback?.('error', `Channel error: ${err?.message || 'Unknown error'}`);
          scheduleReconnect();
          break;
          
        case 'TIMED_OUT':
          console.warn('Realtime subscription timed out');
          statusCallback?.('error', 'Connection timed out');
          scheduleReconnect();
          break;
          
        case 'CLOSED':
          console.log('Realtime channel closed');
          statusCallback?.('disconnected', 'Connection closed');
          // Only reconnect if we didn't explicitly close it
          if (storedCallback) {
            scheduleReconnect();
          }
          break;
      }
    });
  
  return realtimeChannel;
}

export function unsubscribeFromChanges(): void {
  // Clear stored callback to prevent reconnection
  storedCallback = null;
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  if (supabase && realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  
  statusCallback?.('disconnected', 'Disconnected');
}

// Manual reconnect trigger (for UI button)
export function forceReconnect(): void {
  if (!storedCallback) {
    console.warn('No callback stored, cannot reconnect');
    return;
  }
  
  // Reset backoff
  reconnectAttempts = 0;
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  // Disconnect existing channel
  if (supabase && realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  
  // Reconnect immediately
  statusCallback?.('connecting', 'Reconnecting...');
  subscribeToChanges(storedCallback, statusCallback || undefined);
}

// Check if currently connected
export function isConnected(): boolean {
  return realtimeChannel?.state === 'joined';
}
