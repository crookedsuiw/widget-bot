-- Phase 0 schema: everything is scoped by client_id so more clients can be added later
-- without schema changes. Applied by migrate.py as the app's database user.

-- One row per website the widget is embedded on. widget_key is public (it ships in the embed snippet).
CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    widget_key      TEXT NOT NULL UNIQUE,
    allowed_origins TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every save from the dashboard inserts a new version; exactly one is active per client (rollback = flip is_active)
CREATE TABLE bot_settings (
    id             BIGSERIAL PRIMARY KEY,
    client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    version        INT NOT NULL,
    is_active      BOOLEAN NOT NULL DEFAULT false,
    bot_name       TEXT NOT NULL DEFAULT 'Assistant',
    persona        TEXT NOT NULL,
    instructions   TEXT NOT NULL DEFAULT '',
    do_not_rules   TEXT NOT NULL DEFAULT '',
    approved_links JSONB NOT NULL DEFAULT '[]',  -- [{"label": ..., "url": ...}]
    greeting       TEXT NOT NULL DEFAULT '',
    faq_threshold  REAL NOT NULL DEFAULT 0.70,
    rag_top_k      INT NOT NULL DEFAULT 5,
    model          TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, version)
);
CREATE UNIQUE INDEX bot_settings_one_active ON bot_settings (client_id) WHERE is_active;

-- Tier 1 canned answers; one is picked in rotation when the question embedding is close enough
CREATE TABLE faqs (
    id         BIGSERIAL PRIMARY KEY,
    client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    answers    TEXT[] NOT NULL,
    embedding  VECTOR(384) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, question)
);
CREATE INDEX ON faqs (client_id);

-- Pages the crawler visits. 'html' splits on headers first, 'recursive_only' splits plain text.
CREATE TABLE knowledge_sources (
    id        BIGSERIAL PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    url       TEXT NOT NULL,
    strategy  TEXT NOT NULL CHECK (strategy IN ('html', 'recursive_only')),
    enabled   BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (client_id, url)
);

CREATE TABLE crawl_runs (
    id          BIGSERIAL PRIMARY KEY,
    client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    chunk_count INT,
    error       TEXT
);
CREATE INDEX ON crawl_runs (client_id, started_at DESC);

-- RAG chunks. Old runs are deleted only after a new run fully succeeds.
CREATE TABLE chunks (
    id           UUID PRIMARY KEY,
    client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    crawl_run_id BIGINT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
    document     TEXT NOT NULL,
    metadata     JSONB NOT NULL,
    embedding    VECTOR(384) NOT NULL
);
CREATE INDEX ON chunks (client_id);
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    origin          TEXT,  -- website the widget was loaded on
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (client_id, last_message_at DESC);

-- Token/latency/error columns are only filled on bot rows; feedback is +1/-1 from the widget (Phase 1)
CREATE TABLE messages (
    id                BIGSERIAL PRIMARY KEY,
    conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role              TEXT NOT NULL CHECK (role IN ('user', 'bot')),
    content           TEXT NOT NULL,
    tier              SMALLINT,
    sources           JSONB NOT NULL DEFAULT '[]',
    prompt_tokens     INT,
    completion_tokens INT,
    latency_ms        INT,
    error             TEXT,
    feedback          SMALLINT CHECK (feedback IN (-1, 1)),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, id);
CREATE INDEX ON messages (created_at);
