"""Server settings that several modules need, read once from .env."""
import os
import re
from urllib.parse import urlsplit
from dotenv import load_dotenv

load_dotenv()

# The address people reach this app at, e.g. https://bot.example.com. Links in alert emails and the CSV
# export are built from it, never from the request's Host header (which anyone can set).
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?", PUBLIC_BASE_URL):
    raise SystemExit("Set PUBLIC_BASE_URL in .env to the address the app is reached at, "
                     "e.g. https://bot.example.com (no path, no trailing slash).")

# Host names requests may be addressed to: PUBLIC_BASE_URL's host plus any extra ones in ALLOWED_HOSTS
ALLOWED_HOSTS = sorted({urlsplit(PUBLIC_BASE_URL).hostname,
                        *(h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip())})
