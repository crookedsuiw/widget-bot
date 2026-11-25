"""AI summary and classification of conversations, so managers can sort potential customers.

Runs right after a visitor asks for a callback (leads.py) and in a background loop for idle chats.
"""
import asyncio
import json
import os
import re
from features import chat_engine
from core import db

# A conversation is analysed once it has been quiet this long (and again if it continues later)
ANALYSIS_IDLE_MINUTES = int(os.environ.get("ANALYSIS_IDLE_MINUTES", "30"))
ANALYSIS_INTERVAL_SECONDS = 600   # How often the background loop looks for idle chats
ANALYSIS_BATCH_SIZE = 20          # Conversations analysed per loop pass
MIN_VISITOR_MESSAGES = 2          # One-question chats aren't worth the tokens
TRANSCRIPT_MAX_MESSAGES = 40
TRANSCRIPT_MAX_CHARS = 500        # Per message, to keep the prompt small
ANALYSIS_TEMPERATURE = 0.2        # Low: the JSON shape and hot/warm/cold labels should be consistent
# Defaults to the client's chat model; set a cheaper/faster one here if needed
ANALYSIS_MODEL = os.environ.get("ANALYSIS_MODEL")

INTENTS = ("purchase_interest", "product_question", "support", "other")
INTEREST_LEVELS = ("hot", "warm", "cold")

# Params: (conversation_id, limit)
TRANSCRIPT_QUERY = """
    SELECT role, content FROM (
        SELECT id, role, content FROM messages WHERE conversation_id = %s ORDER BY id DESC LIMIT %s
    ) recent ORDER BY id
"""

# Params: (intent, interest_level, summary, conversation_id)
SAVE_ANALYSIS_QUERY = """
    UPDATE conversations SET intent = %s, interest_level = %s, summary = %s, analyzed_at = now()
    WHERE id = %s
"""

# Params: (client_id, prompt_tokens, completion_tokens)
LOG_USAGE_QUERY = """
    INSERT INTO llm_usage (client_id, purpose, prompt_tokens, completion_tokens) VALUES (%s, 'summary', %s, %s)
"""

# Idle conversations not analysed since their last message. Params: (idle_minutes, min_visitor_messages, limit)
IDLE_CONVERSATIONS_QUERY = """
    SELECT c.id, c.client_id, EXISTS (SELECT 1 FROM leads WHERE conversation_id = c.id) AS has_lead
    FROM conversations c
    WHERE c.last_message_at < now() - make_interval(mins => %s)
      AND (c.analyzed_at IS NULL OR c.analyzed_at < c.last_message_at)
      AND (SELECT count(*) FROM messages WHERE conversation_id = c.id AND role = 'user') >= %s
    ORDER BY c.last_message_at DESC
    LIMIT %s
"""

ANALYSIS_PROMPT = """You are reviewing a chat between a website visitor (a parent) and {client_name}'s assistant, to help the sales team prioritise follow-ups.
{lead_note}
Reply with ONLY a JSON object, no other text:
{{"summary": "1-2 sentences: what the visitor wants and anything useful for a follow-up call",
  "intent": "purchase_interest" | "product_question" | "support" | "other",
  "interest_level": "hot" | "warm" | "cold"}}

interest_level guide: hot = ready to buy, asked about pricing/demo/orders, or asked for a call; warm = actively evaluating the product; cold = casual curiosity or a support question.

Chat:
{transcript}"""

def _plain(text):
    """Bot replies contain button HTML; the model only needs the words."""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()[:TRANSCRIPT_MAX_CHARS]

def _parse_analysis(text):
    """Pulls the first JSON object out of the reply and keeps only valid values."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL)
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return {
        "summary": str(data.get("summary") or "").strip()[:600] or None,
        "intent": data.get("intent") if data.get("intent") in INTENTS else "other",
        "interest_level": data.get("interest_level") if data.get("interest_level") in INTEREST_LEVELS else None,
    }

def summarize_conversation(client_id, conversation_id, has_lead=False):
    """Analyses one conversation and stores the result on it. Returns the analysis dict, or None on failure.

    Blocking (DB + Groq): call from a worker thread when inside async code.
    """
    client = db.get_client_by_id(client_id)
    settings = db.get_active_settings(client_id)
    with db.pool.connection() as conn:
        rows = conn.execute(TRANSCRIPT_QUERY, (conversation_id, TRANSCRIPT_MAX_MESSAGES)).fetchall()
    if not rows or client is None or settings is None:
        return None

    transcript = "\n".join(f"{'Visitor' if r['role'] == 'user' else 'Assistant'}: {_plain(r['content'])}" for r in rows)
    prompt = ANALYSIS_PROMPT.format(
        client_name=client["name"],
        lead_note="The visitor has asked the team to call them back." if has_lead else "",
        transcript=transcript,
    )
    text, usage, error = chat_engine.complete(prompt, ANALYSIS_MODEL or settings["model"], ANALYSIS_TEMPERATURE)
    if usage:
        with db.pool.connection() as conn:
            conn.execute(LOG_USAGE_QUERY, (client_id, usage.prompt_tokens, usage.completion_tokens))
    analysis = None if error else _parse_analysis(text)
    if analysis is None:
        print(f"[WARN] Conversation analysis failed for {conversation_id}: {error or 'unparseable reply'}")
        return None

    if has_lead:
        analysis["interest_level"] = "hot"  # Asking for a call is the strongest buying signal we get
    with db.pool.connection() as conn:
        conn.execute(SAVE_ANALYSIS_QUERY, (analysis["intent"], analysis["interest_level"],
                                           analysis["summary"], conversation_id))
    return analysis

def analyze_idle_conversations():
    with db.pool.connection() as conn:
        pending = conn.execute(IDLE_CONVERSATIONS_QUERY,
                               (ANALYSIS_IDLE_MINUTES, MIN_VISITOR_MESSAGES, ANALYSIS_BATCH_SIZE)).fetchall()
    for row in pending:
        summarize_conversation(row["client_id"], row["id"], row["has_lead"])
    if pending:
        print(f"[INFO] Analysed {len(pending)} idle conversation(s).")

async def analysis_loop():
    """Started with the app; runs forever."""
    while True:
        try:
            await asyncio.to_thread(analyze_idle_conversations)
        except Exception as e:
            print(f"[ERROR] Conversation analysis loop: {e}")
        await asyncio.sleep(ANALYSIS_INTERVAL_SECONDS)
