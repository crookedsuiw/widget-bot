-- Phase 2, slice 1: manager dashboard login, lead capture and conversation analysis.

-- One shared manager login per client (password hashed with scrypt by auth.py)
CREATE TABLE admin_accounts (
    id            BIGSERIAL PRIMARY KEY,
    client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only a SHA-256 of the cookie token is stored. Rows are kept after expiry as a login log.
CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    ip         TEXT,
    user_agent TEXT
);
CREATE INDEX ON admin_sessions (account_id);

-- A visitor who asked to be called back. One per conversation; re-submitting updates it.
CREATE TABLE leads (
    id              BIGSERIAL PRIMARY KEY,
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    name            TEXT,
    phone           TEXT NOT NULL,
    consent_text    TEXT NOT NULL,          -- exactly what the visitor agreed to
    consent_at      TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'converted', 'not_interested')),
    summary         TEXT,                   -- AI summary of the chat
    interest_level  TEXT CHECK (interest_level IN ('hot', 'warm', 'cold')),
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    seen_at         TIMESTAMPTZ,            -- NULL = not yet seen by a manager
    contacted_at    TIMESTAMPTZ,
    email_sent_at   TIMESTAMPTZ
);
CREATE INDEX ON leads (client_id, created_at DESC);

-- AI analysis of each conversation, used to sort potential customers
ALTER TABLE conversations
    ADD COLUMN intent              TEXT CHECK (intent IN ('purchase_interest', 'product_question', 'support', 'other')),
    ADD COLUMN interest_level      TEXT CHECK (interest_level IN ('hot', 'warm', 'cold')),
    ADD COLUMN summary             TEXT,
    ADD COLUMN analyzed_at         TIMESTAMPTZ,
    ADD COLUMN callback_offered_at TIMESTAMPTZ;  -- the callback card is offered at most once

-- faq_id: which FAQ answered (tier 1). unanswered: the model said the site doesn't cover it.
ALTER TABLE messages
    ADD COLUMN faq_id     BIGINT REFERENCES faqs(id) ON DELETE SET NULL,
    ADD COLUMN unanswered BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE clients
    ADD COLUMN alert_email    TEXT,  -- where new-lead emails go
    ADD COLUMN retention_days INT;   -- NULL = keep chats forever (purge job comes in slice 4)

-- Offer the callback card after this many visitor messages, even without a buying signal. 0 = off.
ALTER TABLE bot_settings
    ADD COLUMN callback_after_messages INT NOT NULL DEFAULT 4;

-- Tokens spent outside customer replies (chat reply tokens are already on messages)
CREATE TABLE llm_usage (
    id                BIGSERIAL PRIMARY KEY,
    client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    purpose           TEXT NOT NULL CHECK (purpose IN ('summary', 'playground')),
    prompt_tokens     INT NOT NULL,
    completion_tokens INT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON llm_usage (client_id, created_at);
