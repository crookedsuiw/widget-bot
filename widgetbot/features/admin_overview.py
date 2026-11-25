"""Dashboard Overview API: usage stats, the website re-crawl and the crawl URL list.

Every query is scoped to the logged-in account's client_id.
"""
import asyncio
import ipaddress
import os
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, Field
from core import auth
import crawler
from core import db

api = APIRouter(prefix="/admin/api", dependencies=[Depends(auth.require_account)])

RANGE_DAYS = (7, 30, 90)
DEFAULT_TIMEZONE = "Asia/Kolkata"
LIST_LIMIT = 8            # Rows in the "unanswered questions" and "most-used FAQs" lists
CRAWL_HISTORY_LIMIT = 5

# Groq prices in USD per million tokens, e.g. GROQ_INPUT_PRICE_PER_M=0.29. Unset = no cost estimate.
def _price(name):
    value = os.environ.get(name, "").strip()
    return float(value) if value else None

INPUT_PRICE_PER_M = _price("GROQ_INPUT_PRICE_PER_M")
OUTPUT_PRICE_PER_M = _price("GROQ_OUTPUT_PRICE_PER_M")

TIMEZONES_QUERY = "SELECT name FROM pg_timezone_names"

# --- Queries (params: client_id, since, tz) ---

# Headline numbers for the period. Conversations count only if the visitor actually sent something.
TOTALS_QUERY = """
    WITH bot AS (
        SELECT m.tier, m.feedback, m.unanswered, m.error, m.latency_ms, m.prompt_tokens, m.completion_tokens
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.client_id = %(client_id)s AND m.created_at >= %(since)s AND m.role = 'bot'
    )
    SELECT
        (SELECT count(*) FROM conversations c WHERE c.client_id = %(client_id)s AND c.started_at >= %(since)s
            AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)) AS conversations,
        (SELECT count(*) FROM leads WHERE client_id = %(client_id)s AND created_at >= %(since)s) AS leads,
        count(*) AS replies,
        count(*) FILTER (WHERE tier = 1) AS tier_faq,
        count(*) FILTER (WHERE tier = 2) AS tier_ai,
        count(*) FILTER (WHERE tier = 3) AS tier_rag,
        count(*) FILTER (WHERE feedback = 1) AS thumbs_up,
        count(*) FILTER (WHERE feedback = -1) AS thumbs_down,
        count(*) FILTER (WHERE unanswered) AS unanswered,
        count(*) FILTER (WHERE error IS NOT NULL) AS errors,
        -- FAQ answers take milliseconds, so they would hide how long the AI takes
        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE tier <> 1 AND error IS NULL) AS ai_latency_ms,
        coalesce(sum(prompt_tokens), 0) AS chat_prompt_tokens,
        coalesce(sum(completion_tokens), 0) AS chat_completion_tokens
    FROM bot
"""

# Tokens spent outside customer replies (conversation summaries, prompt tests)
OTHER_TOKENS_QUERY = """
    SELECT coalesce(sum(prompt_tokens), 0) AS prompt_tokens, coalesce(sum(completion_tokens), 0) AS completion_tokens
    FROM llm_usage WHERE client_id = %(client_id)s AND created_at >= %(since)s
"""

INTEREST_QUERY = """
    SELECT coalesce(c.interest_level, 'unknown') AS level, count(*) AS count
    FROM conversations c
    WHERE c.client_id = %(client_id)s AND c.started_at >= %(since)s
      AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
    GROUP BY 1
"""

# One row per local day that has data; days without data are filled with zeros in Python
DAILY_QUERY = """
    WITH conv AS (
        SELECT (c.started_at AT TIME ZONE %(tz)s)::date AS day, count(*) AS conversations
        FROM conversations c
        WHERE c.client_id = %(client_id)s AND c.started_at >= %(since)s
          AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
        GROUP BY 1
    ), lead AS (
        SELECT (created_at AT TIME ZONE %(tz)s)::date AS day, count(*) AS leads
        FROM leads WHERE client_id = %(client_id)s AND created_at >= %(since)s GROUP BY 1
    ), chat AS (
        SELECT (m.created_at AT TIME ZONE %(tz)s)::date AS day,
               sum(coalesce(m.prompt_tokens, 0) + coalesce(m.completion_tokens, 0)) AS chat_tokens
        FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.client_id = %(client_id)s AND m.created_at >= %(since)s AND m.role = 'bot'
        GROUP BY 1
    ), other AS (
        SELECT (created_at AT TIME ZONE %(tz)s)::date AS day, sum(prompt_tokens + completion_tokens) AS other_tokens
        FROM llm_usage WHERE client_id = %(client_id)s AND created_at >= %(since)s GROUP BY 1
    )
    SELECT day, coalesce(conv.conversations, 0) AS conversations, coalesce(lead.leads, 0) AS leads,
           coalesce(chat.chat_tokens, 0) AS chat_tokens, coalesce(other.other_tokens, 0) AS other_tokens
    FROM conv FULL JOIN lead USING (day) FULL JOIN chat USING (day) FULL JOIN other USING (day)
"""

