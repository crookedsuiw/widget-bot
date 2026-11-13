-- Phase 2, slice 3: named prompt settings, each with its own linear version history and one draft.

-- A named setting ("Friendly", "Sales push"). Its versions are bot_settings rows.
CREATE TABLE bot_profiles (
    id         BIGSERIAL PRIMARY KEY,
    client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, name)
);

-- Versions are numbered per setting; a draft has no number until it is merged.
-- is_active (one per client, existing index) still marks the version visitors get.
ALTER TABLE bot_settings
    ADD COLUMN profile_id BIGINT REFERENCES bot_profiles(id) ON DELETE CASCADE,
    ADD COLUMN is_draft   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN note       TEXT,          -- optional "what changed", set on merge
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ALTER COLUMN version DROP NOT NULL,
    ADD CONSTRAINT bot_settings_version_unless_draft CHECK (is_draft OR version IS NOT NULL),
    ADD CONSTRAINT bot_settings_draft_not_active CHECK (NOT (is_draft AND is_active)),
    DROP CONSTRAINT bot_settings_client_id_version_key;

-- Existing rows become the versions of a setting called "Default"
INSERT INTO bot_profiles (client_id, name) SELECT DISTINCT client_id, 'Default' FROM bot_settings;
UPDATE bot_settings s SET profile_id = p.id FROM bot_profiles p WHERE p.client_id = s.client_id;
ALTER TABLE bot_settings ALTER COLUMN profile_id SET NOT NULL;

CREATE UNIQUE INDEX bot_settings_profile_version ON bot_settings (profile_id, version);
CREATE UNIQUE INDEX bot_settings_one_draft ON bot_settings (profile_id) WHERE is_draft;

-- Widget text is per website, not per prompt setting: it moves to clients (edited on the Widget page)
ALTER TABLE clients
    ADD COLUMN welcome_title TEXT NOT NULL DEFAULT 'Hi! How can we help?',
    ADD COLUMN greeting      TEXT NOT NULL DEFAULT '',
    ADD COLUMN quick_replies JSONB NOT NULL DEFAULT '[]';
UPDATE clients c SET welcome_title = s.welcome_title, greeting = s.greeting, quick_replies = s.quick_replies
FROM bot_settings s WHERE s.client_id = c.id AND s.is_active;
ALTER TABLE bot_settings
    DROP COLUMN welcome_title,
    DROP COLUMN greeting,
    DROP COLUMN quick_replies;
