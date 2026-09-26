-- The share page's title. A profile row holds only member_id, and a share
-- page's title must be a column, so the card-holder's display name is copied
-- here. The app refreshes it whenever it loads profiles and finds the member's
-- name different, and never writes '' (the encrypt codec refuses an empty
-- string), so until the first refresh an existing card's name is the default.
ALTER TABLE app_health_cards__health_profiles ADD COLUMN card_name TEXT NOT NULL DEFAULT '';
