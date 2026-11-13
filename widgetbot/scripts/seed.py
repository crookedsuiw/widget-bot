"""Seeds one client: its settings, widget content, FAQs and crawl URLs.

Each client's content lives in scripts/clients/<slug>.py; to add a client, copy one of those files.
Safe to run more than once: existing rows are left untouched, so dashboard edits are never overwritten.
Usage (from widgetbot/): python -m scripts.seed --client <slug>
"""
import argparse
import importlib
import secrets
import psycopg
from psycopg.types.json import Jsonb
from pgvector.psycopg import register_vector
from core.db import DATABASE_URL
from core.embeddings import get_ov_embedding

# Params: (slug, name, widget_key, allowed_origins)
UPSERT_CLIENT_QUERY = """
    INSERT INTO clients (slug, name, widget_key, allowed_origins)
    VALUES (%s, %s, %s, %s)
    ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug  -- no-op update so RETURNING yields the existing row
    RETURNING id, widget_key
"""

# Creates the "Default" setting with version 1 live, only when the client has no settings yet. Params: dict
INSERT_INITIAL_SETTINGS_QUERY = """
    WITH profile AS (
        INSERT INTO bot_profiles (client_id, name)
        SELECT %(client_id)s, 'Default'
        WHERE NOT EXISTS (SELECT 1 FROM bot_profiles WHERE client_id = %(client_id)s)
        RETURNING id
    )
    INSERT INTO bot_settings
        (client_id, profile_id, version, is_active, bot_name, persona, instructions, do_not_rules, approved_links,
         rag_top_k, model)
    SELECT %(client_id)s, profile.id, 1, true, %(bot_name)s, %(persona)s, %(instructions)s, %(do_not_rules)s,
           %(approved_links)s, %(rag_top_k)s, %(model)s
    FROM profile
"""

# Only fills branding that is still empty. Params: (logo_url, privacy_url, client_id)
FILL_CLIENT_BRANDING_QUERY = """
    UPDATE clients
    SET logo_url = COALESCE(logo_url, %s), privacy_url = COALESCE(privacy_url, %s)
    WHERE id = %s
"""

# Fills the widget content once (while quick_replies is still empty), so later dashboard edits stick.
# Params: (welcome_title, greeting, quick_replies, client_id)
FILL_WIDGET_CONTENT_QUERY = """
    UPDATE clients
    SET welcome_title = %s, greeting = %s, quick_replies = %s
    WHERE id = %s AND quick_replies = '[]'::jsonb
"""

# Sets the FAQ threshold once (while it is still the column default), so later dashboard edits stick.
# Params: (faq_threshold, client_id)
FILL_FAQ_THRESHOLD_QUERY = "UPDATE clients SET faq_threshold = %s WHERE id = %s AND faq_threshold = 0.70"

# An FAQ with one wording, skipped when that wording already exists. Params: dict
INSERT_FAQ_QUERY = """
    WITH faq AS (
        INSERT INTO faqs (client_id, answers)
        SELECT %(client_id)s, %(answers)s
        WHERE NOT EXISTS (SELECT 1 FROM faq_questions WHERE client_id = %(client_id)s AND lower(question) = lower(%(question)s))
        RETURNING id
    )
    INSERT INTO faq_questions (faq_id, client_id, question, embedding)
    SELECT id, %(client_id)s, %(question)s, %(embedding)s FROM faq
"""

# Params: (client_id, url, strategy)
INSERT_SOURCE_QUERY = """
    INSERT INTO knowledge_sources (client_id, url, strategy)
    VALUES (%s, %s, %s)
    ON CONFLICT (client_id, url) DO NOTHING
"""

def seed(slug):
    c = importlib.import_module(f"scripts.clients.{slug}")
    questions = list(c.FAQS.keys())
    faq_embeddings = get_ov_embedding(questions).numpy() if questions else []

    with psycopg.connect(DATABASE_URL) as conn:
        register_vector(conn)
        client_id, widget_key = conn.execute(
            UPSERT_CLIENT_QUERY, (slug, c.CLIENT_NAME, secrets.token_urlsafe(16), c.ALLOWED_ORIGINS)
        ).fetchone()

        conn.execute(INSERT_INITIAL_SETTINGS_QUERY, {
            "client_id": client_id, "bot_name": c.BOT_NAME, "persona": c.PERSONA, "instructions": c.INSTRUCTIONS,
            "do_not_rules": c.DO_NOT_RULES, "approved_links": Jsonb(c.APPROVED_LINKS),
            "rag_top_k": c.RAG_TOP_K, "model": c.GROQ_MODEL_NAME,
        })
        conn.execute(FILL_FAQ_THRESHOLD_QUERY, (c.FAQ_THRESHOLD, client_id))
        conn.execute(FILL_CLIENT_BRANDING_QUERY, (c.LOGO_URL, c.PRIVACY_URL, client_id))
        conn.execute(FILL_WIDGET_CONTENT_QUERY, (c.WELCOME_TITLE, c.GREETING, Jsonb(c.QUICK_REPLIES), client_id))

        with conn.cursor() as cur:
            if questions:
                cur.executemany(INSERT_FAQ_QUERY, [
                    {"client_id": client_id, "question": question, "answers": c.FAQS[question], "embedding": embedding}
                    for question, embedding in zip(questions, faq_embeddings)
                ])
            cur.executemany(INSERT_SOURCE_QUERY, [
                (client_id, url, strategy) for url, strategy in c.KNOWLEDGE_SOURCES
            ])

    print(f"Seeded client '{slug}' (id {client_id}, widget_key {widget_key}).")

def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--client", required=True, help="client slug, matching a file in scripts/clients/")
    seed(parser.parse_args().client)

if __name__ == "__main__":
    main()
