"""Dashboard Settings API: business details, lead alerts, chat retention, and the shared login's password and sessions.

Every query is scoped to the logged-in account's client_id.
"""
import asyncio
import re
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from core import auth
from core import db
from features import leads
from features import retention

api = APIRouter(prefix="/admin/api/settings", dependencies=[Depends(auth.require_account)])

RETENTION_CHOICES = (90, 180, 365, 730)  # Days; None = keep forever
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# --- Queries ---

# Params: (name, consent_text, client_id)
UPDATE_BUSINESS_QUERY = "UPDATE clients SET name = %s, consent_text = %s WHERE id = %s"

# Params: (alert_email, client_id)
UPDATE_ALERT_EMAIL_QUERY = "UPDATE clients SET alert_email = %s WHERE id = %s"

# Params: (retention_days, client_id)
UPDATE_RETENTION_QUERY = "UPDATE clients SET retention_days = %s WHERE id = %s"

# Params: (account_id,)
PASSWORD_HASH_QUERY = "SELECT password_hash FROM admin_accounts WHERE id = %s"

# Params: (password_hash, account_id)
UPDATE_PASSWORD_QUERY = "UPDATE admin_accounts SET password_hash = %s, updated_at = now() WHERE id = %s"

# Signed-in browsers, newest first. Params: (account_id,)
SESSIONS_QUERY = """
    SELECT token_hash, created_at, expires_at, ip, user_agent
    FROM admin_sessions WHERE account_id = %s AND expires_at > now()
    ORDER BY created_at DESC
"""

# Expired rather than deleted, so they stay in the login log. Params: (account_id, keep_token_hash)
END_OTHER_SESSIONS_QUERY = """
    UPDATE admin_sessions SET expires_at = now()
    WHERE account_id = %s AND expires_at > now() AND token_hash <> %s
"""

# --- Request bodies ---

class BusinessBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    consent_text: str = Field(default="", max_length=300)  # Empty = the default wording

    @field_validator("name", "consent_text")
    @classmethod
    def strip(cls, value):
        return value.strip()

class AlertsBody(BaseModel):
    alert_email: str = Field(default="", max_length=200)  # Empty = no emails

    @field_validator("alert_email")
    @classmethod
    def email(cls, value):
        value = value.strip()
        if value and not EMAIL_PATTERN.match(value):
            raise ValueError("Enter an email address like name@example.com")
        return value

class RetentionBody(BaseModel):
    days: Literal[RETENTION_CHOICES] | None = None

class PasswordBody(BaseModel):
    current: str = Field(min_length=1, max_length=200)
    new: str = Field(min_length=auth.MIN_PASSWORD_LENGTH, max_length=200)

# --- Helpers ---

def _client(account):
    return db.get_client_by_id(account["client_id"])

def _saved(account):
    """Clears the cached client row so the widget and alerts pick up the change, and returns the fresh one."""
    db.invalidate_client(_client(account))
    return _client(account)

def _device(user_agent):
    """A short "Chrome on Windows" style label."""
    ua = user_agent or ""
    browser = next((name for key, name in (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
                                            ("Chrome/", "Chrome"), ("Safari/", "Safari")) if key in ua), "Browser")
    system = next((name for key, name in (("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"),
                                           ("Windows", "Windows"), ("Mac OS", "Mac"), ("Linux", "Linux")) if key in ua), "")
    return f"{browser} on {system}" if system else browser

def _sessions(account, request):
    current = auth.request_token_hash(request)
    with db.pool.connection() as conn:
        rows = conn.execute(SESSIONS_QUERY, (account["id"],)).fetchall()
    return [{"device": _device(r["user_agent"]), "ip": r["ip"], "created_at": r["created_at"],
             "expires_at": r["expires_at"], "current": r["token_hash"] == current} for r in rows]

def _settings(account, request, client=None):
    client = client or _client(account)
    return {
        "username": account["username"],
        "business": {"name": client["name"], "consent_text": client["consent_text"] or "",
                     "default_consent_text": leads.default_consent_text(client)},
        "alerts": {"alert_email": client["alert_email"] or "", "smtp_configured": leads.smtp_configured()},
        "retention": {"days": client["retention_days"], "choices": RETENTION_CHOICES},
        "sessions": _sessions(account, request),
        "min_password_length": auth.MIN_PASSWORD_LENGTH,
    }

# --- Endpoints ---

@api.get("")
async def get_settings(request: Request, account=Depends(auth.require_account)):
    return _settings(account, request)

@api.put("/business")
async def save_business(body: BusinessBody, request: Request, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conn.execute(UPDATE_BUSINESS_QUERY, (body.name, body.consent_text or None, account["client_id"]))
    return _settings(account, request, _saved(account))

@api.put("/alerts")
async def save_alerts(body: AlertsBody, request: Request, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conn.execute(UPDATE_ALERT_EMAIL_QUERY, (body.alert_email or None, account["client_id"]))
    return _settings(account, request, _saved(account))

@api.post("/alerts/test")
async def test_alert(account=Depends(auth.require_account)):
    client = _client(account)
    if not client["alert_email"]:
        raise HTTPException(status_code=409, detail="Save an alert email address first")
    error = await asyncio.to_thread(leads.send_test_email, client, client["alert_email"])
    if error:
        raise HTTPException(status_code=502, detail=f"Couldn't send: {error}")
    return {"sent_to": client["alert_email"]}

@api.get("/retention/preview")
async def retention_preview(days: int, account=Depends(auth.require_account)):
    """How many chats (and leads) a retention period would delete right now."""
    if days not in RETENTION_CHOICES:  # Query strings arrive as text, so Literal[...] can't check them here
        raise HTTPException(status_code=422, detail="Unknown retention period")
    return await asyncio.to_thread(retention.preview, account["client_id"], days)

@api.put("/retention")
async def save_retention(body: RetentionBody, request: Request, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conn.execute(UPDATE_RETENTION_QUERY, (body.days, account["client_id"]))
    client = _saved(account)
    if body.days:
        await asyncio.to_thread(retention.purge_expired)  # Apply now rather than at the next daily run
    return _settings(account, request, client)

@api.put("/password")
async def change_password(body: PasswordBody, request: Request, account=Depends(auth.require_account)):
    """Changes the shared login's password and logs out every other browser."""
    with db.pool.connection() as conn:
        stored = conn.execute(PASSWORD_HASH_QUERY, (account["id"],)).fetchone()["password_hash"]
        if not auth.verify_password(body.current, stored):
            raise HTTPException(status_code=400, detail="The current password is wrong")
        if body.new == body.current:
            raise HTTPException(status_code=400, detail="The new password is the same as the current one")
        conn.execute(UPDATE_PASSWORD_QUERY, (auth.hash_password(body.new), account["id"]))
        conn.execute(END_OTHER_SESSIONS_QUERY, (account["id"], auth.request_token_hash(request)))
    return {"sessions": _sessions(account, request)}

@api.post("/sessions/logout-others")
async def logout_others(request: Request, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conn.execute(END_OTHER_SESSIONS_QUERY, (account["id"], auth.request_token_hash(request)))
    return {"sessions": _sessions(account, request)}
