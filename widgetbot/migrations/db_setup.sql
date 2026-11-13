-- One-time Postgres setup for widgetbot. Run as a superuser, e.g.:
--   psql -h localhost -U postgres -f migrations/db_setup.sql
-- You'll be prompted for the postgres password, then for a new password for the widgetbot user.

CREATE ROLE widgetbot LOGIN;
CREATE DATABASE widgetbot OWNER widgetbot;
GRANT ALL PRIVILEGES ON DATABASE widgetbot TO widgetbot;

\c widgetbot
-- pgvector is not a trusted extension, so a superuser has to create it
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO widgetbot;
GRANT ALL ON SCHEMA public TO widgetbot;

\password widgetbot
