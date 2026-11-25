"""Applies migrations/versions/*.sql in filename order, each exactly once.

Usage (from widgetbot/): python -m migrations.migrate
"""
import os
import psycopg
from core.db import DATABASE_URL

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "versions")

CREATE_MIGRATIONS_TABLE_QUERY = """
    CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
"""

def main():
    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(CREATE_MIGRATIONS_TABLE_QUERY)
        applied = {row[0] for row in conn.execute("SELECT filename FROM schema_migrations")}
        conn.commit()

        pending = sorted(f for f in os.listdir(MIGRATIONS_DIR) if f.endswith(".sql") and f not in applied)
        if not pending:
            print("Database is up to date.")
            return

        for filename in pending:
            print(f"Applying {filename}...")
            with open(os.path.join(MIGRATIONS_DIR, filename), encoding="utf-8") as f:
                sql = f.read()
            # Each migration and its bookkeeping row commit together, so a failure leaves nothing half-applied
            with conn.transaction():
                conn.execute(sql)
                conn.execute("INSERT INTO schema_migrations (filename) VALUES (%s)", (filename,))

        print(f"Applied {len(pending)} migration(s).")

if __name__ == "__main__":
    main()
