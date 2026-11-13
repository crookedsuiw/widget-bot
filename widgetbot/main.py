import os
import uuid
import time
import json
import asyncio
import hashlib
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Literal
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from core import db
from features import (
    chat_engine,
    leads,
    analysis,
    admin,
    admin_faqs,
    admin_knowledge,
    admin_overview,
    admin_prompts,
    admin_settings,
    retention,
)
import crawler

# --- Hyperparameters ---
# Per-client values (FAQ threshold, RAG top-k, model, prompt text) live in the bot_settings table
HISTORY_TURNS = 3  # Previous user/bot exchanges included in the prompt
# Client shown on the demo page at "/" and used when a request carries no widget_key.
# Optional: when unset, the install's only client is used.
DEFAULT_CLIENT_SLUG = os.environ.get("DEFAULT_CLIENT_SLUG")

# --- Abuse limits (the widget key is public, so these are what protect the Groq budget) ---
MAX_MESSAGE_CHARS = 1000      # Longer messages are rejected before any tokens are spent
RATE_LIMIT_PER_MINUTE = 20    # /chat calls per visitor IP
RATE_LIMIT_PER_DAY = 200
MAX_HISTORY_IDS = 20          # Conversations the widget remembers per browser

WIDGET_DIR = "static/widget"

# Setup Postgres (pgvector). Run migrate.py, seed.py and crawler.py first.
db.open_pool()

@asynccontextmanager
async def lifespan(app):
    # Crawls launched from the dashboard run inside this process, so any still marked running died with it
    await asyncio.to_thread(crawler.fail_interrupted_runs)
    # Live-alert streams would otherwise keep a restart (or --reload) waiting forever
    leads.close_streams_on_exit()
    # Sorts idle conversations into hot/warm/cold for the dashboard
    tasks = [asyncio.create_task(analysis.analysis_loop()),
             # Deletes chats past each client's retention period
             asyncio.create_task(retention.retention_loop())]
    yield
    for task in tasks:
        task.cancel()

app = FastAPI(lifespan=lifespan)
app.include_router(admin.api)     # /admin/api/* must be registered before the /admin/{page} catch-all
app.include_router(admin_overview.api)
app.include_router(admin_prompts.api)
app.include_router(admin_faqs.api)
app.include_router(admin_knowledge.api)
app.include_router(admin_settings.api)
app.include_router(admin.router)

# Mount static files
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

class ChatRequest(BaseModel):
    session_id: str = ""
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    widget_key: str | None = None
    origin: str | None = None  # Website the widget is embedded on (sent by widget.js)

class SummariesRequest(BaseModel):
    widget_key: str
    ids: list[str] = Field(max_length=MAX_HISTORY_IDS)

class FeedbackRequest(BaseModel):
    session_id: str
    value: Literal[1, -1, 0]  # 0 clears the rating

class LeadRequest(BaseModel):
    widget_key: str
    session_id: str
    name: str = Field(default="", max_length=leads.MAX_NAME_CHARS)
    phone: str = Field(min_length=6, max_length=25)
    consent: Literal[True]  # The form can't be sent without ticking the consent box

# Changes whenever a widget asset changes, so browsers re-fetch them (appended as ?v=)
def _asset_version():
    digest = hashlib.sha1()
    for path in ("static/widget/theme.css", "static/widget/widget.css", "static/widget/app.js", "static/vendor/purify.min.js"):
        with open(path, "rb") as f:
            digest.update(f.read())
    return digest.hexdigest()[:10]

ASSET_VERSION = _asset_version()

# In-memory sliding window per IP. Fine for a single server process; move to Postgres/Redis if scaled out.
_chat_log = defaultdict(deque)  # ip -> monotonic timestamps of /chat calls in the last 24h

def check_rate_limit(ip):
    now = time.monotonic()
    log = _chat_log[ip]
    while log and now - log[0] > 86400:
        log.popleft()
    last_minute = sum(1 for t in log if now - t < 60)
    if last_minute >= RATE_LIMIT_PER_MINUTE or len(log) >= RATE_LIMIT_PER_DAY:
        raise HTTPException(status_code=429, detail="Too many messages. Please wait a moment.")
    log.append(now)

def default_client():
    try:
        slug = DEFAULT_CLIENT_SLUG or db.sole_client_slug()
    except LookupError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return db.get_client_by_slug(slug)

def resolve_client(widget_key):
    client = db.get_client(widget_key) if widget_key else default_client()
    if client is None:
        raise HTTPException(status_code=403, detail="Unknown widget key")
    return client

def parse_conversation_id(session_id):
    """Old or tampered ids just start a fresh conversation."""
    try:
        return uuid.UUID(session_id)
    except ValueError:
        return None

def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def get_settings_or_503(client_id):
    settings = db.get_active_settings(client_id)
    if settings is None:
        raise HTTPException(status_code=503, detail="Bot is not configured. Run seed.py first.")
    return settings

@app.get("/", response_class=HTMLResponse)
async def demo_page():
    """A stand-in host page with the widget embedded, for local testing."""
    client = resolve_client(None)
    return read_text("static/demo.html").replace("__WIDGET_KEY__", client["widget_key"])

@app.get("/widget.js")
async def widget_loader():
    # Clients embed this fixed URL, so keep the cache short enough for fixes to roll out
    return FileResponse("static/widget.js", media_type="text/javascript",
                        headers={"Cache-Control": "public, max-age=300"})

