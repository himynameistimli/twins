import type { APIRoute } from 'astro';

// Enable server-side rendering for this API route
export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const calendarUrl = url.searchParams.get('url');
  
  if (!calendarUrl) {
    return new Response(JSON.stringify({ error: 'No URL provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const response = await fetch(calendarUrl, {
      headers: {
        'Accept': 'text/calendar,text/plain,*/*'
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch calendar: ${response.status}` }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const icalData = await response.text();
    const events = parseICalendar(icalData);

    return new Response(JSON.stringify({ events }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    });
  } catch (error) {
    console.error('Calendar fetch error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch calendar' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;
  end?: string;
  allDay: boolean;
  recurrence?: string;
}

function parseICalendar(icalData: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const lines = icalData.replace(/\r\n /g, '').replace(/\r\n\t/g, '').split(/\r\n|\n|\r/);
  
  let inEvent = false;
  let currentEvent: Partial<CalendarEvent> = {};
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      currentEvent = {};
      continue;
    }
    
    if (line === 'END:VEVENT') {
      inEvent = false;
      if (currentEvent.uid && currentEvent.summary && currentEvent.start) {
        events.push(currentEvent as CalendarEvent);
      }
      continue;
    }
    
    if (!inEvent) continue;
    
    // Parse event properties
    if (line.startsWith('UID:')) {
      currentEvent.uid = line.substring(4);
    } else if (line.startsWith('SUMMARY:')) {
      currentEvent.summary = unescapeICalText(line.substring(8));
    } else if (line.startsWith('DESCRIPTION:')) {
      currentEvent.description = unescapeICalText(line.substring(12));
    } else if (line.startsWith('DTSTART')) {
      const { value, isAllDay } = parseDateTimeProperty(line);
      currentEvent.start = value;
      currentEvent.allDay = isAllDay;
    } else if (line.startsWith('DTEND')) {
      const { value } = parseDateTimeProperty(line);
      currentEvent.end = value;
    } else if (line.startsWith('RRULE:')) {
      currentEvent.recurrence = line.substring(6);
    }
  }
  
  return events;
}

function parseDateTimeProperty(line: string): { value: string; isAllDay: boolean } {
  // Handle formats like:
  // DTSTART:20260127T140000Z
  // DTSTART;VALUE=DATE:20260127
  // DTSTART;TZID=America/New_York:20260127T090000
  
  const colonIndex = line.indexOf(':');
  const params = line.substring(0, colonIndex);
  const value = line.substring(colonIndex + 1);
  
  const isAllDay = params.includes('VALUE=DATE') && !params.includes('VALUE=DATE-TIME');
  
  if (isAllDay) {
    // All-day event: 20260127 -> 2026-01-27
    return {
      value: `${value.substring(0, 4)}-${value.substring(4, 6)}-${value.substring(6, 8)}`,
      isAllDay: true
    };
  }
  
  // Date-time: 20260127T140000Z -> ISO format
  if (value.includes('T')) {
    const dateStr = value.substring(0, 8);
    const timeStr = value.substring(9, 15);
    const isUTC = value.endsWith('Z');
    
    const isoDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    const isoTime = `${timeStr.substring(0, 2)}:${timeStr.substring(2, 4)}:${timeStr.substring(4, 6)}`;
    
    return {
      value: `${isoDate}T${isoTime}${isUTC ? 'Z' : ''}`,
      isAllDay: false
    };
  }
  
  return { value, isAllDay: false };
}

function unescapeICalText(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
