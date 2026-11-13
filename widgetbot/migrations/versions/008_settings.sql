-- Phase 2, slice 6: Settings page. Consent wording per client; chat retention gets its limits.

-- What visitors agree to in the callback form; NULL = the default wording in leads.py
ALTER TABLE clients ADD COLUMN consent_text TEXT;

-- retention_days (added in 003): chats with their leads older than this are deleted daily; NULL = keep forever.
-- At least 90 so the Overview's longest range is never cut short.
ALTER TABLE clients ADD CONSTRAINT clients_retention_min CHECK (retention_days IS NULL OR retention_days >= 90);
