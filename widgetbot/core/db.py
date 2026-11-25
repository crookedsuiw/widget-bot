import os
import time
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pgvector.psycopg import register_vector

from dotenv import load_dotenv

load_dotenv()

# Never hardcode a password here: put it in DATABASE_URL, or leave it out and set PGPASSWORD (or ~/.pgpass)
DATABASE_URL = os.environ.get("DATABASE_URL", "")

# How long client/settings lookups are cached, so dashboard edits apply without a restart
CACHE_TTL_SECONDS = 30

# --- Queries ---

# Params: (widget_key,)
GET_CLIENT_BY_KEY_QUERY = """
    SELECT id, slug, name, widget_key, allowed_origins, logo_url, privacy_url, welcome_title, greeting, quick_replies, consent_text, alert_email
    FROM clients WHERE widget_key = %s
"""

# Params: (slug,)
GET_CLIENT_BY_SLUG_QUERY = """
    SELECT id, slug, name, widget_key, allowed_origins, logo_url, privacy_url, welcome_title, greeting, quick_replies, consent_text, alert_email
    FROM clients WHERE slug = %s
"""

# Two rows are enough to tell "exactly one client" from "several". No params.
LIST_CLIENT_SLUGS_QUERY = "SELECT slug FROM clients ORDER BY created_at LIMIT 2"

# Params: (client_id,)
GET_CLIENT_BY_ID_QUERY = """
    SELECT id, slug, name, widget_key, allowed_origins, logo_url, privacy_url, welcome_title, greeting, quick_replies, consent_text, alert_email,
           retention_days
    FROM clients WHERE id = %s
"""

# Params: (client_id,)
# The FAQ threshold lives on the client (FAQs page), the rest on the live prompt setting
GET_ACTIVE_SETTINGS_QUERY = """
    SELECT s.*, c.faq_threshold FROM bot_settings s JOIN clients c ON c.id = s.client_id
    WHERE s.client_id = %s AND s.is_active
"""

# Params: (client_id,)
GET_FAQ_THRESHOLD_QUERY = "SELECT faq_threshold FROM clients WHERE id = %s"

# Closest FAQ wording. `<=>` is pgvector's cosine distance, so similarity = 1 - distance.
# Params: (query_embedding, client_id, query_embedding)
MATCH_FAQ_QUERY = """
    SELECT f.id, q.question, f.answers, f.button_label, f.button_url, 1 - (q.embedding <=> %s) AS similarity
    FROM faq_questions q JOIN faqs f ON f.id = q.faq_id
    WHERE q.client_id = %s
    ORDER BY q.embedding <=> %s
    LIMIT 1
"""

# Nearest-neighbour search over the client's website extracts (minus hidden text) and their own notes,
# closest first. Each side is limited on its own so the extract search can still use its vector index.
# Params: dict (client_id, embedding, top_k)
RAG_RETRIEVAL_QUERY = """
    SELECT document, metadata, similarity FROM (
        (SELECT c.document, c.metadata, 1 - (c.embedding <=> %(embedding)s) AS similarity
         FROM chunks c
         WHERE c.client_id = %(client_id)s
           AND NOT EXISTS (SELECT 1 FROM hidden_chunks h WHERE h.client_id = c.client_id AND h.text_hash = md5(c.document))
         ORDER BY c.embedding <=> %(embedding)s
         LIMIT %(top_k)s)
        UNION ALL
        (SELECT n.title || E'\n' || n.body, jsonb_build_object('note_id', n.id, 'title', n.title),
                1 - (n.embedding <=> %(embedding)s)
         FROM knowledge_notes n
         WHERE n.client_id = %(client_id)s
         ORDER BY n.embedding <=> %(embedding)s
         LIMIT %(top_k)s)
    ) found
    ORDER BY similarity DESC
    LIMIT %(top_k)s
"""

# Only reuse a conversation if it belongs to this client; otherwise a new one is started.
# Params: (conversation_id, client_id)
GET_CONVERSATION_QUERY = """
    SELECT id FROM conversations WHERE id = %s AND client_id = %s
"""

# Params: (client_id, origin)
CREATE_CONVERSATION_QUERY = """
    INSERT INTO conversations (client_id, origin) VALUES (%s, %s) RETURNING id
"""

# Newest first; reversed in Python. Params: (conversation_id, limit)
RECENT_MESSAGES_QUERY = """
    SELECT role, content FROM messages
    WHERE conversation_id = %s
    ORDER BY id DESC
    LIMIT %s
"""

