"""Dashboard Knowledge base API: browse website extracts, hide junk ones, the manager's own notes, and a search
test that shows exactly what the bot would read for a question. (Crawl pages and re-crawl live in admin_overview.)

Every query is scoped to the logged-in account's client_id.
"""
import asyncio
import hashlib
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from typing import Annotated
from core import auth
from core import db
from core.embeddings import get_ov_embedding

api = APIRouter(prefix="/admin/api/knowledge", dependencies=[Depends(auth.require_account)])

MAX_EXTRACTS = 3000  # Browser limit; a site this big needs paging

# --- Queries ---

# Every extract of the latest crawl, page by page in crawl order. Params: (client_id, limit)
EXTRACTS_QUERY = """
    SELECT c.id, c.document, c.metadata, md5(c.document) AS text_hash,
           EXISTS (SELECT 1 FROM hidden_chunks h WHERE h.client_id = c.client_id AND h.text_hash = md5(c.document)) AS hidden
    FROM chunks c
    WHERE c.client_id = %s
    ORDER BY c.metadata->>'url', c.ctid
    LIMIT %s
"""

# Only text that is actually one of this client's extracts can be hidden. Params: (client_id, text_hash, client_id)
HIDE_QUERY = """
    INSERT INTO hidden_chunks (client_id, text_hash)
    SELECT %s, %s WHERE EXISTS (SELECT 1 FROM chunks WHERE client_id = %s AND md5(document) = %s)
    ON CONFLICT DO NOTHING
"""

# Params: (client_id, text_hash)
UNHIDE_QUERY = "DELETE FROM hidden_chunks WHERE client_id = %s AND text_hash = %s"

# Params: (client_id,)
NOTES_QUERY = "SELECT id, title, body, updated_at FROM knowledge_notes WHERE client_id = %s ORDER BY id"

# Params: (client_id, title, body, embedding)
INSERT_NOTE_QUERY = """
    INSERT INTO knowledge_notes (client_id, title, body, embedding) VALUES (%s, %s, %s, %s)
    RETURNING id, title, body, updated_at
"""

# Params: (title, body, embedding, note_id, client_id)
UPDATE_NOTE_QUERY = """
    UPDATE knowledge_notes SET title = %s, body = %s, embedding = %s, updated_at = now()
    WHERE id = %s AND client_id = %s
    RETURNING id, title, body, updated_at
"""

# Params: (note_id, client_id)
DELETE_NOTE_QUERY = "DELETE FROM knowledge_notes WHERE id = %s AND client_id = %s RETURNING id"

# --- Request bodies ---

class NoteBody(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    body: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]

class HideBody(BaseModel):
    text_hash: str = Field(pattern=r"^[0-9a-f]{32}$")

class SearchBody(BaseModel):
    question: str = Field(min_length=1, max_length=1000)

# --- Helpers ---

def _note_embedding(body):
    return get_ov_embedding([f"{body.title}\n{body.body}"])[0].numpy()

def _search(client_id, question):
    """What the bot would read for this question: the same retrieval and top-k as a real answer."""
    settings = db.get_active_settings(client_id)
    top_k = settings["rag_top_k"]
    rows = db.retrieve_chunks(client_id, get_ov_embedding([question])[0].numpy(), top_k)
    results = []
    for row in rows:
        meta = row["metadata"]
        results.append({
            "document": row["document"], "similarity": row["similarity"],
            "url": meta.get("url"), "note_id": meta.get("note_id"), "note_title": meta.get("title"),
            "headers": [v for k, v in meta.items() if k.startswith("Header")],
            # Same hash Postgres uses (md5 of the UTF-8 text), so a result can be hidden from here
            "text_hash": None if meta.get("note_id") else hashlib.md5(row["document"].encode()).hexdigest(),
        })
    return {"results": results, "top_k": top_k}

# --- Endpoints ---

@api.get("/extracts")
async def extracts(account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        rows = conn.execute(EXTRACTS_QUERY, (account["client_id"], MAX_EXTRACTS)).fetchall()
    pages = {}
    for row in rows:
        meta = row["metadata"]
        pages.setdefault(meta.get("url") or "", []).append({
            "id": row["id"], "document": row["document"], "text_hash": row["text_hash"], "hidden": row["hidden"],
            "headers": [v for k, v in meta.items() if k.startswith("Header")],
        })
    return {"pages": [{"url": url, "extracts": items} for url, items in pages.items()],
            "total": len(rows), "hidden": sum(r["hidden"] for r in rows), "truncated": len(rows) == MAX_EXTRACTS}

@api.post("/hidden")
async def hide(body: HideBody, account=Depends(auth.require_account)):
    client_id = account["client_id"]
    with db.pool.connection() as conn:
        conn.execute(HIDE_QUERY, (client_id, body.text_hash, client_id, body.text_hash))
    return {"ok": True}

@api.delete("/hidden/{text_hash}")
async def unhide(text_hash: str, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        conn.execute(UNHIDE_QUERY, (account["client_id"], text_hash))
    return {"ok": True}

@api.post("/search")
async def search(body: SearchBody, account=Depends(auth.require_account)):
    return await asyncio.to_thread(_search, account["client_id"], body.question.strip())

@api.get("/notes")
async def notes(account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        return {"notes": conn.execute(NOTES_QUERY, (account["client_id"],)).fetchall()}

@api.post("/notes")
async def create_note(body: NoteBody, account=Depends(auth.require_account)):
    embedding = await asyncio.to_thread(_note_embedding, body)
    with db.pool.connection() as conn:
        return conn.execute(INSERT_NOTE_QUERY, (account["client_id"], body.title, body.body, embedding)).fetchone()

@api.put("/notes/{note_id}")
async def update_note(note_id: int, body: NoteBody, account=Depends(auth.require_account)):
    embedding = await asyncio.to_thread(_note_embedding, body)
    with db.pool.connection() as conn:
        note = conn.execute(UPDATE_NOTE_QUERY, (body.title, body.body, embedding, note_id, account["client_id"])).fetchone()
    if note is None:
        raise HTTPException(status_code=404, detail="Note not found")
    return note

@api.delete("/notes/{note_id}")
async def delete_note(note_id: int, account=Depends(auth.require_account)):
    with db.pool.connection() as conn:
        if conn.execute(DELETE_NOTE_QUERY, (note_id, account["client_id"])).fetchone() is None:
            raise HTTPException(status_code=404, detail="Note not found")
    return {"ok": True}
