# <Client> chat assistant

<!-- Template: replace <Client>, <slug> and <bot-host> before handing over. Developer notes are in DEVELOPING.md (delete it from client copies). -->

An AI chat widget for the <Client> website, with a dashboard where your team handles leads, reads chat history and controls what the assistant says.

It is a self-hosted Python web app (FastAPI) backed by PostgreSQL with the pgvector extension. Search over your content runs locally on the server. Replies come from the Groq API, which needs an API key that you pay for.

## What it does

Each visitor message is answered in one of three ways (see `features/chat_engine.py`):

1. **FAQ match.** If the question is close enough to an FAQ you wrote, your stored answer is sent instantly and costs no AI usage. You set how strict the match is on the dashboard's FAQs page.
2. **Small talk.** Greetings and general questions get a short AI reply without searching your content.
3. **Knowledge-based answer.** The assistant searches extracts of your website plus any notes you added, then writes a reply that follows your prompt rules.

When a visitor shows buying interest, the assistant offers a callback form. Phone numbers left there appear live on the dashboard and, if email is set up, are sent to your team. Questions the assistant couldn't answer are flagged so you can add an FAQ or a note.

In the background, idle chats get a short AI summary and a hot/warm/cold interest label, and chats older than your retention period are deleted.

## Folder layout

```
widgetbot/
├── setup.sh / run.sh    First-time setup, and starting the app
├── .env.example         Settings template (copy to .env)
├── main.py              Web server: widget, chat and lead endpoints
├── crawler.py           Reads your website into the knowledge base
├── core/                Database, login, embedding model
├── features/            Chat engine, leads, summaries, retention, dashboard APIs
├── migrations/          Database setup and schema changes
├── scripts/
│   ├── clients/<slug>.py   Your starting content (prompt, FAQs, notes, pages to crawl)
│   ├── seed.py             Loads that content into the database
│   └── create_admin.py     Creates or resets a dashboard login
├── static/
│   ├── widget/theme.css    Chat widget colours and fonts
│   ├── admin/theme.css     Dashboard colours and fonts
│   ├── widget.js           Embed script, including the launcher button's colours
│   └── brand/              Your logo
└── all-MiniLM-L6-v2-ov-fp16/   Local embedding model
```

Run every command below from inside `widgetbot/`.

## Installation (Linux / macOS)

### Requirements

- Python 3.10 or newer (3.12 recommended)
- PostgreSQL 14+ with the [pgvector](https://github.com/pgvector/pgvector) extension installed
- A [Groq API key](https://console.groq.com/)

### 1. Install the app

```bash
cd widgetbot
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
playwright install --with-deps chromium   # the crawler opens pages in a headless browser
```

### 2. Create the database (once)

As a Postgres superuser, run the line below. It creates a `widgetbot` user and database, turns on pgvector, and asks you to choose a password for the `widgetbot` user:

```bash
psql -h localhost -U postgres -f migrations/db_setup.sql
```

### 3. Settings

```bash
cp .env.example .env
```

Open `.env` and fill in `DATABASE_URL` (with the password from step 2) and `GROQ_API_KEY`. Each setting is explained in the file. Keep `.env` private and out of version control.

### 4. Set up and start

```bash
./setup.sh <slug>    # creates tables, loads your content, asks for a dashboard login, crawls your website
./run.sh             # starts the app
```

`setup.sh` is safe to run again. It never overwrites changes made on the dashboard. Running it again with an existing username resets that login's password.

- **http://127.0.0.1:8000/** is a test page with the widget on it.
- **http://127.0.0.1:8000/admin** is the dashboard.

## Putting the widget on your website

Add this line to every page of your site, before `</body>`:

```html
<script src="https://<bot-host>/widget.js" data-key="<widget_key>" async></script>
```

- `<widget_key>` is printed by `setup.sh`. To look it up later, run `psql "$DATABASE_URL" -c "SELECT widget_key FROM clients;"`.
- The chat only opens on the website addresses in `ALLOWED_ORIGINS` (in `scripts/clients/<slug>.py`). The address must be exact: `https://` plus the domain, with no trailing slash. If your site answers both with and without `www.`, list both. After the first setup, change it in the database: `UPDATE clients SET allowed_origins = '{https://example.com,https://www.example.com}';`

## Using the dashboard

Log in at `/admin`.

- **Overview:** usage, AI cost, the list of pages to crawl, and a re-crawl button. Re-crawl after you change your website.
- **Leads:** callback requests, with live alerts as they come in.
- **Chat history:** every conversation, with its summary and interest level. Can be exported as CSV.
- **Prompt rules:** the assistant's persona, rules and links. Edit a draft, test it, save it as a new version, then make it live. You can roll back to any earlier version.
- **FAQs:** instant answers at no AI cost. Each FAQ can have several wordings, rotating answers and a button. Includes a match tester.
- **Knowledge:** browse what was read from your website, hide anything irrelevant, add your own notes, and test what the assistant would read for a given question.
- **Settings:** business details, the widget's welcome text and quick replies, the lead alert email, chat retention, password and sessions.

Replies and FAQ answers can use `**bold**`, `~~strikethrough~~` and links.

## Changing the look

- **Widget:** `static/widget/theme.css` holds every colour, gradient, shadow and font.
- **Launcher button:** the round button on your site is drawn outside the widget, so its colours are in the `THEME` block at the top of `static/widget.js`. Keep them in step with `theme.css`.
- **Dashboard:** `static/admin/theme.css`.
- **Logo:** put the file in `static/brand/`, then set it on the dashboard's Settings page, or set `LOGO_URL` before the first setup.

Browsers pick up the changes after a restart (`./run.sh`). The widget's file versions are recalculated on start.

## Going live checklist

- Serve the app over HTTPS behind a reverse proxy (nginx, Caddy), and set `COOKIE_SECURE=1` in `.env`.
- Use a strong database password. Keep it only in `.env`.
- Run a single worker. `run.sh` already does this; don't add `--reload` or extra workers. Rate limits, login lockouts, live lead alerts and crawls are kept in memory.
- Set the `SMTP_*` settings if your team should get lead emails.
- Check that `allowed_origins` matches your live domain exactly.
- Back up PostgreSQL regularly. It holds all settings, FAQs, chats, leads and knowledge.
- Keep `run.sh` running under a process manager (systemd, supervisor) so it restarts after a crash or reboot.

## Database changes

Schema changes live in `migrations/versions/` as numbered SQL files. To apply new ones after an update, run `python -m migrations.migrate` (also part of `setup.sh`). Each file runs once, in its own transaction. Never edit a file that has already been applied; add a new one instead.

## Licence

See `LICENSE`.
