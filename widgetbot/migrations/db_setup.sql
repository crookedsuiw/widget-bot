-- One-time Postgres setup for widgetbot. Run as a superuser, e.g.:
--   psql -h localhost -U postgres -f migrations/db_setup.sql
--   sudo -u postgres psql -f migrations/db_setup.sql (Linux)
-- You'll be prompted for the postgres password, then for new passwords for the two widgetbot users:
--   widgetbot      owns the tables; only migrations log in as it (MIGRATIONS_DATABASE_URL in .env)
--   widgetbot_app  what the app, setup and crawler use (DATABASE_URL): it can read and write rows,
--                  but can't create, change or drop tables, so a bug or break-in in the app can't either

CREATE ROLE widgetbot LOGIN;
CREATE ROLE widgetbot_app LOGIN;
CREATE DATABASE widgetbot OWNER widgetbot;
REVOKE ALL ON DATABASE widgetbot FROM PUBLIC;
GRANT CONNECT ON DATABASE widgetbot TO widgetbot_app;

\c widgetbot
-- pgvector is not a trusted extension, so a superuser has to create it
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO widgetbot;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO widgetbot_app;
-- Every table and sequence migrations create (as widgetbot) is readable and writable by the app
ALTER DEFAULT PRIVILEGES FOR ROLE widgetbot IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO widgetbot_app;
ALTER DEFAULT PRIVILEGES FOR ROLE widgetbot IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO widgetbot_app;

\password widgetbot
\password widgetbot_app
