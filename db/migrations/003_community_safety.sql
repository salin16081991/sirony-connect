-- Clubs, events, compatibility exercises, verification state, and the
-- moderation console (PRD §5.2, §5.4, §8).

-- ------------------------------------------------------------ moderation --

-- Moderator access is a flag on the account rather than a separate table:
-- there is one privilege level, and the audit trail records who used it.
ALTER TABLE users ADD COLUMN is_moderator boolean NOT NULL DEFAULT false;

-- Enforcement history. Separate from audit_events because these carry
-- consequences a user can appeal, and must be explainable (PRD §8).
CREATE TABLE moderation_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     uuid REFERENCES reports(id) ON DELETE SET NULL,
  moderator_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action        text NOT NULL CHECK (action IN (
                  'no_action', 'warning', 'content_removed',
                  'suspended', 'banned', 'reinstated')),
  -- Shown to the subject. High-impact enforcement must be explainable.
  rationale     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX moderation_actions_subject_idx ON moderation_actions (subject_id, created_at DESC);

ALTER TABLE reports
  ADD COLUMN claimed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN resolved_at timestamptz;

ALTER TABLE users
  ADD COLUMN suspended_until timestamptz;

-- Appeals (PRD §8): enforcement supports explanation and challenge.
CREATE TABLE appeals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id   uuid NOT NULL REFERENCES moderation_actions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  statement   text NOT NULL,
  status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'upheld', 'overturned')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id)
);

-- ---------------------------------------------------------- verification --

-- The identity-document exchange happens at a vetted provider; this table
-- holds only the state and the provider's opaque reference. Documents and
-- biometrics are deliberately NOT stored here (PRD §8, §16).
CREATE TABLE verifications (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('video_selfie', 'government_id')),
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
  provider_ref text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);

-- ----------------------------------------------------------------- clubs --

CREATE TABLE clubs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  locality     text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Clubs can be archived by moderators without destroying member history.
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE club_members (
  club_id    uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'organiser')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE club_posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    uuid NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  -- Posts are attributed to a profile, not an account, so a user's club
  -- presence does not expose their dating profile.
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX club_posts_club_idx ON club_posts (club_id, created_at DESC);

-- ---------------------------------------------------------------- events --

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid REFERENCES clubs(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  -- Venue text only. No coordinates, consistent with the rest of the schema.
  venue        text,
  locality     text,
  starts_at    timestamptz NOT NULL,
  capacity     int CHECK (capacity IS NULL OR capacity > 0),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_upcoming_idx ON events (starts_at) WHERE cancelled_at IS NULL;

CREATE TABLE event_rsvps (
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'going' CHECK (status IN ('going', 'maybe', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- --------------------------------------------------------- compatibility --

CREATE TABLE compatibility_questions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Maps to the Compatibility Radar dimensions in PRD §5.2.
  category text NOT NULL CHECK (category IN (
             'communication', 'humour', 'finances', 'family', 'religion',
             'lifestyle', 'conflict', 'romance', 'adventure', 'goals')),
  prompt   text NOT NULL,
  options  jsonb NOT NULL,
  sort     int NOT NULL DEFAULT 0
);

CREATE TABLE compatibility_answers (
  profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES compatibility_questions(id) ON DELETE CASCADE,
  choice      int NOT NULL,
  answered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, question_id)
);

INSERT INTO compatibility_questions (category, prompt, options, sort) VALUES
  ('communication', 'When something is bothering you, what feels natural?',
   '["Say it straight away","Think first, talk later","Wait to be asked","Write it down"]', 1),
  ('conflict', 'After a disagreement, you would rather…',
   '["Resolve it before sleeping","Take space, return calmer","Talk it through slowly","Move on without dissecting it"]', 2),
  ('finances', 'Money between partners works best when…',
   '["Fully shared","Mostly separate","Proportional to income","Decided case by case"]', 3),
  ('family', 'How close do you want extended family to be?',
   '["Very involved","Regular contact","Occasional","Independent"]', 4),
  ('lifestyle', 'A free weekend usually means…',
   '["Out and social","Quiet at home","Outdoors","A mix, planned loosely"]', 5),
  ('goals', 'Five years out, what matters most?',
   '["Stability","Growth and change","Freedom to travel","Building something together"]', 6),
  ('romance', 'You feel most cared for when someone…',
   '["Says it clearly","Shows it through actions","Gives undivided time","Remembers small details"]', 7),
  ('adventure', 'A holiday you would choose…',
   '["Planned itinerary","Improvised","Somewhere familiar","Somewhere difficult"]', 8),
  ('humour', 'Your sense of humour is closest to…',
   '["Dry and understated","Silly and playful","Sharp and quick","Warm and gentle"]', 9),
  ('religion', 'Faith or spirituality in daily life is…',
   '["Central","Meaningful but private","Cultural","Not a factor"]', 10);
