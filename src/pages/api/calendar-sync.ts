import type { APIRoute } from 'astro';
import { createCalendarEvent, deleteCalendarEvent, type CalendarEventInput } from '../../scripts/google-calendar';

// Enable server-side rendering for this API route
export const prerender = false;

interface SyncRequest {
  action: 'create' | 'delete';
  eventId?: string;
  event?: {
    summary: string;
    description?: string;
    startTime: string; // ISO string
    endTime?: string;
    childName: string;
    eventType: 'feed' | 'med' | 'diaper';
  };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body: SyncRequest = await request.json();

    if (body.action === 'create' && body.event) {
      const eventInput: CalendarEventInput = {
        summary: body.event.summary,
        description: body.event.description,
        startTime: new Date(body.event.startTime),
        endTime: body.event.endTime ? new Date(body.event.endTime) : undefined,
        childName: body.event.childName,
        eventType: body.event.eventType,
      };

      const eventId = await createCalendarEvent(eventInput);
      
      if (eventId) {
        return new Response(JSON.stringify({ success: true, eventId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        return new Response(JSON.stringify({ success: false, error: 'Failed to create event' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (body.action === 'delete' && body.eventId) {
      const success = await deleteCalendarEvent(body.eventId);
      
      return new Response(JSON.stringify({ success }), {
        status: success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Calendar sync error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
