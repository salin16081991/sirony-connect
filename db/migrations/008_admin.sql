-- Administration.
--
-- `is_moderator` already gates the report queue. Admin is broader: user
-- management, content removal, metrics and the audit log. Separate flags so a
-- moderator handling reports does not automatically get the whole estate.
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- Reading someone's private conversation is the single most invasive thing
-- this panel can do, so it is recorded as its own first-class event with a
-- mandatory reason. PRD §16 names insider access and moderator abuse in the
-- threat model; an audit trail is the control that makes them detectable.
CREATE TABLE sensitive_access_log (
  id           bigserial PRIMARY KEY,
  admin_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  resource     text NOT NULL,
  resource_id  text,
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sensitive_access_admin_idx ON sensitive_access_log (admin_id, created_at DESC);
CREATE INDEX sensitive_access_subject_idx ON sensitive_access_log (subject_id, created_at DESC);

-- Free-text operator notes on an account, for support continuity.
CREATE TABLE admin_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_notes_user_idx ON admin_notes (user_id, created_at DESC);

-- Signup and activity charts scan these constantly.
CREATE INDEX users_created_idx ON users (created_at);
CREATE INDEX matches_created_idx ON matches (created_at);
CREATE INDEX messages_created_idx ON messages (created_at);
