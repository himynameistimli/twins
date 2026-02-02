import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const prerender = false;

// Device ID used by the tracker app
const DEVICE_ID = 'twins_tracker_shared';

// Get Supabase credentials from environment
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.PUBLIC_SUPABASE_KEY || '';

// Create Supabase client
const supabase = supabaseUrl && supabaseKey 
  ? createClient(supabaseUrl, supabaseKey)
  : null;

interface FeedEntry {
  baby: 'jimmy' | 'emily';
  time: string;        // HH:MM format (24h)
  amount: number;      // mL
  timestamp?: number;  // Optional - will use current time if not provided
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { baby, time, amount, timestamp } = body as FeedEntry;
    
    // Validate required fields
    if (!baby || !time || typeof amount !== 'number') {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Missing required fields: baby, time, amount' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Validate baby name
    const babyLower = baby.toLowerCase();
    if (!['jimmy', 'emily'].includes(babyLower)) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Invalid baby name. Must be "jimmy" or "emily"' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Validate time format (HH:MM)
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
    if (!timeRegex.test(time)) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Invalid time format. Must be HH:MM (24h)' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Check Supabase is configured
    if (!supabase) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Supabase not configured. Check PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_KEY env vars' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Fetch current data
    const { data: row, error: fetchError } = await supabase
      .from('tracker_data')
      .select('data')
      .eq('device_id', DEVICE_ID)
      .single();
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Error fetching tracker data:', fetchError);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to fetch current data: ${fetchError.message}` 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Parse current data or use defaults
    const trackerData = row?.data || {
      children: [
        { name: 'Emily', medications: [], feedSchedules: [] },
        { name: 'Jimmy', medications: [], feedSchedules: [] }
      ],
      today: new Date().toISOString().split('T')[0],
      logs: [
        { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} },
        { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} }
      ],
      historicalLogs: {}
    };
    
    // Determine child index
    const childIndex = babyLower === 'emily' ? 0 : 1;
    
    // Format time for display (12h format with AM/PM)
    const [hour24, minute] = time.split(':').map(Number);
    const hour12 = hour24 % 12 || 12;
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    const displayTime = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
    
    // Create feed entry
    const feedEntry = {
      text: `🍼 Feed ${amount}mL`,
      time: displayTime,
      id: timestamp || Date.now(),
      timestamp: timestamp || Date.now()
    };
    
    // Add to logs
    if (!trackerData.logs[childIndex].feeds) {
      trackerData.logs[childIndex].feeds = [];
    }
    trackerData.logs[childIndex].feeds.push(feedEntry);
    
    // Update today's date
    trackerData.today = new Date().toISOString().split('T')[0];
    
    // Save back to Supabase
    const { error: saveError } = await supabase
      .from('tracker_data')
      .upsert({
        device_id: DEVICE_ID,
        data: trackerData,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'device_id'
      });
    
    if (saveError) {
      console.error('Error saving to Supabase:', saveError);
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to save: ${saveError.message}` 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({
      success: true,
      baby: babyLower,
      time: displayTime,
      amount: amount,
      message: `Logged ${amount}mL feed for ${babyLower} at ${displayTime}`
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('API error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

// GET endpoint to retrieve current feeds
export const GET: APIRoute = async () => {
  try {
    // Check Supabase is configured
    if (!supabase) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Supabase not configured. Check PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_KEY env vars' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const { data: row, error } = await supabase
      .from('tracker_data')
      .select('data')
      .eq('device_id', DEVICE_ID)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      return new Response(JSON.stringify({ 
        success: false, 
        error: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const trackerData = row?.data;
    
    if (!trackerData) {
      return new Response(JSON.stringify({
        success: true,
        today: new Date().toISOString().split('T')[0],
        emily: { feeds: [] },
        jimmy: { feeds: [] }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Format response
    const today = trackerData.today || new Date().toISOString().split('T')[0];
    const emilyFeeds = trackerData.logs?.[0]?.feeds || [];
    const jimmyFeeds = trackerData.logs?.[1]?.feeds || [];
    
    return new Response(JSON.stringify({
      success: true,
      today,
      emily: {
        name: trackerData.children?.[0]?.name || 'Emily',
        feeds: emilyFeeds
      },
      jimmy: {
        name: trackerData.children?.[1]?.name || 'Jimmy',
        feeds: jimmyFeeds
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
