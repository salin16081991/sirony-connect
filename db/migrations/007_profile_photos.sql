-- A card-based discovery UI is mostly photograph, so profiles need one.
--
-- The photo is a normal media_object, which means it inherits everything that
-- already applies to media: signed short-lived tickets, no direct URLs, view
-- logging, and deletion cascading properly. Setting it to NULL on media
-- deletion means removing the photo never leaves a profile pointing at a file
-- that is gone.
ALTER TABLE profiles
  ADD COLUMN photo_media_id uuid REFERENCES media_objects(id) ON DELETE SET NULL;
