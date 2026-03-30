// @ts-nocheck
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         Barbería Cullera — reception chat backend               ║
 * ║  Node.js + Express + OpenAI GPT-4o-mini                        ║
 * ║                                                                  ║
 * ║  Features:                                                       ║
 * ║  • 20-message rolling conversation memory per session           ║
 * ║  • Bookings saved to Neon Postgres (POST /api/book)               ║
 * ║  • Website-only booking flow (no WhatsApp redirects)            ║
 * ║  • Session management (in-memory, per visitor)                  ║
 * ║  • Rate limiting to protect OpenAI quota                        ║
 * ║  • Graceful error handling & fallback messages                  ║
 * ║                                                                  ║
 * ║  Deploy: Vercel / Railway / Render / any Node host              ║
 * ║  npm install @neondatabase/serverless express cors dotenv openai uuid ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const fs           = require('fs');
const path         = require('path');
const rootDir      = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const OpenAI       = require('openai');
const { neon }     = require('@neondatabase/serverless');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sessions = {};

setInterval(() => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const sid in sessions) {
    if (sessions[sid].createdAt < twoHoursAgo) {
      delete sessions[sid];
    }
  }
}, 30 * 60 * 1000);

let _sql = null;
function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url || !String(url).trim()) return null;
  if (!_sql) _sql = neon(url.trim());
  return _sql;
}

