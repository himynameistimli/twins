import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseKey = import.meta.env.PUBLIC_SUPABASE_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

// Device ID for identifying this tracker instance
function getDeviceId(): string {
  let deviceId = localStorage.getItem('twinsTracker_deviceId');
  if (!deviceId) {
    deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('twinsTracker_deviceId', deviceId);
  }
  return deviceId;
}

export const deviceId = getDeviceId();
