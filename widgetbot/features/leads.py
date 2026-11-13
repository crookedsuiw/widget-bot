"""Callback requests from the widget: validation, storage and manager alerts (dashboard push + email)."""
import asyncio
import json
import os
import re
import signal
import smtplib
from email.message import EmailMessage
from features import analysis
from core import db

DEFAULT_COUNTRY_CODE = "+91"
MAX_NAME_CHARS = 80
CONSENT_TEXT = "I agree to be contacted by {client_name} about my enquiry."

# Email alerts are skipped (and logged) until these are set. Port 465 = SSL, anything else = STARTTLS.
SMTP_HOST = os.environ.get("SMTP_HOST")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD")
SMTP_FROM = os.environ.get("SMTP_FROM") or SMTP_USER
EMAIL_TRANSCRIPT_MESSAGES = 30

# Re-submitting from the same conversation updates the lead and alerts again.
# Params: (client_id, conversation_id, name, phone, consent_text)
UPSERT_LEAD_QUERY = """
    INSERT INTO leads (client_id, conversation_id, name, phone, consent_text, consent_at)
    VALUES (%s, %s, %s, %s, %s, now())
    ON CONFLICT (conversation_id) DO UPDATE
        SET name = EXCLUDED.name, phone = EXCLUDED.phone, consent_text = EXCLUDED.consent_text,
            consent_at = now(), seen_at = NULL
    RETURNING id, created_at
"""

# Params: (summary, interest_level, lead_id)
SAVE_LEAD_SUMMARY_QUERY = "UPDATE leads SET summary = %s, interest_level = %s WHERE id = %s"

# Params: (lead_id,)
MARK_EMAIL_SENT_QUERY = "UPDATE leads SET email_sent_at = now() WHERE id = %s"

# Params: (conversation_id, limit)
TRANSCRIPT_QUERY = """
    SELECT role, content FROM (
        SELECT id, role, content FROM messages WHERE conversation_id = %s ORDER BY id DESC LIMIT %s
    ) recent ORDER BY id
"""

class InvalidPhone(ValueError):
    pass

def normalize_phone(raw):
    """Accepts an Indian mobile (with or without 0/91/+91) or any +<country><number>. Returns +E.164."""
    digits = re.sub(r"[\s\-().]", "", raw or "")
    if re.fullmatch(r"\+\d{8,15}", digits):
        return digits
    match = re.fullmatch(r"(?:0|91)?([6-9]\d{9})", digits)
    if match:
        return DEFAULT_COUNTRY_CODE + match.group(1)
    raise InvalidPhone("Please enter a valid phone number.")

def default_consent_text(client):
    return CONSENT_TEXT.format(client_name=client["name"])

def consent_text(client):
    """The wording set on the Settings page, else the default."""
    return client.get("consent_text") or default_consent_text(client)

def save_lead(client, conversation_id, name, phone):
    """Stores (or updates) the lead. Raises InvalidPhone. Returns the lead row (id, created_at)."""
    phone = normalize_phone(phone)
    name = (name or "").strip()[:MAX_NAME_CHARS] or None
    with db.pool.connection() as conn:
        return conn.execute(UPSERT_LEAD_QUERY,
                            (client["id"], conversation_id, name, phone, consent_text(client))).fetchone()

# --- Live push to open dashboards (Server-Sent Events) ---
# In-memory, so it only reaches dashboards connected to this server process.

_subscribers = {}  # client_id -> set of asyncio.Queue
STREAM_CLOSED = None  # Put on every queue at shutdown; the stream ends and the browser reconnects to the new server

def close_streams_on_exit():
    """Ends the open dashboard streams as soon as the server is told to stop.

    Uvicorn waits for every open response before it exits (and before --reload restarts), and these streams never
    finish on their own, so without this a restart hangs while any dashboard tab is open.
    Call from the app's startup, after uvicorn has installed its own signal handlers (it uses signal.signal).
    """
    loop = asyncio.get_running_loop()

    def close_all():
        for queues in _subscribers.values():
            for queue in queues:
                try:
                    queue.put_nowait(STREAM_CLOSED)
                except asyncio.QueueFull:
                    queue.get_nowait()
                    queue.put_nowait(STREAM_CLOSED)

    for sig in (signal.SIGINT, signal.SIGTERM):
        previous = signal.getsignal(sig)
        if not callable(previous):
            continue  # Not uvicorn's handler (e.g. not running in the main thread); leave it alone

        def handler(signum, frame, previous=previous):
            loop.call_soon_threadsafe(close_all)
            previous(signum, frame)

        signal.signal(sig, handler)

