"""Manager dashboard: pages under /admin and the JSON API under /admin/api.

Every API query is scoped to the logged-in account's client_id.
"""
import asyncio
import csv
import hashlib
import io
import os
import uuid
from datetime import date
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from core import auth
from core import db
from features import leads

router = APIRouter(prefix="/admin")

ADMIN_DIR = "static/admin"
PAGE_SIZE = 25
CSV_MAX_ROWS = 5000
SSE_HEARTBEAT_SECONDS = 25

# Paths that serve the dashboard app; anything else under /admin/ is a 404
PAGES = {"overview", "leads", "chat-history", "prompt-rules", "faqs", "knowledge", "settings"}
DEFAULT_PAGE = "overview"

ADMIN_CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; "
             "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'")

def _asset_version():
    digest = hashlib.sha1()
    for name in sorted(n for n in os.listdir(ADMIN_DIR) if n.endswith((".js", ".css"))):
        with open(f"{ADMIN_DIR}/{name}", "rb") as f:
            digest.update(f.read())
    return digest.hexdigest()[:10]

ASSET_VERSION = _asset_version()

def _page(name):
    with open(f"{ADMIN_DIR}/{name}", encoding="utf-8") as f:
        html = f.read().replace("__V__", ASSET_VERSION)
    return HTMLResponse(html, headers={"Content-Security-Policy": ADMIN_CSP, "Cache-Control": "no-cache"})

# --- Queries ---

# Conversation list with per-chat counts. {filters} is built from fixed SQL fragments only.
CONVERSATIONS_QUERY = """
    SELECT c.id, c.started_at, c.last_message_at, c.origin, c.summary, c.interest_level, c.intent,
           s.message_count, s.title, s.thumbs_down, s.unanswered, s.errors,
           l.id AS lead_id, l.status AS lead_status, l.name AS lead_name, l.phone AS lead_phone,
           count(*) OVER () AS total
    FROM conversations c
    JOIN LATERAL (
        SELECT count(*) AS message_count,
               (array_agg(content ORDER BY id) FILTER (WHERE role = 'user'))[1] AS title,
               count(*) FILTER (WHERE feedback = -1) AS thumbs_down,
               count(*) FILTER (WHERE unanswered) AS unanswered,
               count(*) FILTER (WHERE error IS NOT NULL) AS errors
        FROM messages WHERE conversation_id = c.id
    ) s ON s.message_count > 0
    LEFT JOIN leads l ON l.conversation_id = c.id
    WHERE c.client_id = %(client_id)s {filters}
    ORDER BY c.last_message_at DESC
    LIMIT %(limit)s OFFSET %(offset)s
"""

# Params: (conversation_id, client_id)
CONVERSATION_DETAIL_QUERY = """
    SELECT id, started_at, last_message_at, origin, summary, interest_level, intent, analyzed_at
    FROM conversations WHERE id = %s AND client_id = %s
"""

# Params: (conversation_id,)
CONVERSATION_MESSAGES_QUERY = """
    SELECT id, role, content, tier, sources, prompt_tokens, completion_tokens, latency_ms, error,
           feedback, unanswered, faq_id, created_at
    FROM messages WHERE conversation_id = %s ORDER BY id
"""

# Params: (conversation_id,)
LEAD_FOR_CONVERSATION_QUERY = """
    SELECT id, name, phone, status, notes, consent_text, consent_at, created_at, contacted_at, email_sent_at
    FROM leads WHERE conversation_id = %s
"""

LEADS_QUERY = """
    SELECT l.id, l.conversation_id, l.name, l.phone, l.status, l.notes, l.created_at, l.seen_at, l.contacted_at,
           coalesce(c.summary, l.summary) AS summary, coalesce(c.interest_level, l.interest_level) AS interest_level,
           count(*) OVER () AS total
    FROM leads l
    JOIN conversations c ON c.id = l.conversation_id
    WHERE l.client_id = %(client_id)s {filters}
    ORDER BY l.created_at DESC
    LIMIT %(limit)s OFFSET %(offset)s
"""

# Params: (client_id,)
UNSEEN_LEADS_QUERY = """
    SELECT l.id, l.conversation_id, l.name, l.phone, l.created_at,
           coalesce(c.summary, l.summary) AS summary, coalesce(c.interest_level, l.interest_level) AS interest_level
    FROM leads l JOIN conversations c ON c.id = l.conversation_id
    WHERE l.client_id = %s AND l.seen_at IS NULL
    ORDER BY l.created_at DESC
"""

# Params: (lead_ids, client_id)
MARK_LEADS_SEEN_QUERY = """
    UPDATE leads SET seen_at = now() WHERE id = ANY(%s) AND client_id = %s AND seen_at IS NULL
"""

