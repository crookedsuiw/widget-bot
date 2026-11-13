"""Manager dashboard login: password hashing, cookie sessions and request guards."""
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque
from urllib.parse import urlparse
from fastapi import HTTPException, Request
from core import db

SESSION_COOKIE = "widgetbot_admin"
SESSION_DAYS = 7
# Set COOKIE_SECURE=1 when served over HTTPS so the cookie is never sent in plain text
COOKIE_SECURE = os.environ.get("COOKIE_SECURE") == "1"

MIN_PASSWORD_LENGTH = 10
LOGIN_MAX_FAILURES = 5          # per IP ...
LOGIN_WINDOW_SECONDS = 15 * 60  # ... within this window

# scrypt cost parameters (stored with each hash so they can be raised later)
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 14, 8, 1

# Params: (username,)
GET_ACCOUNT_BY_USERNAME_QUERY = """
    SELECT id, client_id, username, password_hash FROM admin_accounts WHERE username = %s
"""

# Params: (token_hash, account_id, days, ip, user_agent)
CREATE_SESSION_QUERY = """
    INSERT INTO admin_sessions (token_hash, account_id, expires_at, ip, user_agent)
    VALUES (%s, %s, now() + make_interval(days => %s), %s, %s)
"""

# Params: (token_hash,)
GET_SESSION_ACCOUNT_QUERY = """
    SELECT a.id, a.client_id, a.username, c.name AS client_name
    FROM admin_sessions s
    JOIN admin_accounts a ON a.id = s.account_id
    JOIN clients c ON c.id = a.client_id
    WHERE s.token_hash = %s AND s.expires_at > now()
"""

# Expire instead of delete, so the row stays in the login log. Params: (token_hash,)
END_SESSION_QUERY = """
    UPDATE admin_sessions SET expires_at = now() WHERE token_hash = %s AND expires_at > now()
"""

# --- Passwords ---

def hash_password(password):
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"

def verify_password(password, stored):
    try:
        _, n, r, p, salt, expected = stored.split("$")
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                                n=int(n), r=int(r), p=int(p), dklen=32)
    except ValueError:
        return False
    return hmac.compare_digest(digest.hex(), expected)

# --- Sessions ---

def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()

_login_failures = defaultdict(deque)  # ip -> monotonic times of failed logins

def check_login_allowed(ip):
    now = time.monotonic()
    failures = _login_failures[ip]
    while failures and now - failures[0] > LOGIN_WINDOW_SECONDS:
        failures.popleft()
    if len(failures) >= LOGIN_MAX_FAILURES:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again in 15 minutes.")

def login(username, password, ip, user_agent):
    """Returns a new session token, or None when the credentials are wrong."""
    check_login_allowed(ip)
    with db.pool.connection() as conn:
        account = conn.execute(GET_ACCOUNT_BY_USERNAME_QUERY, (username,)).fetchone()
        if not account or not verify_password(password, account["password_hash"]):
            _login_failures[ip].append(time.monotonic())
            return None
        token = secrets.token_urlsafe(32)
        conn.execute(CREATE_SESSION_QUERY,
                     (_token_hash(token), account["id"], SESSION_DAYS, ip, (user_agent or "")[:300]))
    _login_failures.pop(ip, None)
    return token

def logout(token):
    with db.pool.connection() as conn:
        conn.execute(END_SESSION_QUERY, (_token_hash(token),))

def set_session_cookie(response, token):
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=COOKIE_SECURE, samesite="strict", path="/admin")

def clear_session_cookie(response):
    response.delete_cookie(SESSION_COOKIE, path="/admin")

def request_token_hash(request: Request):
    """Identifies this browser's session (e.g. to keep it when logging out the others)."""
    token = request.cookies.get(SESSION_COOKIE)
    return _token_hash(token) if token else None

def current_account(request: Request):
    """The logged-in account (id, client_id, username, client_name), or None."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    with db.pool.connection() as conn:
        return conn.execute(GET_SESSION_ACCOUNT_QUERY, (_token_hash(token),)).fetchone()

# --- Request guards ---

def check_same_origin(request: Request):
    """Blocks cross-site form posts (CSRF): data-changing requests must come from this server's own pages."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    origin = request.headers.get("origin")
    if not origin or urlparse(origin).netloc != request.headers.get("host"):
        raise HTTPException(status_code=403, detail="Cross-site request blocked")

def require_account(request: Request):
    """FastAPI dependency for every /admin/api route."""
    check_same_origin(request)
    account = current_account(request)
    if account is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    return account
