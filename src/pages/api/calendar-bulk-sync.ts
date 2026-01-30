import type { APIRoute } from 'astro';
import { createCalendarEvent, type CalendarEventInput } from '../../scripts/google-calendar';
import { createClient } from '@supabase/supabase-js';

// Enable server-side rendering for this API route
export const prerender = false;

interface Feed {
  text: string;
  time: string;
  id: number;
  timestamp: number;
}

interface DiaperLog {
  type: 'pee' | 'poop';
  time: string;
  timestamp: number;
}

interface MedLog {
  medId: string;
  medName: string;
  doseIndex: number;
  time: string;
  timestamp: number;
}

interface DayLog {
  feeds: Feed[];
  diapers: DiaperLog[];
  meds: MedLog[];
}

interface TrackerData {
  children: { name: string }[];
  today: string | null;
  logs: DayLog[];
  historicalLogs: Record<string, DayLog[]>;
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
    const supabaseKey = import.meta.env.PUBLIC_SUPABASE_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    
    // Fetch data from Supabase
    const { data: rows, error } = await supabase
      .from('tracker_data')
      .select('data')
      .eq('device_id', 'twins_tracker_shared')
      .single();

    if (error || !rows) {
      return new Response(JSON.stringify({ error: 'Failed to fetch data from Supabase', details: error?.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const trackerData = rows.data as TrackerData;
    const childNames = trackerData.children?.map(c => c.name) || ['Child 1', 'Child 2'];
    
    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    // Helper to sync a day's logs
    async function syncDayLogs(dateStr: string, logs: DayLog[], childIndex: number) {
      const childName = childNames[childIndex] || `Child ${childIndex + 1}`;
      const dayLog = logs[childIndex];
      if (!dayLog) return;

      // Sync feeds
      for (const feed of dayLog.feeds || []) {
        try {
          const amount = feed.text.match(/(\d+)/)?.[1] || '';
          const eventInput: CalendarEventInput = {
            summary: `Feed ${amount}mL`,
            description: `Formula feeding: ${amount}mL`,
            startTime: new Date(feed.timestamp),
            childName,
            eventType: 'feed',
          };
          const result = await createCalendarEvent(eventInput);
          if (result) synced++;
          else failed++;
        } catch (e: any) {
          failed++;
          errors.push(`Feed ${feed.timestamp}: ${e.message}`);
        }
      }

      // Sync diapers
      for (const diaper of dayLog.diapers || []) {
        try {
          const emoji = diaper.type === 'pee' ? '💧' : '💩';
          const eventInput: CalendarEventInput = {
            summary: `${emoji} Diaper (${diaper.type})`,
            description: `Diaper change: ${diaper.type}`,
            startTime: new Date(diaper.timestamp),
            childName,
            eventType: 'diaper',
          };
          const result = await createCalendarEvent(eventInput);
          if (result) synced++;
          else failed++;
        } catch (e: any) {
          failed++;
          errors.push(`Diaper ${diaper.timestamp}: ${e.message}`);
        }
      }

      // Sync meds
      for (const med of dayLog.meds || []) {
        try {
          const eventInput: CalendarEventInput = {
            summary: med.medName,
            description: `Medication: ${med.medName} (Dose ${med.doseIndex + 1})`,
            startTime: new Date(med.timestamp),
            childName,
            eventType: 'med',
          };
          const result = await createCalendarEvent(eventInput);
          if (result) synced++;
          else failed++;
        } catch (e: any) {
          failed++;
          errors.push(`Med ${med.timestamp}: ${e.message}`);
        }
      }
    }

    // Sync current day's logs
    if (trackerData.logs) {
      const today = trackerData.today || new Date().toDateString();
      for (let i = 0; i < trackerData.logs.length; i++) {
        await syncDayLogs(today, trackerData.logs, i);
      }
    }

    // Sync historical logs
    if (trackerData.historicalLogs) {
      for (const [dateStr, logs] of Object.entries(trackerData.historicalLogs)) {
        for (let i = 0; i < logs.length; i++) {
          await syncDayLogs(dateStr, logs, i);
        }
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      synced, 
      failed,
      errors: errors.slice(0, 10) // Only return first 10 errors
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    console.error('Bulk sync error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
