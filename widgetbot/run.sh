#!/usr/bin/env bash
# Starts the app with the settings in .env. Usage, from this folder:  ./run.sh
# Always one worker: rate limits, login lockouts, live lead alerts and crawls live in process memory.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env ]; then
    set -a; . ./.env; set +a
fi
exec "${PYTHON:-python}" -m uvicorn main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" --workers 1 "$@"
