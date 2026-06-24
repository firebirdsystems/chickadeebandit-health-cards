CREATE TABLE IF NOT EXISTS app_health_cards__health_profiles (
  id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS app_health_cards__health_allergies (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'moderate',
  triggers TEXT NOT NULL DEFAULT '',
  symptoms TEXT NOT NULL DEFAULT '',
  response_steps TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS app_health_cards__health_medications (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dose TEXT NOT NULL DEFAULT '',
  when_to_give TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS app_health_cards__health_contacts (
  id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS health_profiles_member_idx
  ON app_health_cards__health_profiles (member_id);

CREATE INDEX IF NOT EXISTS health_allergies_profile_idx
  ON app_health_cards__health_allergies (profile_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS health_medications_profile_idx
  ON app_health_cards__health_medications (profile_id, created_at);

CREATE INDEX IF NOT EXISTS health_contacts_profile_idx
  ON app_health_cards__health_contacts (profile_id, priority, created_at);
