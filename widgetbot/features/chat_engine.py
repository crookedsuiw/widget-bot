"""Answers a visitor message: FAQ routing, RAG retrieval, prompt building and Groq generation.

Shared by the widget's /chat route and (from slice 3) the dashboard's prompt test box.
"""
import html
import os
import re
from groq import Groq
from core.embeddings import get_ov_embedding
from core import db

# Setup Groq
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
if GROQ_API_KEY:
    groq_client = Groq(api_key=GROQ_API_KEY)
else:
    print("WARNING: GROQ_API_KEY not set. Generation will fail.")
    groq_client = None

# Shown to customers when generation fails; the real error is logged in messages.error for the dashboard
GENERATION_FAILED_MESSAGE = "Sorry, I couldn't come up with an answer just now. Please try again in a moment."
# Used when the model replies with only a callback tag; the callback card still appears below it
CALLBACK_ONLY_MESSAGE = "I'd be happy to connect you with our team. Just leave your number below."

# Sampling randomness. Groq's default (1.0) occasionally injects stray tokens into the tags below
# (e.g. "[kNO_ANSWER]"); lower values keep fixed strings and factual answers consistent.
CHAT_TEMPERATURE = 0.4

# Fixed rules appended to every prompt (not editable from the dashboard, the server depends on them).
# The model marks the END of its reply with these tags; parse_signals() strips them before the visitor sees it.
CALLBACK_TAG = "[CALLBACK]"
NO_ANSWER_TAG = "[NO_ANSWER]"
SIGNAL_RULES = f"""Conversation signals (always follow these, never mention or explain them):
- If the user shows interest in buying, pricing, a demo, school or bulk orders, or asks to talk to a person, end your reply with {CALLBACK_TAG}"""
NO_ANSWER_RULE = f"- If the context does not contain the answer, politely say you don't have that information and end your reply with {NO_ANSWER_TAG}"

# Tolerant versions of the tags: up to 3 stray characters, any case, and space/underscore/hyphen variants
# ("[kNO_ANSWER]", "[ no answer ]", "[Call-Back]")
_JUNK = r"[^\]\[\n]{0,3}?"
CALLBACK_PATTERN = re.compile(rf"\[\s*{_JUNK}\s*call[\s_-]*back\s*{_JUNK}\s*\]", re.IGNORECASE)
NO_ANSWER_PATTERN = re.compile(rf"\[\s*{_JUNK}\s*no[\s_-]*answer\s*{_JUNK}\s*\]", re.IGNORECASE)
# An all-caps bracketed token left at the start or end is probably a tag variant we don't know yet
_LEFTOVER_TAG = re.compile(r"^\s*\[[A-Z_ ]{4,}\]|\[[A-Z_ ]{4,}\]\s*$")

faq_counters = {} # Keeps track of answer rotation per FAQ id

def faq_button_html(faq):
    """The FAQ's optional button, rendered like the approved-link buttons (the widget sanitises it)."""
    if not faq.get("button_url"):
        return ""
    return (f"<br><a href='{html.escape(faq['button_url'], quote=True)}' target='_blank' class='action-btn'>"
            f"{html.escape(faq['button_label'])}</a>")

def semantic_router(client_id, settings, message: str, user_embedding):
    """
    Returns (tier, preprocessed_response, faq_id)
    Tier 1 = FAQ (OpenVINO Semantic Match)
    Tier 2 = Generic (Regex Match)
    Tier 3 = Specific (Needs RAG)
    """
    msg_lower = message.lower().strip()

    # Tier 1 check (cosine similarity against the client's FAQ questions, computed in Postgres)
    faq = db.match_faq(client_id, user_embedding)
    if faq:
        if faq["similarity"] >= settings["faq_threshold"]:
            print(f"[DEBUG] Matched FAQ '{faq['question']}' with similarity {faq['similarity']:.2f}")

            answers = faq["answers"]
            idx = faq_counters.get(faq["id"], 0) % len(answers)
            faq_counters[faq["id"]] = (idx + 1) % len(answers)
            return 1, answers[idx] + faq_button_html(faq), faq["id"]
        else:
            return 3, "", None

    # Tier 2 check (Regex for generic questions)
    regexPattern = None
    tier_2_patterns = [
        regexPattern
    ]
    for pattern in tier_2_patterns:
        if pattern and re.search(pattern, msg_lower):
            return 2, "", None

    # Tier 3 (Default for everything else)
    return 3, "", None

def format_history(history, bot_name):
    formatted = ""
    for msg in history:
        speaker = "User" if msg["role"] == "user" else bot_name
        formatted += f"{speaker}: {msg['content']}\n"
        if msg["role"] == "bot":
            formatted += "\n"
    return formatted