def subscribe(client_id):
    queue = asyncio.Queue(maxsize=100)
    _subscribers.setdefault(client_id, set()).add(queue)
    return queue

def unsubscribe(client_id, queue):
    _subscribers.get(client_id, set()).discard(queue)

def publish(client_id, event_type, data):
    message = f"event: {event_type}\ndata: {json.dumps(data, default=str)}\n\n"
    for queue in list(_subscribers.get(client_id, ())):
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            pass  # A stalled dashboard tab misses this event; it still sees the lead on reload

# --- Email ---

def _plain(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()

def smtp_configured():
    return bool(SMTP_HOST and SMTP_FROM)

def _send(msg):
    """Blocking. Returns None when sent, else the error text."""
    try:
        if SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
            server.starttls()
        with server:
            if SMTP_USER:
                server.login(SMTP_USER, SMTP_PASSWORD or "")
            server.send_message(msg)
    except (smtplib.SMTPException, OSError) as e:
        return str(e) or e.__class__.__name__
    return None

def send_test_email(client, address):
    """Blocking; the Settings page's "Send test email". Returns None when sent, else the error text."""
    if not smtp_configured():
        return "Email sending isn't set up on the server (SMTP_HOST and SMTP_FROM in .env)."
    msg = EmailMessage()
    msg["Subject"] = f"Test: callback alerts for {client['name']}"
    msg["From"] = SMTP_FROM
    msg["To"] = address
    msg.set_content(f"This is a test from the {client['name']} dashboard. "
                    "New callback requests from the chat widget will be emailed to this address.\n")
    return _send(msg)

def send_lead_email(client, lead, dashboard_url):
    """Blocking; call from a worker thread. Returns True when sent."""
    if not client.get("alert_email"):
        print(f"[INFO] No alert_email set for {client['name']}; lead email skipped.")
        return False
    if not SMTP_HOST:
        print("[INFO] SMTP_HOST not set; lead email skipped.")
        return False

    with db.pool.connection() as conn:
        rows = conn.execute(TRANSCRIPT_QUERY, (lead["conversation_id"], EMAIL_TRANSCRIPT_MESSAGES)).fetchall()
    transcript = "\n".join(f"{'Visitor' if r['role'] == 'user' else 'Assistant'}: {_plain(r['content'])}" for r in rows)

    msg = EmailMessage()
    msg["Subject"] = f"New callback request: {lead['name'] or lead['phone']}"
    msg["From"] = SMTP_FROM
    msg["To"] = client["alert_email"]
    msg.set_content(
        f"A visitor asked {client['name']}'s team to call them back.\n\n"
        f"Name: {lead['name'] or '(not given)'}\n"
        f"Phone: {lead['phone']}\n"
        f"Interest: {lead['interest_level'] or 'unknown'}\n\n"
        f"Summary: {lead['summary'] or '(not available)'}\n\n"
        f"Full chat: {dashboard_url}\n\n"
        f"--- Chat transcript ---\n{transcript}\n"
    )
    error = _send(msg)
    if error:
        print(f"[ERROR] Lead email failed: {error}")
        return False

    with db.pool.connection() as conn:
        conn.execute(MARK_EMAIL_SENT_QUERY, (lead["id"],))
    return True

# --- After a lead is saved ---

async def process_new_lead(client, lead_id, conversation_id, name, phone, created_at, base_url):
    """Summarise the chat, then alert open dashboards and email the client. Runs as a background task."""
    result = await asyncio.to_thread(analysis.summarize_conversation, client["id"], conversation_id, True)
    summary = result["summary"] if result else None
    interest = result["interest_level"] if result else "hot"
    with db.pool.connection() as conn:
        conn.execute(SAVE_LEAD_SUMMARY_QUERY, (summary, interest, lead_id))

    lead = {
        "id": lead_id, "conversation_id": str(conversation_id), "name": name, "phone": phone,
        "summary": summary, "interest_level": interest, "created_at": created_at,
    }
    publish(client["id"], "lead", lead)

    client_full = db.get_client_by_id(client["id"])
    dashboard_url = f"{base_url.rstrip('/')}/admin/chat-history/{conversation_id}"
    await asyncio.to_thread(send_lead_email, client_full, lead, dashboard_url)