@app.get("/widget", response_class=HTMLResponse)
async def widget_page(key: str):
    """The chat panel, loaded by widget.js in an iframe."""
    client = resolve_client(key)
    settings = get_settings_or_503(client["id"])
    config = {
        "widgetKey": key,
        "clientName": client["name"],
        "botName": settings["bot_name"],
        "logoUrl": client["logo_url"],
        "privacyUrl": client["privacy_url"],
        "welcomeTitle": client["welcome_title"],
        "greeting": client["greeting"],
        "quickReplies": client["quick_replies"],
        "maxMessageChars": MAX_MESSAGE_CHARS,
        "maxHistory": MAX_HISTORY_IDS,
        "consentText": leads.consent_text(client),
    }
    # "<" is escaped so config text can never close the <script> tag it is embedded in
    config_json = json.dumps(config).replace("<", "\\u003c")
    page = read_text(f"{WIDGET_DIR}/index.html").replace("__CONFIG__", config_json).replace("__V__", ASSET_VERSION)

    # Browsers refuse to show the panel inside any site not on the client's allowed list
    frame_ancestors = " ".join(["'self'", *client["allowed_origins"]])
    csp = (f"frame-ancestors {frame_ancestors}; default-src 'self'; img-src 'self' https: data:; "
           f"style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'")
    return HTMLResponse(page, headers={"Content-Security-Policy": csp, "Cache-Control": "no-cache"})

@app.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: uuid.UUID, key: str):
    client = resolve_client(key)
    rows = db.get_conversation_messages(client["id"], conversation_id)
    if not rows:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {
        "session_id": str(conversation_id),
        "messages": [
            {"id": r["id"], "role": r["role"], "content": r["content"],
             "sources": r["sources"], "feedback": r["feedback"]}
            for r in rows
        ],
    }

@app.post("/conversations/summaries")
async def conversation_summaries(request: SummariesRequest):
    """Titles for the widget's History list. Unknown or foreign ids are silently skipped."""
    client = resolve_client(request.widget_key)
    ids = [cid for cid in map(parse_conversation_id, request.ids) if cid]
    rows = db.get_conversation_summaries(client["id"], ids) if ids else []
    return [
        {"session_id": str(r["id"]), "title": (r["title"] or "")[:80],
         "last_message_at": r["last_message_at"].isoformat(), "message_count": r["message_count"]}
        for r in rows
    ]

@app.post("/messages/{message_id}/feedback")
async def message_feedback(message_id: int, request: FeedbackRequest):
    conversation_id = parse_conversation_id(request.session_id)
    if not conversation_id or not db.set_feedback(conversation_id, message_id, request.value or None):
        raise HTTPException(status_code=404, detail="Message not found")
    return {"ok": True}

@app.post("/chat")
async def chat(request: ChatRequest, http_request: Request):
    check_rate_limit(http_request.client.host)
    client = resolve_client(request.widget_key)
    client_id = client["id"]
    settings = get_settings_or_503(client_id)

    conversation_id = db.get_or_create_conversation(
        client_id, parse_conversation_id(request.session_id),
        request.origin or http_request.headers.get("origin"),
    )
    history = db.get_recent_messages(conversation_id, HISTORY_TURNS * 2)
    user_message = request.message

    start_time = time.time()
    print(f"\n======================================")
    print(f"[START] Processing new message: '{user_message}'")
    print(f"[ACTION] Running Semantic Router...")

    result = chat_engine.answer(client_id, settings, user_message, history)

    end_time = time.time()
    elapsed = end_time - start_time
    print(f"[DONE] Finished processing in {elapsed:.2f} seconds.")
    print(f"======================================\n")

    usage = result["usage"]
    message_id = db.log_turn(
        conversation_id, user_message, result["text"], result["tier"], result["sources"],
        prompt_tokens=usage.prompt_tokens if usage else None,
        completion_tokens=usage.completion_tokens if usage else None,
        latency_ms=int(elapsed * 1000),
        error=result["error"],
        faq_id=result["faq_id"],
        unanswered=result["unanswered"],
    )
    # Checked after logging so this message counts towards callback_after_messages
    offer_callback = db.should_offer_callback(
        conversation_id, result["wants_callback"], settings["callback_after_messages"]
    )

    return {
        "session_id": str(conversation_id),
        "message_id": message_id,
        "response": result["text"],
        "tier": result["tier"],
        "sources": result["sources"],  # Most relevant first
        "offer_callback": offer_callback,
    }

@app.post("/leads")
async def create_lead(request: LeadRequest, http_request: Request, background_tasks: BackgroundTasks):
    """The widget's "Want our team to call you?" form."""
    check_rate_limit(http_request.client.host)
    client = resolve_client(request.widget_key)
    conversation_id = parse_conversation_id(request.session_id)
    if not conversation_id or not db.get_conversation_messages(client["id"], conversation_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    try:
        lead = leads.save_lead(client, conversation_id, request.name, request.phone)
    except leads.InvalidPhone as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Summary, dashboard alert and email happen after the visitor gets their confirmation
    background_tasks.add_task(
        leads.process_new_lead, client, lead["id"], conversation_id, request.name.strip() or None,
        leads.normalize_phone(request.phone), lead["created_at"], str(http_request.base_url),
    )
    return {"ok": True}
