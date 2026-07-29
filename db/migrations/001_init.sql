-- AURA / sirony-connect — initial schema
--
-- Data classification (PRD §11, §16): date_of_birth, connection modes and
-- intent, reports, and consent records are all HIGHLY SENSITIVE. Access is
-- restricted to the owning user except where moderation requires otherwise.
-- No IP addresses or precise coordinates are stored anywhere in this schema.

-- ---------------------------------------------------------------- accounts --

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  -- Adults only (PRD §3). Enforced in the application, since a CHECK cannot
  -- call now(). Stored rather than derived so verification can compare later.
  date_of_birth   date NOT NULL,
  identity_verified_at timestamptz,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Emails are normalised to lowercase before insert.
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE status <> 'deleted';

-- Only the hash is stored, so a database leak does not yield live sessions.
-- No IP or user-agent columns: session hygiene without building a movement log.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------- profiles --

-- Separate presentations per purpose (PRD §3). Identity verification is never
-- surfaced across profiles without explicit permission.
CREATE TABLE profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL
                  CHECK (kind IN ('dating', 'friends', 'activities', 'networking')),
  display_name  text NOT NULL,
  headline      text,
  bio           text,
  interests     text[] NOT NULL DEFAULT '{}',
  -- Approximate only. PRD §7: precise location is never shown by default.
  locality      text,
  -- Discoverability (PRD §5.1). Default is the most private option.
  visibility    text NOT NULL DEFAULT 'invisible'
                  CHECK (visibility IN ('invisible', 'audiences', 'clubs_events', 'discoverable')),
  age_min       int NOT NULL DEFAULT 18 CHECK (age_min >= 18),
  age_max       int NOT NULL DEFAULT 99 CHECK (age_max <= 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind),
  CHECK (age_max >= age_min)
);

CREATE INDEX profiles_discovery_idx ON profiles (kind, visibility);

-- Matching requires overlapping, mutually selected modes (PRD §3).
CREATE TABLE profile_modes (
  profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mode        text NOT NULL CHECK (mode IN (
                'marriage', 'long_term', 'casual_dating', 'fun_hangout',
                'hookup', 'friends', 'activity_partners', 'networking')),
  PRIMARY KEY (profile_id, mode)
);

CREATE INDEX profile_modes_mode_idx ON profile_modes (mode);

-- ---------------------------------------------------------------- consents --

-- Per-analysis-type consent, default off for anything sensitive (PRD §6).
-- Withdrawal is a row update, so the current state is always unambiguous.
CREATE TABLE consents (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN (
                'ai_profile_assist', 'ai_chat_analysis', 'ai_voice_analysis',
                'approximate_location', 'push_notifications', 'trusted_contacts')),
  granted     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- ------------------------------------------------------- discovery / graph --

-- Blocks are recorded per user, not per profile, so blocking someone hides
-- every presentation they have.
CREATE TABLE blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE likes (
  from_profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  to_profile_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_profile_id, to_profile_id),
  CHECK (from_profile_id <> to_profile_id)
);

CREATE INDEX likes_to_idx ON likes (to_profile_id);

-- A match exists only after mutual interest (PRD §4). The ordering constraint
-- keeps one row per pair.
CREATE TABLE matches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_a_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_b_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  UNIQUE (profile_a_id, profile_b_id),
  CHECK (profile_a_id < profile_b_id)
);

-- Curated daily introductions rather than an infinite deck (PRD §5.1).
CREATE TABLE introductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  candidate_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  issued_on         date NOT NULL DEFAULT CURRENT_DATE,
  acted_at          timestamptz,
  UNIQUE (profile_id, candidate_id),
  CHECK (profile_id <> candidate_id)
);

CREATE INDEX introductions_daily_idx ON introductions (profile_id, issued_on);

-- ----------------------------------------------------------------- safety --

CREATE TABLE reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN (
                  'harassment', 'threats', 'scam', 'impersonation',
                  'non_consensual_imagery', 'underage', 'other')),
  details       text,
  -- Credible threats, minors and NCII jump the queue (PRD §8).
  priority      text NOT NULL DEFAULT 'standard'
                  CHECK (priority IN ('urgent', 'standard')),
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reports_triage_idx ON reports (status, priority, created_at);

-- Append-only trail for moderation and consent changes (PRD §6, §8).
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  subject     text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);
