-- Phase 1: content the embeddable widget shows. Styling lives in static/widget/widget.css;
-- these are per-client text and links so the dashboard can edit them later.

-- Branding shown in the widget header and footer (NULL = bot name text / no privacy link)
ALTER TABLE clients
    ADD COLUMN logo_url    TEXT,
    ADD COLUMN privacy_url TEXT;

-- Welcome screen heading and quick-reply chips: [{"label": ..., "message": ..., "icon": "download"|"games"|"sparkle"|"phone"}]
ALTER TABLE bot_settings
    ADD COLUMN welcome_title TEXT NOT NULL DEFAULT 'Hi! How can we help?',
    ADD COLUMN quick_replies JSONB NOT NULL DEFAULT '[]';
