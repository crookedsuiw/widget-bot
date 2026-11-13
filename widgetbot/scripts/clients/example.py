"""Template for a client's seed content. Copy to scripts/clients/<slug>.py; the file name is the client's slug.

Then run `./setup.sh <slug>`, or `python -m scripts.seed --client <slug>`.
Only the first run writes these values. After that, change them on the dashboard; re-running never overwrites edits.
"""

# Shown on the dashboard and in prompts
CLIENT_NAME = "Example Co"

# Websites allowed to embed the widget: scheme + domain only, no trailing slash or path.
# List both forms if the site answers on www and without it. Not editable from the dashboard.
ALLOWED_ORIGINS = ["https://example.com", "https://www.example.com"]

# Groq model used for replies (can be changed per prompt setting on the dashboard)
GROQ_MODEL_NAME = 'qwen/qwen3.8-27b'

# --- Bot settings: version 1 of the "Default" prompt setting (dashboard: Prompt rules) ---
BOT_NAME = "ExampleBot"
PERSONA = """You are ExampleBot, a helpful assistant for Example Co.
Tone: friendly and brief."""
INSTRUCTIONS = "Only use links when relevant to the user's question or when they flow with a natural response."
DO_NOT_RULES = """Do not hallucinate specific facts about Example Co.
Do not jam in links for unrelated queries."""
# Links the bot may offer, as {"label", "url"}
APPROVED_LINKS = [
    {"label": "Main Website", "url": "https://example.com/"},
]
# Similarity (0-1) a question needs to get an FAQ answer instead of an AI reply (dashboard: FAQs)
FAQ_THRESHOLD = 0.70
# How many knowledge extracts the AI reads per question
RAG_TOP_K = 5

# --- Widget content (dashboard: Settings) ---
# Put the logo file in static/brand/ and point to it, e.g. "/static/brand/logo.png". None hides it.
LOGO_URL = None
PRIVACY_URL = None  # Privacy policy link under the chat box; None hides it
WELCOME_TITLE = "Hi! How can we help?"
GREETING = "Ask about our products, orders, or anything else."
# Buttons on the welcome screen. icon is one of: sparkle, download, games, phone (colours in static/widget/theme.css)
QUICK_REPLIES = [
    {"label": "What do you do?", "message": "What does Example Co do?", "icon": "sparkle"},
    {"label": "Contact support", "message": "How do I contact support?", "icon": "phone"},
]

# --- Instant FAQ answers: wording -> list of answers (one is picked in rotation) ---
# Several wordings can share one answer list. Answers may use **bold**, ~~strikethrough~~ and <a> links;
# class='action-btn' on a link turns it into a button.
FAQS = {
    # "how do i contact support": ["Email us at support@example.com 📧"],
}

# --- Pages to crawl into the knowledge base: (url, strategy) ---
# 'html' splits on headings; 'recursive_only' splits plain text (better for pages without clear headings).
KNOWLEDGE_SOURCES = [
    ("https://example.com/", "html"),
]
