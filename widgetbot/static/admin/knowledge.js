// /admin/knowledge: what the assistant answers from. Website pages and re-crawl, a search test that shows the
// extracts the bot would read, the manager's own notes, and every extract (junk ones can be hidden).

export const CRAWL_POLL_MS = 2000;
const STRATEGY = { html: 'Page with sections', recursive_only: 'Plain text page' };
const CLAMP_CHARS = 280;  // Longer extracts are cut here until "Show more"
const CLAMP_LINES = 6;    // …and so are ones made of many short lines (menus, card grids)

export async function render(view, ctx) {
    const { fmt } = ctx;
    const { h } = fmt;
    view.append(h('div', { class: 'page-head' },
        h('div', {}, h('h1', { text: 'Knowledge base' }),
            h('p', { class: 'muted', text: 'What the assistant reads when a question isn\'t an FAQ: extracts from your website pages, plus your own notes.' }))));

    const search = h('section', { class: 'card card-pad kb-search' });
    const pages = h('section', { class: 'card card-pad knowledge', 'aria-labelledby': 'knowledge-title' });
    const notes = h('section', { class: 'card card-pad kb-notes' });
    const extracts = h('section', { class: 'card card-pad kb-extracts' });
    view.append(search, pages, notes, extracts);

    // Hiding or unhiding from the search results updates the browser below, and the other way round
    const sync = { refreshExtracts: null, rerunSearch: null };
    await Promise.all([
        searchCard(search, ctx, sync),
        crawlCard(pages, ctx, () => sync.refreshExtracts?.()),
        notesCard(notes, ctx, () => sync.rerunSearch?.()),
        extractsCard(extracts, ctx, sync),
    ]);
}

// --- Shared with the Overview's quick re-crawl ---

export function duration(run) {
    if (!run.finished_at) return '';
    const s = Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function describeRun(run, fmt) {
    if (!run) return 'Not crawled yet.';
    if (run.status === 'running') {
        const done = run.pages.filter((p) => p.ok !== null).length;
        return `Crawling… ${done} of ${run.pages.length || '?'} pages fetched`;
    }
    if (run.status === 'failed') {
        return `Last crawl failed ${fmt.when(run.finished_at || run.started_at)}: ${run.error || 'unknown error'}. `
            + 'The assistant still uses the previous crawl.';
    }
    return `Last crawled ${fmt.when(run.finished_at)} · ${run.chunk_count} extracts · took ${duration(run)}`;
}

function excerpt(h, text) {
    const short = text.split('\n').slice(0, CLAMP_LINES).join('\n').slice(0, CLAMP_CHARS).trimEnd();
    if (short === text.trimEnd()) return h('p', { class: 'kb-text', text });
    const body = h('p', { class: 'kb-text', text: short + '…' });
    let open = false;
    const toggle = h('button', { type: 'button', class: 'link-btn kb-more', text: 'Show more', onclick: () => {
        open = !open;
        body.textContent = open ? text : short + '…';
        toggle.textContent = open ? 'Show less' : 'Show more';
    } });
    return [body, toggle];
}

// --- Search test ---

async function searchCard(card, ctx, sync) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let question = '';

    const input = h('input', { class: 'input', placeholder: 'Type a question a visitor might ask…', maxlength: 1000, 'aria-label': 'Question to search' });
    const searchBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Search' });
    const summary = h('p', { class: 'muted kb-summary', 'aria-live': 'polite' });
    const results = h('div', { class: 'kb-results' });
    const fullBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Full answer', hidden: true,
        title: 'Run the live bot on this question (uses AI tokens)', onclick: fullAnswer });
    const fullBox = h('div', { class: 'match-full' });

    card.append(
        h('h2', { text: 'Search test' }),
        h('p', { class: 'field-help', text: 'Shows the extracts the assistant would read for a question, closest first. FAQs are checked before this; see the FAQs page.' }),
        h('form', { class: 'test-form', onsubmit: (e) => { e.preventDefault(); question = input.value.trim(); run(); } }, input, searchBtn),
        summary, results,
        h('div', { class: 'match-foot' }, h('span', {}), fullBtn),
        fullBox);

    async function run() {
        if (!question) return;
        searchBtn.disabled = true;
        fullBox.replaceChildren();
        try {
            const data = await api.post('/admin/api/knowledge/search', { question });
            summary.textContent = data.results.length
                ? `The assistant reads the ${data.results.length} closest of up to ${data.top_k} (set under Prompt rules → Advanced).`
                : 'Nothing to read yet: crawl the website or add a note.';
            results.replaceChildren(...data.results.map(resultRow));
            fullBtn.hidden = false;
        } catch (e) {
            summary.textContent = e.message;
        }
        searchBtn.disabled = false;
    }
    sync.rerunSearch = () => { if (question) run(); };

    function resultRow(r) {
        const source = r.note_id
            ? h('span', { class: 'pill pill-lead', text: `Your note: ${r.note_title}` })
            : h('a', { class: 'source-link', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: fmt.sourceLabel(r.url) });
        return h('div', { class: 'kb-result' },
            h('strong', { class: 'match-score', text: r.similarity.toFixed(2) }),
            h('div', { class: 'kb-body' },
                h('div', { class: 'kb-source' }, source,
                    r.headers.length ? h('span', { class: 'muted', text: r.headers.join(' › ') }) : null),
                excerpt(h, r.document)),
            r.text_hash ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Hide this extract', title: 'Hide: the assistant skips it',
                onclick: async () => {
                    await api.post('/admin/api/knowledge/hidden', { text_hash: r.text_hash });
                    run();
                    sync.refreshExtracts?.();
                } }, fmt.icon('eyeOff')) : h('span', {}));
    }

    async function fullAnswer() {
        fullBtn.disabled = true;
        fullBox.replaceChildren(h('div', { class: 't-bot-bubble test-wait', text: 'Thinking…' }));
        try {
            const a = await api.post('/admin/api/prompts/test', { target: 'live', message: question, history: [] });
            const tokens = (a.prompt_tokens || 0) + (a.completion_tokens || 0);
            fullBox.replaceChildren(...[
                h('div', { class: 't-bot-bubble' }, fmt.botHtml(a.text)),
                a.error ? h('div', { class: 't-error', text: `Model error: ${a.error}` }) : null,
                h('div', { class: 't-meta' },
                    h('span', { text: fmt.TIER[a.tier] }),
                    tokens ? h('span', { text: `${tokens.toLocaleString()} tokens` }) : null,
                    h('span', { text: `${(a.latency_ms / 1000).toFixed(1)} s` }),
                    a.unanswered ? h('span', { class: 'pill pill-flag', text: 'Unanswered' }) : null),
            ].filter(Boolean));
        } catch (e) {
            fullBox.replaceChildren(h('div', { class: 't-error', text: e.message }));
        }
        fullBtn.disabled = false;
    }
}

