"""Dashboard FAQs API: FAQs (question wordings + rotating answers + optional button), match testing and strictness.

An FAQ answers when a visitor's message is close enough to any of its wordings (tier 1, no AI cost).
Every query is scoped to the logged-in account's client_id.
"""
import asyncio
from typing import Annotated
from urllib.parse import urlparse
from fastapi import APIRouter, Depends, HTTPException
from psycopg.errors import UniqueViolation
from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator
from core import auth
from core import db
from core.embeddings import get_ov_embedding

api = APIRouter(prefix="/admin/api/faqs", dependencies=[Depends(auth.require_account)])

USAGE_DAYS = 30   # "Used N times" on the list counts this many days back
MATCH_LIMIT = 3   # FAQs shown in the match test

# --- Queries ---

# Params: (client_id, client_id)
FAQS_QUERY = f"""
    SELECT f.id, f.answers, f.button_label, f.button_url, f.updated_at,
           (SELECT array_agg(q.question ORDER BY q.position, q.id) FROM faq_questions q WHERE q.faq_id = f.id) AS questions,
           (SELECT count(*) FROM messages m WHERE m.faq_id = f.id
              AND m.created_at >= now() - interval '{USAGE_DAYS} days') AS uses
    FROM faqs f
    WHERE f.client_id = %s
    ORDER BY f.id
"""

# Params: (faq_id, client_id)
FAQ_QUERY = """
    SELECT f.id, f.answers, f.button_label, f.button_url, f.updated_at,
           (SELECT array_agg(q.question ORDER BY q.position, q.id) FROM faq_questions q WHERE q.faq_id = f.id) AS questions
    FROM faqs f
    WHERE f.id = %s AND f.client_id = %s
"""

# Params: (client_id,)
THRESHOLD_QUERY = "SELECT faq_threshold FROM clients WHERE id = %s"

# Params: (value, client_id)
SET_THRESHOLD_QUERY = "UPDATE clients SET faq_threshold = %s WHERE id = %s"

# Wordings already used by another FAQ. Params: (client_id, lowercased questions, faq_id or None)
CLASHES_QUERY = """
    SELECT q.question,
           (SELECT t.question FROM faq_questions t WHERE t.faq_id = q.faq_id ORDER BY t.position, t.id LIMIT 1) AS title
    FROM faq_questions q
    WHERE q.client_id = %s AND lower(q.question) = ANY(%s) AND q.faq_id IS DISTINCT FROM %s
"""

# Params: (client_id, answers, button_label, button_url)
INSERT_FAQ_QUERY = """
    INSERT INTO faqs (client_id, answers, button_label, button_url) VALUES (%s, %s, %s, %s) RETURNING id
"""

# Params: (answers, button_label, button_url, faq_id, client_id)
UPDATE_FAQ_QUERY = """
    UPDATE faqs SET answers = %s, button_label = %s, button_url = %s, updated_at = now()
    WHERE id = %s AND client_id = %s
    RETURNING id
"""

# Params: (faq_id,)
WORDINGS_QUERY = "SELECT id, question FROM faq_questions WHERE faq_id = %s"

# Params: (faq_id, client_id, question, embedding, position)
INSERT_WORDING_QUERY = """
    INSERT INTO faq_questions (faq_id, client_id, question, embedding, position) VALUES (%s, %s, %s, %s, %s)
"""

# Params: (question, position, id)
UPDATE_WORDING_QUERY = "UPDATE faq_questions SET question = %s, position = %s WHERE id = %s"

# Params: (question, embedding, position, id)
UPDATE_WORDING_EMBEDDING_QUERY = "UPDATE faq_questions SET question = %s, embedding = %s, position = %s WHERE id = %s"

# Params: (ids,)
DELETE_WORDINGS_QUERY = "DELETE FROM faq_questions WHERE id = ANY(%s)"

# Chat messages keep their history; their faq_id becomes NULL. Params: (faq_id, client_id)
DELETE_FAQ_QUERY = "DELETE FROM faqs WHERE id = %s AND client_id = %s RETURNING id"

# Closest wording of each FAQ, best FAQs first. Params: dict
MATCH_QUERY = """
    SELECT best.faq_id, best.question, best.similarity,
           (SELECT t.question FROM faq_questions t WHERE t.faq_id = best.faq_id ORDER BY t.position, t.id LIMIT 1) AS title
    FROM (
        SELECT DISTINCT ON (q.faq_id) q.faq_id, q.question, 1 - (q.embedding <=> %(embedding)s) AS similarity
        FROM faq_questions q
        WHERE q.client_id = %(client_id)s AND q.faq_id IS DISTINCT FROM %(exclude)s
        ORDER BY q.faq_id, q.embedding <=> %(embedding)s
    ) best
    ORDER BY best.similarity DESC
    LIMIT %(limit)s
"""

# --- Request bodies ---

Wording = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
Answer = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]

class FaqBody(BaseModel):
    questions: list[Wording] = Field(min_length=1, max_length=20)
    answers: list[Answer] = Field(min_length=1, max_length=10)
    button_label: str | None = Field(default=None, max_length=40)
    button_url: str | None = Field(default=None, max_length=500)

    @field_validator("button_label", "button_url", mode="before")
    @classmethod
    def blank_is_none(cls, value):
        if isinstance(value, str):
            value = value.strip()
        return value or None

    @field_validator("button_url")
    @classmethod
    def https_only(cls, value):
        if value is not None:
            parsed = urlparse(value)
            if parsed.scheme != "https" or not parsed.hostname:
                raise ValueError("Use a full address starting with https://")
        return value

    @field_validator("questions")
    @classmethod
    def no_repeats(cls, value):
        seen = set()
        for question in value:
            if question.lower() in seen:
                raise ValueError(f'"{question}" is listed twice')
            seen.add(question.lower())
        return value

    @model_validator(mode="after")
    def button_pair(self):
        if (self.button_label is None) != (self.button_url is None):
            raise ValueError("Give the button both a label and an address, or leave both empty")
        return self

