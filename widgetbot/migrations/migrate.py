"""Applies migrations/versions/*.sql in filename order, each exactly once.

All pending files run in ONE transaction: either every one of them is applied, or (on any error) none is,
so a failed setup never leaves the database half-migrated.
Usage (from widgetbot/): python -m migrations.migrate
"""
import os
import re
import psycopg
from core.db import DATABASE_URL

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "versions")

# Statements Postgres refuses to run inside a transaction block; they would break the all-or-nothing run
NON_TRANSACTIONAL = re.compile(r"\b(CONCURRENTLY|VACUUM)\b|\bCREATE\s+EXTENSION\b|\bALTER\s+SYSTEM\b", re.IGNORECASE)

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

        scripts = []
        for filename in pending:
            with open(os.path.join(MIGRATIONS_DIR, filename), encoding="utf-8") as f:
                sql = f.read()
            if NON_TRANSACTIONAL.search(sql):
                raise SystemExit(f"{filename} uses a statement that can't run inside a transaction "
                                 "(CONCURRENTLY, VACUUM, CREATE EXTENSION, ALTER SYSTEM). Move it to db_setup.sql.")
            scripts.append((filename, sql))

        try:
            with conn.transaction():
                for filename, sql in scripts:
                    print(f"Applying {filename}...")
                    conn.execute(sql)
                    conn.execute("INSERT INTO schema_migrations (filename) VALUES (%s)", (filename,))
        except psycopg.Error as e:
            raise SystemExit(f"Migration failed in {filename}; nothing was applied.\n{e}")

        print(f"Applied {len(pending)} migration(s).")

if __name__ == "__main__":
    main()
