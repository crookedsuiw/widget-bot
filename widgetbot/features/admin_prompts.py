"""Dashboard Prompt rules API: named settings, each with a linear version history and at most one draft.

A setting (bot_profiles row) owns bot_settings rows: numbered versions, plus one unnumbered draft.
Versions are only ever added by merging the draft, so the history is a straight line.
Exactly one version per client is live (is_active). Every query is scoped to the account's client_id.
"""
import asyncio
import time
from datetime import datetime
from typing import Literal
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator
from core import auth
from features import chat_engine
from core import db

api = APIRouter(prefix="/admin/api/prompts", dependencies=[Depends(auth.require_account)])

TEST_HISTORY_TURNS = 10  # Earlier test messages sent back to the model, like the widget's history

# The columns a setting holds; widget text and the FAQ threshold live on clients
FIELDS = ("bot_name", "persona", "instructions", "do_not_rules", "approved_links", "model",
          "rag_top_k", "callback_after_messages")
FIELD_LIST = ", ".join(FIELDS)

# --- Queries ---

# Params: (client_id,)
PROFILES_QUERY = """
    SELECT p.id, p.name, max(s.version) AS latest_version,
           coalesce(bool_or(s.is_active), false) AS is_live, coalesce(bool_or(s.is_draft), false) AS has_draft,
           max(s.updated_at) AS updated_at
    FROM bot_profiles p LEFT JOIN bot_settings s ON s.profile_id = p.id
    WHERE p.client_id = %s
    GROUP BY p.id
    ORDER BY p.created_at, p.id
"""

# Params: (profile_id, client_id)
PROFILE_QUERY = "SELECT id, name FROM bot_profiles WHERE id = %s AND client_id = %s"

# Locks the setting so two merges can't take the same version number. Params: (profile_id,)
LOCK_PROFILE_QUERY = "SELECT id FROM bot_profiles WHERE id = %s FOR UPDATE"

# Params: (profile_id,)
LATEST_VERSION_QUERY = f"""
    SELECT version, is_active, note, created_at, {FIELD_LIST}
    FROM bot_settings WHERE profile_id = %s AND NOT is_draft ORDER BY version DESC LIMIT 1
"""

# Params: (profile_id, version)
VERSION_QUERY = f"""
    SELECT version, {FIELD_LIST} FROM bot_settings WHERE profile_id = %s AND version = %s
"""

# Params: (profile_id,)
DRAFT_QUERY = f"""
    SELECT note, updated_at, {FIELD_LIST} FROM bot_settings WHERE profile_id = %s AND is_draft
"""

# Params: (profile_id,)
LOCK_DRAFT_QUERY = "SELECT id, updated_at FROM bot_settings WHERE profile_id = %s AND is_draft FOR UPDATE"

# Params: (profile_id,)
VERSIONS_QUERY = """
    SELECT version, is_active, note, created_at FROM bot_settings
    WHERE profile_id = %s AND NOT is_draft ORDER BY version DESC
"""

# Params: dict(client_id, profile_id, note, <fields>)
INSERT_DRAFT_QUERY = f"""
    INSERT INTO bot_settings (client_id, profile_id, is_draft, note, {FIELD_LIST})
    VALUES (%(client_id)s, %(profile_id)s, true, %(note)s, {", ".join(f"%({f})s" for f in FIELDS)})
    RETURNING updated_at
"""

# Params: dict(draft_id, note, <fields>); a NULL note keeps the current one
UPDATE_DRAFT_QUERY = f"""
    UPDATE bot_settings SET {", ".join(f"{f} = %({f})s" for f in FIELDS)},
        note = coalesce(%(note)s, note), updated_at = now()
    WHERE id = %(draft_id)s
    RETURNING updated_at
"""

# Params: (profile_id,)
DELETE_DRAFT_QUERY = "DELETE FROM bot_settings WHERE profile_id = %s AND is_draft RETURNING id"

# Params: (profile_id,)
NEXT_VERSION_QUERY = "SELECT coalesce(max(version), 0) + 1 AS next FROM bot_settings WHERE profile_id = %s"

# Params: (profile_id,)
PROFILE_IS_LIVE_QUERY = "SELECT id FROM bot_settings WHERE profile_id = %s AND is_active"

# Params: (client_id,)
DEACTIVATE_QUERY = "UPDATE bot_settings SET is_active = false WHERE client_id = %s AND is_active"

