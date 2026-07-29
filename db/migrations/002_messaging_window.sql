-- Messaging plus a Bumble-style 24-hour opening window.
--
-- Why an expiry at all: it is the one Bumble mechanic that fits this PRD.
-- A match that nobody opens decays instead of sitting in a list forever,
-- which pushes toward fewer, more deliberate connections rather than
-- collection. It is not a scarcity trick — extend and rematch both exist.

ALTER TABLE matches
  -- Whoever was liked FIRST holds the opening move. They were pursued, so
  -- they decide whether the conversation happens. Bumble uses gender for
  -- this; the PRD has no gender field and adding one to gate a feature
  -- would be worse, so pursuit order stands in for it.
  ADD COLUMN first_move_profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  ADD COLUMN expires_at  timestamptz,
  ADD COLUMN extended_at timestamptz,
  -- Set by the first message. Once opened, the match never expires.
  ADD COLUMN opened_at   timestamptz;

-- Existing matches (there are none in production yet, but keep this correct)
-- get a full window from now rather than being retroactively expired.
UPDATE matches
   SET expires_at = now() + interval '24 hours',
       first_move_profile_id = profile_a_id
 WHERE expires_at IS NULL AND closed_at IS NULL;

CREATE INDEX matches_expiry_idx ON matches (expires_at) WHERE opened_at IS NULL;

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id          uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  body              text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  read_at           timestamptz,
  -- Disappearing messages (PRD §5.3). NULL means the message persists.
  expires_at        timestamptz
);

CREATE INDEX messages_match_idx ON messages (match_id, created_at);

-- Per-match retention choice, so "disappearing" is a property of the
-- conversation both people can see, not a hidden per-message setting.
ALTER TABLE matches
  ADD COLUMN message_ttl_seconds int
    CHECK (message_ttl_seconds IS NULL OR message_ttl_seconds BETWEEN 60 AND 604800);
