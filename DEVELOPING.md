# Developing widgetbot (internal: delete from client copies)

widgetbot is a brand-neutral core. Each client gets their own copy, with its own database, design and content. The copy is handed over as a standalone app.

## Repo model

```
widgetbot/            core: brand-neutral, no client files, clean history
widgetbot-<slug>/     one per client, cloned from the core
```

- Client repos are **clones** of the core, so they share its history. A core fix reaches a client with
  `git fetch core && git cherry-pick <sha>`.
- Keep client changes inside these paths so cherry-picks apply cleanly:
  - `widgetbot/static/widget/theme.css`, `widgetbot/static/admin/theme.css`, the `THEME` block in `widgetbot/static/widget.js`
  - `widgetbot/scripts/clients/<slug>.py`
  - `widgetbot/static/brand/`
  - `README.md` (fill in the placeholders)
- A change that would help every client belongs in the core first. Then cherry-pick it into each client repo.
- Never put one client's files (content, logo, contacts) in the core or in another client's repo.

## New client copy

```bash
git clone /path/to/widgetbot widgetbot-<slug>
cd widgetbot-<slug>
git remote rename origin core
git remote add origin <client's repo url>        # where the client copy will live

cp widgetbot/scripts/clients/example.py widgetbot/scripts/clients/<slug>.py   # fill in
# put the logo in widgetbot/static/brand/, restyle the theme.css files and THEME in widget.js
# README.md: replace <Client>, <slug>, <bot-host>; set LICENSE; delete DEVELOPING.md
git add -A && git commit -m "<Client> setup"
```

Then set it up locally to check it works. Use a fresh database per client, and when testing several on one machine, give each its own database name in `db_setup.sql`:

```bash
cd widgetbot && cp .env.example .env   # fill in
psql -h localhost -U postgres -f migrations/db_setup.sql
./setup.sh <slug> && ./run.sh
```

## Conventions

- Schema changes: add the next `migrations/versions/NNN_*.sql`. Never edit an applied one.
- `scripts/clients/<slug>.py` is only read on the first seed. After that, the dashboard is the source of truth.
- Colours: never hardcode them in `widget.css`, `admin.css` or the JS. Add a token to the matching `theme.css`. Widget icons use `currentColor`.
- Single uvicorn worker: rate limits, lockouts, lead alerts and crawl state live in process memory.