/** Same admin email everywhere (login, reset); trims DB + request quirks. */
function normalizeAdminEmail(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  try {
    s = s.normalize('NFKC');
  } catch (_) { /* ignore */ }
  return s.replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/** IANA timezone for “today” / calendar metrics (Barbería Cullera). Override with SHOP_TIMEZONE in .env */
function shopTimezone() {
  const t = String(process.env.SHOP_TIMEZONE || 'Europe/Madrid').trim();
  return /^[A-Za-z0-9_\/+-]+$/.test(t) ? t : 'Europe/Madrid';
}

function csvEscapeCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Match booking `service` string to menu price (€). */
const SERVICE_PRICE_EUR = {
  'Haircut':                                      16,
  'Haircut + Beard Trim':                         21,
  'Beard Grooming':                               11,
  'Haircut + Beard + Steam Shave + Head Massage': 30,
  'Fade':                                         14,
  'Shave + Fade + Beard':                         19,
  'Haircut + Design / Pattern':                   18,
  'Highlights':                                   40,
  'Full Color':                                   60,
};

function estimatePriceEur(serviceName) {
  const s = String(serviceName || '').trim();
  if (!s) return null;
  if (SERVICE_PRICE_EUR[s] != null) return Number(SERVICE_PRICE_EUR[s]);
  const lower = s.toLowerCase();
  for (const [name, price] of Object.entries(SERVICE_PRICE_EUR)) {
    if (lower.includes(name.toLowerCase()) || name.toLowerCase().includes(lower.slice(0, 12))) {
      return Number(price);
    }
  }
  return null;
}

async function touchChatSession(sessionId, meta = {}) {
  const sql = getSql();
  if (!sql || !sessionId) return;
  const ua = meta.userAgent || null;
  const dh = meta.deviceHint || null;
  await sql`
    INSERT INTO chat_sessions (session_id, user_agent, device_hint)
    VALUES (${sessionId}, ${ua}, ${dh})
    ON CONFLICT (session_id) DO UPDATE SET
      last_activity_at = now(),
      user_agent       = COALESCE(EXCLUDED.user_agent, chat_sessions.user_agent),
      device_hint      = COALESCE(EXCLUDED.device_hint, chat_sessions.device_hint)
  `;
}

async function appendChatMessages(sessionId, userText, assistantText) {
  const sql = getSql();
  if (!sql || !sessionId) return;
  const u = String(userText || '').slice(0, 8000);
  const a = String(assistantText || '').slice(0, 8000);
  await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, 'user', ${u})`;
  await sql`INSERT INTO chat_messages (session_id, role, content) VALUES (${sessionId}, 'assistant', ${a})`;
  await sql`
    UPDATE chat_sessions SET
      message_count    = message_count + 2,
      last_activity_at = now(),
      outcome = CASE
        WHEN outcome = 'active' AND message_count + 2 >= 4 THEN 'engaged'
        ELSE outcome
      END
    WHERE session_id = ${sessionId}
  `;
}

/**
 * @param {string} sessionId
 * @param {{ name: string, phone: string, service: string, preferred_date?: string, preferred_time?: string, notes?: string }} lead
 * @param {number} turns
 */
async function saveLeadToDatabase(sessionId, lead, turns) {
  const sql = getSql();
  if (!sql) throw new Error('DATABASE_URL is not set');

  await touchChatSession(sessionId, {});

  const preferredDate =
    lead.preferred_date && String(lead.preferred_date).trim()
      ? String(lead.preferred_date).trim()
      : null;
  const preferredTime = lead.preferred_time && String(lead.preferred_time).trim()
    ? String(lead.preferred_time).trim()
    : null;
  const notes = lead.notes && String(lead.notes).trim() ? String(lead.notes).trim() : null;
  const amount = estimatePriceEur(lead.service);

  await sql`
    INSERT INTO leads (
      session_id, name, phone, service, preferred_date, preferred_time, notes,
      conversation_turns, amount_eur, crm_status, appointment_status
    )
    VALUES (
      ${sessionId},
      ${lead.name},
      ${lead.phone},
      ${lead.service},
      ${preferredDate},
      ${preferredTime},
      ${notes},
      ${turns},
      ${amount},
      'converted',
      'pending'
    )
  `;
  await sql`
    UPDATE chat_sessions
    SET outcome = 'booked', last_activity_at = now()
    WHERE session_id = ${sessionId}
  `;
  console.log(`✅  Lead saved (DB) → ${lead.name} | ${lead.phone} | ${lead.service}`);
}

const JWT_SECRET   = String(process.env.JWT_SECRET || '').trim();
const JWT_EXPIRES  = String(process.env.JWT_EXPIRES_IN || '7d');
/** If neither JWT_SECRET nor ADMIN_TOKEN is set, admin routes stay closed unless this is "1" (dev only). */
const ADMIN_ALLOW_OPEN = String(process.env.ADMIN_ALLOW_OPEN || '').trim() === '1';

function adminBearerToken(req) {
  const h = req.headers.authorization;
  if (h && String(h).startsWith('Bearer ')) return String(h).slice(7).trim();
  const q = req.query.token || req.headers['x-admin-token'];
  return q ? String(q).trim() : '';
}

function requireAdmin(req, res, next) {
  const raw        = adminBearerToken(req);
  const staticTok  = String(process.env.ADMIN_TOKEN || '').trim();
  const jwtConfigured = Boolean(JWT_SECRET);

  if (staticTok && raw === staticTok) {
    return next();
  }
  if (jwtConfigured && raw) {
    try {
      const p = jwt.verify(raw, JWT_SECRET);
      if (p && p.typ === 'admin' && p.sub != null) {
        req.adminId = String(p.sub);
        return next();
      }
    } catch (_) { /* fall through */ }
  }
  if (!jwtConfigured && !staticTok) {
    if (ADMIN_ALLOW_OPEN) return next();
    return res.status(503).json({
      error: 'Admin API is locked. Set JWT_SECRET (and use dashboard login) and/or ADMIN_TOKEN in .env. For insecure local tests only, set ADMIN_ALLOW_OPEN=1.',
    });
  }
  return res.status(401).json({ error: 'Unauthorized. Sign in or provide a valid token.' });
}

function hashResetToken(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

const authRateBucket = {};
function checkAuthRateLimit(ip, max = 25, winMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (!authRateBucket[ip]) authRateBucket[ip] = [];
  authRateBucket[ip] = authRateBucket[ip].filter((t) => now - t < winMs);
  if (authRateBucket[ip].length >= max) return false;
  authRateBucket[ip].push(now);
  return true;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatActivityTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** First-of-month UTC keys for the last 12 rolling calendar months (oldest → newest). */
function monthStartsLast12Utc() {
  const now = new Date();
  const keys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

function priorYearSameMonthFirst(isoYmd) {
  const d = new Date(`${isoYmd}T12:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/** Normalize Postgres/Neon date values to YYYY-MM-01 for month maps and heatmap keys. */
function pgDateToYmd(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  const d = new Date(val);
  if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

const BARBER_CONFIG = {
  shopName: "Barbería Cullera",
  location: "Carrer Ateneu Musical, 63a, 46400 Cullera, Valencia, Spain",
  phone:    "617 54 58 37",
};

const BOOKING_TRIGGER_LINE = 'SHOW_BOOKING_FORM';

const SYSTEM_PROMPT = `You are the reception for Barbería Cullera, a premium barbershop in Cullera, Valencia, Spain. You write in clear, warm, natural English — the same tone as a friendly, professional front-desk person who works at the shop. Never describe yourself as a bot, virtual assistant, chatbot, or AI. You are simply helping guests on behalf of the barbershop.

YOUR PRIMARY GOALS IN ORDER:
GOAL 1 — Welcome the visitor warmly and start a real conversation.
GOAL 2 — Find out which service they are interested in.
GOAL 3 — Collect their name, phone number, preferred day, and preferred time.
GOAL 4 — Confirm the booking directly on the website. No WhatsApp. No redirects.
GOAL 5 — Answer any questions about services, prices, hours, and location.

PERSONA RULES:
- Warm, confident, natural English. Like a real receptionist, not a bot.
- Never start with "Certainly!", "Of course!", "Great choice!", "Absolutely!" — robotic.
- Keep replies to 2–4 sentences max. Mobile users. No walls of text.
- Use bullet points ONLY when listing services or hours, never in normal replies.
- Use 1–2 emojis per message max (✂️ 💈 📅 ✅). Do not overuse.
- Mirror the customer's energy — casual for casual, formal for formal.
- Always end with a question or clear next step. Never leave the conversation hanging.

CONVERSATION STAGES:

STAGE 1 — GREETING (first message only):
Deliver a warm, professional opening. Example to adapt:
"Hey there! 👋 Welcome to Barbería Cullera. I'm here at reception — I can sort out an appointment, walk you through prices, or answer anything about the shop. What can I help you with today? ✂️"

STAGE 2 — QUALIFY SERVICE:
Ask which service they want. If unsure, suggest the 3 most popular:
- Haircut — €16
- Fade — €14  
- Haircut + Beard — €21
Ask: "Any of those sound right, or are you after something different?"

STAGE 3 — COLLECT BOOKING DETAILS (one question at a time, in this order):
Step A: Ask for their first name. "What's your name so I can get this booked for you?"
Step B: Ask for their phone number. "And what's the best number to reach you on?"
Step C: Ask for preferred day. "What day works best for you?"
Step D: Ask for preferred time. "And roughly what time were you thinking — morning or afternoon?"
NEVER ask for two pieces of information in the same message. One question per message only.

STAGE 4 — CONFIRM BOOKING ON WEBSITE:
Once you have name, phone, service, and a preferred day/time, say exactly:
"Perfect [Name]! I have everything I need. Let me confirm your booking now — just tap the button below to lock it in. ✅"
Then output this exact trigger on its own line so the frontend can show the booking confirmation button:
SHOW_BOOKING_FORM

STAGE 5 — POST BOOKING:
After booking is submitted, say:
"You're all booked, [Name]! We'll see you [day] for your [service]. If anything changes, give us a call at 617 54 58 37. See you soon! ✂️"

OBJECTION HANDLING:
- "Too expensive" → "I understand — our most affordable options are Beard Grooming at €11 or a Fade starting at €14. Both are done by experienced hands. Want to give one a try?"
- "I'll think about it" → "No rush at all! Just know that Saturday slots fill up fast. I'm here whenever you're ready 😊"
- "Do you need an appointment?" → "We recommend booking ahead, especially on weekends. I can lock one in for you right here in under a minute — want to go ahead?"
- "Where are you?" → "We're at Carrer Ateneu Musical, 63a, 46400 Cullera, Valencia. Easy to find in the centre of town."
- Price comparison or hesitation → Highlight the quality, experience, and premium service. Do not just repeat the price.

SHOP DATA — NEVER INVENT ANYTHING NOT ON THIS LIST:

ADDRESS: Carrer Ateneu Musical, 63a, 46400 Cullera, Valencia, Spain
PHONE: 617 54 58 37

SERVICES AND PRICES:
01. Haircut — €16
02. Haircut + Beard Trim — €21
03. Beard Grooming — €11
04. Haircut + Beard + Steam Shave + Head Massage — €30
05. Fade — €14
06. Shave + Fade + Beard — €19
07. Haircut + Design / Pattern — €18
08. Highlights — €40
09. Full Color — €60

OPENING HOURS:
Monday: Closed
Tuesday: 10:00–13:30 and 15:30–20:00
Wednesday: 10:00–13:30 and 15:30–20:00
Thursday: 10:00–13:30 and 15:30–20:00
Friday: 10:00–13:30 and 15:30–20:00
Saturday: 10:00–15:00
Sunday: Closed
Note: Thursday and Friday hours may vary on public holidays.

ABSOLUTE RULES — NEVER BREAK:
1. Never invent prices, hours, or services not listed above.
2. Never redirect to WhatsApp. All booking happens on this website.
3. Never ask for two pieces of information in the same message.
4. Never say you are software, AI, a chatbot, or built on OpenAI or GPT. If asked how you work: "I'm with the Barbería Cullera team — here to help with bookings and anything about the shop. What do you need?"
5. Never go off-topic. If asked anything unrelated: "I'm best at helping with haircuts and bookings — is there anything about our services I can help with? ✂️"
6. Only output SHOW_BOOKING_FORM after collecting name, phone, service, and preferred time. Never before.
7. Only output SHOW_BOOKING_FORM once per conversation.
8. Always use the customer's name once you have it.
9. Never leave a message without a question or next step at the end.
10. If a customer is rude, stay calm and professional. Redirect politely.`;

function buildSystemPrompt() {
  return SYSTEM_PROMPT;
}

/** Strip SHOW_BOOKING_FORM from text stored in session history (client still receives full reply). */
function stripBookingTriggerForHistory(text) {
  if (!text) return text;
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== BOOKING_TRIGGER_LINE)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Allow any Origin (localhost, file://, Vercel, custom domains). Do not use ALLOWED_ORIGIN to lock down
// unless you also serve the frontend from that exact origin only.
app.use(cors({
  origin:         true,
  methods:        ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'x-admin-token', 'Authorization', 'x-setup-key'],
}));
app.use(express.json({ limit: '64kb' }));

app.post('/api/admin/auth/setup-first-admin', async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL is not set' });
  const expected = String(process.env.ADMIN_SETUP_KEY || '').trim();
  const key = String(req.headers['x-setup-key'] || '').trim();
  if (!expected || key !== expected) {
    return res.status(403).json({ error: 'Missing or invalid x-setup-key (ADMIN_SETUP_KEY in .env).' });
  }
  try {
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM admin_users`;
    if (Number(n) > 0) return res.status(409).json({ error: 'An admin account already exists.' });
    const email = normalizeAdminEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const password_hash = await bcrypt.hash(password, 10);
    await sql`INSERT INTO admin_users (email, password_hash) VALUES (${email}, ${password_hash})`;
    return res.json({ success: true });
  } catch (err) {
    console.error('setup-first-admin:', err);
    return res.status(500).json({ error: 'Could not create admin.' });
  }
});

app.post('/api/admin/auth/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkAuthRateLimit(`login:${ip}`)) {
    return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  }
  if (!JWT_SECRET) {
    return res.status(503).json({ error: 'Server missing JWT_SECRET — cannot issue login tokens.' });
  }
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL is not set' });
  const email = normalizeAdminEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const rows = await sql`
      SELECT id, password_hash FROM admin_users
      WHERE lower(trim(email)) = ${email}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const token = jwt.sign({ typ: 'admin', sub: String(row.id) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    return res.json({ token, tokenType: 'Bearer' });
  } catch (err) {
    console.error('admin login:', err);
    return res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/admin/auth/verify-reset-email', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkAuthRateLimit(`reset:${ip}`)) {
    return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  }
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL is not set' });
  const email = normalizeAdminEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const rows = await sql`
      SELECT id FROM admin_users
      WHERE lower(trim(email)) = ${email}
      LIMIT 1
    `;
    if (!rows.length) {
      return res.status(404).json({ error: 'No account was found for that email address.' });
    }
    const plain = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(plain);
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await sql`
      UPDATE admin_users SET
        reset_token_hash = ${tokenHash},
        reset_token_expires_at = ${expires.toISOString()},
        updated_at = now()
      WHERE id = ${rows[0].id}
    `;
    return res.json({
      ok:         true,
      resetToken: plain,
      expiresIn:  3600,
    });
  } catch (err) {
    console.error('verify-reset-email:', err);
    const msg = String(err && err.message ? err.message : '');
    if (/admin_users|relation.*does not exist/i.test(msg)) {
      return res.status(503).json({ error: 'Password reset is not available right now. Please try again later.' });
    }
    return res.status(500).json({ error: 'Something went wrong. Please try again in a moment.' });
  }
});

app.post('/api/admin/auth/reset-password', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkAuthRateLimit(`reset-do:${ip}`)) {
    return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
  }
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL is not set' });
  const email = normalizeAdminEmail(req.body?.email);
  const resetToken = String(req.body?.resetToken || '').trim();
  const password = String(req.body?.password || '');
  const passwordConfirm = String(req.body?.passwordConfirm || '');
  if (!email || !resetToken) return res.status(400).json({ error: 'Email and reset token are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (password !== passwordConfirm) return res.status(400).json({ error: 'Passwords do not match.' });
  try {
    const tokenHash = hashResetToken(resetToken);
    const rows = await sql`
      SELECT id FROM admin_users
      WHERE lower(trim(email)) = ${email}
        AND reset_token_hash = ${tokenHash}
        AND reset_token_expires_at > now()
      LIMIT 1
    `;
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset link. Request a new reset.' });
    const password_hash = await bcrypt.hash(password, 10);
    await sql`
      UPDATE admin_users SET
        password_hash = ${password_hash},
        reset_token_hash = NULL,
        reset_token_expires_at = NULL,
        updated_at = now()
      WHERE id = ${rows[0].id}
    `;
    return res.json({ success: true });
  } catch (err) {
    console.error('reset-password:', err);
    return res.status(500).json({ error: 'Could not reset password.' });
  }
});

const rateLimitMap = {};
function checkRateLimit(ip) {
  const now    = Date.now();
  const window = 10 * 60 * 1000;
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(ts => now - ts < window);
  if (rateLimitMap[ip].length >= 30) return false;
  rateLimitMap[ip].push(now);
  return true;
}

app.post('/api/session/new', async (req, res) => {
  const sessionId = uuidv4();
  sessions[sessionId] = {
    history:   [],
    createdAt: Date.now(),
  };
  console.log(`🆕  New session: ${sessionId.slice(0, 8)}…`);
  try {
    const hint = typeof req.body?.deviceHint === 'string' ? req.body.deviceHint.slice(0, 32) : null;
    await touchChatSession(sessionId, {
      userAgent: req.headers['user-agent'] || null,
      deviceHint: hint,
    });
  } catch (e) {
    console.warn('session DB:', e.message);
  }
  res.json({ sessionId });
});

/**
 * POST /api/book — save appointment to Neon Postgres (DATABASE_URL)
 * Body: { sessionId, name, phone, service, preferredDate, preferredTime, notes }
 */
app.post('/api/book', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  if (!getSql()) {
    return res.status(503).json({
      error: 'Database is not configured. Add DATABASE_URL (Neon) to your environment.',
    });
  }

  const body = req.body || {};
  const name           = typeof body.name === 'string' ? body.name.trim() : '';
  const phone          = typeof body.phone === 'string' ? body.phone.trim() : '';
  const service        = typeof body.service === 'string' ? body.service.trim() : '';
  const preferredDate  = typeof body.preferredDate === 'string' ? body.preferredDate.trim() : '';
  const preferredTime  = typeof body.preferredTime === 'string' ? body.preferredTime.trim() : '';
  let   notes          = typeof body.notes === 'string' ? body.notes.trim() : '';
  const sessionId      = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : uuidv4();

  if (!name || !phone || !service) {
    return res.status(400).json({ error: 'name, phone, and service are required.' });
  }
  if (name.length > 120 || phone.length > 40 || service.length > 200) {
    return res.status(400).json({ error: 'One or more fields are too long.' });
  }
  if (notes.length > 200) {
    return res.status(400).json({ error: 'notes must be 200 characters or less.' });
  }

  const turns = sessions[sessionId]?.history?.length ?? 0;

  try {
    await saveLeadToDatabase(sessionId, {
      name,
      phone,
      service,
      preferred_date: preferredDate,
      preferred_time: preferredTime,
      notes,
    }, turns);
    return res.json({ success: true, message: 'Booking confirmed' });
  } catch (err) {
    console.error('❌  DB insert error:', err.message);
    return res.status(500).json({ error: 'Could not save your booking. Please try again or call us.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many messages right now. Please wait a moment and try again.' });
  }

  const { sessionId: clientSessionId, message, deviceHint } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message field is required and must be non-empty.' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message is too long. Please keep it under 1000 characters.' });
  }

  const sessionId = (clientSessionId && sessions[clientSessionId])
    ? clientSessionId
    : uuidv4();

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      history:   [],
      createdAt: Date.now(),
    };
  }

  const session = sessions[sessionId];

  session.history.push({ role: 'user', content: message.trim() });

  const MAX_HISTORY = 20;
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(session.history.length - MAX_HISTORY);
  }

  try {
    const openaiMessages = [
      { role: 'system', content: buildSystemPrompt() },
      ...session.history,
    ];

    const completion = await openai.chat.completions.create({
      model:             'gpt-4o-mini',
      max_tokens:        450,
      temperature:       0.72,
      presence_penalty:  0.35,
      frequency_penalty: 0.20,
      messages:          openaiMessages,
    });

    const rawReply = completion.choices[0]?.message?.content?.trim() || '';
    const usage    = completion.usage;
    const turns    = session.history.length;

    const replyForClient  = rawReply;
    const replyForHistory = stripBookingTriggerForHistory(rawReply);

    session.history.push({ role: 'assistant', content: replyForHistory });

    console.log(
      `💬  [${sessionId.slice(0, 8)}]`,
      `turn=${turns}`,
      `| prompt=${usage?.prompt_tokens}tok`,
      `| completion=${usage?.completion_tokens}tok`
    );

    try {
      const hint = typeof deviceHint === 'string' ? deviceHint.slice(0, 32) : null;
      await touchChatSession(sessionId, {
        userAgent: req.headers['user-agent'] || null,
        deviceHint: hint,
      });
      await appendChatMessages(sessionId, message.trim(), replyForHistory);
    } catch (dbErr) {
      console.error('❌  chat persist:', dbErr.message);
    }

    return res.json({
      reply:     replyForClient,
      sessionId: sessionId,
      turn:      turns,
    });

  } catch (err) {
    console.error('❌  OpenAI error:', err.status, err.message);

    let userMessage;
    if (err.status === 401) {
      userMessage = 'There was an authentication issue on our end. Please try again or call us directly.';
    } else if (err.status === 429) {
      userMessage = "We're handling a lot of chats right now! Please try again in a moment, or call us at " + BARBER_CONFIG.phone;
    } else if (err.status === 503 || err.code === 'ECONNREFUSED') {
      userMessage = "Our messaging is temporarily unavailable. Please call us at " + BARBER_CONFIG.phone + " and we'll be happy to help!";
    } else {
      userMessage = "Something went wrong on our end. Please try again or call us at " + BARBER_CONFIG.phone;
    }

    return res.status(500).json({ error: userMessage });
  }
});

