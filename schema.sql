-- ═══════════════════════════════════════════════════════════════════
-- Barbería Cullera — Neon PostgreSQL (Vercel)
-- Run the full script once in Neon SQL Editor.
-- If you already have an old `leads` table, run only the ALTER block at the bottom.
-- ═══════════════════════════════════════════════════════════════════

-- Chat sessions (syncs with public chatbot)
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id       TEXT PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_count    INTEGER     NOT NULL DEFAULT 0,
  user_agent       TEXT,
  device_hint      TEXT,
  outcome          TEXT        NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_started ON chat_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_outcome ON chat_sessions (outcome);

-- Every user + assistant message (admin conversations / analytics)
CREATE TABLE IF NOT EXISTS chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions (session_id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_time ON chat_messages (session_id, created_at);

-- Booking / lead records (form submit from chatbot)
CREATE TABLE IF NOT EXISTS leads (
  id                   BIGSERIAL PRIMARY KEY,
  session_id           TEXT REFERENCES chat_sessions (session_id) ON DELETE SET NULL,
  name                 TEXT        NOT NULL,
  phone                TEXT        NOT NULL,
  service              TEXT        NOT NULL,
  preferred_date       DATE,
  preferred_time       TEXT,
  notes                TEXT,
  conversation_turns   INTEGER     NOT NULL DEFAULT 0,
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_eur           NUMERIC(10, 2),
  crm_status           TEXT        NOT NULL DEFAULT 'new',
  appointment_status   TEXT        NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_leads_captured ON leads (captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_session ON leads (session_id);
CREATE INDEX IF NOT EXISTS idx_leads_crm ON leads (crm_status);
CREATE INDEX IF NOT EXISTS idx_leads_appt ON leads (appointment_status);

COMMENT ON TABLE chat_sessions IS 'Visitor chatbot sessions; outcome: active | engaged | booked';
COMMENT ON TABLE chat_messages IS 'Full conversation log for admin + analytics';
COMMENT ON TABLE leads IS 'Appointment requests; crm_status: new | contacted | converted; appointment_status: pending | confirmed | completed | cancelled';

-- Admin panel users (email + password; reset flow uses reset_token_hash)
CREATE TABLE IF NOT EXISTS admin_users (
  id                      BIGSERIAL PRIMARY KEY,
  email                   TEXT        NOT NULL UNIQUE,
  password_hash           TEXT        NOT NULL,
  reset_token_hash        TEXT,
  reset_token_expires_at  TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (lower(email));

COMMENT ON TABLE admin_users IS 'Dashboard login. Bootstrap first user via POST /api/admin/auth/setup-first-admin with ADMIN_SETUP_KEY.';
-- If reset/login cannot find a user you inserted by hand, normalize stored emails once:
-- UPDATE admin_users SET email = trim(lower(email));

-- ── Upgrade path: existing `leads` from older schema (no new columns) ──
ALTER TABLE leads ADD COLUMN IF NOT EXISTS amount_eur NUMERIC(10, 2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS crm_status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_status TEXT NOT NULL DEFAULT 'pending';
