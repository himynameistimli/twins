import { google } from 'googleapis';

// Initialize the Google Calendar API client
function getCalendarClient() {
  const privateKey = import.meta.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = import.meta.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  
  if (!privateKey || !clientEmail) {
    throw new Error('Missing Google Calendar credentials');
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startTime: Date;
  endTime?: Date;
  childName: string;
  eventType: 'feed' | 'med' | 'diaper';
}

// Create a unique event ID based on the event details
// Google Calendar event IDs must be 5-1024 characters, lowercase a-v and 0-9 only (base32hex)
function generateEventId(event: CalendarEventInput): string {
  // Create a simple hash from the input
  const input = `${event.childName}${event.eventType}${event.startTime.getTime()}`;
  
  // Convert string to a base32hex-compatible ID
  let result = '';
  for (let i = 0; i < input.length; i++) {
    const charCode = input.charCodeAt(i);
    // Map to base32hex characters (0-9, a-v)
    result += (charCode % 32).toString(32);
  }
  
  // Add timestamp in base32hex to ensure uniqueness
  result += event.startTime.getTime().toString(32);
  
  // Ensure minimum length of 5 characters
  while (result.length < 5) {
    result += 'a';
  }
  
  // Truncate to max 1024 characters
  return result.substring(0, 1024);
}

// Add emoji prefix based on event type
function getEventEmoji(type: CalendarEventInput['eventType']): string {
  switch (type) {
    case 'feed': return '🍼';
    case 'med': return '💊';
    case 'diaper': return '👶';
    default: return '📌';
  }
}

// Create or update an event in Google Calendar
export async function createCalendarEvent(event: CalendarEventInput): Promise<string | null> {
  const calendarId = import.meta.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.error('Missing GOOGLE_CALENDAR_ID');
    return null;
  }

  try {
    const calendar = getCalendarClient();
    const eventId = generateEventId(event);
    const emoji = getEventEmoji(event.eventType);
    
    // Default end time to 15 minutes after start
    const endTime = event.endTime || new Date(event.startTime.getTime() + 15 * 60 * 1000);
    
    const eventResource = {
      summary: `${emoji} ${event.childName}: ${event.summary}`,
      description: event.description || `Logged via Twins Tracker`,
      start: {
        dateTime: event.startTime.toISOString(),
        timeZone: 'America/New_York',
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: 'America/New_York',
      },
    };

    // Try to update existing event, or create new one
    try {
      await calendar.events.update({
        calendarId,
        eventId,
        requestBody: eventResource,
      });
      console.log(`Updated calendar event: ${eventId}`);
      return eventId;
    } catch (updateError: any) {
      if (updateError.code === 404) {
        // Event doesn't exist, create it
        const response = await calendar.events.insert({
          calendarId,
          requestBody: {
            ...eventResource,
            id: eventId,
          },
        });
        console.log(`Created calendar event: ${response.data.id}`);
        return response.data.id || null;
      }
      throw updateError;
    }
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return null;
  }
}

// Delete an event from Google Calendar
export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const calendarId = import.meta.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.error('Missing GOOGLE_CALENDAR_ID');
    return false;
  }

  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({
      calendarId,
      eventId,
    });
    console.log(`Deleted calendar event: ${eventId}`);
    return true;
  } catch (error: any) {
    if (error.code === 404) {
      // Event already deleted
      return true;
    }
    console.error('Error deleting calendar event:', error);
    return false;
  }
}

// List events for a specific date range
export async function listCalendarEvents(startDate: Date, endDate: Date) {
  const calendarId = import.meta.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.error('Missing GOOGLE_CALENDAR_ID');
    return [];
  }

  try {
    const calendar = getCalendarClient();
    const response = await calendar.events.list({
      calendarId,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return response.data.items || [];
  } catch (error) {
    console.error('Error listing calendar events:', error);
    return [];
  }
}