# contacted_at records the first time a lead moved to "contacted".
# Params: dict(status, notes, lead_id, client_id); a NULL status/notes leaves that field unchanged.
UPDATE_LEAD_QUERY = """
    UPDATE leads SET
        status = coalesce(%(status)s, status),
        notes = coalesce(%(notes)s, notes),
        contacted_at = CASE WHEN %(status)s = 'contacted' AND contacted_at IS NULL THEN now() ELSE contacted_at END,
        seen_at = coalesce(seen_at, now())
    WHERE id = %(lead_id)s AND client_id = %(client_id)s
    RETURNING id, status, notes, contacted_at
"""

# --- Request models ---

class LoginRequest(BaseModel):
    username: str = Field(max_length=100)
    password: str = Field(max_length=200)

class LeadUpdate(BaseModel):
    status: Literal["new", "contacted", "converted", "not_interested"] | None = None
    notes: str | None = Field(default=None, max_length=4000)

class SeenRequest(BaseModel):
    ids: list[int] = Field(max_length=200)

# --- Pages ---

@router.get("/login")
async def login_page(request: Request):
    if auth.current_account(request):
        return RedirectResponse(f"/admin/{DEFAULT_PAGE}", status_code=303)
    return _page("login.html")

@router.post("/login")
async def login(body: LoginRequest, request: Request):
    auth.check_same_origin(request)
    token = auth.login(body.username.strip(), body.password, request.client.host, request.headers.get("user-agent"))
    if token is None:
        raise HTTPException(status_code=401, detail="Wrong username or password")
    response = JSONResponse({"ok": True})
    auth.set_session_cookie(response, token)
    return response

@router.post("/logout")
async def logout(request: Request):
    auth.check_same_origin(request)
    token = request.cookies.get(auth.SESSION_COOKIE)
    if token:
        auth.logout(token)
    response = JSONResponse({"ok": True})
    auth.clear_session_cookie(response)
    return response

@router.get("")
@router.get("/")
async def admin_root():
    return RedirectResponse(f"/admin/{DEFAULT_PAGE}", status_code=303)

@router.get("/{page}")
@router.get("/{page}/{item}")
async def admin_page(page: str, request: Request, item: str | None = None):
    if page not in PAGES:
        raise HTTPException(status_code=404)
    if not auth.current_account(request):
        return RedirectResponse(f"/admin/login?next={request.url.path}", status_code=303)
    return _page("index.html")

# --- API: session ---

api = APIRouter(prefix="/admin/api", dependencies=[Depends(auth.require_account)])

@api.get("/me")
async def me(account=Depends(auth.require_account)):
    client = db.get_client_by_id(account["client_id"])
    return {"username": account["username"], "client_name": account["client_name"], "logo_url": client["logo_url"]}