# Params: (conversation_id, role, content, tier, sources, prompt_tokens, completion_tokens, latency_ms, error,
#          faq_id, unanswered)
INSERT_MESSAGE_QUERY = """
    INSERT INTO messages
        (conversation_id, role, content, tier, sources, prompt_tokens, completion_tokens, latency_ms, error,
         faq_id, unanswered)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    RETURNING id
"""

# What decides whether to offer the callback card. Params: (conversation_id,)
CALLBACK_STATE_QUERY = """
    SELECT c.callback_offered_at,
           (SELECT count(*) FROM messages WHERE conversation_id = c.id AND role = 'user') AS user_messages,
           EXISTS (SELECT 1 FROM leads WHERE conversation_id = c.id) AS has_lead
    FROM conversations c
    WHERE c.id = %s
"""

# Atomic, so two quick messages can't both trigger the card. Params: (conversation_id,)
MARK_CALLBACK_OFFERED_QUERY = """
    UPDATE conversations SET callback_offered_at = now()
    WHERE id = %s AND callback_offered_at IS NULL
    RETURNING id
"""

# Full transcript for the widget, scoped to the client. Params: (conversation_id, client_id)
CONVERSATION_MESSAGES_QUERY = """
    SELECT m.id, m.role, m.content, m.sources, m.feedback, m.created_at
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = %s AND c.client_id = %s
    ORDER BY m.id
"""

# History list: title = first user message. Params: (conversation_ids, client_id)
CONVERSATION_SUMMARIES_QUERY = """
    SELECT c.id, c.last_message_at,
           count(m.id) AS message_count,
           (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY id LIMIT 1) AS title
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE c.id = ANY(%s) AND c.client_id = %s
    GROUP BY c.id
    ORDER BY c.last_message_at DESC
"""

# Only bot replies in the caller's own conversation can be rated. Params: (feedback, message_id, conversation_id)
SET_FEEDBACK_QUERY = """
    UPDATE messages SET feedback = %s
    WHERE id = %s AND conversation_id = %s AND role = 'bot'
"""

# Params: (conversation_id,)
TOUCH_CONVERSATION_QUERY = """
    UPDATE conversations SET last_message_at = now() WHERE id = %s
"""

# --- Connection pool (used by the web app; scripts use psycopg.connect directly) ---

pool = None

def open_pool():
    global pool
    # check_connection replaces dead connections, e.g. after Postgres restarts
    pool = ConnectionPool(
        DATABASE_URL,
        configure=register_vector,
        kwargs={"autocommit": True, "row_factory": dict_row},
        check=ConnectionPool.check_connection,
        open=True,
    )
    return pool

# --- Cached lookups ---

_client_cache = {}    # widget_key or "slug:<slug>" -> (expires_at, client)
_settings_cache = {}  # client_id -> (expires_at, settings)

def _cached(cache, key, loader):
    hit = cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    value = loader()
    cache[key] = (time.monotonic() + CACHE_TTL_SECONDS, value)
    return value

def get_client(widget_key):
    def load():
        with pool.connection() as conn:
            return conn.execute(GET_CLIENT_BY_KEY_QUERY, (widget_key,)).fetchone()
    return _cached(_client_cache, widget_key, load)

def get_client_by_slug(slug):
    def load():
        with pool.connection() as conn:
            return conn.execute(GET_CLIENT_BY_SLUG_QUERY, (slug,)).fetchone()
    return _cached(_client_cache, f"slug:{slug}", load)

def sole_client_slug(conn=None):
    """Slug of the install's only client, used when no client is named. Raises LookupError for zero or several.

    Scripts pass their own psycopg connection; the web app leaves conn out and uses the pool.
    """
    if conn is None:
        with pool.connection() as pooled:
            return sole_client_slug(pooled)
    rows = conn.execute(LIST_CLIENT_SLUGS_QUERY).fetchall()
    if not rows:
        raise LookupError("No client exists yet. Run: python -m scripts.seed --client <slug>")
    if len(rows) > 1:
        raise LookupError("Several clients exist. Pass --client <slug>, or set DEFAULT_CLIENT_SLUG for the web app.")
    row = rows[0]
    return row["slug"] if isinstance(row, dict) else row[0]

def get_client_by_id(client_id):
    def load():
        with pool.connection() as conn:
            return conn.execute(GET_CLIENT_BY_ID_QUERY, (client_id,)).fetchone()
    return _cached(_client_cache, f"id:{client_id}", load)