# The draft row becomes the new version. Params: (version, is_active, note, draft_id)
MERGE_DRAFT_QUERY = """
    UPDATE bot_settings SET is_draft = false, version = %s, is_active = %s, note = %s,
        created_at = now(), updated_at = now()
    WHERE id = %s
"""

# Params: (profile_id,)
ACTIVATE_LATEST_QUERY = """
    UPDATE bot_settings SET is_active = true
    WHERE id = (SELECT id FROM bot_settings WHERE profile_id = %s AND NOT is_draft ORDER BY version DESC LIMIT 1)
    RETURNING version
"""

# Params: (client_id,)
LIVE_FIELDS_QUERY = f"SELECT profile_id, {FIELD_LIST} FROM bot_settings WHERE client_id = %s AND is_active"

# Params: (client_id, name)
CREATE_PROFILE_QUERY = "INSERT INTO bot_profiles (client_id, name) VALUES (%s, %s) RETURNING id, name"

# Params: (name, profile_id, client_id)
RENAME_PROFILE_QUERY = "UPDATE bot_profiles SET name = %s WHERE id = %s AND client_id = %s RETURNING id, name"

# Versions and draft go with it (ON DELETE CASCADE). Params: (profile_id, client_id)
DELETE_PROFILE_QUERY = "DELETE FROM bot_profiles WHERE id = %s AND client_id = %s RETURNING id"

# Params: (client_id, prompt_tokens, completion_tokens)
LOG_TEST_USAGE_QUERY = """
    INSERT INTO llm_usage (client_id, purpose, prompt_tokens, completion_tokens) VALUES (%s, 'playground', %s, %s)
"""

# --- Request models ---