# Latest questions the bot couldn't answer from the website, with the visitor message that caused them
UNANSWERED_QUERY = """
    SELECT b.id, b.conversation_id, b.created_at,
           (SELECT content FROM messages u WHERE u.conversation_id = b.conversation_id AND u.id < b.id
              AND u.role = 'user' ORDER BY u.id DESC LIMIT 1) AS question
    FROM messages b JOIN conversations c ON c.id = b.conversation_id
    WHERE c.client_id = %(client_id)s AND b.created_at >= %(since)s AND b.unanswered
    ORDER BY b.id DESC
    LIMIT %(limit)s
"""

TOP_FAQS_QUERY = """
    SELECT m.faq_id AS id, count(*) AS hits,
           (SELECT question FROM faq_questions q WHERE q.faq_id = m.faq_id ORDER BY position, id LIMIT 1) AS question
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.client_id = %(client_id)s AND m.created_at >= %(since)s AND m.faq_id IS NOT NULL
    GROUP BY m.faq_id
    ORDER BY hits DESC, question
    LIMIT %(limit)s
"""

# Params: (client_id, limit)
CRAWL_RUNS_QUERY = """
    SELECT id, status, started_at, finished_at, chunk_count, error, pages
    FROM crawl_runs WHERE client_id = %s ORDER BY started_at DESC LIMIT %s
"""

# Params: (client_id,)
SOURCES_QUERY = """
    SELECT id, url, strategy, enabled FROM knowledge_sources WHERE client_id = %s ORDER BY id
"""

# Params: (client_id,). Chunks the bot is answering from right now, per page.
CURRENT_CHUNKS_QUERY = """
    SELECT metadata->>'url' AS url, count(*) AS chunks FROM chunks WHERE client_id = %s GROUP BY 1
"""

# Params: (client_id, url, strategy)
ADD_SOURCE_QUERY = """
    INSERT INTO knowledge_sources (client_id, url, strategy) VALUES (%s, %s, %s)
    RETURNING id, url, strategy, enabled
"""

# Params: dict(enabled, strategy, source_id, client_id); a NULL value leaves that field unchanged
UPDATE_SOURCE_QUERY = """
    UPDATE knowledge_sources SET enabled = coalesce(%(enabled)s, enabled), strategy = coalesce(%(strategy)s, strategy)
    WHERE id = %(source_id)s AND client_id = %(client_id)s
    RETURNING id, url, strategy, enabled
"""

# Params: (source_id, client_id)
DELETE_SOURCE_QUERY = """
    DELETE FROM knowledge_sources WHERE id = %s AND client_id = %s RETURNING id
"""

# --- Request models ---

Strategy = Literal["html", "recursive_only"]

class SourceCreate(BaseModel):
    url: str = Field(max_length=2000)
    strategy: Strategy = "html"

class SourceUpdate(BaseModel):
    enabled: bool | None = None
    strategy: Strategy | None = None

# --- Overview stats ---

@lru_cache(maxsize=1)
def _timezones():
    """Names Postgres accepts. Python's list also has old aliases (e.g. Asia/Calcutta) that Postgres rejects."""
    with db.pool.connection() as conn:
        return {r["name"] for r in conn.execute(TIMEZONES_QUERY).fetchall()}

def _cost(prompt_tokens, completion_tokens):
    if INPUT_PRICE_PER_M is None or OUTPUT_PRICE_PER_M is None:
        return None
    return round((prompt_tokens * INPUT_PRICE_PER_M + completion_tokens * OUTPUT_PRICE_PER_M) / 1_000_000, 4)