// --- Website pages (crawl) ---

async function crawlCard(card, ctx, onCrawled) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let state = await api.get('/admin/api/crawl');
    let pollTimer = null;
    ctx.signal.addEventListener('abort', () => clearTimeout(pollTimer));

    const status = h('p', { class: 'crawl-status', 'aria-live': 'polite' });
    const crawlButton = h('button', { type: 'button', class: 'btn btn-primary', text: 'Re-crawl website', onclick: startCrawl });
    const pending = h('span', { class: 'pill pill-lead', text: 'Re-crawl to apply changes', hidden: true });
    const rows = h('div', { class: 'source-list' });
    const history = h('div', { class: 'crawl-history' });
    const addError = h('p', { class: 'form-error', 'aria-live': 'polite' });
    const urlInput = h('input', { class: 'input source-url', type: 'url', placeholder: 'https://example.com/page', 'aria-label': 'Page address', required: true });
    const strategySelect = fmt.select(STRATEGY, 'html', { 'aria-label': 'Page type' });

    const addForm = h('form', { class: 'source-add', onsubmit: addSource },
        urlInput, strategySelect, h('button', { type: 'submit', class: 'btn', text: 'Add page' }));

    card.append(
        h('div', { class: 'knowledge-head' },
            h('div', {}, h('h2', { id: 'knowledge-title', text: 'Website pages' }), status),
            h('div', { class: 'knowledge-actions' }, pending, crawlButton)),
        h('p', { class: 'muted small', text: 'The assistant answers from these pages. Changes here apply on the next crawl. '
            + '"Page with sections" splits at headings; "Plain text page" suits lists and short pages.' }),
        rows, addForm, addError,
        h('details', { class: 'crawl-details' }, h('summary', { text: 'Recent crawls' }), history),
    );

    function latestRun() { return state.runs[0] || null; }

    // Crawls from before per-page results were recorded (migration 004) have an empty page list
    function isLegacyRun(run) { return run && run.status === 'done' && !run.pages.length; }

    // Has the list changed since the latest crawl read it?
    function hasPendingChanges() {
        const run = latestRun();
        if (!run || run.status === 'running' || isLegacyRun(run)) return false;
        const crawled = new Map(run.pages.map((p) => [p.url, p.strategy]));
        const enabled = state.sources.filter((s) => s.enabled);
        return enabled.length !== crawled.size || enabled.some((s) => crawled.get(s.url) !== s.strategy);
    }

    function pageResult(source) {
        const run = latestRun();
        const page = run?.pages.find((p) => p.url === source.url);
        if (run?.status === 'running' && page) {
            if (page.ok === null) return h('span', { class: 'muted', text: 'Waiting…' });
            return page.ok ? h('span', { class: 'result-ok', text: 'Fetched' }) : h('span', { class: 'pill pill-flag', text: 'Failed', title: page.error });
        }
        if (!source.enabled) return h('span', { class: 'muted', text: 'Turned off' });
        if (isLegacyRun(run)) return chunkCount(source.current_chunks);
        if (!page) return h('span', { class: 'muted', text: 'Not crawled yet' });
        if (!page.ok) return h('span', { class: 'result-failed' }, h('span', { class: 'pill pill-flag', text: 'Failed' }), h('span', { class: 'muted', text: page.error }));
        return chunkCount(page.chunks);
    }

    function chunkCount(chunks) {
        if (!chunks) return h('span', { class: 'muted', text: 'No text found' });
        return h('span', { class: 'result-ok', text: `${chunks} ${chunks === 1 ? 'extract' : 'extracts'}` });
    }

    function sourceRow(source) {
        const running = state.running;
        return h('div', { class: `source-row${source.enabled ? '' : ' off'}` },
            h('label', { class: 'switch', title: source.enabled ? 'Turn off' : 'Turn on' },
                h('input', { type: 'checkbox', checked: source.enabled, disabled: running, 'aria-label': `Crawl ${source.url}`,
                    onchange: (e) => updateSource(source, { enabled: e.target.checked }) }),
                h('span', { class: 'switch-track', 'aria-hidden': 'true' })),
            h('a', { class: 'source-link', href: source.url, target: '_blank', rel: 'noopener noreferrer', text: fmt.sourceLabel(source.url) }),
            fmt.select(STRATEGY, source.strategy, { class: 'select select-small', 'aria-label': 'Page type', disabled: running,
                onchange: (e) => updateSource(source, { strategy: e.target.value }) }),
            h('span', { class: 'source-result' }, pageResult(source)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${source.url}`, title: 'Remove', disabled: running,
                onclick: () => removeSource(source) },
                fmt.icon('x')));
    }

    function historyRow(run) {
        const label = { running: 'Running', done: 'Done', failed: 'Failed' }[run.status];
        return h('div', { class: 'history-row' },
            h('span', { text: fmt.fullDate(run.started_at) }),
            h('span', { class: `pill${run.status === 'failed' ? ' pill-flag' : ''}`, text: label }),
            h('span', { class: 'muted', text: run.status === 'done' ? `${run.chunk_count} extracts · ${duration(run)}` : (run.error || '') }));
    }

    function update() {
        status.textContent = describeRun(latestRun(), fmt);
        status.classList.toggle('crawl-failed', latestRun()?.status === 'failed');
        crawlButton.disabled = state.running || !state.sources.some((s) => s.enabled);
        crawlButton.textContent = state.running ? 'Crawling…' : 'Re-crawl website';
        pending.hidden = !hasPendingChanges();
        rows.replaceChildren(...(state.sources.length
            ? state.sources.map(sourceRow)
            : [h('p', { class: 'empty', text: 'No pages yet. Add the website pages the assistant should learn from.' })]));
        history.replaceChildren(...(state.runs.length ? state.runs.map(historyRow) : [h('p', { class: 'muted', text: 'No crawls yet.' })]));

        clearTimeout(pollTimer);
        if (state.running && !ctx.signal.aborted) pollTimer = setTimeout(refresh, CRAWL_POLL_MS);
    }

    async function refresh() {
        const wasRunning = state.running;
        state = await api.get('/admin/api/crawl');
        update();
        if (wasRunning && !state.running) onCrawled();
    }

    async function startCrawl() {
        crawlButton.disabled = true;
        try {
            state = await api.post('/admin/api/crawl');
        } catch (e) {
            if (e.status !== 409) { status.textContent = e.message; crawlButton.disabled = false; return; }
            state = await api.get('/admin/api/crawl');  // Someone else started one: show it
        }
        update();
    }

    async function updateSource(source, changes) {
        try {
            Object.assign(source, await api.patch(`/admin/api/sources/${source.id}`, changes));
        } catch (e) {
            addError.textContent = e.message;
        }
        update();
    }

    async function removeSource(source) {
        try {
            await api.delete(`/admin/api/sources/${source.id}`);
            state.sources = state.sources.filter((s) => s.id !== source.id);
        } catch (e) {
            addError.textContent = e.message;
        }
        update();
    }

    async function addSource(e) {
        e.preventDefault();
        addError.textContent = '';
        try {
            const source = await api.post('/admin/api/sources', { url: urlInput.value, strategy: strategySelect.value });
            state.sources.push({ ...source, current_chunks: 0 });
            urlInput.value = '';
            update();
        } catch (err) {
            addError.textContent = err.message;
        }
    }

    update();
}

// --- Your notes ---

async function notesCard(card, ctx, onChange) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let notes = (await api.get('/admin/api/knowledge/notes')).notes;
    let editing = null;   // note id, 'new', or null

    const list = h('div', { class: 'kb-note-list' });
    const addBtn = h('button', { type: 'button', class: 'btn', text: '+ Add note', onclick: () => { editing = 'new'; update(); } });
    card.append(
        h('div', { class: 'knowledge-head' },
            h('div', {}, h('h2', { text: 'Your notes' }),
                h('p', { class: 'field-help', text: 'Facts that aren\'t on the website, e.g. prices or policies. Searched like website text; crawls never change them.' })),
            h('div', { class: 'knowledge-actions' }, addBtn)),
        list);

    function noteForm(note) {
        const titleInput = h('input', { class: 'input', placeholder: 'Title, e.g. "School pricing"', maxlength: 120, value: note?.title || '', 'aria-label': 'Note title' });
        const bodyInput = h('textarea', { class: 'textarea', rows: 5, maxlength: 2000, value: note?.body || '', 'aria-label': 'Note text',
            placeholder: 'Write it the way you\'d explain it to a new colleague. Up to 2000 characters.' });
        const error = h('p', { class: 'form-error', 'aria-live': 'polite' });
        const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small', text: 'Save note' });
        const form = h('form', { class: 'kb-note-form', onsubmit: async (e) => {
            e.preventDefault();
            error.textContent = '';
            saveBtn.disabled = true;
            const body = { title: titleInput.value, body: bodyInput.value };
            try {
                const saved = note ? await api.put(`/admin/api/knowledge/notes/${note.id}`, body)
                    : await api.post('/admin/api/knowledge/notes', body);
                notes = note ? notes.map((n) => (n.id === saved.id ? saved : n)) : [...notes, saved];
                editing = null;
                update();
                onChange();
            } catch (err) {
                error.textContent = err.fieldErrors?.length
                    ? err.fieldErrors.map((f) => `${f.loc.at(-1) === 'title' ? 'Title' : 'Text'}: ${f.type === 'string_too_short' ? 'required' : f.msg}`).join(' · ')
                    : err.message;
                saveBtn.disabled = false;
            }
        } },
            titleInput, bodyInput, error,
            h('div', { class: 'kb-note-actions' },
                h('button', { type: 'button', class: 'btn btn-small', text: 'Cancel', onclick: () => { editing = null; update(); } }),
                saveBtn));
        setTimeout(() => titleInput.focus());
        return form;
    }

    function noteRow(note) {
        if (editing === note.id) return noteForm(note);
        const action = (name, label, onclick) => h('button', { type: 'button', class: 'icon-btn', 'aria-label': `${label} ${note.title}`, title: label, onclick }, fmt.icon(name));
        return h('div', { class: 'item-row kb-note' },
            h('div', { class: 'kb-body' },
                h('strong', { class: 'row-title', text: note.title }),
                h('p', { class: 'row-sub', text: note.body })),
            h('span', { class: 'row-meta', text: `Edited ${fmt.when(note.updated_at)}` }),
            h('div', { class: 'item-actions' },
                action('pencil', 'Edit', () => { editing = note.id; update(); }),
                action('trash', 'Delete', async () => {
                    if (!confirm(`Delete the note "${note.title}"?`)) return;
                    await api.delete(`/admin/api/knowledge/notes/${note.id}`);
                    notes = notes.filter((n) => n.id !== note.id);
                    update();
                    onChange();
                })));
    }

    function update() {
        addBtn.hidden = editing === 'new';
        list.replaceChildren(
            ...notes.map(noteRow),
            ...(editing === 'new' ? [noteForm(null)] : []),
            ...(!notes.length && editing !== 'new' ? [h('p', { class: 'muted kb-empty', text: 'No notes yet.' })] : []));
    }

    update();
}

// --- All extracts ---

async function extractsCard(card, ctx, sync) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let data = null;
    const openPages = new Set();   // Kept open across refreshes

    const summary = h('span', { class: 'muted' });
    const filter = h('input', { class: 'input kb-filter', type: 'search', placeholder: 'Filter by text…', 'aria-label': 'Filter extracts',
        oninput: () => update() });
    const hiddenOnly = h('input', { type: 'checkbox', onchange: () => update() });
    const groups = h('div', { class: 'kb-groups' });
    card.append(
        h('div', { class: 'knowledge-head' },
            h('div', {}, h('h2', { text: 'Extracts' }), summary),
            h('div', { class: 'knowledge-actions' }, filter,
                h('label', { class: 'check' }, hiddenOnly, 'Hidden only'))),
        h('p', { class: 'field-help', text: 'The pieces each page was split into on the last crawl. Hide navigation menus, footers and other junk so the assistant skips them; the same text stays hidden after future crawls.' }),
        groups);

    async function refresh() {
        data = await api.get('/admin/api/knowledge/extracts');
        update();
    }
    sync.refreshExtracts = refresh;

    async function setHidden(extract, hidden) {
        if (hidden) await api.post('/admin/api/knowledge/hidden', { text_hash: extract.text_hash });
        else await api.delete(`/admin/api/knowledge/hidden/${extract.text_hash}`);
        await refresh();
        sync.rerunSearch?.();
    }

    function extractRow(extract) {
        return h('div', { class: `kb-extract${extract.hidden ? ' hidden' : ''}` },
            h('div', { class: 'kb-body' },
                extract.headers.length || extract.hidden ? h('div', { class: 'kb-source' },
                    extract.hidden ? h('span', { class: 'pill', text: 'Hidden' }) : null,
                    extract.headers.length ? h('span', { class: 'muted', text: extract.headers.join(' › ') }) : null) : null,
                excerpt(h, extract.document)),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': extract.hidden ? 'Show this extract again' : 'Hide this extract',
                title: extract.hidden ? 'Unhide' : 'Hide: the assistant skips it', onclick: () => setHidden(extract, !extract.hidden) },
                fmt.icon(extract.hidden ? 'eye' : 'eyeOff')));
    }

    function update() {
        const q = filter.value.trim().toLowerCase();
        summary.textContent = `${data.total} ${data.total === 1 ? 'extract' : 'extracts'}${data.hidden ? ` · ${data.hidden} hidden` : ''}`
            + (data.truncated ? ' · showing the first ones only' : '');
        const shown = data.pages.map((page) => ({
            ...page,
            extracts: page.extracts.filter((x) => (!hiddenOnly.checked || x.hidden) && (!q || x.document.toLowerCase().includes(q))),
        })).filter((page) => page.extracts.length);
        groups.replaceChildren(...(shown.length ? shown.map((page) => {
            const hiddenCount = page.extracts.filter((x) => x.hidden).length;
            const details = h('details', { class: 'kb-group', open: Boolean(q) || hiddenOnly.checked || openPages.has(page.url) },
                h('summary', {},
                    h('span', { class: 'kb-group-title', text: page.url ? fmt.sourceLabel(page.url) : '(no page)' }),
                    h('span', { class: 'muted', text: `${page.extracts.length}${hiddenCount ? ` · ${hiddenCount} hidden` : ''}` })),
                h('div', { class: 'kb-group-body' }, page.extracts.map(extractRow)));
            details.addEventListener('toggle', () => { if (details.open) openPages.add(page.url); else openPages.delete(page.url); });
            return details;
        }) : [h('p', { class: 'muted kb-empty', text: data.total ? 'No extracts match.' : 'No extracts yet. Re-crawl the website above.' })]));
    }

    await refresh();
}
