import { BOOKING_TRIGGER } from './shop';

/** Production API (deployed backend). Override with ?api= or VITE_API_BASE in .env.production. */
const DEFAULT_PRODUCTION_API_ORIGIN = 'https://barbar-shop-booking-chatbot-tspg.vercel.app';

export function getApiBase() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('api');
    if (fromQuery) return fromQuery.replace(/\/$/, '');
  } catch {
    // ignore
  }
  if (import.meta.env.DEV) {
    return '';
  }
  const envBase = import.meta.env.VITE_API_BASE;
  if (envBase && String(envBase).trim()) {
    return String(envBase).trim().replace(/\/$/, '');
  }
  try {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      return 'http://localhost:3000';
    }
  } catch {
    return 'http://localhost:3000';
  }
  return DEFAULT_PRODUCTION_API_ORIGIN.replace(/\/$/, '');
}

export function clientDeviceHint() {
  try {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches
      ? 'mobile'
      : 'desktop';
  } catch {
    return null;
  }
}

export function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function stripBookingTrigger(text, trigger = BOOKING_TRIGGER) {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== trigger)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export function todayISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function normalizeBookingIntent(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return trimmed;
  const t = trimmed.toLowerCase();
  const stripped = t
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (/book online|book now|\breserve\b/.test(t)) {
    return "I'd like to book an appointment";
  }
  if (
    /^book an appointment$/.test(stripped) ||
    /^book appointment$/.test(stripped) ||
    /^book a slot$/.test(stripped)
  ) {
    return "I'd like to book an appointment";
  }
  return trimmed;
}

/** Guess name/phone from last user message bubbles (plain text lines). */
export function guessPrefillFromChat(userTexts) {
  if (!userTexts.length) return { name: '', phone: '' };
  const last = userTexts[userTexts.length - 1];
  const prev = userTexts[userTexts.length - 2] || '';
  const digits = last.replace(/\D/g, '');
  if (digits.length >= 9) return { name: prev, phone: last };
  return { name: '', phone: '' };
}