@api.get("/events")
async def events(request: Request, account=Depends(auth.require_account)):
    """Live alerts for this client's dashboards (Server-Sent Events)."""
    queue = leads.subscribe(account["client_id"])

    async def stream():
        try:
            yield "retry: 5000\n\n"
            while not await request.is_disconnected():
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
                    if message is leads.STREAM_CLOSED:
                        return  # Server is stopping
                    yield message
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"  # Keeps proxies from closing an idle connection
        finally:
            leads.unsubscribe(account["client_id"], queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

# --- API: leads ---

@api.get("/leads")
async def list_leads(account=Depends(auth.require_account),
                     status: str | None = None, interest: str | None = None, page: int = Query(1, ge=1)):
    filters, params = [], {"client_id": account["client_id"], "limit": PAGE_SIZE, "offset": (page - 1) * PAGE_SIZE}
    if status:
        filters.append("AND l.status = %(status)s")
        params["status"] = status
    if interest:
        filters.append("AND coalesce(c.interest_level, l.interest_level) = %(interest)s")
        params["interest"] = interest
    with db.pool.connection() as conn:
        rows = conn.execute(LEADS_QUERY.format(filters=" ".join(filters)), params).fetchall()
    return {"total": rows[0]["total"] if rows else 0, "page": page, "page_size": PAGE_SIZE,
            "items": [{k: v for k, v in r.items() if k != "total"} for r in rows]}

@api.get("/leads/unseen")
async def unseen_leads(account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        return conn.execute(UNSEEN_LEADS_QUERY, (account["client_id"],)).fetchall()

@api.post("/leads/seen")
async def mark_leads_seen(body: SeenRequest, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conn.execute(MARK_LEADS_SEEN_QUERY, (body.ids, account["client_id"]))
    return {"ok": True}

@api.patch("/leads/{lead_id}")
async def update_lead(lead_id: int, body: LeadUpdate, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        row = conn.execute(UPDATE_LEAD_QUERY, {"status": body.status, "notes": body.notes,
                                               "lead_id": lead_id, "client_id": account["client_id"]}).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    return row

# --- API: chat history ---

def _escape_like(text):
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

def _conversation_filters(params, date_from, date_to, q, interest, intent, has_lead, thumbs_down, unanswered, errors):
    """Adds only fixed SQL fragments; every user value goes through a named parameter."""
    filters = []
    if date_from:
        filters.append("AND c.last_message_at >= %(date_from)s")
        params["date_from"] = date_from
    if date_to:
        filters.append("AND c.last_message_at < %(date_to)s::date + 1")
        params["date_to"] = date_to
    if q:
        filters.append("AND (EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id AND content ILIKE %(q)s)"
                       " OR l.phone ILIKE %(q)s OR l.name ILIKE %(q)s)")
        params["q"] = f"%{_escape_like(q.strip())}%"
    if interest:
        filters.append("AND c.interest_level = %(interest)s")
        params["interest"] = interest
    if intent:
        filters.append("AND c.intent = %(intent)s")
        params["intent"] = intent
    if has_lead:
        filters.append("AND l.id IS NOT NULL")
    if thumbs_down:
        filters.append("AND s.thumbs_down > 0")
    if unanswered:
        filters.append("AND s.unanswered > 0")
    if errors:
        filters.append("AND s.errors > 0")
    return " ".join(filters)

def _query_conversations(account, limit, offset, **filters):
    params = {"client_id": account["client_id"], "limit": limit, "offset": offset}
    sql = CONVERSATIONS_QUERY.format(filters=_conversation_filters(params, **filters))
    with db.pool.connection() as conn:
        return conn.execute(sql, params).fetchall()

class ConversationFilters:
    """Shared query-string filters for the list and the CSV export."""
    def __init__(self, date_from: date | None = Query(None, alias="from"), date_to: date | None = Query(None, alias="to"),
                 q: str | None = Query(None, max_length=200), interest: str | None = None, intent: str | None = None,
                 has_lead: bool = False, thumbs_down: bool = False, unanswered: bool = False, errors: bool = False):
        self.values = dict(date_from=date_from, date_to=date_to, q=q, interest=interest, intent=intent,
                           has_lead=has_lead, thumbs_down=thumbs_down, unanswered=unanswered, errors=errors)

@api.get("/conversations")
async def list_conversations(account=Depends(auth.require_account), filters: ConversationFilters = Depends(),
                             page: int = Query(1, ge=1)):
    rows = _query_conversations(account, PAGE_SIZE, (page - 1) * PAGE_SIZE, **filters.values)
    return {"total": rows[0]["total"] if rows else 0, "page": page, "page_size": PAGE_SIZE,
            "items": [{k: v for k, v in r.items() if k != "total"} for r in rows]}

def _csv_cell(value):
    """Stops spreadsheet apps from treating visitor text as a formula (CSV injection)."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text

@api.get("/conversations.csv")
async def export_conversations(request: Request, account=Depends(auth.require_account),
                               filters: ConversationFilters = Depends()):
    rows = _query_conversations(account, CSV_MAX_ROWS, 0, **filters.values)
    base = str(request.base_url).rstrip("/")
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["Started", "Last message", "First question", "Summary", "Interest", "Intent", "Messages",
                     "Lead name", "Lead phone", "Lead status", "Thumbs down", "Unanswered", "Errors", "Link"])
    for r in rows:
        writer.writerow([_csv_cell(v) for v in (
            r["started_at"].isoformat(timespec="minutes"), r["last_message_at"].isoformat(timespec="minutes"),
            r["title"], r["summary"], r["interest_level"], r["intent"], r["message_count"],
            r["lead_name"], r["lead_phone"], r["lead_status"], r["thumbs_down"], r["unanswered"], r["errors"],
            f"{base}/admin/chat-history/{r['id']}",
        )])
    filename = f"chat-history-{date.today().isoformat()}.csv"
    return StreamingResponse(iter([out.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})

@api.get("/conversations/{conversation_id}")
async def conversation_detail(conversation_id: uuid.UUID, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conversation = conn.execute(CONVERSATION_DETAIL_QUERY, (conversation_id, account["client_id"])).fetchone()
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        messages = conn.execute(CONVERSATION_MESSAGES_QUERY, (conversation_id,)).fetchall()
        lead = conn.execute(LEAD_FOR_CONVERSATION_QUERY, (conversation_id,)).fetchone()
    return {"conversation": conversation, "messages": messages, "lead": lead}