class Link(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    url: str = Field(min_length=1, max_length=500)

    @field_validator("url")
    @classmethod
    def https_only(cls, value):
        parsed = urlparse(value.strip())
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("Use a full address starting with https://")
        return value.strip()

class SettingFields(BaseModel):
    bot_name: str = Field(min_length=1, max_length=60)
    persona: str = Field(min_length=1, max_length=4000)
    instructions: str = Field(default="", max_length=4000)
    do_not_rules: str = Field(default="", max_length=4000)
    approved_links: list[Link] = Field(default=[], max_length=20)
    model: str = Field(min_length=1, max_length=100)
    rag_top_k: int = Field(ge=1, le=10)
    callback_after_messages: int = Field(ge=0, le=20)

class DraftSave(BaseModel):
    fields: SettingFields
    updated_at: datetime | None = None  # The draft version this edit started from; None = no draft yet

class MergeRequest(BaseModel):
    note: str = Field(default="", max_length=200)

class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    copy_from: int | None = None  # None = copy the live setting

class ProfileRename(BaseModel):
    name: str = Field(min_length=1, max_length=60)

class TestTurn(BaseModel):
    role: Literal["user", "bot"]
    content: str = Field(max_length=6000)

class TestRequest(BaseModel):
    profile_id: int | None = None  # Needed for "saved"; the FAQs page tests "live" without one
    target: Literal["live", "saved", "draft"]  # live = what visitors get, from whichever setting is live
    message: str = Field(min_length=1, max_length=1000)
    history: list[TestTurn] = Field(default=[], max_length=2 * TEST_HISTORY_TURNS)
    draft: SettingFields | None = None  # The form as it is now, saved or not (target "draft")

# --- Helpers ---

def _field_params(fields):
    params = dict(fields)
    params["approved_links"] = Jsonb(params["approved_links"])
    return params

def _only_fields(row):
    return {f: row[f] for f in FIELDS}

def _get_profile(conn, profile_id, client_id):
    profile = conn.execute(PROFILE_QUERY, (profile_id, client_id)).fetchone()
    if profile is None:
        raise HTTPException(status_code=404, detail="Setting not found")
    return profile

def _profile_detail(client_id, profile_id):
    with db.pool.connection() as conn:
        profile = _get_profile(conn, profile_id, client_id)
        latest = conn.execute(LATEST_VERSION_QUERY, (profile_id,)).fetchone()
        draft = conn.execute(DRAFT_QUERY, (profile_id,)).fetchone()
        versions = conn.execute(VERSIONS_QUERY, (profile_id,)).fetchall()
    return {"profile": profile, "latest": latest, "draft": draft, "versions": versions}

def _upsert_draft(conn, client_id, profile_id, fields, note=None, expected_updated_at=None, force=False):
    """Creates or replaces the setting's draft. Unless force, refuses (409) if it changed since the caller loaded it."""
    with conn.transaction():
        current = conn.execute(LOCK_DRAFT_QUERY, (profile_id,)).fetchone()
        if not force and (current["updated_at"] if current else None) != expected_updated_at:
            raise HTTPException(status_code=409, detail="This draft was changed in another tab. Reload to see the latest.")
        params = {**_field_params(fields), "note": note}
        if current:
            return conn.execute(UPDATE_DRAFT_QUERY, {**params, "draft_id": current["id"]}).fetchone()["updated_at"]
        try:
            return conn.execute(INSERT_DRAFT_QUERY, {**params, "client_id": client_id,
                                                     "profile_id": profile_id}).fetchone()["updated_at"]
        except UniqueViolation:
            raise HTTPException(status_code=409, detail="This draft was changed in another tab. Reload to see the latest.")

# --- Settings and versions ---

@api.get("")
async def list_profiles(account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        profiles = conn.execute(PROFILES_QUERY, (account["client_id"],)).fetchall()
    return {"profiles": profiles,
            "system_rules": chat_engine.SIGNAL_RULES + "\n" + chat_engine.NO_ANSWER_RULE + " (when website extracts are used)"}

@api.get("/{profile_id}")
async def profile_detail(profile_id: int, account=Depends(auth.require_account)):
    return _profile_detail(account["client_id"], profile_id)

@api.put("/{profile_id}/draft")
async def save_draft(profile_id: int, body: DraftSave, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        _get_profile(conn, profile_id, account["client_id"])
        updated_at = _upsert_draft(conn, account["client_id"], profile_id, body.fields.model_dump(),
                                   expected_updated_at=body.updated_at)
    return {"updated_at": updated_at}

@api.delete("/{profile_id}/draft")
async def discard_draft(profile_id: int, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        _get_profile(conn, profile_id, account["client_id"])
        if conn.execute(LATEST_VERSION_QUERY, (profile_id,)).fetchone() is None:
            raise HTTPException(status_code=409, detail="This setting has no saved version yet. Delete the setting instead.")
        conn.execute(DELETE_DRAFT_QUERY, (profile_id,))
    return _profile_detail(account["client_id"], profile_id)

@api.post("/{profile_id}/draft/from/{version}")
async def restore_version(profile_id: int, version: int, account=Depends(auth.require_account)):
    """Copies an old version into the draft; merging it then adds it as the newest version."""
    with db.pool.connection() as conn:
        _get_profile(conn, profile_id, account["client_id"])
        row = conn.execute(VERSION_QUERY, (profile_id, version)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Version not found")
        _upsert_draft(conn, account["client_id"], profile_id, _only_fields(row), note=f"Restored from v{version}",
                      force=True)
    return _profile_detail(account["client_id"], profile_id)

@api.post("/{profile_id}/merge")
async def merge_draft(profile_id: int, body: MergeRequest, account=Depends(auth.require_account)):
    client_id = account["client_id"]
    with db.pool.connection() as conn:
        _get_profile(conn, profile_id, client_id)
        with conn.transaction():
            conn.execute(LOCK_PROFILE_QUERY, (profile_id,))
            draft = conn.execute(LOCK_DRAFT_QUERY, (profile_id,)).fetchone()
            if draft is None:
                raise HTTPException(status_code=409, detail="There is no draft to save. It may have been saved in another tab.")
            version = conn.execute(NEXT_VERSION_QUERY, (profile_id,)).fetchone()["next"]
            # Merging the live setting publishes the new version straight away
            is_live = conn.execute(PROFILE_IS_LIVE_QUERY, (profile_id,)).fetchone() is not None
            if is_live:
                conn.execute(DEACTIVATE_QUERY, (client_id,))
            note = body.note.strip() or None
            conn.execute(MERGE_DRAFT_QUERY, (version, is_live, note, draft["id"]))
    if is_live:
        db.invalidate_settings(client_id)
    return {**_profile_detail(client_id, profile_id), "merged_version": version, "went_live": is_live}

@api.post("/{profile_id}/live")
async def make_live(profile_id: int, account=Depends(auth.require_account)):
    client_id = account["client_id"]
    with db.pool.connection() as conn:
        _get_profile(conn, profile_id, client_id)
        with conn.transaction():
            if conn.execute(LATEST_VERSION_QUERY, (profile_id,)).fetchone() is None:
                raise HTTPException(status_code=409, detail="Save a first version of this setting before making it live.")
            conn.execute(DEACTIVATE_QUERY, (client_id,))
            conn.execute(ACTIVATE_LATEST_QUERY, (profile_id,))
    db.invalidate_settings(client_id)
    return _profile_detail(client_id, profile_id)

@api.post("")
async def create_profile(body: ProfileCreate, account=Depends(auth.require_account)):
    """New setting (copy of the live one) or Duplicate (copy of what the viewed setting shows: its draft, else latest)."""
    client_id = account["client_id"]
    name = body.name.strip()
    with db.pool.connection() as conn:
        if body.copy_from is None:
            source = conn.execute(LIVE_FIELDS_QUERY, (client_id,)).fetchone()
            source_name = None
        else:
            source_name = _get_profile(conn, body.copy_from, client_id)["name"]
            source = (conn.execute(DRAFT_QUERY, (body.copy_from,)).fetchone()
                      or conn.execute(LATEST_VERSION_QUERY, (body.copy_from,)).fetchone())
        if source is None:
            raise HTTPException(status_code=409, detail="There is no setting to copy from")
        try:
            with conn.transaction():
                profile = conn.execute(CREATE_PROFILE_QUERY, (client_id, name)).fetchone()
                note = f"Copied from '{source_name}'" if source_name else "Copied from the live setting"
                _upsert_draft(conn, client_id, profile["id"], _only_fields(source), note=note, force=True)
        except UniqueViolation:
            raise HTTPException(status_code=409, detail="A setting with that name already exists")
    return _profile_detail(client_id, profile["id"])

@api.patch("/{profile_id}")
async def rename_profile(profile_id: int, body: ProfileRename, account=Depends(auth.require_account)):
    try:
        with db.pool.connection() as conn:
            row = conn.execute(RENAME_PROFILE_QUERY, (body.name.strip(), profile_id, account["client_id"])).fetchone()
    except UniqueViolation:
        raise HTTPException(status_code=409, detail="A setting with that name already exists")
    if row is None:
        raise HTTPException(status_code=404, detail="Setting not found")
    return row

@api.delete("/{profile_id}")
async def delete_profile(profile_id: int, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        _get_profile(conn, profile_id, account["client_id"])
        if conn.execute(PROFILE_IS_LIVE_QUERY, (profile_id,)).fetchone():
            raise HTTPException(status_code=409, detail="The live setting can't be deleted. Make another setting live first.")
        conn.execute(DELETE_PROFILE_QUERY, (profile_id, account["client_id"]))
    return {"ok": True}

# --- Test box ---

def _run_test(client_id, settings, message, history):
    started = time.monotonic()
    result = chat_engine.answer(client_id, settings, message, history)
    usage = result["usage"]
    if usage:
        with db.pool.connection() as conn:
            conn.execute(LOG_TEST_USAGE_QUERY, (client_id, usage.prompt_tokens, usage.completion_tokens))
    return {
        "text": result["text"], "tier": result["tier"], "sources": result["sources"], "error": result["error"],
        "wants_callback": result["wants_callback"], "unanswered": result["unanswered"],
        "prompt_tokens": usage.prompt_tokens if usage else None,
        "completion_tokens": usage.completion_tokens if usage else None,
        "latency_ms": round((time.monotonic() - started) * 1000),
    }

@api.post("/test")
async def test_prompt(body: TestRequest, account=Depends(auth.require_account)):
    """Answers like the widget would, with the live setting, this setting's saved version or the unsaved form.
    Nothing is stored except token usage."""
    client_id = account["client_id"]
    if body.target == "draft":
        if body.draft is None:
            raise HTTPException(status_code=422, detail="Draft settings are missing")
        settings = body.draft.model_dump()
    elif body.target == "live":
        with db.pool.connection() as conn:
            live = conn.execute(LIVE_FIELDS_QUERY, (client_id,)).fetchone()
        if live is None:
            raise HTTPException(status_code=409, detail="No setting is live")
        settings = _only_fields(live)
    else:
        if body.profile_id is None:
            raise HTTPException(status_code=422, detail="Which setting to test is missing")
        with db.pool.connection() as conn:
            _get_profile(conn, body.profile_id, client_id)
            latest = conn.execute(LATEST_VERSION_QUERY, (body.profile_id,)).fetchone()
        if latest is None:
            raise HTTPException(status_code=409, detail="This setting has no saved version yet")
        settings = _only_fields(latest)
    settings["faq_threshold"] = await asyncio.to_thread(db.get_faq_threshold, client_id)
    history = [t.model_dump() for t in body.history[-2 * TEST_HISTORY_TURNS:]]
    return await asyncio.to_thread(_run_test, client_id, settings, body.message.strip(), history)