app.get('/api/admin/overview', requireAdmin, async (_req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL not set' });

  try {
    const tz = shopTimezone();

    const [kpi] = await sql`
      SELECT
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date = (CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date) AS revenue_today,
        (SELECT COUNT(*)::int FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date = (CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date) AS bookings_today,
        (SELECT COUNT(*)::int FROM chat_sessions
          WHERE (started_at AT TIME ZONE ${tz})::date = (CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date) AS visitors_today,
        (SELECT COUNT(*)::int FROM chat_sessions) AS total_sessions,
        (SELECT COUNT(*)::int FROM leads) AS total_leads,
        (SELECT COUNT(*)::int FROM leads WHERE LOWER(TRIM(COALESCE(crm_status, ''))) = 'new') AS leads_new,
        (SELECT COUNT(*)::int FROM leads WHERE appointment_status IN ('pending', 'confirmed')) AS open_appointments,
        (SELECT COALESCE(AVG(message_count), 0)::float FROM chat_sessions WHERE message_count > 0) AS avg_messages
    `;

    const totalSessions = Math.max(1, kpi.total_sessions || 0);
    const conversionPct = Math.min(100, Math.round(((kpi.total_leads || 0) / totalSessions) * 100));

    const weekRevRows = await sql`
      WITH days AS (
        SELECT generate_series(
          ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 6),
          (CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date,
          INTERVAL '1 day'
        )::date AS d
      )
      SELECT days.d AS d, COALESCE(agg.rev, 0)::float AS rev
      FROM days
      LEFT JOIN (
        SELECT (captured_at AT TIME ZONE ${tz})::date AS d, SUM(amount_eur)::float AS rev
        FROM leads
        GROUP BY 1
      ) agg ON agg.d = days.d
      ORDER BY days.d
    `;
    const revenueWeek = weekRevRows.map((r) => Number(r.rev) || 0);

    const allMonthRows = await sql`
      SELECT DATE_TRUNC('month', captured_at AT TIME ZONE 'UTC')::date AS m,
             COALESCE(SUM(amount_eur), 0)::float AS rev
      FROM leads
      WHERE captured_at >= (DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '35 months')
      GROUP BY 1 ORDER BY 1
    `;
    const monthRevMap = Object.fromEntries(
      allMonthRows.map((r) => [pgDateToYmd(r.m), Number(r.rev) || 0]),
    );
    const monthKeys12 = monthStartsLast12Utc();
    const monthlyRev = monthKeys12.map((k) => monthRevMap[k] || 0);
    const monthlyRevPriorYear = monthKeys12.map((k) => monthRevMap[priorYearSameMonthFirst(k)] || 0);

    const funnelRow = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM chat_sessions) AS visitors,
        (SELECT COUNT(*)::int FROM chat_sessions WHERE message_count >= 2) AS started_chat,
        (SELECT COUNT(*)::int FROM leads) AS captured,
        (SELECT COUNT(*)::int FROM leads WHERE appointment_status IN ('pending','confirmed','completed')) AS booked
    `;
    const fr = funnelRow[0] || {};
    const funnel = [
      fr.visitors || 0,
      fr.started_chat || 0,
      fr.captured || 0,
      fr.booked || 0,
    ];

    const hourlyRows = await sql`
      SELECT EXTRACT(HOUR FROM created_at)::int AS h, COUNT(*)::int AS c
      FROM chat_messages
      WHERE role = 'user' AND created_at >= now() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `;
    const hourlyData = Array.from({ length: 24 }, (_, h) => {
      const row = hourlyRows.find((x) => Number(x.h) === h);
      return row ? Number(row.c) : 0;
    });

    const svcRows = await sql`
      SELECT service, COUNT(*)::int AS bookings, COALESCE(SUM(amount_eur), 0)::float AS revenue
      FROM leads
      GROUP BY service
      ORDER BY bookings DESC
    `;
    const services = svcRows.map((r) => ({
      name:    r.service,
      price:   estimatePriceEur(r.service) || 0,
      bookings: Number(r.bookings),
      revenue:  Number(r.revenue),
    }));

    const leads = await sql`
      SELECT id, session_id, name, phone, service,
        preferred_date::text AS preferred_date,
        preferred_time,
        notes,
        captured_at::text AS captured_at,
        conversation_turns,
        amount_eur::float AS amount_eur,
        crm_status,
        appointment_status
      FROM leads
      ORDER BY
        CASE
          WHEN appointment_status IN ('pending', 'confirmed') THEN 0
          WHEN appointment_status = 'cancelled' THEN 1
          ELSE 2
        END ASC,
        captured_at ASC
      LIMIT 500
    `;

    const sessions = await sql`
      SELECT session_id, started_at::text AS started_at, last_activity_at::text AS last_activity_at,
             message_count, outcome, device_hint, user_agent
      FROM chat_sessions
      ORDER BY last_activity_at DESC
      LIMIT 200
    `;

    const dowSessions = await sql`
      SELECT EXTRACT(DOW FROM started_at AT TIME ZONE 'UTC')::int AS dow, COUNT(*)::int AS n
      FROM chat_sessions
      WHERE started_at >= now() - INTERVAL '30 days'
      GROUP BY 1
    `;
    const dowLeads = await sql`
      SELECT EXTRACT(DOW FROM captured_at AT TIME ZONE 'UTC')::int AS dow, COUNT(*)::int AS n
      FROM leads
      WHERE captured_at >= now() - INTERVAL '30 days'
      GROUP BY 1
    `;
    const botSessionsByDow = Array.from({ length: 7 }, (_, i) => {
      const row = dowSessions.find((x) => Number(x.dow) === i);
      return row ? Number(row.n) : 0;
    });
    const botLeadsByDow = Array.from({ length: 7 }, (_, i) => {
      const row = dowLeads.find((x) => Number(x.dow) === i);
      return row ? Number(row.n) : 0;
    });

    const dowRevRows = await sql`
      SELECT EXTRACT(DOW FROM captured_at AT TIME ZONE 'UTC')::int AS dow,
             COALESCE(SUM(amount_eur), 0)::float AS rev
      FROM leads
      WHERE captured_at >= now() - INTERVAL '90 days'
      GROUP BY 1
    `;
    const dowRevenue = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      if (i === 0 || i === 6) return 0;
      const row = dowRevRows.find((x) => Number(x.dow) === i);
      return row ? Math.round(Number(row.rev)) : 0;
    });

    const recentLeads = leads.slice(0, 6);
    const activities = [];
    for (const r of leads.slice(0, 5)) {
      activities.push({
        dot:  'green',
        text: `<strong>New booking</strong> — ${escapeHtml(r.name)} · ${escapeHtml(r.service)}`,
        time: formatActivityTime(r.captured_at),
        _ts:  Date.parse(r.captured_at) || 0,
      });
    }
    for (const s of sessions.slice(0, 4)) {
      if (s.message_count < 2) {
        activities.push({
          dot:  'blue',
          text: `<strong>Chat started</strong> — session ${escapeHtml(s.session_id.slice(0, 8))}…`,
          time: formatActivityTime(s.started_at),
          _ts:  Date.parse(s.started_at) || 0,
        });
      }
    }
    activities.sort((a, b) => (b._ts || 0) - (a._ts || 0));

    const weekApptRows = await sql`
      SELECT DATE_TRUNC('week', captured_at AT TIME ZONE ${tz})::date AS wk, COUNT(*)::int AS n
      FROM leads
      WHERE (captured_at AT TIME ZONE ${tz})::date >= ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - INTERVAL '112 days')
      GROUP BY 1 ORDER BY 1
    `;
    const weekApptBars = weekApptRows.map((r) => Number(r.n));

    const heatmapBookings = await sql`
      SELECT (captured_at AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS n
      FROM leads
      WHERE captured_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '120 days'
      GROUP BY 1
    `;
    const hmMap = Object.fromEntries(
      heatmapBookings.map((x) => [pgDateToYmd(x.d), Number(x.n) || 0]),
    );

    const nowU = new Date();
    const todayUtc = new Date(Date.UTC(nowU.getUTCFullYear(), nowU.getUTCMonth(), nowU.getUTCDate()));
    const daysFromMon = (todayUtc.getUTCDay() + 6) % 7;
    const thisMonday = new Date(todayUtc);
    thisMonday.setUTCDate(thisMonday.getUTCDate() - daysFromMon);
    const gridStart = new Date(thisMonday);
    gridStart.setUTCDate(gridStart.getUTCDate() - 7 * 11);

    function bookingsToHeatLevel(n) {
      const c = Number(n) || 0;
      if (c <= 0) return 0;
      if (c === 1) return 1;
      if (c === 2) return 2;
      if (c <= 4) return 3;
      if (c <= 7) return 4;
      return 5;
    }

    const heatmap = [];
    for (let row = 0; row < 12; row++) {
      for (let col = 0; col < 7; col++) {
        const cell = new Date(gridStart);
        cell.setUTCDate(cell.getUTCDate() + row * 7 + col);
        const key = cell.toISOString().slice(0, 10);
        heatmap.push(bookingsToHeatLevel(hmMap[key] || 0));
      }
    }

    const dowShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const revenueWeekLabels = weekRevRows.map((r) => {
      const ds = String(r.d).slice(0, 10);
      const parts = ds.split('-').map((x) => parseInt(x, 10));
      const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      return `${dowShort[utc.getUTCDay()]} ${parts[2]}`;
    });
    const revWeekSum = revenueWeek.reduce((a, b) => a + b, 0);

    const svcWeekRows = await sql`
      SELECT service, COUNT(*)::int AS bookings, COALESCE(SUM(amount_eur), 0)::float AS revenue
      FROM leads
      WHERE (captured_at AT TIME ZONE ${tz})::date >= ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - INTERVAL '6 days')
      GROUP BY service
      ORDER BY bookings DESC
    `;
    const servicesWeek = svcWeekRows.map((r) => ({
      name:     r.service,
      price:    estimatePriceEur(r.service) || 0,
      bookings: Number(r.bookings),
      revenue:  Number(r.revenue),
    }));

    const [cmp] = await sql`
      SELECT
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date = ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 1)) AS rev_yesterday,
        (SELECT COUNT(*)::int FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date = ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 1)) AS bookings_yesterday,
        (SELECT COUNT(*)::int FROM chat_sessions
          WHERE (started_at AT TIME ZONE ${tz})::date = ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 1)) AS visitors_yesterday,
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE captured_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})
            AND captured_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) + INTERVAL '1 month') AS rev_month,
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE captured_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) - INTERVAL '1 month'
            AND captured_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})) AS rev_prev_month,
        (SELECT COUNT(*)::int FROM leads
          WHERE captured_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})
            AND captured_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) + INTERVAL '1 month') AS bookings_month,
        (SELECT COUNT(*)::int FROM leads
          WHERE captured_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) - INTERVAL '1 month'
            AND captured_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})) AS bookings_prev_month,
        (SELECT COUNT(*)::int FROM chat_sessions
          WHERE started_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})
            AND started_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) + INTERVAL '1 month') AS sessions_month,
        (SELECT COUNT(*)::int FROM chat_sessions
          WHERE started_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) - INTERVAL '1 month'
            AND started_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})) AS sessions_prev_month,
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date BETWEEN ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 13) AND ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 7)) AS rev_prev_week,
        (SELECT COALESCE(AVG(amount_eur), 0)::float FROM leads
          WHERE amount_eur IS NOT NULL
            AND captured_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})
            AND captured_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) + INTERVAL '1 month') AS avg_ticket_month,
        (SELECT COALESCE(AVG(amount_eur), 0)::float FROM leads
          WHERE amount_eur IS NOT NULL
            AND captured_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) - INTERVAL '1 month'
            AND captured_at < DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE ${tz})) AS avg_ticket_prev_month,
        (SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (last_activity_at - started_at)) / 60.0), 0)::float FROM chat_sessions
          WHERE started_at >= now() - INTERVAL '30 days'
            AND last_activity_at > started_at
            AND EXTRACT(EPOCH FROM (last_activity_at - started_at)) BETWEEN 1 AND 7200) AS avg_session_min,
        (SELECT COUNT(*)::int FROM leads
          WHERE appointment_status = 'cancelled'
            AND (captured_at AT TIME ZONE ${tz})::date >= ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 6)) AS cancelled_week,
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE EXTRACT(YEAR FROM (captured_at AT TIME ZONE ${tz})) = EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE ${tz}))) AS rev_ytd,
        (SELECT COALESCE(SUM(amount_eur), 0)::float FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date >= (DATE_TRUNC('year', CURRENT_TIMESTAMP AT TIME ZONE ${tz}) - INTERVAL '1 year')::date
            AND (captured_at AT TIME ZONE ${tz})::date <= ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - INTERVAL '1 year')) AS rev_ytd_prior_year,
        (SELECT COUNT(*) FILTER (WHERE amount_eur >= 25)::int FROM leads) AS premium_bookings_n
    `;

    const [engage] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE message_count >= 4)::int AS engaged,
        COUNT(*)::int AS total
      FROM chat_sessions
      WHERE started_at >= now() - INTERVAL '30 days'
    `;

    const [mob] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE device_hint = 'mobile' OR (device_hint IS NULL AND user_agent IS NOT NULL AND user_agent ~* '(mobile|android|iphone|ipad)'))::int AS mobile_n,
        COUNT(*) FILTER (WHERE device_hint = 'desktop' OR (device_hint IS NULL AND (user_agent IS NULL OR user_agent !~* '(mobile|android|iphone|ipad)')))::int AS desktop_n,
        COUNT(*)::int AS total
      FROM chat_sessions
      WHERE started_at >= now() - INTERVAL '30 days'
    `;

    const [bookedRate] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'booked')::int AS booked,
        COUNT(*)::int AS total
      FROM chat_sessions
      WHERE started_at >= now() - INTERVAL '30 days'
    `;

    const [convWeek] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM chat_sessions
          WHERE (started_at AT TIME ZONE ${tz})::date BETWEEN ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 6) AND ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date)) AS s_this,
        (SELECT COUNT(*)::int FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date BETWEEN ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 6) AND ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date)) AS l_this,
        (SELECT COUNT(*)::int FROM chat_sessions
          WHERE (started_at AT TIME ZONE ${tz})::date BETWEEN ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 13) AND ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 7)) AS s_prev,
        (SELECT COUNT(*)::int FROM leads
          WHERE (captured_at AT TIME ZONE ${tz})::date BETWEEN ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 13) AND ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 7)) AS l_prev
    `;

    const daySessRows = await sql`
      SELECT (started_at AT TIME ZONE ${tz})::date AS d, COUNT(*)::int AS n
      FROM chat_sessions
      WHERE (started_at AT TIME ZONE ${tz})::date >= ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 29)
      GROUP BY 1 ORDER BY 1
    `;
    const daySessMap = Object.fromEntries(daySessRows.map((r) => [String(r.d).slice(0, 10), Number(r.n)]));
    const daySeries30 = await sql`
      SELECT gs::date AS d FROM generate_series(
        ((CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date - 29),
        (CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date,
        INTERVAL '1 day'
      ) AS gs
    `;
    const sessionsByDay30 = daySeries30.map((r) => daySessMap[String(r.d).slice(0, 10)] || 0);
    const sessionsByDay30Labels = daySeries30.map((r) => {
      const ds = String(r.d).slice(0, 10);
      const p = ds.split('-').map((x) => parseInt(x, 10));
      return `${p[1]}/${p[2]}`;
    });

    let peakH = 0;
    let peakC = 0;
    hourlyData.forEach((c, h) => {
      if (c > peakC) {
        peakC = c;
        peakH = h;
      }
    });
    const peakHourLabel = peakC > 0 ? `${peakH}:00 – ${peakH + 1}:00` : '—';

    let maxD = 0;
    let maxDi = 0;
    botLeadsByDow.forEach((n, i) => {
      if (n > maxD) {
        maxD = n;
        maxDi = i;
      }
    });
    const dowFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const busiestDowLabel = maxD > 0 ? dowFull[maxDi] : '—';
    const avgBookingsOnBusiestDow = maxD > 0 ? Math.round(maxD / 4.3) : 0;

    const totalLeadBookings = services.reduce((s, x) => s + x.bookings, 0);
    const topSvc = services[0];
    const topServicePct = totalLeadBookings > 0 && topSvc ? Math.round((topSvc.bookings / totalLeadBookings) * 100) : 0;

    const engTotal = Number(engage?.total) || 0;
    const engagementPct = engTotal > 0 ? Math.round(((Number(engage?.engaged) || 0) / engTotal) * 100) : 0;

    const mobT = Number(mob?.total) || 0;
    const mobilePct30 = mobT > 0 ? Math.round(((Number(mob?.mobile_n) || 0) / mobT) * 100) : 0;
    const desktopPct30 = mobT > 0 ? Math.round(((Number(mob?.desktop_n) || 0) / mobT) * 100) : 0;

    const brTot = Number(bookedRate?.total) || 0;
    const outcomeBookedPct = brTot > 0 ? Math.round(((Number(bookedRate?.booked) || 0) / brTot) * 100) : 0;

    const funnelBookedPct = (fr.captured || 0) > 0 ? Math.round(((fr.booked || 0) / (fr.captured || 0)) * 100) : 0;

    const totalLeadsAll = Number(kpi.total_leads) || 0;
    const premiumPct = totalLeadsAll > 0 ? Math.round(((Number(cmp?.premium_bookings_n) || 0) / totalLeadsAll) * 100) : 0;

    const sThis = Number(convWeek?.s_this) || 0;
    const sPrev = Number(convWeek?.s_prev) || 0;
    const convThisWk = sThis > 0 ? ((Number(convWeek?.l_this) || 0) / sThis) * 100 : 0;
    const convPrevWk = sPrev > 0 ? ((Number(convWeek?.l_prev) || 0) / sPrev) * 100 : 0;
    const convWeekDelta = Math.round(convThisWk - convPrevWk);

    const monShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyRevLabels = monthKeys12.map((k) => {
      const d = new Date(`${k}T12:00:00.000Z`);
      return `${monShort[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(-2)}`;
    });

    const stats = {
      revYesterday:           Number(cmp?.rev_yesterday) || 0,
      bookingsYesterday:      Number(cmp?.bookings_yesterday) || 0,
      visitorsYesterday:      Number(cmp?.visitors_yesterday) || 0,
      revMonth:               Number(cmp?.rev_month) || 0,
      revPrevMonth:           Number(cmp?.rev_prev_month) || 0,
      bookingsMonth:          Number(cmp?.bookings_month) || 0,
      bookingsPrevMonth:      Number(cmp?.bookings_prev_month) || 0,
      sessionsMonth:          Number(cmp?.sessions_month) || 0,
      sessionsPrevMonth:      Number(cmp?.sessions_prev_month) || 0,
      revPrevWeek:            Number(cmp?.rev_prev_week) || 0,
      revWeekSum,
      avgTicketMonth:         Number(cmp?.avg_ticket_month) || 0,
      avgTicketPrevMonth:     Number(cmp?.avg_ticket_prev_month) || 0,
      avgSessionMin:          Number(cmp?.avg_session_min) || 0,
      cancelledWeek:          Number(cmp?.cancelled_week) || 0,
      revYtd:                 Number(cmp?.rev_ytd) || 0,
      revYtdPriorYear:        Number(cmp?.rev_ytd_prior_year) || 0,
      peakHourLabel,
      busiestDowLabel,
      busiestDowLeads30d: maxD,
      topServiceName:         topSvc?.name || '—',
      topServicePct,
      engagementPct,
      mobilePct30,
      desktopPct30,
      mobileN:                Number(mob?.mobile_n) || 0,
      desktopN:               Number(mob?.desktop_n) || 0,
      outcomeBookedPct,
      funnelBookedPct,
      premiumPct,
      convWeekDelta,
      totalLeadsAll,
      totalSessionsAll:       Number(kpi.total_sessions) || 0,
    };

    const [todayShopRow] = await sql`
      SELECT (CURRENT_TIMESTAMP AT TIME ZONE ${tz})::date::text AS shop_today
    `;
    const shopDateToday = String(todayShopRow?.shop_today || '').slice(0, 10);

    return res.json({
      kpi: {
        revenueToday:       Number(kpi.revenue_today) || 0,
        appointmentsToday:  kpi.bookings_today || 0,
        visitorsToday:      kpi.visitors_today || 0,
        conversionPct,
        avgMessages:        Number(kpi.avg_messages) || 0,
        totalLeads:         Number(kpi.total_leads) || 0,
        leadsNew:           Number(kpi.leads_new) || 0,
        openAppointments:   Number(kpi.open_appointments) || 0,
        shopTimezone:       tz,
        shopDateToday,
      },
      stats,
      revenueWeek,
      revenueWeekLabels,
      monthlyRev,
      monthlyRevLabels,
      monthlyRevPriorYear,
      funnel,
      hourlyData,
      services,
      servicesWeek,
      leads,
      appointments: leads,
      sessions,
      botPerf: { sessionsByDow: botSessionsByDow, leadsByDow: botLeadsByDow },
      dowRevenue,
      heatmap,
      weekApptBars,
      sessionsByDay30,
      sessionsByDay30Labels,
      activities: activities.slice(0, 12).map(({ _ts, ...rest }) => rest),
    });
  } catch (err) {
    console.error('admin overview:', err);
    return res.status(500).json({ error: 'Could not load admin data.', detail: err.message });
  }
});

app.get('/api/admin/sessions/:sessionId/messages', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL not set' });
  const sid = String(req.params.sessionId || '').trim();
  if (!sid) return res.status(400).json({ error: 'sessionId required' });
  try {
    const rows = await sql`
      SELECT id, role, content, created_at::text AS created_at
      FROM chat_messages
      WHERE session_id = ${sid}
      ORDER BY created_at ASC
    `;
    return res.json({ sessionId: sid, messages: rows });
  } catch (err) {
    console.error('admin messages:', err);
    return res.status(500).json({ error: 'Could not load messages.' });
  }
});

app.patch('/api/admin/leads/:id', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL not set' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

  const { crm_status, appointment_status } = req.body || {};
  const allowedCrm = ['new', 'contacted', 'converted'];
  const allowedAppt = ['pending', 'confirmed', 'completed', 'cancelled'];

  try {
    if (crm_status != null) {
      if (!allowedCrm.includes(crm_status)) {
        return res.status(400).json({ error: 'Invalid crm_status' });
      }
      await sql`UPDATE leads SET crm_status = ${crm_status} WHERE id = ${id}`;
    }
    if (appointment_status != null) {
      if (!allowedAppt.includes(appointment_status)) {
        return res.status(400).json({ error: 'Invalid appointment_status' });
      }
      await sql`UPDATE leads SET appointment_status = ${appointment_status} WHERE id = ${id}`;
    }
    const rows = await sql`SELECT * FROM leads WHERE id = ${id}`;
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' });
    return res.json({ success: true, lead: rows[0] });
  } catch (err) {
    console.error('patch lead:', err);
    return res.status(500).json({ error: 'Update failed.' });
  }
});

app.delete('/api/admin/leads/:id', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) return res.status(503).json({ error: 'DATABASE_URL is not set' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
  try {
    const found = await sql`SELECT id FROM leads WHERE id = ${id} LIMIT 1`;
    if (!found.length) return res.status(404).json({ error: 'Lead not found' });
    await sql`DELETE FROM leads WHERE id = ${id}`;
    return res.json({ success: true });
  } catch (err) {
    console.error('delete lead:', err);
    return res.status(500).json({ error: 'Delete failed.' });
  }
});

app.get('/api/leads/download', requireAdmin, async (req, res) => {
  const sql = getSql();
  if (!sql) {
    return res.status(503).json({ error: 'DATABASE_URL is not configured.' });
  }

  try {
    const rows = await sql`
      SELECT id, session_id, name, phone, service,
        preferred_date::text AS preferred_date,
        preferred_time,
        notes,
        captured_at::text AS captured_at,
        conversation_turns,
        amount_eur::text AS amount_eur,
        crm_status,
        appointment_status
      FROM leads
      ORDER BY captured_at DESC
    `;
    const header = 'id,session_id,name,phone,service,preferred_date,preferred_time,notes,captured_at,conversation_turns,amount_eur,crm_status,appointment_status\n';
    const lines = rows.map((r) =>
      [
        r.id,
        r.session_id,
        r.name,
        r.phone,
        r.service,
        r.preferred_date,
        r.preferred_time,
        r.notes,
        r.captured_at,
        r.conversation_turns,
        r.amount_eur,
        r.crm_status,
        r.appointment_status,
      ].map(csvEscapeCell).join(','),
    );
    const csv = header + lines.join('\n') + (lines.length ? '\n' : '');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="barber_leads_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('❌  leads download:', err.message);
    return res.status(500).json({ error: 'Could not export leads.' });
  }
});

app.get('/api/leads/count', requireAdmin, async (_req, res) => {
  const sql = getSql();
  if (!sql) {
    return res.json({ total_leads: 0, error: 'DATABASE_URL not set' });
  }

  try {
    const rows = await sql`SELECT COUNT(*)::int AS n FROM leads`;
    const n    = rows[0]?.n ?? 0;
    res.json({ total_leads: n, source: 'postgres' });
  } catch (err) {
    console.error('❌  leads count:', err.message);
    res.status(500).json({ error: 'Could not count leads.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status:          'ok',
    time:            new Date().toISOString(),
    active_sessions: Object.keys(sessions).length,
    openai_model:    'gpt-4o-mini',
    memory_window:   20,
    database:        getSql() ? 'connected' : 'missing DATABASE_URL',
  });
});

{
  const adminRootDir = path.join(rootDir, 'admin');
  const adminDistDir = path.join(adminRootDir, 'dist');
  const adminStaticDir = fs.existsSync(path.join(adminDistDir, 'index.html'))
    ? adminDistDir
    : adminRootDir;
  app.use('/admin', express.static(adminStaticDir));
  if (adminStaticDir === adminRootDir) {
    console.warn('⚠️  admin/dist not found — run `npm run build` in /admin (or use Vite dev on :5174) for the React admin UI.\n');
  }
}
const userAppRootDir = path.join(rootDir, 'user');
const userAppDistDir = path.join(userAppRootDir, 'dist');
const userAppStaticDir = fs.existsSync(path.join(userAppDistDir, 'index.html'))
  ? userAppDistDir
  : userAppRootDir;
app.use(express.static(userAppStaticDir));
if (userAppStaticDir === userAppRootDir) {
  console.warn('⚠️  user/dist not found — run `npm run build` in /user (or use Vite dev on :5173) for the React chat UI.\n');
}

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

const server = app.listen(port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   ✂️  Barbería Cullera — chat server online    ║');
  console.log(`║   🌐  http://localhost:${port}                  ║`);
  console.log('║   📄  Leads → Neon Postgres (DATABASE_URL)    ║');
  console.log('║   🔑  Admin: set ADMIN_TOKEN to lock /api/admin ║');
  console.log('╚══════════════════════════════════════════════╝');
  if (!getSql()) {
    console.warn('⚠️  DATABASE_URL missing — bookings will fail until Neon is connected.\n');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use. Stop the other process or set PORT in .env.\n`);
    console.error('Windows: netstat -ano | findstr :' + port + '   then   taskkill /PID <pid> /F\n');
    process.exit(1);
  }
  throw err;
});

module.exports = app;
