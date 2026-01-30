import { supabase, deviceId, clientId, subscribeToChanges } from './supabase';

// Types
interface Medication {
  id: string;
  name: string;
  dosesPerDay: number;
  doseTimes: string[];
}

interface FeedSchedule {
  id: string;
  name: string;
  defaultAmount: number;
}

interface Child {
  name: string;
  medications: Medication[];
  feedSchedules: FeedSchedule[];
}

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
  medsDone: Record<string, number[]>;
  feedAmounts: Record<string, number>;
}

interface TrackerData {
  children: Child[];
  today: string | null;
  logs: DayLog[];
  // Historical logs keyed by date string (e.g., "Mon Jan 27 2026")
  historicalLogs: Record<string, DayLog[]>;
  // Google Calendar iCal URL
  calendarUrl?: string;
  // Dismissed calendar event UIDs (won't show in planner)
  dismissedCalendarEvents?: string[];
}

interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;
  end?: string;
  allDay: boolean;
  recurrence?: string;
}

interface Urgency {
  status: 'urgent' | 'soon' | 'normal' | 'done';
  text: string;
  nextDose?: { hour: number; min: number; index: number; diffMins: number } | null;
}

interface TimelineEvent {
  time: string;
  timestamp: number;
  hour: number;
  minute: number;
  type: 'feed' | 'med' | 'pee' | 'poop';
  label: string;
  color: string;
  originalIndex?: number;
  medId?: string;
  doseIndex?: number;
}

// Drag-to-edit state
interface DragState {
  active: boolean;
  childIndex: number;
  event: TimelineEvent | null;
  startY: number;
  currentY: number;
  originalHour: number;
  originalMinute: number;
  element: HTMLElement | null;
}

let dragState: DragState = {
  active: false,
  childIndex: 0,
  event: null,
  startY: 0,
  currentY: 0,
  originalHour: 0,
  originalMinute: 0,
  element: null
};

let longPressTimer: number | null = null;
const DRAG_PRESS_DURATION = 150; // ms - short press for dragging
const DELETE_MODE_DURATION = 1000; // ms - long press for delete mode
let eventEditMode: boolean[] = [false, false]; // Edit mode per child for event deletion

// State
let data: TrackerData = {
  children: [
    { name: 'Emily', medications: [], feedSchedules: [] },
    { name: 'Jimmy', medications: [], feedSchedules: [] }
  ],
  today: null,
  logs: [
    { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} },
    { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} }
  ],
  historicalLogs: {}
};

let currentChild = 0;
let soundEnabled = true;
let viewingDate: Date = new Date(); // The date we're currently viewing
let notifiedItems = new Set<string>();
let audioContext: AudioContext | null = null;
let notificationDismissed = false;
let selectedDoseCount = 1;
let plannerScale = [1, 1]; // Scale for each child's planner
let calendarEvents: CalendarEvent[] = []; // Events from Google Calendar
let calendarLastFetched = 0; // Timestamp of last calendar fetch
let editMode: boolean[] = [false, false]; // Edit mode per child for medication deletion

// Initialize
export async function init() {
  // Hide tooltips initially until data is loaded
  for (let i = 0; i < 2; i++) {
    document.getElementById(`urgent-tooltip-${i}`)?.classList.remove('active');
  }
  
  // Load data from Supabase (with localStorage fallback)
  const hasExistingData = await loadData();
  
  // Load defaults if no saved data exists (first run)
  if (!hasExistingData) {
    await loadDefaults();
  }
  
  loadSoundPreference();
  
  // Always reset viewingDate to current date on init
  // This ensures we're viewing "today" when the app loads
  viewingDate = new Date();
  
  checkNewDay();
  updateDisplay();
  updateDate();
  checkNotifications();
  setupPlannerZoom();
  setupSwipeNavigation();
  setupFeedControls();
  setupSyncedScroll();
  
  // Update feed amount displays to match loaded defaults
  for (let i = 0; i < 2; i++) {
    const amountEl = document.getElementById(`feed-amount-${i}`);
    if (amountEl) amountEl.textContent = `${feedAmounts[i]}`;
  }
  
  setInterval(() => {
    updateDisplay();
    checkNotifications();
  }, 60000);
  
  // Check for overdue items every 30 seconds and beep if any exist
  setInterval(() => {
    checkOverdueBeep();
  }, 30000);
  
  // Refresh calendar every 5 minutes
  setInterval(() => {
    fetchCalendarEvents();
  }, 5 * 60 * 1000);
  
  // Initial calendar fetch
  fetchCalendarEvents();
  
  setupEventListeners();
  
  // Setup realtime sync for multi-client updates
  setupRealtimeSync();
}

// ===== GOOGLE CALENDAR SYNC =====
async function fetchCalendarEvents() {
  if (!data.calendarUrl) return;
  
  // Don't fetch if we fetched less than 1 minute ago
  const now = Date.now();
  if (now - calendarLastFetched < 60000) return;
  
  try {
    const response = await fetch(`/api/calendar?url=${encodeURIComponent(data.calendarUrl)}`);
    if (!response.ok) {
      console.error('Failed to fetch calendar:', response.status);
      return;
    }
    
    const result = await response.json();
    if (result.events) {
      calendarEvents = result.events;
      calendarLastFetched = now;
      console.log(`Loaded ${calendarEvents.length} calendar events`);
      
      // Re-render planners to show calendar events
      for (let i = 0; i < 2; i++) {
        renderPlanner(i);
      }
    }
  } catch (error) {
    console.error('Error fetching calendar:', error);
  }
}

// Dismiss a calendar event (hide it from the planner)
function dismissCalendarEvent(uid: string) {
  if (!data.dismissedCalendarEvents) {
    data.dismissedCalendarEvents = [];
  }
  if (!data.dismissedCalendarEvents.includes(uid)) {
    data.dismissedCalendarEvents.push(uid);
    saveData();
    // Re-render planners to remove the dismissed event
    for (let i = 0; i < 2; i++) {
      renderPlanner(i);
    }
  }
}

// Expose for global access
(window as any).dismissCalendarEvent = dismissCalendarEvent;

// Sync event to Google Calendar
async function syncToGoogleCalendar(event: {
  summary: string;
  description?: string;
  startTime: Date;
  childName: string;
  eventType: 'feed' | 'med' | 'diaper';
}) {
  try {
    const response = await fetch('/api/calendar-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        event: {
          summary: event.summary,
          description: event.description,
          startTime: event.startTime.toISOString(),
          childName: event.childName,
          eventType: event.eventType,
        }
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log('Synced to Google Calendar:', result.eventId);
    } else {
      console.error('Failed to sync to Google Calendar');
    }
  } catch (error) {
    console.error('Error syncing to Google Calendar:', error);
  }
}

function getCalendarEventsForDate(date: Date): { uid: string; hour: number; minute: number; summary: string; description?: string; allDay: boolean }[] {
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const events: { uid: string; hour: number; minute: number; summary: string; description?: string; allDay: boolean }[] = [];
  
  // Get child names to filter out our own synced events
  const childNames = data.children.map(c => c.name.toLowerCase());
  const dismissedEvents = new Set(data.dismissedCalendarEvents || []);
  
  for (const event of calendarEvents) {
    // Skip dismissed events
    if (dismissedEvents.has(event.uid)) continue;
    
    // Skip events created by our app (they have emoji prefix and child name)
    const summary = event.summary || '';
    const isOurEvent = (summary.startsWith('🍼') || summary.startsWith('💊') || summary.startsWith('👶')) &&
      childNames.some(name => summary.toLowerCase().includes(`${name}:`));
    if (isOurEvent) continue;
    
    // Check if event is on this date
    const eventDate = event.start.split('T')[0];
    if (eventDate === dateStr) {
      if (event.allDay) {
        events.push({
          uid: event.uid,
          hour: 0,
          minute: 0,
          summary: event.summary,
          description: event.description,
          allDay: true
        });
      } else {
        // Parse the time
        const timePart = event.start.split('T')[1];
        if (timePart) {
          const [hourStr, minStr] = timePart.split(':');
          let hour = parseInt(hourStr);
          const minute = parseInt(minStr);
          
          // Handle UTC conversion if needed
          if (event.start.endsWith('Z')) {
            const utcDate = new Date(event.start);
            events.push({
              uid: event.uid,
              hour: utcDate.getHours(),
              minute: utcDate.getMinutes(),
              summary: event.summary,
              description: event.description,
              allDay: false
            });
          } else {
            events.push({
              uid: event.uid,
              hour,
              minute,
              summary: event.summary,
              description: event.description,
              allDay: false
            });
          }
        }
      }
    }
  }
  
  return events.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
}

function setupEventListeners() {
  document.getElementById('dismiss-btn')?.addEventListener('click', dismissNotification);
  
  document.querySelectorAll('[data-child-name]').forEach(el => {
    el.addEventListener('click', () => {
      const childIndex = parseInt(el.getAttribute('data-child-name') || '0');
      editChildName(childIndex);
    });
  });
  
  document.querySelectorAll('.dose-count-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const doses = parseInt(btn.getAttribute('data-doses') || '1');
      selectDoseCount(doses);
    });
  });
  
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.getAttribute('data-action');
    const childIndex = parseInt(target.getAttribute('data-child') || '0');
    
    switch (action) {
      case 'open-med-settings':
        openMedSettings(childIndex);
        break;
      case 'exit-edit-mode':
        (window as any).toggleMedEditMode(childIndex);
        break;
      case 'log-diaper':
        const type = target.getAttribute('data-type') as 'pee' | 'poop';
        logDiaper(childIndex, type);
        break;
      case 'close-modal':
        closeModal();
        break;
      case 'save-medication':
        saveMedication();
        break;
      case 'save-name':
        saveName();
        break;
      case 'dismiss-tooltip':
        dismissChildTooltip(childIndex);
        break;
      case 'add-overdue-med':
        addOverdueMed(childIndex);
        break;
    }
  });
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const target = e.target as HTMLElement;
      if (target.id === 'med-name') saveMedication();
    }
  });
  
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  });
}

// ===== SYNCED SCROLL =====
let scrollLeader: HTMLElement | null = null;
let scrollLeaderTimeout: number | null = null;

function setupSyncedScroll() {
  const viewport0 = document.getElementById('planner-0');
  const viewport1 = document.getElementById('planner-1');
  
  if (!viewport0 || !viewport1) return;
  
  const setLeader = (el: HTMLElement) => {
    scrollLeader = el;
    if (scrollLeaderTimeout) clearTimeout(scrollLeaderTimeout);
    // Keep leadership for 300ms after last scroll (allows momentum to continue)
    scrollLeaderTimeout = window.setTimeout(() => { scrollLeader = null; }, 300);
  };
  
  // User interaction sets the leader - we only sync FROM the leader
  viewport0.addEventListener('touchstart', () => setLeader(viewport0), { passive: true });
  viewport0.addEventListener('mousedown', () => setLeader(viewport0), { passive: true });
  viewport0.addEventListener('wheel', () => setLeader(viewport0), { passive: true });
  
  viewport1.addEventListener('touchstart', () => setLeader(viewport1), { passive: true });
  viewport1.addEventListener('mousedown', () => setLeader(viewport1), { passive: true });
  viewport1.addEventListener('wheel', () => setLeader(viewport1), { passive: true });
  
  // Sync scroll - only from leader to follower, never set scrollTop on the leader
  viewport0.addEventListener('scroll', () => {
    if (scrollLeader === viewport0) {
      // Extend leadership during momentum scrolling
      if (scrollLeaderTimeout) clearTimeout(scrollLeaderTimeout);
      scrollLeaderTimeout = window.setTimeout(() => { scrollLeader = null; }, 300);
      viewport1.scrollTop = viewport0.scrollTop;
    }
  }, { passive: true });
  
  viewport1.addEventListener('scroll', () => {
    if (scrollLeader === viewport1) {
      // Extend leadership during momentum scrolling
      if (scrollLeaderTimeout) clearTimeout(scrollLeaderTimeout);
      scrollLeaderTimeout = window.setTimeout(() => { scrollLeader = null; }, 300);
      viewport0.scrollTop = viewport1.scrollTop;
    }
  }, { passive: true });
}

