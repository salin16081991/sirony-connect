-- Stories accept a photo OR a YouTube link — never an uploaded video.
--
-- Same reasoning as reels: video does not touch this disk. A 40 MB upload per
-- story, on a box sharing 36 GB across nine stacks, is the fastest way to take
-- every site here down at once. Photos are small and bounded; anything moving
-- goes to the author's own YouTube channel.

ALTER TABLE posts DROP CONSTRAINT posts_kind_source_ck;

ALTER TABLE posts ADD CONSTRAINT posts_kind_source_ck CHECK (
  -- A reel is always a link, never an upload.
  (kind = 'reel' AND video_id IS NOT NULL AND media_id IS NULL)
  OR
  -- A story is a photo, or a link, or text-only — but not a photo AND a link.
  (kind = 'story' AND NOT (media_id IS NOT NULL AND video_id IS NOT NULL))
);
