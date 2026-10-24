-- A care team: the hub member group whose members read every health card
-- marked "care" (visibility = 'care') — the child's allergies, emergency
-- medications and contacts — without reaching the adults' own cards. A nanny
-- who signs in as a guest, or a grandparent. Medications has its own setting
-- under the same key name; an admin chooses the same group in each app.
--
-- Who may read a card. 'adults' (the default, and what every existing card
-- keeps) is the adults of the household; 'care' adds the care team. Plaintext
-- (manifest db_plaintext_columns): the row policy compares it.
ALTER TABLE app_health_cards__health_profiles ADD COLUMN visibility TEXT NOT NULL DEFAULT 'adults';

-- Who wrote each entry, stamped by the hub on INSERT (row policy
-- inherit_visibility writer_column). Plaintext by suffix (_by).
ALTER TABLE app_health_cards__health_allergies ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

ALTER TABLE app_health_cards__health_medications ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

ALTER TABLE app_health_cards__health_contacts ADD COLUMN created_by TEXT NOT NULL DEFAULT '';

-- Entries whose card no longer exists are removed first. Nothing can show
-- them, and left in place one could be adopted: a new card INSERTed under the
-- old card's id, owned by a child, would take the stale entries with it. The
-- delete_cascades on health_profiles keep this from happening again.
-- Idempotent: a replay finds no orphan.
DELETE FROM app_health_cards__health_allergies
 WHERE NOT EXISTS (SELECT 1 FROM app_health_cards__health_profiles p WHERE p.id = profile_id);

DELETE FROM app_health_cards__health_medications
 WHERE NOT EXISTS (SELECT 1 FROM app_health_cards__health_profiles p WHERE p.id = profile_id);

DELETE FROM app_health_cards__health_contacts
 WHERE NOT EXISTS (SELECT 1 FROM app_health_cards__health_profiles p WHERE p.id = profile_id);

-- Entries written before the column existed are credited to the card's own
-- member. Left as '', they match no writer: in a co-parenting space (no
-- supervision bypass) nobody could change them, and in a general space only
-- the steward could. member_id is plaintext (_id), so the copy is too. Every
-- entry left has a card (the deletes above). Idempotent: a replay finds no ''.
UPDATE app_health_cards__health_allergies
   SET created_by = (SELECT p.member_id FROM app_health_cards__health_profiles p WHERE p.id = profile_id)
 WHERE created_by = '';

UPDATE app_health_cards__health_medications
   SET created_by = (SELECT p.member_id FROM app_health_cards__health_profiles p WHERE p.id = profile_id)
 WHERE created_by = '';

UPDATE app_health_cards__health_contacts
   SET created_by = (SELECT p.member_id FROM app_health_cards__health_profiles p WHERE p.id = profile_id)
 WHERE created_by = '';

-- key/value settings, one key so far: care_team_group_id. Written only by the
-- admin-gated /api/admin-config endpoint (row policy app_config), never by
-- app SQL: if any adult could point it at a group, any adult could grant
-- themselves what the care team sees. The row policy on health_profiles reads
-- it (privileged_groups).
CREATE TABLE IF NOT EXISTS app_health_cards__settings (
  key    TEXT NOT NULL,
  value  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (key)
);