class ThresholdBody(BaseModel):
    value: float = Field(ge=0.5, le=0.95)

class MatchBody(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    exclude_faq_id: int | None = None  # The FAQ being edited, so its own wordings don't count as overlaps

# --- Helpers ---

def _embed(texts):
    return list(get_ov_embedding(texts).numpy()) if texts else []

def _check_clashes(conn, client_id, questions, faq_id):
    clash = conn.execute(CLASHES_QUERY, (client_id, [q.lower() for q in questions], faq_id)).fetchone()
    if clash:
        raise HTTPException(status_code=409, detail=f'"{clash["question"]}" is already a wording of the FAQ "{clash["title"]}"')

def _get_faq(conn, faq_id, client_id):
    faq = conn.execute(FAQ_QUERY, (faq_id, client_id)).fetchone()
    if faq is None:
        raise HTTPException(status_code=404, detail="FAQ not found")
    return faq

def _save_faq(client_id, body, faq_id=None):
    """Creates (faq_id None) or replaces an FAQ. Only new or reworded wordings are embedded again."""
    with db.pool.connection() as conn:
        existing = {}
        if faq_id is not None:
            _get_faq(conn, faq_id, client_id)
            existing = {row["question"]: row["id"] for row in conn.execute(WORDINGS_QUERY, (faq_id,))}
        _check_clashes(conn, client_id, body.questions, faq_id)

        by_lower = {question.lower(): wid for question, wid in existing.items()}
        to_embed = [q for q in body.questions if q not in existing]
        embeddings = dict(zip(to_embed, _embed(to_embed)))
        try:
            with conn.transaction():
                params = (body.answers, body.button_label, body.button_url)
                if faq_id is None:
                    faq_id = conn.execute(INSERT_FAQ_QUERY, (client_id, *params)).fetchone()["id"]
                else:
                    conn.execute(UPDATE_FAQ_QUERY, (*params, faq_id, client_id))
                kept = set()
                for position, question in enumerate(body.questions):
                    wid = existing.get(question) or by_lower.get(question.lower())
                    if wid is None:
                        conn.execute(INSERT_WORDING_QUERY, (faq_id, client_id, question, embeddings[question], position))
                        continue
                    kept.add(wid)
                    if question in existing:
                        conn.execute(UPDATE_WORDING_QUERY, (question, position, wid))
                    else:  # Same words, different capitals
                        conn.execute(UPDATE_WORDING_EMBEDDING_QUERY, (question, embeddings[question], position, wid))
                removed = [wid for wid in existing.values() if wid not in kept]
                if removed:
                    conn.execute(DELETE_WORDINGS_QUERY, (removed,))
        except UniqueViolation:  # Another tab added the same wording in between
            raise HTTPException(status_code=409, detail="One of these wordings was just added to another FAQ. Reload and try again.")
        return _get_faq(conn, faq_id, client_id)

def _match(client_id, question, exclude):
    embedding = get_ov_embedding([question])[0].numpy()
    with db.pool.connection() as conn:
        return conn.execute(MATCH_QUERY, {"client_id": client_id, "embedding": embedding,
                                          "exclude": exclude, "limit": MATCH_LIMIT}).fetchall()

# --- Endpoints ---

@api.get("")
async def list_faqs(account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        faqs = conn.execute(FAQS_QUERY, (account["client_id"],)).fetchall()
        threshold = conn.execute(THRESHOLD_QUERY, (account["client_id"],)).fetchone()["faq_threshold"]
    return {"faqs": faqs, "threshold": threshold, "usage_days": USAGE_DAYS}

@api.put("/threshold")
async def set_threshold(body: ThresholdBody, account=Depends(auth.require_account)):
    value = round(body.value, 2)
    with db.pool.connection() as conn:
        conn.execute(SET_THRESHOLD_QUERY, (value, account["client_id"]))
    db.invalidate_settings(account["client_id"])
    return {"threshold": value}

@api.post("/match")
async def match(body: MatchBody, account=Depends(auth.require_account)):
    """The FAQs closest to a question, with scores. No AI call."""
    matches = await asyncio.to_thread(_match, account["client_id"], body.question.strip(), body.exclude_faq_id)
    return {"matches": matches}

@api.get("/{faq_id}")
async def get_faq(faq_id: int, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        return _get_faq(conn, faq_id, account["client_id"])

@api.post("")
async def create_faq(body: FaqBody, account=Depends(auth.require_account)):
    return await asyncio.to_thread(_save_faq, account["client_id"], body)

@api.put("/{faq_id}")
async def update_faq(faq_id: int, body: FaqBody, account=Depends(auth.require_account)):
    return await asyncio.to_thread(_save_faq, account["client_id"], body, faq_id)

@api.delete("/{faq_id}")
async def delete_faq(faq_id: int, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        if conn.execute(DELETE_FAQ_QUERY, (faq_id, account["client_id"])).fetchone() is None:
            raise HTTPException(status_code=404, detail="FAQ not found")
    return {"ok": True}