@api.get("/overview")
async def overview(account=Depends(auth.require_account), days: int = Query(30), tz: str = Query(DEFAULT_TIMEZONE)):
    if days not in RANGE_DAYS:
        raise HTTPException(status_code=422, detail=f"days must be one of {RANGE_DAYS}")
    if tz not in _timezones():
        tz = DEFAULT_TIMEZONE  # The browser's zone is a hint; fall back rather than fail
    # The range starts at local midnight, so "last 7 days" means today plus the 6 days before it
    today = datetime.now(ZoneInfo(tz)).date()
    first_day = today - timedelta(days=days - 1)
    since = datetime.combine(first_day, datetime.min.time(), ZoneInfo(tz))
    params = {"client_id": account["client_id"], "since": since, "tz": tz, "limit": LIST_LIMIT}

    with db.pool.connection() as conn:
        totals = conn.execute(TOTALS_QUERY, params).fetchone()
        other = conn.execute(OTHER_TOKENS_QUERY, params).fetchone()
        interest = {r["level"]: r["count"] for r in conn.execute(INTEREST_QUERY, params).fetchall()}
        daily_rows = {r["day"]: r for r in conn.execute(DAILY_QUERY, params).fetchall()}
        unanswered = conn.execute(UNANSWERED_QUERY, params).fetchall()
        top_faqs = conn.execute(TOP_FAQS_QUERY, params).fetchall()

    empty_day = {"conversations": 0, "leads": 0, "chat_tokens": 0, "other_tokens": 0}
    daily = []
    for offset in range(days):
        day = first_day + timedelta(days=offset)
        row = daily_rows.get(day, empty_day)
        daily.append({"day": day.isoformat(), **{k: int(row[k]) for k in empty_day}})

    prompt_tokens = totals["chat_prompt_tokens"] + other["prompt_tokens"]
    completion_tokens = totals["chat_completion_tokens"] + other["completion_tokens"]
    latency = totals["ai_latency_ms"]
    return {
        "days": days,
        "from": first_day.isoformat(),
        "to": today.isoformat(),
        "totals": {
            **{k: v for k, v in totals.items() if k != "ai_latency_ms"},
            "ai_latency_ms": round(latency) if latency is not None else None,
            "other_prompt_tokens": other["prompt_tokens"],
            "other_completion_tokens": other["completion_tokens"],
        },
        "cost_usd": _cost(prompt_tokens, completion_tokens),
        "interest": interest,
        "daily": daily,
        "unanswered": unanswered,
        "top_faqs": top_faqs,
    }

# --- Website crawl ---

_crawl_tasks = set()  # Keeps running crawl tasks referenced until they finish

def _crawl_in_thread(client_id, run_id):
    """Runs the crawl on its own event loop: Playwright, embedding and psycopg calls would block the server's."""
    try:
        asyncio.run(crawler.run_crawl(client_id, run_id))
    except Exception as e:
        print(f"[ERROR] Dashboard crawl {run_id} failed: {e}")  # Already recorded on the crawl_runs row

def _crawl_state(client_id):
    with db.pool.connection() as conn:
        runs = conn.execute(CRAWL_RUNS_QUERY, (client_id, CRAWL_HISTORY_LIMIT)).fetchall()
        sources = conn.execute(SOURCES_QUERY, (client_id,)).fetchall()
        current = {r["url"]: r["chunks"] for r in conn.execute(CURRENT_CHUNKS_QUERY, (client_id,)).fetchall()}
    for source in sources:
        source["current_chunks"] = current.get(source["url"], 0)
    return {"running": bool(runs) and runs[0]["status"] == "running", "runs": runs, "sources": sources}

@api.get("/crawl")
async def crawl_state(account=Depends(auth.require_account)):
    return _crawl_state(account["client_id"])

@api.post("/crawl")
async def start_crawl(account=Depends(auth.require_account)):
    client_id = account["client_id"]
    run_id = await asyncio.to_thread(crawler.start_run, client_id)
    if run_id is None:
        raise HTTPException(status_code=409, detail="A crawl is already running")
    task = asyncio.create_task(asyncio.to_thread(_crawl_in_thread, client_id, run_id))
    _crawl_tasks.add(task)
    task.add_done_callback(_crawl_tasks.discard)
    return _crawl_state(client_id)

# --- Crawl URLs ---

def _check_crawl_url(raw):
    """Only public http(s) pages: the crawler runs on our server, so it must not be pointed at internal addresses."""
    url = raw.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="Enter a full web address starting with https://")
    host = parsed.hostname
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        raise HTTPException(status_code=422, detail="Local addresses can't be crawled")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return url
    if not ip.is_global:
        raise HTTPException(status_code=422, detail="Private network addresses can't be crawled")
    return url

@api.post("/sources")
async def add_source(body: SourceCreate, account=Depends(auth.require_account)):
    url = _check_crawl_url(body.url)
    try:
        with db.pool.connection() as conn:
            return conn.execute(ADD_SOURCE_QUERY, (account["client_id"], url, body.strategy)).fetchone()
    except UniqueViolation:
        raise HTTPException(status_code=409, detail="That address is already in the list")

@api.patch("/sources/{source_id}")
async def update_source(source_id: int, body: SourceUpdate, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        row = conn.execute(UPDATE_SOURCE_QUERY, {"enabled": body.enabled, "strategy": body.strategy,
                                                 "source_id": source_id, "client_id": account["client_id"]}).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Address not found")
    return row

@api.delete("/sources/{source_id}")
async def delete_source(source_id: int, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        row = conn.execute(DELETE_SOURCE_QUERY, (source_id, account["client_id"])).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Address not found")
    return {"ok": True}