def build_prompt(settings, history, user_message, context=None):
    """Assembles the prompt from the client's active bot_settings.

    `context` is the RAG extract text for Tier 3; None for Tier 2 (no retrieval).
    The button format is fixed here because the frontend styles `action-btn` links.
    """
    sections = [settings["persona"]]
    if settings["instructions"]:
        sections.append(settings["instructions"])
    if context is not None:
        sections.append("Use the following context extracted from the website to answer the question. "
                        "If the answer is not in the context, do not make it up.")

    if settings["approved_links"]:
        links = "\n".join(f"- {link['label']}: {link['url']}" for link in settings["approved_links"])
        sections.append(f"""IMPORTANT: If you need to direct the user to a specific page or action, ONLY use these official links:
{links}

When providing a link, ALWAYS format it exactly like this button:
<br><br><a href='[OFFICIAL_LINK]' target='_blank' class='action-btn'>[Button Text]</a>

DO NOT make up or guess any other URLs.""")

    if settings["do_not_rules"]:
        sections.append(f"Rules you must always follow:\n{settings['do_not_rules']}")
    sections.append(SIGNAL_RULES + ("\n" + NO_ANSWER_RULE if context is not None else ""))
    if context is not None:
        sections.append(f"Context:\n{context}")

    sections.append(f"""Previous conversation:
{format_history(history, settings['bot_name'])}
User: {user_message}
{settings['bot_name']}:""")
    return "\n\n".join(sections)

def complete(prompt, model, temperature=CHAT_TEMPERATURE):
    """Calls Groq. Returns (text, usage or None, error or None)."""
    if not groq_client:
        return "", None, "GROQ_API_KEY not set"
    try:
        chat_completion = groq_client.chat.completions.create(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            temperature=temperature,
        )
        return chat_completion.choices[0].message.content or "", chat_completion.usage, None
    except Exception as e:
        print(f"[ERROR] Groq generation failed: {str(e)}")
        return "", None, str(e)

def parse_signals(text):
    """Strips the signal tags (and any reasoning block) from a reply, tolerating small glitches in them.

    Returns (clean_text, wants_callback, unanswered).
    """
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    text, callback_count = CALLBACK_PATTERN.subn("", text)
    text, no_answer_count = NO_ANSWER_PATTERN.subn("", text)
    text = text.strip()
    if _LEFTOVER_TAG.search(text):
        print(f"[WARN] Possible unrecognised signal tag in reply: {text[:80]!r} ... {text[-80:]!r}")
    return text, callback_count > 0, no_answer_count > 0

def answer(client_id, settings, user_message, history):
    """Produces the bot reply for one visitor message. Nothing is stored here.

    Returns a dict: tier, text, sources (most relevant first), usage, error, faq_id,
    wants_callback, unanswered.
    """
    # Embedded once, reused for FAQ matching and RAG retrieval
    user_embedding = get_ov_embedding([user_message])[0].numpy()
    tier, preprocessed, faq_id = semantic_router(client_id, settings, user_message, user_embedding)
    result = {"tier": tier, "text": "", "sources": [], "usage": None, "error": None,
              "faq_id": faq_id, "wants_callback": False, "unanswered": False}

    print(f"[INFO] Message classified as Tier {tier}")

    if tier == 1:
        print(f"[ACTION] Returning preprocessed FAQ answer...")
        result["text"] = preprocessed
        return result

    context = None
    if tier == 3:
        print(f"[ACTION] Specific request (TIER 3). Querying Postgres for context...")
        context = ""
        rows = db.retrieve_chunks(client_id, user_embedding, settings["rag_top_k"])
        for i, row in enumerate(rows):
            context += f"--- Extract {i+1} ---\n{row['document']}\n"
            # Rows come back closest first, so this keeps the most relevant page first. Notes have no page.
            url = row['metadata'].get('url')
            if url and url not in result["sources"]:
                result["sources"].append(url)
        print(f"[INFO] Found {len(result['sources'])} unique sources.")

    print(f"[ACTION] Calling Groq{' with RAG context' if context is not None else ' directly (No RAG)'}...")
    prompt = build_prompt(settings, history, user_message, context)
    text, usage, error = complete(prompt, settings["model"])
    text, wants_callback, unanswered = parse_signals(text)

    if not error and not text and wants_callback:
        # The model sent only the tag: still offer the call, with a short reply instead of an error
        result.update(text=CALLBACK_ONLY_MESSAGE, wants_callback=True)
    elif error or not text:
        # Don't cite pages for an answer that never happened
        result.update(text=GENERATION_FAILED_MESSAGE, sources=[], error=error or "Empty reply from model")
    else:
        result.update(text=text, wants_callback=wants_callback, unanswered=unanswered)
    result["usage"] = usage
    return result
