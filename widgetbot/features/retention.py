"""Deletes chats older than each client's retention period (Settings page). Messages and leads go with them."""
import asyncio
from core import db

PURGE_INTERVAL_SECONDS = 6 * 60 * 60  # Daily is enough; more often just keeps the gap after a restart small

# Params: none
PURGE_QUERY = """
    DELETE FROM conversations v
    USING clients c
    WHERE c.id = v.client_id AND c.retention_days IS NOT NULL
      AND v.last_message_at < now() - make_interval(days => c.retention_days)
"""

# What a retention period would delete right now. Params: (client_id, days, client_id, days)
PREVIEW_QUERY = """
    SELECT (SELECT count(*) FROM conversations
            WHERE client_id = %s AND last_message_at < now() - make_interval(days => %s)) AS conversations,
           (SELECT count(*) FROM leads l JOIN conversations v ON v.id = l.conversation_id
            WHERE v.client_id = %s AND v.last_message_at < now() - make_interval(days => %s)) AS leads
"""

def preview(client_id, days):
    with db.pool.connection() as conn:
        return conn.execute(PREVIEW_QUERY, (client_id, days, client_id, days)).fetchone()

def purge_expired():
    with db.pool.connection() as conn:
        deleted = conn.execute(PURGE_QUERY).rowcount
    if deleted:
        print(f"[INFO] Retention: deleted {deleted} old conversation(s).")

async def retention_loop():
    """Started with the app; runs forever."""
    while True:
        try:
            await asyncio.to_thread(purge_expired)
        except Exception as e:
            print(f"[ERROR] Retention purge: {e}")
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)