def invalidate_client(client):
    """Called after the Settings page changes the client row, so the widget and alerts use it now."""
    for key in (client["widget_key"], f"slug:{client['slug']}", f"id:{client['id']}"):
        _client_cache.pop(key, None)

def get_active_settings(client_id):
    def load():
        with pool.connection() as conn:
            return conn.execute(GET_ACTIVE_SETTINGS_QUERY, (client_id,)).fetchone()
    return _cached(_settings_cache, client_id, load)

def invalidate_settings(client_id):
    """Called when the live prompt setting or FAQ threshold changes, so visitors get it now instead of after the cache expires."""
    _settings_cache.pop(client_id, None)

def get_faq_threshold(client_id):
    with pool.connection() as conn:
        return conn.execute(GET_FAQ_THRESHOLD_QUERY, (client_id,)).fetchone()["faq_threshold"]

# --- Retrieval ---

def match_faq(client_id, query_embedding):
    """Returns the closest FAQ row (with a `similarity` field), or None if the client has no FAQs."""
    with pool.connection() as conn:
        return conn.execute(MATCH_FAQ_QUERY, (query_embedding, client_id, query_embedding)).fetchone()

def retrieve_chunks(client_id, query_embedding, top_k):
    """Website extracts and notes for the prompt: rows of document, metadata (url, or note_id + title), similarity."""
    with pool.connection() as conn:
        return conn.execute(RAG_RETRIEVAL_QUERY, {"client_id": client_id, "embedding": query_embedding,
                                                  "top_k": top_k}).fetchall()

# --- Conversations ---

def get_or_create_conversation(client_id, conversation_id, origin):
    with pool.connection() as conn:
        if conversation_id:
            row = conn.execute(GET_CONVERSATION_QUERY, (conversation_id, client_id)).fetchone()
            if row:
                return row["id"]
        return conn.execute(CREATE_CONVERSATION_QUERY, (client_id, origin)).fetchone()["id"]

def get_recent_messages(conversation_id, limit):
    with pool.connection() as conn:
        rows = conn.execute(RECENT_MESSAGES_QUERY, (conversation_id, limit)).fetchall()
    return list(reversed(rows))

def log_turn(conversation_id, user_message, bot_message, tier, sources,
             prompt_tokens=None, completion_tokens=None, latency_ms=None, error=None,
             faq_id=None, unanswered=False):
    """Stores the user message and the bot reply together. Returns the bot message id."""
    with pool.connection() as conn, conn.transaction():
        conn.execute(INSERT_MESSAGE_QUERY,
                     (conversation_id, "user", user_message, tier, Jsonb([]), None, None, None, None, None, False))
        bot_row = conn.execute(INSERT_MESSAGE_QUERY,
                               (conversation_id, "bot", bot_message, tier, Jsonb(sources),
                                prompt_tokens, completion_tokens, latency_ms, error,
                                faq_id, unanswered)).fetchone()
        conn.execute(TOUCH_CONVERSATION_QUERY, (conversation_id,))
    return bot_row["id"]

def should_offer_callback(conversation_id, wants_callback, after_messages):
    """True at most once per conversation: on a buying signal, or after `after_messages` visitor messages."""
    with pool.connection() as conn:
        state = conn.execute(CALLBACK_STATE_QUERY, (conversation_id,)).fetchone()
        if state is None or state["callback_offered_at"] or state["has_lead"]:
            return False
        reached_count = after_messages > 0 and state["user_messages"] >= after_messages
        if not (wants_callback or reached_count):
            return False
        return conn.execute(MARK_CALLBACK_OFFERED_QUERY, (conversation_id,)).fetchone() is not None

def get_conversation_messages(client_id, conversation_id):
    with pool.connection() as conn:
        return conn.execute(CONVERSATION_MESSAGES_QUERY, (conversation_id, client_id)).fetchall()

def get_conversation_summaries(client_id, conversation_ids):
    with pool.connection() as conn:
        return conn.execute(CONVERSATION_SUMMARIES_QUERY, (conversation_ids, client_id)).fetchall()

def set_feedback(conversation_id, message_id, feedback):
    """Returns False when the message isn't a bot reply in that conversation."""
    with pool.connection() as conn:
        return conn.execute(SET_FEEDBACK_QUERY, (feedback, message_id, conversation_id)).rowcount == 1
