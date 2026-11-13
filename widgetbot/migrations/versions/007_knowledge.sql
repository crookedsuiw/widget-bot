-- Phase 2, slice 5: knowledge base. Hidden extracts and the manager's own notes.

-- Extracts the bot should skip. Stored by the text's md5 (crawls replace every chunk row), so the next
-- crawl hides the same text again; if the page text changes, the new extract shows up.
CREATE TABLE hidden_chunks (
    client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    text_hash  TEXT NOT NULL,          -- md5(chunks.document)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, text_hash)
);

-- Knowledge that isn't on the website. Searched together with the extracts; crawls never touch it.
CREATE TABLE knowledge_notes (
    id         BIGSERIAL PRIMARY KEY,
    client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    embedding  VECTOR(384) NOT NULL,   -- of title + body
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON knowledge_notes (client_id);