// ===== SWIPE NAVIGATION =====
function setupSwipeNavigation() {
  const container = document.querySelector('.container');
  if (!container) return;
  
  let touchStartX = 0;
  let touchStartY = 0;
  let touchEndX = 0;
  let isSwiping = false;
  
  const SWIPE_THRESHOLD = 80;
  const SWIPE_ANGLE_THRESHOLD = 30; // Max vertical angle for horizontal swipe
  
  // Elements that should ignore swipe gestures
  const isInteractiveElement = (el: HTMLElement): boolean => {
    // Check if the element or any parent matches interactive selectors
    const interactiveSelectors = [
      '.med-btn',
      '.feed-wheel',
      '[data-action="log-diaper"]',
      '[data-action="open-feed-settings"]',
      '[data-action="open-med-settings"]',
      '.controls-section button',
      '.modal-overlay'
    ];
    
    return interactiveSelectors.some(selector => 
      el.matches(selector) || el.closest(selector) !== null
    );
  };
  
  container.addEventListener('touchstart', (e) => {
    const target = e.target as HTMLElement;
    
    // Ignore swipe if starting on interactive elements
    if (isInteractiveElement(target)) {
      isSwiping = false;
      return;
    }
    
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    isSwiping = true;
  }, { passive: true });
  
  container.addEventListener('touchmove', (e) => {
    if (!isSwiping) return;
    touchEndX = e.touches[0].clientX;
  }, { passive: true });
  
  container.addEventListener('touchend', (e) => {
    if (!isSwiping) return;
    isSwiping = false;
    
    const deltaX = touchEndX - touchStartX;
    const deltaY = (e.changedTouches[0]?.clientY || touchStartY) - touchStartY;
    
    // Calculate swipe angle - must be mostly horizontal
    const angle = Math.abs(Math.atan2(deltaY, deltaX) * 180 / Math.PI);
    const isHorizontalSwipe = angle < SWIPE_ANGLE_THRESHOLD || angle > (180 - SWIPE_ANGLE_THRESHOLD);
    
    if (Math.abs(deltaX) > SWIPE_THRESHOLD && isHorizontalSwipe) {
      if (deltaX > 0) {
        // Swipe right = go to previous day
        navigateDate(-1);
      } else {
        // Swipe left = go to next day
        navigateDate(1);
      }
    }
    
    touchStartX = 0;
    touchEndX = 0;
  }, { passive: true });
}

function navigateDate(delta: number) {
  const newDate = new Date(viewingDate);
  newDate.setDate(newDate.getDate() + delta);
  
  // Don't allow navigating to future dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDay = new Date(newDate);
  targetDay.setHours(0, 0, 0, 0);
  
  if (targetDay > today) return;
  
  viewingDate = newDate;
  updateDate();
  updateDisplay();
  
  // Haptic feedback
  triggerHaptic();
  playClickSound();
}

function isViewingToday(): boolean {
  const today = new Date();
  return viewingDate.toDateString() === today.toDateString();
}

function getViewingLogs(): DayLog[] {
  if (isViewingToday()) {
    return data.logs;
  }
  
  const dateKey = viewingDate.toDateString();
  return data.historicalLogs[dateKey] || [
    { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} },
    { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} }
  ];
}

// Export for global access
(window as any).navigateDate = navigateDate;

// ===== PLANNER / TIMELINE =====
function setupPlannerZoom() {
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3;
  const RUBBER_BAND_FACTOR = 0.3;
  const FRICTION = 0.75; // Higher friction = quicker slowdown
  const MIN_VELOCITY = 0.002;
  
  for (let i = 0; i < 2; i++) {
    const viewport = document.getElementById(`planner-${i}`);
    const content = document.getElementById(`planner-content-${i}`);
    if (!viewport || !content) continue;
    
    let initialDistance = 0;
    let initialScale = 1;
    let isPinching = false;
    let currentScale = 1;
    let velocity = 0;
    let lastDistance = 0;
    let lastTime = 0;
    let animationId: number | null = null;
    
    function applyRubberBand(scale: number): number {
      if (scale < MIN_SCALE) {
        const overshoot = MIN_SCALE - scale;
        return MIN_SCALE - overshoot * RUBBER_BAND_FACTOR;
      }
      if (scale > MAX_SCALE) {
        const overshoot = scale - MAX_SCALE;
        return MAX_SCALE + overshoot * RUBBER_BAND_FACTOR;
      }
      return scale;
    }
    
    function clearZoomStyles() {
      content.style.transform = '';
      content.querySelectorAll('.planner-text, .planner-event').forEach(el => {
        (el as HTMLElement).style.transform = '';
      });
    }
    
    function updateVisualScale(scale: number) {
      const visualScale = scale / initialScale;
      content.style.transform = `scaleY(${visualScale})`;
      content.style.transformOrigin = 'top left';
      
      // Counter-scale text elements directly via JS
      const counterScale = 1 / visualScale;
      const elements = content.querySelectorAll('.planner-text, .planner-event');
      elements.forEach(el => {
        (el as HTMLElement).style.transform = `scaleY(${counterScale})`;
      });
    }
    
    function animateToScale(targetScale: number, useSpring = false) {
      if (animationId) cancelAnimationFrame(animationId);
      
      const startScale = currentScale;
      const startTime = performance.now();
      const duration = useSpring ? 500 : 300;
      
      function animate(now: number) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        
        // Ease out with optional overshoot for spring
        let eased: number;
        if (useSpring) {
          // Spring overshoot curve
          eased = 1 - Math.pow(1 - progress, 3) * Math.cos(progress * Math.PI * 0.5);
        } else {
          // Smooth ease out
          eased = 1 - Math.pow(1 - progress, 3);
        }
        
        currentScale = startScale + (targetScale - startScale) * eased;
        updateVisualScale(currentScale);
        
        if (progress < 1) {
          animationId = requestAnimationFrame(animate);
        } else {
          currentScale = targetScale;
          plannerScale[i] = targetScale;
          clearZoomStyles();
          renderPlanner(i);
          animationId = null;
        }
      }
      
      animationId = requestAnimationFrame(animate);
    }
    
    function animateInertia() {
      if (animationId) cancelAnimationFrame(animationId);
      
      function animate() {
        // Apply velocity
        currentScale *= (1 + velocity);
        velocity *= FRICTION;
        
        // Check bounds with rubber band
        const isOutOfBounds = currentScale < MIN_SCALE || currentScale > MAX_SCALE;
        const visualScale = applyRubberBand(currentScale);
        
        // Update visual with counter-scale for text
        const displayRatio = visualScale / initialScale;
        content.style.transform = `scaleY(${displayRatio})`;
        content.style.transformOrigin = 'top left';
        
        // Counter-scale text elements directly
        const counterScale = 1 / displayRatio;
        const elements = content.querySelectorAll('.planner-text, .planner-event');
        elements.forEach(el => {
          (el as HTMLElement).style.transform = `scaleY(${counterScale})`;
        });
        
        // If out of bounds and velocity is low, snap back
        if (isOutOfBounds && Math.abs(velocity) < MIN_VELOCITY) {
          const targetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale));
          animateToScale(targetScale, true);
          return;
        }
        
        // Continue if still moving
        if (Math.abs(velocity) > MIN_VELOCITY) {
          animationId = requestAnimationFrame(animate);
        } else {
          // Settle
          const finalScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale));
          plannerScale[i] = finalScale;
          clearZoomStyles();
          renderPlanner(i);
          animationId = null;
        }
      }
      
      animationId = requestAnimationFrame(animate);
    }
    
    viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        if (animationId) {
          cancelAnimationFrame(animationId);
          animationId = null;
        }
        
        isPinching = true;
        initialDistance = getDistance(e.touches[0], e.touches[1]);
        lastDistance = initialDistance;
        initialScale = plannerScale[i];
        currentScale = initialScale;
        velocity = 0;
        lastTime = performance.now();
        e.preventDefault();
      }
    }, { passive: false });
    
    viewport.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && isPinching) {
        e.preventDefault();
        
        const now = performance.now();
        const distance = getDistance(e.touches[0], e.touches[1]);
        const dt = now - lastTime;
        
        if (dt > 0) {
          const ratio = distance / lastDistance;
          velocity = (ratio - 1) * 0.5; // Dampen for smoothness
        }
        
        const overallRatio = distance / initialDistance;
        currentScale = initialScale * overallRatio;
        const visualScale = applyRubberBand(currentScale);
        
        updateVisualScale(visualScale);
        
        lastDistance = distance;
        lastTime = now;
      }
    }, { passive: false });
    
    viewport.addEventListener('touchend', () => {
      if (isPinching) {
        isPinching = false;
        
        // Continue with inertia
        if (Math.abs(velocity) > MIN_VELOCITY) {
          animateInertia();
        } else {
          // No velocity - just settle
          const isOutOfBounds = currentScale < MIN_SCALE || currentScale > MAX_SCALE;
          if (isOutOfBounds) {
            const targetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale));
            animateToScale(targetScale, true);
          } else {
            plannerScale[i] = currentScale;
            clearZoomStyles();
            renderPlanner(i);
          }
        }
      }
    });
    
    // Mouse wheel zoom with easing
    let wheelTimeout: number | null = null;
    let wheelTargetScale = plannerScale[i];
    
    viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        
        if (wheelTimeout) clearTimeout(wheelTimeout);
        
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        wheelTargetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, wheelTargetScale * delta));
        
        initialScale = plannerScale[i];
        currentScale = plannerScale[i];
        animateToScale(wheelTargetScale, false);
        
        wheelTimeout = window.setTimeout(() => {
          wheelTargetScale = plannerScale[i];
        }, 150);
      }
    }, { passive: false });
  }
}

function getDistance(touch1: Touch, touch2: Touch): number {
  return Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
}

