"""Creates the shared manager login for a client, or resets its password.

Usage (from widgetbot/): python -m scripts.create_admin --username <name> [--client <slug>]
--client can be left out when the install has a single client.
The password is asked for interactively, so it never lands in shell history.
"""
import argparse
import getpass
import psycopg
from core.db import DATABASE_URL, sole_client_slug
from core.auth import MIN_PASSWORD_LENGTH, hash_password

# Params: (slug,)
GET_CLIENT_ID_QUERY = "SELECT id FROM clients WHERE slug = %s"

# Re-running for an existing username resets its password. Params: (client_id, username, password_hash)
UPSERT_ACCOUNT_QUERY = """
    INSERT INTO admin_accounts (client_id, username, password_hash)
    VALUES (%s, %s, %s)
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
    RETURNING (xmax = 0) AS created
"""

# A password reset logs out every open dashboard session. Params: (username,)
END_ALL_SESSIONS_QUERY = """
    UPDATE admin_sessions SET expires_at = now()
    WHERE expires_at > now() AND account_id = (SELECT id FROM admin_accounts WHERE username = %s)
"""

def main():
    parser = argparse.ArgumentParser(description="Create or reset the dashboard login for a client")
    parser.add_argument("--client", help="client slug (default: the only client)")
    parser.add_argument("--username", required=True)
    args = parser.parse_args()

    password = getpass.getpass("Password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if getpass.getpass("Repeat password: ") != password:
        raise SystemExit("Passwords don't match.")

    with psycopg.connect(DATABASE_URL) as conn:
        try:
            args.client = args.client or sole_client_slug(conn)
        except LookupError as e:
            raise SystemExit(str(e))
        row = conn.execute(GET_CLIENT_ID_QUERY, (args.client,)).fetchone()
        if row is None:
            raise SystemExit(f"Unknown client '{args.client}'. Run seed.py first.")
        created = conn.execute(UPSERT_ACCOUNT_QUERY, (row[0], args.username, hash_password(password))).fetchone()[0]
        if not created:
            conn.execute(END_ALL_SESSIONS_QUERY, (args.username,))

    print(f"{'Created' if created else 'Reset password for'} dashboard login '{args.username}'.")

if __name__ == "__main__":
    main()
