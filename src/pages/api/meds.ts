import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

export const prerender = false;

const DEVICE_ID = 'twins_tracker_shared';
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.PUBLIC_SUPABASE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

interface MedEntry {
  baby: 'jimmy' | 'emily';
  medName: string;
  time: string;        // HH:MM format (24h)
  doseIndex?: number;  // Optional - which dose number
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { baby, medName, time, doseIndex = 0 } = body as MedEntry;
    
    // Validate required fields
    if (!baby || !medName || !time) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Missing required fields: baby, medName, time' 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
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
    
    if (!supabase) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Supabase not configured' 
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
      return new Response(JSON.stringify({ 
        success: false, 
        error: `Failed to fetch current data: ${fetchError.message}` 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
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
    
    const childIndex = babyLower === 'emily' ? 0 : 1;
    
    // Format time for display (12h format)
    const [hour24, minute] = time.split(':').map(Number);
    const hour12 = hour24 % 12 || 12;
    const ampm = hour24 >= 12 ? 'PM' : 'AM';
    const displayTime = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
    
    // Find or create medication
    let medId = '';
    const existingMed = trackerData.children[childIndex].medications?.find(
      (m: any) => m.name.toLowerCase() === medName.toLowerCase()
    );
    
    if (existingMed) {
      medId = existingMed.id;
    } else {
      // Create new medication entry
      medId = `med_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      if (!trackerData.children[childIndex].medications) {
        trackerData.children[childIndex].medications = [];
      }
      trackerData.children[childIndex].medications.push({
        id: medId,
        name: medName,
        dosesPerDay: 1,
        doseTimes: [time]
      });
    }
    
    // Mark dose as done
    if (!trackerData.logs[childIndex].medsDone) {
      trackerData.logs[childIndex].medsDone = {};
    }
    if (!trackerData.logs[childIndex].medsDone[medId]) {
      trackerData.logs[childIndex].medsDone[medId] = [];
    }
    if (!trackerData.logs[childIndex].medsDone[medId].includes(doseIndex)) {
      trackerData.logs[childIndex].medsDone[medId].push(doseIndex);
    }
    
    // Log the medication
    if (!trackerData.logs[childIndex].meds) {
      trackerData.logs[childIndex].meds = [];
    }
    trackerData.logs[childIndex].meds.push({
      medId,
      medName,
      doseIndex,
      time: displayTime,
      timestamp: Date.now()
    });
    
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
      medName,
      time: displayTime,
      message: `Logged ${medName} for ${babyLower} at ${displayTime}`
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

// GET endpoint to retrieve current meds
export const GET: APIRoute = async () => {
  try {
    if (!supabase) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Supabase not configured' 
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
        emily: { meds: [] },
        jimmy: { meds: [] }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const today = trackerData.today || new Date().toISOString().split('T')[0];
    const emilyMeds = trackerData.logs?.[0]?.meds || [];
    const jimmyMeds = trackerData.logs?.[1]?.meds || [];
    
    return new Response(JSON.stringify({
      success: true,
      today,
      emily: {
        name: trackerData.children?.[0]?.name || 'Emily',
        meds: emilyMeds
      },
      jimmy: {
        name: trackerData.children?.[1]?.name || 'Jimmy',
        meds: jimmyMeds
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
