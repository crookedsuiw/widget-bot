#!/usr/bin/env bash
# First-time setup: database tables, client content, dashboard login, knowledge base.
# Safe to re-run. Usage, from this folder:  ./setup.sh <client-slug>
# Set PYTHON=/path/to/python to use a specific interpreter (default: python from your active venv).
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-python}"

slug="${1:-}"
if [ -z "$slug" ]; then
    echo "Usage: ./setup.sh <client-slug>   (the name of a file in scripts/clients/, without .py)"
    exit 1
fi
if [ ! -f "scripts/clients/$slug.py" ]; then
    echo "scripts/clients/$slug.py not found. Copy scripts/clients/example.py to it and fill it in."
    exit 1
fi
if [ ! -f .env ]; then
    echo "No .env file. Copy .env.example to .env and fill it in."
    exit 1
fi
set -a; . ./.env; set +a
if [ -z "${GROQ_API_KEY:-}" ]; then
    echo "GROQ_API_KEY is empty in .env."
    exit 1
fi

echo "==> 1/4 Database tables"
if ! "$PY" -m migrations.migrate; then
    echo
    echo "Could not set up the database. If this is the first install, create it once as a Postgres superuser:"
    echo "    psql -h localhost -U postgres -f migrations/db_setup.sql"
    echo "then put the password you chose into DATABASE_URL in .env and run this script again."
    exit 1
fi

echo "==> 2/4 Client content ($slug)"
"$PY" -m scripts.seed --client "$slug"

echo "==> 3/4 Dashboard login"
read -rp "Dashboard username [$slug]: " username
"$PY" -m scripts.create_admin --client "$slug" --username "${username:-$slug}"

echo "==> 4/4 Knowledge base (crawling the website; this can take a few minutes)"
"$PY" crawler.py --client "$slug"

echo
echo "Done. Start the app with ./run.sh, then open http://${HOST:-127.0.0.1}:${PORT:-8000}/admin"
