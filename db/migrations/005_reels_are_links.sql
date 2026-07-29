-- Reels reference a YouTube video instead of storing one.
--
-- The user uploads to their own YouTube channel; this platform keeps only the
-- link. Three things fall out of that, all good:
--   - no video bytes on a VPS with 9 stacks sharing 36 GB
--   - no transcoding pipeline, and no video moderation burden on upload
--   - the creator keeps ownership and can delete at source
--
-- The link is stored canonically (watch?v=ID) so the same video pasted in
-- three different URL shapes is still one video.

ALTER TABLE posts
  ADD COLUMN video_url text,
  -- Canonical 11-character YouTube id, extracted on write.
  ADD COLUMN video_id  text;

-- A reel is a link; a story is uploaded media. Enforced rather than assumed,
-- so a reel can never quietly start consuming disk again.
ALTER TABLE posts ADD CONSTRAINT posts_kind_source_ck CHECK (
  (kind = 'reel'  AND video_id IS NOT NULL AND media_id IS NULL) OR
  (kind = 'story' AND video_id IS NULL)
);

CREATE INDEX posts_video_idx ON posts (video_id) WHERE video_id IS NOT NULL;
