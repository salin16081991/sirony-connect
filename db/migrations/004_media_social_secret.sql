-- digest() for secret-chat safety numbers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Media, ephemeral posts, private engagement counts, QR connect, and
-- end-to-end encrypted secret chat.

-- Server-side secrets that must survive restarts (media URL signing key).
CREATE TABLE app_secrets (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- media --

-- Files live on a local volume; this table is the authority on who may see
-- what and for how long. Direct file URLs are never issued — access always
-- goes through a short-lived signed token (PRD §7).
CREATE TABLE media_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('photo', 'video')),
  mime          text NOT NULL,
  bytes         bigint NOT NULL,
  storage_path  text NOT NULL,
  -- One-time view: the first viewer other than the owner burns it.
  one_time      boolean NOT NULL DEFAULT false,
  burned_at     timestamptz,
  -- Hard deletion deadline. The sweeper removes the row and the file.
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_expiry_idx ON media_objects (expires_at) WHERE expires_at IS NOT NULL;

-- Who has actually opened a piece of media. Also the audit trail behind the
-- per-viewer watermark, so redistributed content can be traced back.
CREATE TABLE media_views (
  media_id  uuid NOT NULL REFERENCES media_objects(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, viewer_id)
);

-- ----------------------------------------------------------------- posts --

-- Stories last a day, reels a month (PRD §5.4 retention thinking, and the
-- product decision to avoid a permanent performance archive).
CREATE TABLE posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  media_id   uuid REFERENCES media_objects(id) ON DELETE SET NULL,
  kind       text NOT NULL CHECK (kind IN ('story', 'reel')),
  caption    text CHECK (caption IS NULL OR length(caption) <= 500),
  expires_at timestamptz NOT NULL,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posts_feed_idx ON posts (kind, expires_at) WHERE removed_at IS NULL;

-- Hearts are recorded per user so they cannot be inflated, but the COUNT is
-- only ever returned to the post's owner. There is no public leaderboard:
-- PRD §8 rules out popularity-based reputation, so this is private feedback.
CREATE TABLE hearts (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- Follows are likewise private: you can see your own follower count, nobody
-- else can see it or browse your follower list.
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX follows_followee_idx ON follows (followee_id);

-- ------------------------------------------------------------ QR connect --

-- Short-lived, single-use token behind a QR code, for meeting in person.
-- Deliberately expires fast: a screenshot of a QR code should not be a
-- permanent way to reach someone.
CREATE TABLE qr_tokens (
  token      text PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  used_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------- secret chat --

-- END-TO-END ENCRYPTED CHAT — NOT SECURITY REVIEWED.
--
-- PRD §7 requires that key management, device revocation and recovery be
-- reviewed by security specialists before launch, and §12 defers this
-- feature. It is implemented here at the owner's explicit request and must
-- not be described to users as audited.
--
-- The server stores public keys and ciphertext only. It never sees plaintext
-- and never holds a private key — those stay in the browser's IndexedDB.
CREATE TABLE device_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Client-generated, stable per browser profile.
  device_id   text NOT NULL,
  -- SPKI-encoded ECDH P-256 public key, base64url.
  public_key  text NOT NULL,
  label       text,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE INDEX device_keys_user_idx ON device_keys (user_id) WHERE revoked_at IS NULL;

-- One row per recipient device: the sender encrypts separately for each,
-- which is what makes multi-device work without the server holding a key.
CREATE TABLE secret_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_profile_id  uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_device_id uuid NOT NULL REFERENCES device_keys(id) ON DELETE CASCADE,
  -- Opaque to the server.
  ciphertext         text NOT NULL,
  iv                 text NOT NULL,
  sender_public_key  text NOT NULL,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX secret_messages_device_idx ON secret_messages (recipient_device_id, created_at);

ALTER TABLE matches ADD COLUMN secret_mode boolean NOT NULL DEFAULT false;