function getTimelineEvents(childIndex: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const logs = getViewingLogs();
  const log = logs[childIndex];
  
  // Add feeds
  log.feeds.forEach((feed, index) => {
    const [hourStr, rest] = feed.time.split(':');
    const isPM = feed.time.toLowerCase().includes('pm');
    const isAM = feed.time.toLowerCase().includes('am');
    let hour = parseInt(hourStr);
    if (isPM && hour !== 12) hour += 12;
    if (isAM && hour === 12) hour = 0;
    const minute = parseInt(rest) || 0;
    
    events.push({
      time: feed.time,
      timestamp: feed.timestamp || feed.id,
      hour,
      minute,
      type: 'feed',
      label: feed.text,
      color: '#22c55e',
      originalIndex: index
    });
  });
  
  // Add meds
  log.meds.forEach((med, index) => {
    const [hourStr, rest] = med.time.split(':');
    const isPM = med.time.toLowerCase().includes('pm');
    const isAM = med.time.toLowerCase().includes('am');
    let hour = parseInt(hourStr);
    if (isPM && hour !== 12) hour += 12;
    if (isAM && hour === 12) hour = 0;
    const minute = parseInt(rest) || 0;
    
    events.push({
      time: med.time,
      timestamp: med.timestamp,
      hour,
      minute,
      type: 'med',
      label: med.medName,
      color: '#6366f1',
      originalIndex: index,
      medId: med.medId,
      doseIndex: med.doseIndex
    });
  });
  
  // Add diapers
  log.diapers.forEach((diaper, index) => {
    const [hourStr, rest] = diaper.time.split(':');
    const isPM = diaper.time.toLowerCase().includes('pm');
    const isAM = diaper.time.toLowerCase().includes('am');
    let hour = parseInt(hourStr);
    if (isPM && hour !== 12) hour += 12;
    if (isAM && hour === 12) hour = 0;
    const minute = parseInt(rest) || 0;
    
    events.push({
      time: diaper.time,
      timestamp: diaper.timestamp,
      hour,
      minute,
      type: diaper.type,
      label: diaper.type === 'pee' ? '💧 Pee' : '💩 Poop',
      color: diaper.type === 'pee' ? '#3b82f6' : '#a16207',
      originalIndex: index
    });
  });
  
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// Calculate column layout for overlapping events
function calculateEventColumns(events: TimelineEvent[], hourHeight: number): Map<TimelineEvent, { column: number; totalColumns: number }> {
  const eventHeight = 36; // h-9 = 36px
  const overlapThreshold = eventHeight; // Events within this vertical distance are considered overlapping
  
  // Sort events by their Y position (time)
  const sortedEvents = [...events].sort((a, b) => {
    const yA = (a.hour + a.minute / 60) * hourHeight;
    const yB = (b.hour + b.minute / 60) * hourHeight;
    return yA - yB;
  });
  
  const result = new Map<TimelineEvent, { column: number; totalColumns: number }>();
  
  // Find overlapping groups
  const groups: TimelineEvent[][] = [];
  let currentGroup: TimelineEvent[] = [];
  
  sortedEvents.forEach(event => {
    const y = (event.hour + event.minute / 60) * hourHeight;
    
    if (currentGroup.length === 0) {
      currentGroup.push(event);
    } else {
      // Check if this event overlaps with any event in the current group
      const groupEndY = Math.max(...currentGroup.map(e => 
        (e.hour + e.minute / 60) * hourHeight + eventHeight
      ));
      
      if (y < groupEndY) {
        // Overlaps with current group
        currentGroup.push(event);
      } else {
        // Doesn't overlap, start new group
        groups.push(currentGroup);
        currentGroup = [event];
      }
    }
  });
  
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  // Assign columns within each group
  groups.forEach(group => {
    const totalColumns = group.length;
    group.forEach((event, index) => {
      result.set(event, { column: index, totalColumns });
    });
  });
  
  return result;
}

// Calculate column layout for scheduled events (meds and feeds)
interface ScheduledEvent {
  hour: number;
  minute: number;
  time: string;
  name: string;
  type: 'med' | 'feed';
  medId?: string;
  doseIndex?: number;
  isPast: boolean;
  isGhost?: boolean; // True if this was already given but at a different time
}

function calculateScheduledColumns(events: ScheduledEvent[], hourHeight: number): Map<ScheduledEvent, { column: number; totalColumns: number }> {
  const eventHeight = 36; // h-9 = 36px
  
  // Sort events by their Y position (time)
  const sortedEvents = [...events].sort((a, b) => {
    const yA = (a.hour + a.minute / 60) * hourHeight;
    const yB = (b.hour + b.minute / 60) * hourHeight;
    return yA - yB;
  });
  
  const result = new Map<ScheduledEvent, { column: number; totalColumns: number }>();
  
  // Find overlapping groups
  const groups: ScheduledEvent[][] = [];
  let currentGroup: ScheduledEvent[] = [];
  
  sortedEvents.forEach(event => {
    const y = (event.hour + event.minute / 60) * hourHeight;
    
    if (currentGroup.length === 0) {
      currentGroup.push(event);
    } else {
      // Check if this event overlaps with any event in the current group
      const groupEndY = Math.max(...currentGroup.map(e => 
        (e.hour + e.minute / 60) * hourHeight + eventHeight
      ));
      
      if (y < groupEndY) {
        // Overlaps with current group
        currentGroup.push(event);
      } else {
        // Doesn't overlap, start new group
        groups.push(currentGroup);
        currentGroup = [event];
      }
    }
  });
  
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  // Assign columns within each group
  groups.forEach(group => {
    const totalColumns = group.length;
    group.forEach((event, index) => {
      result.set(event, { column: index, totalColumns });
    });
  });
  
  return result;
}

function renderPlanner(childIndex: number) {
  const container = document.getElementById(`planner-content-${childIndex}`);
  if (!container) return;
  
  const scale = plannerScale[childIndex];
  const hourHeight = 60 * scale;
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const viewingToday = isViewingToday();
  
  const events = getTimelineEvents(childIndex);
  
  // Calculate column layout for overlapping events
  const eventColumns = calculateEventColumns(events, hourHeight);
  
  // Create 24-hour timeline
  let html = `<div class="relative w-full" style="height: ${24 * hourHeight}px;">`;
  
  // Hour lines and labels
  for (let hour = 0; hour < 24; hour++) {
    const y = hour * hourHeight;
    const isCurrentHour = viewingToday && hour === currentHour;
    const hourLabel = hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`;
    
    html += `
      <div class="planner-row absolute left-0 right-0 flex items-start" style="top: ${y}px; height: ${hourHeight}px;">
        <div class="planner-text w-12 text-[10px] text-gray-500 pr-2 text-right flex-shrink-0 ${isCurrentHour ? 'text-white font-bold' : ''}">${hourLabel}</div>
        <div class="flex-1 border-t border-border/50 h-full relative ${isCurrentHour ? 'bg-accent-left/10' : ''}"></div>
      </div>
    `;
  }
  
  // Current time indicator - only show when viewing today
  if (viewingToday) {
    const currentY = (currentHour + currentMinute / 60) * hourHeight;
    html += `
      <div class="absolute left-12 right-0 h-0.5 bg-urgent z-10" style="top: ${currentY}px;">
        <div class="absolute -left-1 -top-1 w-2.5 h-2.5 rounded-full bg-urgent"></div>
      </div>
    `;
  }
  
  // Scheduled items (meds and feeds) - only show for today, with column layout for overlapping
  if (viewingToday) {
    const meds = data.children[childIndex].medications;
    const feedSchedules = data.children[childIndex].feedSchedules || [];
    const nowMinutes = currentHour * 60 + currentMinute;
    
    // Collect all scheduled (pending) events - both meds and feeds
    const scheduledEvents: { hour: number; minute: number; time: string; name: string; type: 'med' | 'feed'; medId?: string; doseIndex?: number; isPast: boolean }[] = [];
    
    // Add scheduled meds
    meds.forEach(med => {
      med.doseTimes.forEach((time, idx) => {
        const [h, m] = time.split(':').map(Number);
        const scheduledMinutes = h * 60 + m;
        const isDone = (data.logs[childIndex].medsDone[med.id] || []).includes(idx);
        
        if (isDone) {
          // Check if the med was given at a significantly different time than scheduled
          // If so, show a "ghost" entry at the scheduled time
          const medLogs = data.logs[childIndex].meds.filter(
            log => log.medId === med.id && log.doseIndex === idx
          );
          
          if (medLogs.length > 0) {
            const loggedTime = new Date(medLogs[0].timestamp);
            const loggedMinutes = loggedTime.getHours() * 60 + loggedTime.getMinutes();
            const timeDiff = Math.abs(loggedMinutes - scheduledMinutes);
            
            // If given more than 30 minutes from scheduled time, show ghost entry
            if (timeDiff > 30) {
              scheduledEvents.push({
                hour: h,
                minute: m,
                time,
                name: med.name,
                type: 'med',
                medId: med.id,
                doseIndex: idx,
                isPast: true,
                isGhost: true // This was given, but at a different time
              });
            }
          }
          return;
        }
        
        const isPast = scheduledMinutes < nowMinutes;
        
        scheduledEvents.push({
          hour: h,
          minute: m,
          time,
          name: med.name,
          type: 'med',
          medId: med.id,
          doseIndex: idx,
          isPast,
          isGhost: false
        });
      });
    });
    
    // Add scheduled feeds
    if (feedSchedules.length > 0 && feedSchedules[0].times) {
      const feedTimes = feedSchedules[0].times as string[];
      const feedsGiven = data.logs[childIndex].feeds || [];
      
      feedTimes.forEach((time, idx) => {
        const [h, m] = time.split(':').map(Number);
        
        // Check if a feed was given within 30 minutes of this scheduled time
        const scheduledMinutes = h * 60 + m;
        const isFeedGiven = feedsGiven.some(feed => {
          const feedDate = new Date(feed.timestamp || feed.id);
          const feedMinutes = feedDate.getHours() * 60 + feedDate.getMinutes();
          return Math.abs(feedMinutes - scheduledMinutes) < 30;
        });
        
        if (isFeedGiven) return;
        
        const isPast = scheduledMinutes < nowMinutes;
        
        scheduledEvents.push({
          hour: h,
          minute: m,
          time,
          name: '🍼 Feed',
          type: 'feed',
          doseIndex: idx,
          isPast,
          isGhost: false
        });
      });
    }
    
    // Calculate column layout for scheduled events
    const scheduledColumns = calculateScheduledColumns(scheduledEvents, hourHeight);
    
    // Render scheduled events with column layout
    scheduledEvents.forEach(event => {
      const y = (event.hour + event.minute / 60) * hourHeight;
      const layout = scheduledColumns.get(event) || { column: 0, totalColumns: 1 };
      const { column, totalColumns } = layout;
      
      const gap = totalColumns > 1 ? 2 : 0;
      const leftStyle = totalColumns === 1 
        ? 'left: 56px; right: 8px;' 
        : `left: calc(56px + ${column} * ((100% - 64px) / ${totalColumns}) + ${gap}px); width: calc((100% - 64px - ${(totalColumns - 1) * gap}px) / ${totalColumns});`;
      
      // Style based on whether it's past or future, ghost or not, and type
      const isPast = event.isPast;
      const isGhost = event.isGhost;
      const isFeed = event.type === 'feed';
      
      // Ghost entries (was given at a different time) get an even fainter style
      // Past items get faint outline style, future items get filled style
      let bgClass: string;
      let badgeClass: string;
      let badgeText: string;
      
      if (isGhost) {
        // Ghost: was scheduled here but given at a different time
        bgClass = isFeed 
          ? 'border-normal/25 bg-transparent text-normal/30' 
          : 'border-soon/25 bg-transparent text-soon/30';
        badgeClass = isFeed ? 'bg-normal/15' : 'bg-soon/15';
        badgeText = 'Was Due';
      } else if (isPast) {
        // Past and not given: missed
        bgClass = isFeed 
          ? 'border-normal/40 bg-transparent text-normal/50' 
          : 'border-soon/40 bg-transparent text-soon/50';
        badgeClass = isFeed ? 'bg-normal/20' : 'bg-soon/20';
        badgeText = 'Missed';
      } else {
        // Future: scheduled - use dotted border to indicate pending
        bgClass = isFeed 
          ? 'border-normal bg-normal/15 text-normal' 
          : 'border-soon bg-soon/15 text-soon';
        badgeClass = '';
        badgeText = '';
      }
      
      // Border style: dotted for future, dashed for past/ghost
      const borderStyle = isPast || isGhost ? 'border-dashed' : 'border-dotted';
      
      html += `
        <div class="planner-event absolute h-9 rounded flex items-center justify-between px-2 text-xs border-l-2 ${bgClass} ${borderStyle}" style="top: ${y - 18}px; ${leftStyle}">
          <span class="flex items-center min-w-0">
            <span class="opacity-70 ${totalColumns > 2 ? 'hidden' : ''}">${event.time}</span>
            <span class="${totalColumns > 2 ? '' : 'ml-1 '}font-medium truncate">${event.name}</span>
          </span>
          ${badgeText ? `<span class="ml-2 px-1.5 py-0.5 ${badgeClass} rounded text-[8px] uppercase tracking-wider flex-shrink-0 ${totalColumns > 1 ? 'hidden' : ''}">${badgeText}</span>` : ''}
        </div>
      `;
    });
  }
  
  // Actual events - with column layout for overlapping events
  events.forEach(event => {
    const y = (event.hour + event.minute / 60) * hourHeight;
    const bgClass = event.type === 'feed' ? 'bg-normal/30 border-normal' 
                  : event.type === 'med' ? 'bg-accent-left/30 border-accent-left'
                  : event.type === 'pee' ? 'bg-blue-500/30 border-blue-500'
                  : 'bg-yellow-700/30 border-yellow-700';
    
    // Get column layout for this event
    const layout = eventColumns.get(event) || { column: 0, totalColumns: 1 };
    const { column, totalColumns } = layout;
    
    // Calculate horizontal positioning
    // Base: left-14 (56px) to right-2 (8px from right)
    // Available width = 100% - 56px - 8px = calc(100% - 64px)
    const widthPercent = 100 / totalColumns;
    const leftOffset = 56 + (column * ((100 - 64) / totalColumns)); // Approximate pixel calculation
    const gap = totalColumns > 1 ? 2 : 0; // 2px gap between columns
    
    // Use calc for precise positioning
    const leftStyle = totalColumns === 1 
      ? 'left: 56px; right: 8px;' 
      : `left: calc(56px + ${column} * ((100% - 64px) / ${totalColumns}) + ${gap}px); width: calc((100% - 64px - ${(totalColumns - 1) * gap}px) / ${totalColumns});`;
    
    // Only add draggable events when viewing today
    const draggableAttrs = viewingToday 
      ? `data-draggable="true" 
         data-event-type="${event.type}" 
         data-event-index="${event.originalIndex}" 
         data-event-hour="${event.hour}" 
         data-event-minute="${event.minute}"
         data-event-timestamp="${event.timestamp}"
         ${event.medId ? `data-med-id="${event.medId}"` : ''}
         ${event.doseIndex !== undefined ? `data-dose-index="${event.doseIndex}"` : ''}`
      : '';
    
    const isInEditMode = eventEditMode[childIndex];
    const deleteBtn = isInEditMode && viewingToday
      ? `<button class="event-delete-btn" onclick="event.stopPropagation(); event.preventDefault(); deleteEventFromPlanner(${childIndex}, '${event.type}', ${event.timestamp})">✕</button>`
      : '';
    
    // In edit mode, don't show grab cursor and don't add draggable attrs
    const cursorClass = viewingToday && !isInEditMode ? 'cursor-grab' : '';
    const attrs = isInEditMode ? '' : draggableAttrs;
    
    html += `
      <div class="planner-event absolute h-9 rounded flex items-center px-2 text-xs border-l-2 ${bgClass} text-white ${cursorClass} ${isInEditMode ? 'jiggle-event' : ''}" 
           style="top: ${y - 18}px; ${leftStyle}" 
           ${attrs}>
        <span class="opacity-70 event-time ${totalColumns > 2 ? 'hidden' : ''}">${event.time}</span>
        <span class="${totalColumns > 2 ? '' : 'ml-2 '}font-medium truncate flex-1">${event.label}</span>
        ${deleteBtn}
      </div>
    `;
  });
  
  // Google Calendar events - show on both panels
  const calEvents = getCalendarEventsForDate(viewingDate);
  calEvents.forEach(calEvent => {
    const escapedUid = calEvent.uid.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const dismissBtn = `<button onclick="event.stopPropagation(); dismissCalendarEvent('${escapedUid}')" class="ml-1 p-1 hover:bg-pink-500/50 rounded opacity-60 hover:opacity-100 flex-shrink-0" title="Hide this event">✕</button>`;
    
    if (calEvent.allDay) {
      // All-day events at the very top
      html += `
        <div class="planner-event absolute h-9 rounded flex items-center px-2 text-xs border-l-2 bg-pink-500/30 border-pink-500 text-white" 
             style="top: 4px; left: 56px; right: 8px;"
             title="${calEvent.description || calEvent.summary}">
          <span class="opacity-70">📅</span>
          <span class="ml-2 font-medium truncate flex-1">${calEvent.summary}</span>
          <span class="px-1.5 py-0.5 bg-pink-500/40 rounded text-[8px] uppercase tracking-wider flex-shrink-0">All Day</span>
          ${dismissBtn}
        </div>
      `;
    } else {
      const y = (calEvent.hour + calEvent.minute / 60) * hourHeight;
      const displayHour = calEvent.hour % 12 || 12;
      const ampm = calEvent.hour >= 12 ? 'PM' : 'AM';
      const minuteStr = String(calEvent.minute).padStart(2, '0');
      const timeStr = `${displayHour}:${minuteStr} ${ampm}`;
      
      html += `
        <div class="planner-event absolute h-9 rounded flex items-center px-2 text-xs border-l-2 bg-pink-500/30 border-pink-500 text-white" 
             style="top: ${y - 18}px; left: 56px; right: 8px;"
             title="${calEvent.description || calEvent.summary}">
          <span class="opacity-70">📅 ${timeStr}</span>
          <span class="ml-2 font-medium truncate flex-1">${calEvent.summary}</span>
          <span class="px-1.5 py-0.5 bg-pink-500/40 rounded text-[8px] uppercase tracking-wider flex-shrink-0">GCal</span>
          ${dismissBtn}
        </div>
      `;
    }
  });
  
  html += '</div>';
  container.innerHTML = html;
  
  // Scroll to current time on first render (or first event for past dates)
  const viewport = document.getElementById(`planner-${childIndex}`);
  if (viewport && !viewport.dataset.scrolled) {
    let scrollY: number;
    if (viewingToday) {
      scrollY = (currentHour + currentMinute / 60) * hourHeight;
    } else if (events.length > 0) {
      // Scroll to first event for past dates
      const firstEvent = events[0];
      scrollY = (firstEvent.hour + firstEvent.minute / 60) * hourHeight;
    } else {
      // Default to 8 AM for empty past days
      scrollY = 8 * hourHeight;
    }
    viewport.scrollTop = Math.max(0, scrollY - 100);
    viewport.dataset.scrolled = 'true';
  }
  
  // Re-attach drag handlers for this planner
  setupDraggableEvents(childIndex);
}

// ===== EVENT DRAGGING =====
function setupDraggableEvents(childIndex: number) {
  const container = document.getElementById(`planner-content-${childIndex}`);
  if (!container) return;
  
  const events = container.querySelectorAll('[data-draggable="true"]');
  
  events.forEach(el => {
    const element = el as HTMLElement;
    
    // Touch events for mobile
    element.addEventListener('touchstart', (e) => handleEventTouchStart(e, childIndex), { passive: false });
    
    // Mouse events for desktop
    element.addEventListener('mousedown', (e) => handleEventMouseDown(e, childIndex));
  });
}

function handleEventTouchStart(e: TouchEvent, childIndex: number) {
  const target = e.currentTarget as HTMLElement;
  if (!target.dataset.draggable) return;
  
  // If in edit mode, don't start drag - just allow delete button clicks
  if (eventEditMode[childIndex]) return;
  
  // Prevent text selection and context menu
  e.preventDefault();
  e.stopPropagation();
  
  const touch = e.touches[0];
  const startY = touch.clientY;
  
  let deleteTimer: number | null = null;
  let canDrag = false;
  
  // After short press, user CAN start dragging by moving
  const dragReadyTimer = window.setTimeout(() => {
    canDrag = true;
  }, DRAG_PRESS_DURATION);
  
  // Long press timer for delete/edit mode
  deleteTimer = window.setTimeout(() => {
    if (!dragState.active) {
      clearTimeout(dragReadyTimer);
      toggleEventEditMode(childIndex);
    }
  }, DELETE_MODE_DURATION);
  
  // Track handlers to remove them later
  const moveHandler = (moveEvent: TouchEvent) => {
    const currentTouch = moveEvent.touches[0];
    const deltaY = Math.abs(currentTouch.clientY - startY);
    
    if (deltaY > 10) {
      if (canDrag && !dragState.active) {
        // Start dragging
        if (deleteTimer) clearTimeout(deleteTimer);
        startDragging(target, childIndex, startY);
      } else if (!canDrag) {
        // User is scrolling before drag ready, cancel everything
        clearTimeout(dragReadyTimer);
        if (deleteTimer) clearTimeout(deleteTimer);
        document.removeEventListener('touchmove', moveHandler as EventListener);
        document.removeEventListener('touchend', endHandler);
        return;
      }
    }
    
    if (dragState.active) {
      handleDragMove(currentTouch.clientY);
      moveEvent.preventDefault();
    }
  };
  
  const endHandler = () => {
    clearTimeout(dragReadyTimer);
    if (deleteTimer) clearTimeout(deleteTimer);
    if (dragState.active) {
      endDragging();
    }
    document.removeEventListener('touchmove', moveHandler as EventListener);
    document.removeEventListener('touchend', endHandler);
  };
  
  document.addEventListener('touchmove', moveHandler as EventListener, { passive: false });
  document.addEventListener('touchend', endHandler);
}

function handleEventMouseDown(e: MouseEvent, childIndex: number) {
  const target = e.currentTarget as HTMLElement;
  if (!target.dataset.draggable) return;
  
  // If in edit mode, don't start drag
  if (eventEditMode[childIndex]) return;
  
  // Prevent text selection
  e.preventDefault();
  e.stopPropagation();
  
  const startY = e.clientY;
  let deleteTimer: number | null = null;
  let canDrag = false;
  
  // After short press, user CAN start dragging by moving
  const dragReadyTimer = window.setTimeout(() => {
    canDrag = true;
  }, DRAG_PRESS_DURATION);
  
  // Long press timer for delete/edit mode
  deleteTimer = window.setTimeout(() => {
    if (!dragState.active) {
      clearTimeout(dragReadyTimer);
      toggleEventEditMode(childIndex);
      // Clean up listeners
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
    }
  }, DELETE_MODE_DURATION);
  
  const moveHandler = (moveEvent: MouseEvent) => {
    const deltaY = Math.abs(moveEvent.clientY - startY);
    
    if (deltaY > 10) {
      if (canDrag && !dragState.active) {
        // Start dragging
        if (deleteTimer) clearTimeout(deleteTimer);
        startDragging(target, childIndex, startY);
      } else if (!canDrag) {
        // User moved before drag ready, cancel everything
        clearTimeout(dragReadyTimer);
        if (deleteTimer) clearTimeout(deleteTimer);
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
        return;
      }
    }
    
    if (dragState.active) {
      handleDragMove(moveEvent.clientY);
      moveEvent.preventDefault();
    }
  };
  
  const upHandler = () => {
    clearTimeout(dragReadyTimer);
    if (deleteTimer) clearTimeout(deleteTimer);
    if (dragState.active) {
      endDragging();
    }
    document.removeEventListener('mousemove', moveHandler);
    document.removeEventListener('mouseup', upHandler);
  };
  
  document.addEventListener('mousemove', moveHandler);
  document.addEventListener('mouseup', upHandler);
}

function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function startDragging(element: HTMLElement, childIndex: number, startY: number) {
  const eventType = element.dataset.eventType as TimelineEvent['type'];
  const eventIndex = parseInt(element.dataset.eventIndex || '0');
  const hour = parseInt(element.dataset.eventHour || '0');
  const minute = parseInt(element.dataset.eventMinute || '0');
  const timestamp = parseInt(element.dataset.eventTimestamp || '0');
  
  dragState = {
    active: true,
    childIndex,
    event: {
      type: eventType,
      originalIndex: eventIndex,
      hour,
      minute,
      timestamp,
      time: '',
      label: '',
      color: '',
      medId: element.dataset.medId,
      doseIndex: element.dataset.doseIndex !== undefined ? parseInt(element.dataset.doseIndex) : undefined
    },
    startY,
    currentY: startY,
    originalHour: hour,
    originalMinute: minute,
    element
  };
  
  // Visual feedback - scale up and add glow
  element.classList.add('dragging');
  element.style.zIndex = '100';
  element.style.transform = 'scale(1.02)';
  element.style.boxShadow = '0 0 20px rgba(99, 102, 241, 0.5)';
  element.style.cursor = 'grabbing';
  
  // Haptic feedback
  triggerHaptic();
  playClickSound();
  
  // Disable pointer events on other elements
  document.body.classList.add('dragging-event');
}

function handleDragMove(currentY: number) {
  if (!dragState.active || !dragState.element) return;
  
  dragState.currentY = currentY;
  
  // Calculate time change based on vertical movement
  const scale = plannerScale[dragState.childIndex];
  const hourHeight = 60 * scale;
  const deltaY = currentY - dragState.startY;
  const deltaMinutes = Math.round((deltaY / hourHeight) * 60);
  
  // Calculate new time
  let totalMinutes = (dragState.originalHour * 60) + dragState.originalMinute + deltaMinutes;
  
  // Clamp to valid range (0:00 - 23:59)
  totalMinutes = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  
  // Round to 5-minute intervals for easier use
  totalMinutes = Math.round(totalMinutes / 5) * 5;
  
  const newHour = Math.floor(totalMinutes / 60);
  const newMinute = totalMinutes % 60;
  
  // Update visual position
  const newY = (newHour + newMinute / 60) * hourHeight;
  dragState.element.style.top = `${newY - 12}px`;
  
  // Update time display
  const timeEl = dragState.element.querySelector('.event-time');
  if (timeEl) {
    const displayHour = newHour % 12 || 12;
    const ampm = newHour >= 12 ? 'PM' : 'AM';
    const minuteStr = String(newMinute).padStart(2, '0');
    timeEl.textContent = `${displayHour}:${minuteStr} ${ampm}`;
  }
}

function endDragging() {
  if (!dragState.active || !dragState.element || !dragState.event) return;
  
  // Calculate final time
  const scale = plannerScale[dragState.childIndex];
  const hourHeight = 60 * scale;
  const deltaY = dragState.currentY - dragState.startY;
  const deltaMinutes = Math.round((deltaY / hourHeight) * 60);
  
  let totalMinutes = (dragState.originalHour * 60) + dragState.originalMinute + deltaMinutes;
  totalMinutes = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  totalMinutes = Math.round(totalMinutes / 5) * 5;
  
  const newHour = Math.floor(totalMinutes / 60);
  const newMinute = totalMinutes % 60;
  
  // Only update if time actually changed
  if (newHour !== dragState.originalHour || newMinute !== dragState.originalMinute) {
    updateEventTime(dragState.childIndex, dragState.event, newHour, newMinute);
  }
  
  // Reset visual state
  dragState.element.classList.remove('dragging');
  dragState.element.style.zIndex = '';
  dragState.element.style.transform = '';
  dragState.element.style.boxShadow = '';
  dragState.element.style.cursor = '';
  
  document.body.classList.remove('dragging-event');
  
  // Haptic feedback
  triggerHaptic();
  
  // Reset state
  dragState = {
    active: false,
    childIndex: 0,
    event: null,
    startY: 0,
    currentY: 0,
    originalHour: 0,
    originalMinute: 0,
    element: null
  };
  
  // Re-render to update positions
  updateDisplay();
}

function updateEventTime(childIndex: number, event: TimelineEvent, newHour: number, newMinute: number) {
  const logs = data.logs; // Only update today's logs
  const log = logs[childIndex];
  
  // Format new time string
  const displayHour = newHour % 12 || 12;
  const ampm = newHour >= 12 ? 'PM' : 'AM';
  const minuteStr = String(newMinute).padStart(2, '0');
  const newTimeStr = `${displayHour}:${minuteStr} ${ampm}`;
  
  // Calculate new timestamp (keep the same date, update time)
  const originalDate = new Date(event.timestamp);
  originalDate.setHours(newHour, newMinute, 0, 0);
  const newTimestamp = originalDate.getTime();
  
  switch (event.type) {
    case 'feed':
      if (event.originalIndex !== undefined && log.feeds[event.originalIndex]) {
        log.feeds[event.originalIndex].time = newTimeStr;
        log.feeds[event.originalIndex].timestamp = newTimestamp;
      }
      break;
    case 'med':
      if (event.originalIndex !== undefined && log.meds[event.originalIndex]) {
        log.meds[event.originalIndex].time = newTimeStr;
        log.meds[event.originalIndex].timestamp = newTimestamp;
      }
      break;
    case 'pee':
    case 'poop':
      if (event.originalIndex !== undefined && log.diapers[event.originalIndex]) {
        log.diapers[event.originalIndex].time = newTimeStr;
        log.diapers[event.originalIndex].timestamp = newTimestamp;
      }
      break;
  }
  
  saveData();
}

// ===== DATA PERSISTENCE =====
async function loadDefaults(): Promise<void> {
  try {
    const response = await fetch('/defaults.json');
    if (!response.ok) return;
    
    const defaults = await response.json();
    
    // Load calendar URL
    if (defaults.calendarUrl) {
      data.calendarUrl = defaults.calendarUrl;
    }
    
    if (defaults.children && Array.isArray(defaults.children)) {
      data.children = defaults.children.map((child: any, i: number) => ({
        name: child.name || data.children[i]?.name || `Child ${i + 1}`,
        medications: (child.medications || []).map((m: any) => ({
          id: m.id || Date.now().toString() + Math.random(),
          name: m.name,
          dosesPerDay: m.dosesPerDay || m.doseTimes?.length || 1,
          doseTimes: m.doseTimes || generateDefaultTimes(m.dosesPerDay || 1)
        })),
        feedSchedules: child.feedSchedules || []
      }));
      
      // Set default feed amounts from feedSchedules
      defaults.children.forEach((child: any, i: number) => {
        if (child.feedSchedules?.[0]?.defaultAmount) {
          feedAmounts[i] = child.feedSchedules[0].defaultAmount;
        }
      });
    }
    
    saveData();
  } catch (e) {
    console.log('No defaults.json found or error loading:', e);
  }
}

async function loadData(): Promise<boolean> {
  let hasData = false;
  
  // Load from localStorage first for instant display
  const saved = localStorage.getItem('twinsTracker');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      applyParsedData(parsed);
      hasData = true;
    } catch (e) {
      console.log('Error parsing localStorage data:', e);
    }
  }
  
  // Then try to sync from Supabase (in case there's newer data from another device)
  if (supabase) {
    try {
      console.log('Loading from Supabase with deviceId:', deviceId);
      updateSyncStatus('syncing', 'Loading from cloud...');
      
      const { data: rows, error } = await supabase
        .from('tracker_data')
        .select('data, updated_at')
        .eq('device_id', deviceId)
        .single();
      
      if (error) {
        console.log('Supabase load error:', error.message, error.code);
        // PGRST116 means no rows found, which is OK for first run
        if (error.code === 'PGRST116') {
          updateSyncStatus('synced', 'Ready to sync');
        } else {
          updateSyncStatus('error', `Load error: ${error.message}`);
        }
      }
      
      if (!error && rows?.data) {
        const cloudData = rows.data;
        // Use cloud data (it's the source of truth if it exists)
        applyParsedData(cloudData);
        hasData = true;
        // Sync to localStorage
        localStorage.setItem('twinsTracker', JSON.stringify(data));
        console.log('Synced from cloud, updated_at:', rows.updated_at);
        // Track the known updated_at to detect external changes
        lastKnownUpdatedAt = rows.updated_at;
        // Will be upgraded to 'realtime' once subscription is connected
        updateSyncStatus('synced', `Loaded from cloud: ${new Date(rows.updated_at).toLocaleTimeString()}`);
      }
    } catch (e) {
      console.error('Supabase error:', e);
      updateSyncStatus('error', 'Connection failed');
    }
  } else {
    console.log('Supabase not configured, using localStorage only');
    updateSyncStatus('offline');
  }
  
  return hasData;
}

function applyParsedData(parsed: any) {
  data = {
    ...data,
    ...parsed,
    calendarUrl: parsed.calendarUrl || data.calendarUrl,
    children: parsed.children.map((c: any, i: number) => ({
      ...data.children[i],
      ...c,
      feedSchedules: c.feedSchedules || [],
      medications: (c.medications || []).map((m: any) => ({
        ...m,
        doseTimes: m.doseTimes || generateDefaultTimes(m.dosesPerDay, m.startTime)
      }))
    })),
    logs: parsed.logs.map((l: any, i: number) => ({
      ...data.logs[i],
      ...l,
      diapers: Array.isArray(l.diapers) ? l.diapers : [],
      meds: l.meds || [],
      feedAmounts: l.feedAmounts || {}
    })),
    historicalLogs: parsed.historicalLogs || {},
    dismissedCalendarEvents: parsed.dismissedCalendarEvents || []
  };
  
  // Load feed amounts from saved data if available
  parsed.children?.forEach((child: any, i: number) => {
    if (child.feedSchedules?.[0]?.defaultAmount) {
      feedAmounts[i] = child.feedSchedules[0].defaultAmount;
    }
  });
}

function generateDefaultTimes(doses: number, startTime?: string): string[] {
  const start = startTime || '08:00';
  const [startHour] = start.split(':').map(Number);
  const interval = 24 / doses;
  const times: string[] = [];
  
  for (let i = 0; i < doses; i++) {
    const hour = Math.floor((startHour + interval * i) % 24);
    times.push(`${String(hour).padStart(2, '0')}:00`);
  }
  
  return times;
}

let saveTimeout: number | null = null;
const SAVE_DEBOUNCE_MS = 1000;

// Realtime sync tracking
let lastSaveTimestamp = 0; // Timestamp of our last save
let isApplyingRemoteUpdate = false; // Flag to prevent save loops during remote updates
let lastKnownUpdatedAt: string | null = null; // Track the last known updated_at to detect external changes

// Show a toast notification when syncing from another device
function showSyncToast(message: string) {
  // Remove any existing toast
  const existingToast = document.getElementById('sync-toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  // Create toast element
  const toast = document.createElement('div');
  toast.id = 'sync-toast';
  toast.className = 'sync-toast';
  toast.innerHTML = `
    <svg class="sync-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 12a9 9 0 0 0-9-9M3 12a9 9 0 0 0 9 9M21 12a9 9 0 0 1-9 9M3 12a9 9 0 0 1 9-9"/>
      <path d="M16 12h5l-3-3m3 3l-3 3M8 12H3l3 3m-3-3l3-3"/>
    </svg>
    <span>${message}</span>
  `;
  
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Setup realtime subscription to sync changes from other clients
function setupRealtimeSync() {
  if (!supabase) {
    console.log('Supabase not configured - realtime sync disabled');
    return;
  }
  
  const channel = subscribeToChanges((payload) => {
    // Only process UPDATE events
    if (payload.eventType !== 'UPDATE' && payload.eventType !== 'INSERT') {
      return;
    }
    
    const newData = payload.new;
    if (!newData || !newData.data) return;
    
    // Check if this update is from another client by comparing updated_at
    const remoteUpdatedAt = newData.updated_at;
    
    // If we just saved (within last 2 seconds), this is likely our own update
    const timeSinceOurSave = Date.now() - lastSaveTimestamp;
    if (timeSinceOurSave < 2000) {
      console.log('Ignoring realtime update - likely our own save');
      lastKnownUpdatedAt = remoteUpdatedAt;
      return;
    }
    
    // If updated_at is the same as last known, skip
    if (remoteUpdatedAt === lastKnownUpdatedAt) {
      console.log('Ignoring realtime update - same timestamp');
      return;
    }
    
    console.log('Applying remote update from another client');
    lastKnownUpdatedAt = remoteUpdatedAt;
    
    // Apply the remote data
    isApplyingRemoteUpdate = true;
    try {
      applyParsedData(newData.data);
      localStorage.setItem('twinsTracker', JSON.stringify(data));
      
      // Refresh the UI
      updateDisplay();
      checkNotifications();
      
      // Show sync toast
      showSyncToast('Synced from another device');
      
      // Play a subtle sound
      playClickSound();
      
      // Restore realtime status after applying remote update
      updateSyncStatus('realtime', `Realtime sync - updated ${new Date().toLocaleTimeString()}`);
    } finally {
      isApplyingRemoteUpdate = false;
    }
  });
  
  if (channel) {
    console.log('Realtime sync enabled');
    updateSyncStatus('realtime', 'Realtime sync active - changes sync instantly');
  }
}

// Sync status management
type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'realtime';

function updateSyncStatus(status: SyncStatus, title?: string) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  
  // Remove all status classes
  el.classList.remove('synced', 'syncing', 'offline', 'error', 'realtime');
  el.classList.add(status);
  
  // Update title/tooltip
  const titles: Record<SyncStatus, string> = {
    synced: 'Synced to cloud',
    syncing: 'Syncing...',
    offline: 'Local only (no cloud)',
    error: 'Sync error',
    realtime: 'Realtime sync active'
  };
  el.title = title || titles[status];
}

function saveData() {
  // Always save to localStorage immediately for offline access
  localStorage.setItem('twinsTracker', JSON.stringify(data));
  
  // Don't save to cloud if we're applying a remote update (prevents loops)
  if (isApplyingRemoteUpdate) {
    console.log('Skipping cloud save - applying remote update');
    return;
  }
  
  // Skip Supabase if not configured
  if (!supabase) {
    updateSyncStatus('offline');
    return;
  }
  
  // Show syncing status
  updateSyncStatus('syncing');
  
  // Debounce Supabase saves to avoid too many requests
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  
  saveTimeout = window.setTimeout(async () => {
    try {
      const now = new Date().toISOString();
      lastSaveTimestamp = Date.now(); // Track when we saved
      lastKnownUpdatedAt = now; // Track the timestamp we're saving
      
      const { error } = await supabase
        .from('tracker_data')
        .upsert({
          device_id: deviceId,
          data: data,
          updated_at: now
        }, {
          onConflict: 'device_id'
        });
      
      if (error) {
        console.error('Error saving to Supabase:', error);
        updateSyncStatus('error', `Sync error: ${error.message}`);
      } else {
        console.log('Data synced to cloud');
        // Restore realtime status after successful save
        updateSyncStatus('realtime', 'Realtime sync active - changes sync instantly');
      }
    } catch (e) {
      console.error('Error saving to Supabase:', e);
      updateSyncStatus('error', 'Sync failed');
    }
  }, SAVE_DEBOUNCE_MS);
}

function checkNewDay() {
  const today = new Date().toDateString();
  if (data.today !== today) {
    // Archive old logs if they exist and have any data
    if (data.today && hasAnyData(data.logs)) {
      if (!data.historicalLogs) data.historicalLogs = {};
      data.historicalLogs[data.today] = JSON.parse(JSON.stringify(data.logs));
      
      // Keep only last 30 days of history
      const dates = Object.keys(data.historicalLogs).sort((a, b) => 
        new Date(b).getTime() - new Date(a).getTime()
      );
      if (dates.length > 30) {
        dates.slice(30).forEach(d => delete data.historicalLogs[d]);
      }
    }
    
    data.today = today;
    data.logs = [
      { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} },
      { feeds: [], diapers: [], meds: [], medsDone: {}, feedAmounts: {} }
    ];
    
    // Reset viewing date to today
    viewingDate = new Date();
    
    // Update the displayed date in the UI
    updateDate();
    
    saveData();
  }
}

function hasAnyData(logs: DayLog[]): boolean {
  return logs.some(log => 
    log.feeds.length > 0 || 
    log.diapers.length > 0 || 
    log.meds.length > 0 || 
    Object.keys(log.medsDone).length > 0
  );
}

function updateDate() {
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const dateStr = viewingDate.toLocaleDateString('en-US', options);
  const isToday = isViewingToday();
  
  document.querySelectorAll('.date-display').forEach(el => {
    // Create interactive date display with arrows
    const canGoForward = !isToday;
    
    el.innerHTML = `
      <div class="date-nav flex items-center gap-2">
        <button class="date-nav-btn text-gray-500 hover:text-white transition-colors p-1" onclick="navigateDate(-1)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6"/>
          </svg>
        </button>
        <span class="${isToday ? '' : 'text-amber-400 font-semibold'}">${isToday ? dateStr : dateStr}</span>
        <button class="date-nav-btn text-gray-500 hover:text-white transition-colors p-1 ${canGoForward ? '' : 'opacity-30 cursor-not-allowed'}" 
                onclick="navigateDate(1)" ${canGoForward ? '' : 'disabled'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>
      </div>
    `;
    
    // Add "Today" pill when viewing past
    if (!isToday) {
      const pill = document.createElement('button');
      pill.className = 'ml-2 text-[10px] bg-amber-500 text-black px-2 py-0.5 rounded-full font-semibold hover:bg-amber-400 transition-colors';
      pill.textContent = 'Today';
      pill.onclick = () => {
        viewingDate = new Date();
        updateDate();
        updateDisplay();
        triggerHaptic();
      };
      el.querySelector('.date-nav')?.appendChild(pill);
    }
  });
}

// ===== SOUND & HAPTICS =====
function loadSoundPreference() {
  // Sound is always on
  soundEnabled = true;
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
}

function playNotificationSound() {
  if (!soundEnabled || !audioContext) return;
  
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const now = audioContext.currentTime;
  
  const osc1 = audioContext.createOscillator();
  const gain1 = audioContext.createGain();
  osc1.connect(gain1);
  gain1.connect(audioContext.destination);
  osc1.frequency.value = 587.33;
  osc1.type = 'sine';
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
  osc1.start(now);
  osc1.stop(now + 0.3);

  const osc2 = audioContext.createOscillator();
  const gain2 = audioContext.createGain();
  osc2.connect(gain2);
  gain2.connect(audioContext.destination);
  osc2.frequency.value = 880;
  osc2.type = 'sine';
  gain2.gain.setValueAtTime(0.3, now + 0.15);
  gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.5);
}

function playClickSound() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  const now = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.frequency.value = 1200;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
  osc.start(now);
  osc.stop(now + 0.05);
}

function triggerHaptic() {
  if ('vibrate' in navigator) {
    navigator.vibrate(10);
  }
}

// ===== NOTIFICATIONS =====
interface UrgentItem {
  id: string;
  child: string;
  name: string;
  type: string;
  text: string;
}

function getUrgentItems(): UrgentItem[] {
  const urgentItems: UrgentItem[] = [];
  
  for (let i = 0; i < 2; i++) {
    const childName = data.children[i].name;
    
    for (const med of data.children[i].medications) {
      const urgency = getMedUrgency(med, i);
      if (urgency.status === 'urgent') {
        urgentItems.push({
          id: `med-${i}-${med.id}`,
          child: childName,
          name: med.name,
          type: 'med',
          text: urgency.text
        });
      }
    }
  }
  
  return urgentItems;
}

function checkOverdueBeep() {
  // Only beep if sound is enabled
  if (!soundEnabled) return;
  
  // Check if any items are overdue and not dismissed
  const urgentItems = getUrgentItems();
  for (let i = 0; i < 2; i++) {
    if (dismissedTooltips.has(i)) continue;
    
    const childName = data.children[i].name;
    const hasOverdue = urgentItems.some(item => 
      item.child === childName && item.text.includes('late')
    );
    
    if (hasOverdue) {
      playNotificationSound();
      return; // Only beep once even if multiple children have overdue items
    }
  }
}

function checkNotifications() {
  const urgentItems = getUrgentItems();
  
  for (let i = 0; i < 2; i++) {
    const panel = document.querySelectorAll('.child-panel')[i];
    const hasUrgent = urgentItems.some(item => item.child === data.children[i].name);
    panel?.classList.toggle('has-urgent', hasUrgent);
  }
  
  if (urgentItems.length === 0) {
    hideNotification();
    notifiedItems.clear();
    return;
  }
  
  const newUrgentItems = urgentItems.filter(item => !notifiedItems.has(item.id));
  
  if (newUrgentItems.length > 0) {
    playNotificationSound();
    newUrgentItems.forEach(item => notifiedItems.add(item.id));
  }
  
  if (!notificationDismissed) {
    showNotification(urgentItems);
  }
}

// Track dismissed tooltips per child
let dismissedTooltips: Set<number> = new Set();

function showNotification(items: UrgentItem[]) {
  // Group items by child
  for (let i = 0; i < 2; i++) {
    const childName = data.children[i]?.name;
    if (!childName) {
      document.getElementById(`urgent-tooltip-${i}`)?.classList.remove('active');
      continue;
    }
    
    const childItems = items.filter(item => item.child === childName);
    const tooltip = document.getElementById(`urgent-tooltip-${i}`);
    const tooltipText = document.getElementById(`tooltip-text-${i}`);
    
    // Only show tooltip if there are urgent items for this child
    if (childItems.length > 0 && !dismissedTooltips.has(i)) {
      const overdueItems = childItems.filter(item => item.text.includes('late'));
      const isOverdue = overdueItems.length > 0;
      
      // Build tooltip text
      let text = '';
      if (isOverdue) {
        text = overdueItems.length === 1 
          ? `${overdueItems[0].name} ${overdueItems[0].text}`
          : `${overdueItems.length} meds overdue!`;
        tooltip?.classList.remove('warning');
      } else {
        text = childItems.length === 1
          ? `${childItems[0].name} due now`
          : `${childItems.length} meds due now`;
        tooltip?.classList.add('warning');
      }
      
      if (tooltipText) tooltipText.textContent = text;
      tooltip?.classList.add('active');
    } else {
      // Hide tooltip when no urgent items
      if (tooltipText) tooltipText.textContent = '';
      tooltip?.classList.remove('active');
    }
  }
}

function hideNotification() {
  for (let i = 0; i < 2; i++) {
    document.getElementById(`urgent-tooltip-${i}`)?.classList.remove('active');
  }
  dismissedTooltips.clear();
  notificationDismissed = false;
}

function dismissNotification() {
  // Legacy function - kept for compatibility
  notificationDismissed = true;
  for (let i = 0; i < 2; i++) {
    dismissedTooltips.add(i);
    document.getElementById(`urgent-tooltip-${i}`)?.classList.remove('active');
  }
  
  setTimeout(() => {
    notificationDismissed = false;
    dismissedTooltips.clear();
    checkNotifications();
  }, 5 * 60 * 1000);
}

function dismissChildTooltip(childIndex: number) {
  dismissedTooltips.add(childIndex);
  document.getElementById(`urgent-tooltip-${childIndex}`)?.classList.remove('active');
  
  // Reset after 5 minutes
  setTimeout(() => {
    dismissedTooltips.delete(childIndex);
    checkNotifications();
  }, 5 * 60 * 1000);
}

function addOverdueMed(childIndex: number) {
  const child = data.children[childIndex];
  const log = data.logs[childIndex];
  
  // Ensure medsDone is initialized
  if (!log.medsDone) {
    log.medsDone = {};
  }
  
  // Find the first overdue medication
  for (const med of child.medications) {
    const urgency = getMedUrgency(med, childIndex);
    if (urgency.text.includes('late') && urgency.nextDose) {
      // Mark this dose as given
      const doseIndex = urgency.nextDose.index;
      if (!log.medsDone[med.id]) {
        log.medsDone[med.id] = [];
      }
      if (!log.medsDone[med.id].includes(doseIndex)) {
        log.medsDone[med.id].push(doseIndex);
        
        // Log the actual time given
        if (!log.meds) log.meds = [];
        log.meds.push({
          id: med.id,
          name: med.name,
          time: new Date().toISOString(),
          doseIndex
        });
        
        saveData();
        updateDisplay();
        checkNotifications();
        return;
      }
    }
  }
}

// ===== FEEDS =====
let feedAmounts = [120, 120]; // Current feed amounts for each child

function logFeed(childIndex: number) {
  // Only allow logging on today
  if (!isViewingToday()) return;
  
  const amount = feedAmounts[childIndex];
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const text = `🍼 Feed ${amount}mL`;
  
  data.logs[childIndex].feeds.push({ text, time, id: Date.now(), timestamp: Date.now() });
  saveData();
  updateDisplay();
  
  // Sync to Google Calendar
  syncToGoogleCalendar({
    summary: `Feed ${amount}mL`,
    description: `Formula feeding: ${amount}mL`,
    startTime: now,
    childName: data.children[childIndex].name,
    eventType: 'feed'
  });
  
  playClickSound();
  triggerHaptic();
}

function adjustFeedAmount(childIndex: number, delta: number) {
  const current = feedAmounts[childIndex];
  const newAmount = Math.max(0, Math.min(500, current + delta));
  
  if (newAmount !== current) {
    feedAmounts[childIndex] = newAmount;
    
    const amountEl = document.getElementById(`feed-amount-${childIndex}`);
    if (amountEl) amountEl.textContent = `${newAmount}`;
    
    playClickSound();
    triggerHaptic();
  }
}

function setupFeedControls() {
  for (let i = 0; i < 2; i++) {
    const feedControl = document.getElementById(`feed-control-${i}`);
    const swipeArea = document.getElementById(`feed-swipe-${i}`);
    if (!feedControl || !swipeArea) continue;
    
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let isDragging = false;
    let hasMoved = false;
    let accumulatedDelta = 0;
    const SWIPE_THRESHOLD = 15; // pixels per 10mL increment
    const VERTICAL_THRESHOLD = 30; // max vertical movement
    
    // Touch events for swipe
    feedControl.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      currentX = startX;
      isDragging = true;
      hasMoved = false;
      accumulatedDelta = 0;
      feedControl.classList.remove('swiping-left', 'swiping-right');
    }, { passive: true });
    
    feedControl.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      
      const touch = e.touches[0];
      const deltaY = Math.abs(touch.clientY - startY);
      
      // Cancel if moving too much vertically
      if (deltaY > VERTICAL_THRESHOLD) {
        isDragging = false;
        feedControl.classList.remove('swiping-left', 'swiping-right');
        return;
      }
      
      currentX = touch.clientX;
      const deltaX = currentX - startX;
      
      // Visual feedback
      if (deltaX < -10) {
        feedControl.classList.add('swiping-left');
        feedControl.classList.remove('swiping-right');
      } else if (deltaX > 10) {
        feedControl.classList.add('swiping-right');
        feedControl.classList.remove('swiping-left');
      } else {
        feedControl.classList.remove('swiping-left', 'swiping-right');
      }
      
      // Calculate how many increments
      const increments = Math.floor(Math.abs(deltaX) / SWIPE_THRESHOLD);
      const newDelta = increments * 10 * (deltaX > 0 ? 1 : -1);
      
      if (newDelta !== accumulatedDelta) {
        const diff = newDelta - accumulatedDelta;
        if (diff !== 0) {
          adjustFeedAmount(i, diff);
          hasMoved = true;
        }
        accumulatedDelta = newDelta;
      }
    }, { passive: true });
    
    feedControl.addEventListener('touchend', () => {
      isDragging = false;
      feedControl.classList.remove('swiping-left', 'swiping-right');
      
      // If no significant swipe, treat as tap to log
      if (!hasMoved) {
        logFeed(i);
      }
    });
    
    // Mouse events for desktop
    feedControl.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      isDragging = true;
      hasMoved = false;
      accumulatedDelta = 0;
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      currentX = e.clientX;
      const deltaX = currentX - startX;
      
      // Visual feedback
      if (deltaX < -10) {
        feedControl.classList.add('swiping-left');
        feedControl.classList.remove('swiping-right');
      } else if (deltaX > 10) {
        feedControl.classList.add('swiping-right');
        feedControl.classList.remove('swiping-left');
      } else {
        feedControl.classList.remove('swiping-left', 'swiping-right');
      }
      
      // Calculate increments
      const increments = Math.floor(Math.abs(deltaX) / SWIPE_THRESHOLD);
      const newDelta = increments * 10 * (deltaX > 0 ? 1 : -1);
      
      if (newDelta !== accumulatedDelta) {
        const diff = newDelta - accumulatedDelta;
        if (diff !== 0) {
          adjustFeedAmount(i, diff);
          hasMoved = true;
        }
        accumulatedDelta = newDelta;
      }
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        feedControl.classList.remove('swiping-left', 'swiping-right');
        
        if (!hasMoved) {
          logFeed(i);
        }
      }
    });
    
    // Mouse wheel support
    feedControl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 10 : -10;
      adjustFeedAmount(i, delta);
    }, { passive: false });
  }
}

function updateFeedButton(childIndex: number, viewingToday: boolean) {
  const feedControl = document.getElementById(`feed-control-${childIndex}`);
  if (!feedControl) return;
  
  if (viewingToday) {
    feedControl.classList.remove('opacity-50', 'pointer-events-none');
  } else {
    feedControl.classList.add('opacity-50', 'pointer-events-none');
  }
}

// ===== MEDICATIONS =====
function getMedUrgency(med: Medication, childIndex: number): Urgency {
  const now = new Date();
  const doneToday = data.logs[childIndex].medsDone[med.id] || [];
  
  let nextDue: any = null;
  let allDone = true;
  
  for (let i = 0; i < med.doseTimes.length; i++) {
    if (!doneToday.includes(i)) {
      allDone = false;
      const [hour, min] = med.doseTimes[i].split(':').map(Number);
      const doseDate = new Date();
      doseDate.setHours(hour, min, 0, 0);
      const diffMins = (doseDate.getTime() - now.getTime()) / 60000;
      
      if (nextDue === null || diffMins < nextDue.diffMins) {
        nextDue = { hour, min, index: i, diffMins };
      }
    }
  }

  if (allDone) return { status: 'done', text: 'Done', nextDose: null };
  
  // Format the next dose time for display
  const doseHour = nextDue.hour % 12 || 12;
  const doseAmPm = nextDue.hour >= 12 ? 'pm' : 'am';
  const doseTimeStr = `${doseHour}${nextDue.min > 0 ? ':' + String(nextDue.min).padStart(2, '0') : ''}${doseAmPm}`;
  
  if (nextDue.diffMins < -30) {
    const overdueMinutes = Math.abs(nextDue.diffMins);
    let overdueText: string;
    if (overdueMinutes < 60) {
      overdueText = `${Math.round(overdueMinutes)}m late (${doseTimeStr})`;
    } else {
      const hours = Math.floor(overdueMinutes / 60);
      const mins = Math.round(overdueMinutes % 60);
      overdueText = mins > 0 ? `${hours}h ${mins}m late (${doseTimeStr})` : `${hours}h late (${doseTimeStr})`;
    }
    return { status: 'urgent', text: overdueText, nextDose: nextDue };
  }
  if (nextDue.diffMins < 30) return { status: 'urgent', text: 'Now', nextDose: nextDue };
  if (nextDue.diffMins < 120) return { status: 'soon', text: `${Math.round(nextDue.diffMins)}m (${doseTimeStr})`, nextDose: nextDue };
  return { status: 'normal', text: `${Math.floor(nextDue.diffMins / 60)}h (${doseTimeStr})`, nextDose: nextDue };
}

(window as any).giveMed = function(childIndex: number, medId: string, doseIndex: number) {
  // Only allow logging on today
  if (!isViewingToday()) return;
  
  if (!data.logs[childIndex].medsDone[medId]) {
    data.logs[childIndex].medsDone[medId] = [];
  }
  if (!data.logs[childIndex].medsDone[medId].includes(doseIndex)) {
    data.logs[childIndex].medsDone[medId].push(doseIndex);
    notifiedItems.delete(`med-${childIndex}-${medId}`);
    
    // Log to timeline
    const med = data.children[childIndex].medications.find(m => m.id === medId);
    if (med) {
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      data.logs[childIndex].meds.push({
        medId,
        medName: med.name,
        doseIndex,
        time,
        timestamp: Date.now()
      });
      
      // Sync to Google Calendar
      syncToGoogleCalendar({
        summary: med.name,
        description: `Medication: ${med.name} (Dose ${doseIndex + 1}/${med.doseTimes.length})`,
        startTime: now,
        childName: data.children[childIndex].name,
        eventType: 'med'
      });
    }
    
    saveData();
    updateDisplay();
    checkNotifications();
    playClickSound();
    triggerHaptic();
  }
};

function renderMeds(childIndex: number) {
  const container = document.getElementById(`meds-grid-${childIndex}`);
  if (!container) return;
  
  const meds = data.children[childIndex].medications;
  const viewingToday = isViewingToday();
  const logs = getViewingLogs();
  const isEditMode = editMode[childIndex];
  
  // Maintain edit mode class
  container.classList.toggle('edit-mode', isEditMode);

  if (meds.length === 0) {
    editMode[childIndex] = false;
    container.classList.remove('edit-mode');
    container.innerHTML = viewingToday ? `
      <button class="med-btn add-new col-span-3" data-action="open-med-settings" data-child="${childIndex}">
        <span class="med-name text-xl">+</span>
        <span class="med-status">Add medication</span>
      </button>
    ` : '<div class="col-span-3 text-gray-500 text-xs text-center py-4">No medications configured</div>';
    return;
  }

  if (viewingToday) {
    const sorted = meds.map(med => ({
      med,
      urgency: getMedUrgency(med, childIndex)
    })).sort((a, b) => {
      const order = { urgent: 0, soon: 1, normal: 2, done: 3 };
      return order[a.urgency.status] - order[b.urgency.status];
    });

    container.innerHTML = sorted.map(({ med, urgency }) => {
      const doneCount = (logs[childIndex].medsDone[med.id] || []).length;
      
      // In edit mode, show X button and don't allow giving meds
      const clickHandler = isEditMode 
        ? '' 
        : `onclick="giveMed(${childIndex}, '${med.id}', ${urgency.nextDose?.index ?? 0})"`;
      
      const deleteBtn = `
        <button class="med-delete-btn" onclick="event.stopPropagation(); event.preventDefault(); deleteMedFromGrid(${childIndex}, '${med.id}')">✕</button>
      `;
      
      const isDisabled = urgency.status === 'done' && !isEditMode;
      
      return `
        <div class="med-btn ${urgency.status} ${isDisabled ? 'pointer-events-none' : ''}" 
             ${clickHandler}
             data-med-id="${med.id}"
             data-child="${childIndex}">
          ${deleteBtn}
          <span class="med-name">${med.name}</span>
          <span class="med-status">${urgency.text}</span>
          <span class="med-time">${doneCount}/${med.doseTimes.length}</span>
        </div>
      `;
    }).join('');
    
    // Setup long press to enter edit mode on med buttons
    setupMedLongPress(childIndex);
  } else {
    // Read-only view for past dates - show what was completed
    container.innerHTML = meds.map(med => {
      const doneCount = (logs[childIndex].medsDone[med.id] || []).length;
      const totalDoses = med.doseTimes.length;
      const allDone = doneCount >= totalDoses;
      
      return `
        <div class="med-btn ${allDone ? 'done' : 'bg-card opacity-60'}" style="cursor: default;">
          <span class="med-name">${med.name}</span>
          <span class="med-status">${allDone ? 'Done' : `${doneCount}/${totalDoses}`}</span>
        </div>
      `;
    }).join('');
  }
}

// Setup long press on medication buttons to enter edit mode
function setupMedLongPress(childIndex: number) {
  const container = document.getElementById(`meds-grid-${childIndex}`);
  if (!container) return;
  
  const buttons = container.querySelectorAll('.med-btn:not(.add-new)');
  
  buttons.forEach(btn => {
    let pressTimer: number | null = null;
    const LONG_PRESS_MS = 500;
    
    const startPress = (e: Event) => {
      // Don't start long press if already in edit mode
      if (editMode[childIndex]) return;
      
      pressTimer = window.setTimeout(() => {
        (window as any).toggleMedEditMode(childIndex);
      }, LONG_PRESS_MS);
    };
    
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };
    
    btn.addEventListener('touchstart', startPress, { passive: true });
    btn.addEventListener('touchend', cancelPress);
    btn.addEventListener('touchmove', cancelPress);
    btn.addEventListener('touchcancel', cancelPress);
    
    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('mouseup', cancelPress);
    btn.addEventListener('mouseleave', cancelPress);
  });
}

// ===== DIAPERS =====
function logDiaper(childIndex: number, type: 'pee' | 'poop') {
  // Only allow logging on today
  if (!isViewingToday()) return;
  
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  data.logs[childIndex].diapers.push({ type, time, timestamp: Date.now() });
  saveData();
  updateDiaperCount(childIndex);
  updateDisplay();
  
  // Sync to Google Calendar
  const emoji = type === 'pee' ? '💧' : '💩';
  syncToGoogleCalendar({
    summary: `${emoji} Diaper (${type})`,
    description: `Diaper change: ${type}`,
    startTime: now,
    childName: data.children[childIndex].name,
    eventType: 'diaper'
  });
  
  playClickSound();
  triggerHaptic();
}

function updateDiaperCount(childIndex: number) {
  const logs = getViewingLogs();
  const diapers = logs[childIndex].diapers;
  const peeCount = diapers.filter(d => d.type === 'pee').length;
  const poopCount = diapers.filter(d => d.type === 'poop').length;
  
  const peeEl = document.getElementById(`pee-count-${childIndex}`);
  const poopEl = document.getElementById(`poop-count-${childIndex}`);
  if (peeEl) peeEl.textContent = String(peeCount);
  if (poopEl) poopEl.textContent = String(poopCount);
}

// ===== MODALS =====
function selectDoseCount(doses: number) {
  selectedDoseCount = doses;
  
  document.querySelectorAll('.dose-count-btn').forEach(btn => {
    const btnDoses = parseInt(btn.getAttribute('data-doses') || '1');
    btn.classList.toggle('selected', btnDoses === doses);
  });
  
  renderDoseSchedule(doses);
}

function renderDoseSchedule(doses: number) {
  const container = document.getElementById('dose-schedule');
  if (!container) return;
  
  const times = generateDefaultTimes(doses);
  
  container.innerHTML = `
    <label class="text-xs text-gray-400 mb-2 block">Dose Schedule</label>
    <div class="grid grid-cols-2 gap-2">
      ${times.map((time, i) => `
        <div class="flex items-center gap-2 bg-card rounded-lg p-2">
          <span class="text-xs text-gray-400 w-12">Dose ${i + 1}</span>
          <input 
            type="time" 
            class="dose-time-input flex-1 px-2 py-1 border-none rounded bg-panel text-white text-sm"
            value="${time}"
            data-dose-index="${i}"
          />
        </div>
      `).join('')}
    </div>
  `;
}

function openMedSettings(childIndex: number) {
  currentChild = childIndex;
  document.getElementById('med-modal')?.classList.add('active');
  document.body.classList.add('modal-open');
  (document.getElementById('med-name') as HTMLInputElement).value = '';
  
  selectedDoseCount = 1;
  document.querySelectorAll('.dose-count-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.getAttribute('data-doses') === '1');
  });
  renderDoseSchedule(1);
  
  renderMedList();
}

function renderMedList() {
  const container = document.getElementById('med-list');
  if (!container) return;
  
  const meds = data.children[currentChild].medications;

  if (meds.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = meds.map(med => `
    <div class="item-list-item">
      <div class="info">
        <div class="name">${med.name}</div>
        <div class="details">${med.doseTimes.join(', ')}</div>
      </div>
      <button onclick="removeMed('${med.id}')">Remove</button>
    </div>
  `).join('');
}

function saveMedication() {
  const name = (document.getElementById('med-name') as HTMLInputElement).value.trim();
  if (!name) return;

  const timeInputs = document.querySelectorAll('.dose-time-input') as NodeListOf<HTMLInputElement>;
  const doseTimes: string[] = [];
  timeInputs.forEach(input => {
    doseTimes.push(input.value);
  });

  data.children[currentChild].medications.push({
    id: Date.now().toString(),
    name,
    dosesPerDay: selectedDoseCount,
    doseTimes
  });

  (document.getElementById('med-name') as HTMLInputElement).value = '';
  saveData();
  renderMedList();
  updateDisplay();
}

(window as any).removeMed = function(medId: string) {
  data.children[currentChild].medications = data.children[currentChild].medications.filter(m => m.id !== medId);
  saveData();
  renderMedList();
  updateDisplay();
};

// Toggle edit mode for medication grid
(window as any).toggleMedEditMode = function(childIndex: number) {
  editMode[childIndex] = !editMode[childIndex];
  const grid = document.getElementById(`meds-grid-${childIndex}`);
  grid?.classList.toggle('edit-mode', editMode[childIndex]);
  
  // Update the + button to show "Done" when in edit mode (need to search for either action)
  const headerBtn = document.querySelector(`[data-action="open-med-settings"][data-child="${childIndex}"]`) 
                 || document.querySelector(`[data-action="exit-edit-mode"][data-child="${childIndex}"]`);
  if (headerBtn) {
    if (editMode[childIndex]) {
      headerBtn.textContent = 'Done';
      headerBtn.classList.add('edit-done-btn');
      headerBtn.setAttribute('data-action', 'exit-edit-mode');
    } else {
      headerBtn.textContent = '+';
      headerBtn.classList.remove('edit-done-btn');
      headerBtn.setAttribute('data-action', 'open-med-settings');
    }
  }
  
  playClickSound();
  triggerHaptic();
  renderMeds(childIndex);
};

// Delete medication from edit mode
(window as any).deleteMedFromGrid = function(childIndex: number, medId: string) {
  // Confirm deletion with haptic
  triggerHaptic();
  
  data.children[childIndex].medications = data.children[childIndex].medications.filter(m => m.id !== medId);
  saveData();
  
  // Exit edit mode if no more meds
  if (data.children[childIndex].medications.length === 0) {
    editMode[childIndex] = false;
    const grid = document.getElementById(`meds-grid-${childIndex}`);
    grid?.classList.remove('edit-mode');
    
    const headerBtn = document.querySelector(`[data-action="exit-edit-mode"][data-child="${childIndex}"]`);
    if (headerBtn) {
      headerBtn.textContent = '+';
      headerBtn.classList.remove('edit-done-btn');
      headerBtn.setAttribute('data-action', 'open-med-settings');
    }
  }
  
  playClickSound();
  updateDisplay();
};

// Toggle edit mode for planner events
function toggleEventEditMode(childIndex: number) {
  eventEditMode[childIndex] = !eventEditMode[childIndex];
  const container = document.getElementById(`planner-content-${childIndex}`);
  container?.classList.toggle('event-edit-mode', eventEditMode[childIndex]);
  
  playClickSound();
  triggerHaptic();
  
  // Re-render to show/hide delete buttons
  renderPlanner(childIndex);
}

(window as any).toggleEventEditMode = toggleEventEditMode;

// Exit event edit mode (called from Done button)
(window as any).exitEventEditMode = function(childIndex: number) {
  if (eventEditMode[childIndex]) {
    toggleEventEditMode(childIndex);
  }
};

// Delete event from planner
(window as any).deleteEventFromPlanner = function(childIndex: number, eventType: string, timestamp: number) {
  triggerHaptic();
  
  const logs = getViewingLogs();
  const log = logs[childIndex];
  
  if (eventType === 'feed') {
    log.feeds = log.feeds.filter((f: Feed) => f.timestamp !== timestamp);
  } else if (eventType === 'pee' || eventType === 'poop') {
    log.diapers = log.diapers.filter((d: DiaperLog) => !(d.type === eventType && d.timestamp === timestamp));
  } else if (eventType === 'med') {
    // Find the med entry by timestamp
    const medEntry = log.meds.find((m: MedLog) => m.timestamp === timestamp);
    if (medEntry) {
      // Remove from meds array
      log.meds = log.meds.filter((m: MedLog) => m.timestamp !== timestamp);
      
      // Also remove the dose index from medsDone
      if (log.medsDone[medEntry.medId]) {
        log.medsDone[medEntry.medId] = log.medsDone[medEntry.medId].filter(
          (idx: number) => idx !== medEntry.doseIndex
        );
        if (log.medsDone[medEntry.medId].length === 0) {
          delete log.medsDone[medEntry.medId];
        }
      }
    }
  }
  
  saveData();
  playClickSound();
  updateDisplay();
};

function editChildName(childIndex: number) {
  currentChild = childIndex;
  (document.getElementById('name-input') as HTMLInputElement).value = data.children[childIndex].name;
  document.getElementById('name-modal')?.classList.add('active');
  document.body.classList.add('modal-open');
}

function saveName() {
  const name = (document.getElementById('name-input') as HTMLInputElement).value.trim();
  if (name) {
    data.children[currentChild].name = name;
    saveData();
    updateDisplay();
  }
  closeModal();
}

function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
  document.body.classList.remove('modal-open');
}

// ===== UPDATE DISPLAY =====
function updateDisplay() {
  checkNewDay();
  
  const viewingToday = isViewingToday();
  
  // Update names using the data-child-name attribute, not DOM order
  document.querySelectorAll('[data-child-name]').forEach(el => {
    const childIndex = parseInt(el.getAttribute('data-child-name') || '0');
    el.textContent = data.children[childIndex].name;
  });
  
  for (let i = 0; i < 2; i++) {
    renderPlanner(i);
    renderMeds(i);
    updateDiaperCount(i);
    updateDiaperButtons(i, viewingToday);
    updateFeedButton(i, viewingToday);
  }
  
  // Update container styling for past viewing
  const container = document.querySelector('.container');
  container?.classList.toggle('viewing-past', !viewingToday);
}

function updateDiaperButtons(childIndex: number, enabled: boolean) {
  const peeBtn = document.querySelector(`[data-action="log-diaper"][data-child="${childIndex}"][data-type="pee"]`) as HTMLButtonElement;
  const poopBtn = document.querySelector(`[data-action="log-diaper"][data-child="${childIndex}"][data-type="poop"]`) as HTMLButtonElement;
  
  if (peeBtn) {
    peeBtn.disabled = !enabled;
    peeBtn.classList.toggle('opacity-50', !enabled);
    peeBtn.classList.toggle('cursor-not-allowed', !enabled);
  }
  if (poopBtn) {
    poopBtn.disabled = !enabled;
    poopBtn.classList.toggle('opacity-50', !enabled);
    poopBtn.classList.toggle('cursor-not-allowed', !enabled);
  }
}
