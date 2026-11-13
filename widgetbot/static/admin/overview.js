// /admin/overview: usage stats for the chosen period, plus a quick website re-crawl (pages are managed in Knowledge base).
const V = new URL(import.meta.url).search;
const charts = await import('./charts.js' + V);
const { describeRun, CRAWL_POLL_MS } = await import('./knowledge.js' + V);
const { SERIES_COLORS: COLORS } = charts;

const RANGES = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days' };
const DEFAULT_RANGE = '30';
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export async function render(view, ctx) {
    const { fmt } = ctx;
    const { h } = fmt;
    let days = RANGES[ctx.params.get('days')] ? ctx.params.get('days') : DEFAULT_RANGE;

    const rangeButtons = Object.entries(RANGES).map(([value, label]) => h('button', {
        type: 'button', class: 'seg-btn', text: label, 'aria-pressed': String(value === days),
        onclick: () => {
            if (value === days) return;
            days = value;
            rangeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(RANGES)[i] === days)));
            ctx.setQuery(days === DEFAULT_RANGE ? '' : `days=${days}`);
            loadStats();
        },
    }));

    const crawl = h('div', { class: 'quick-crawl' });
    view.append(h('div', { class: 'page-head' },
        h('div', {}, h('h1', { text: 'Overview' }),
            h('p', { class: 'muted', text: 'How the assistant is doing.' })),
        h('div', { class: 'head-actions' }, crawl,
            h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, rangeButtons))));

    // Stats are replaced when the period changes
    const stats = h('div', { class: 'overview-stats' });
    view.append(stats);

    let latestRequest = 0;
    async function loadStats() {
        const requestId = ++latestRequest;
        stats.classList.add('loading');
        const data = await ctx.api.get(`/admin/api/overview?days=${days}&tz=${encodeURIComponent(TIMEZONE)}`);
        if (requestId !== latestRequest) return;
        stats.classList.remove('loading');
        stats.replaceChildren(...statsView(data, fmt));
    }

    await Promise.all([loadStats(), quickCrawl(crawl, ctx)]);
}

// --- Stats ---

function percent(part, whole) {
    return whole ? `${Math.round((part / whole) * 100)}%` : '–';
}

function seconds(ms) {
    return ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`;
}

function statsView(data, fmt) {
    const { h } = fmt;
    const t = data.totals;
    const aiReplies = t.tier_ai + t.tier_rag;
    const rated = t.thumbs_up + t.thumbs_down;
    const chatTokens = t.chat_prompt_tokens + t.chat_completion_tokens;
    const otherTokens = t.other_prompt_tokens + t.other_completion_tokens;

    const tile = (label, value, sub, href) => h(href ? 'a' : 'div', { class: 'card tile', href },
        h('span', { class: 'tile-label', text: label }),
        h('strong', { class: 'tile-value', text: value }),
        h('span', { class: 'tile-sub', text: sub }));

    const tiles = h('div', { class: 'tiles' },
        tile('Conversations', t.conversations.toLocaleString(), `${t.replies.toLocaleString()} bot replies`, '/admin/chat-history'),
        tile('Callback requests', t.leads.toLocaleString(), `${percent(t.leads, t.conversations)} of conversations`, '/admin/leads'),
        tile('Helpful ratings', percent(t.thumbs_up, rated),
            rated ? `${t.thumbs_up} helpful · ${t.thumbs_down} not helpful` : 'No ratings yet', '/admin/chat-history?thumbs_down=1'),
        tile('Unanswered', t.unanswered.toLocaleString(), `${percent(t.unanswered, aiReplies)} of AI replies`, '/admin/chat-history?unanswered=1'),
        tile('AI reply time', seconds(t.ai_latency_ms), 'Median; FAQ answers are instant'),
        tile('Errors', t.errors.toLocaleString(), `${percent(t.errors, t.replies)} of replies`, '/admin/chat-history?errors=1'),
        tile('Tokens used', charts.compactNumber(chatTokens + otherTokens),
            `${charts.compactNumber(chatTokens)} replies · ${charts.compactNumber(otherTokens)} summaries & tests`),
        tile('Estimated cost', data.cost_usd == null ? '–' : `$${data.cost_usd.toFixed(2)}`,
            data.cost_usd == null ? 'Add Groq prices to .env to estimate' : 'At the Groq prices in .env'),
    );

    const daysList = data.daily.map((d) => d.day);
    const conversationsChart = h('section', { class: 'card card-pad' },
        h('h2', { text: 'Conversations per day' }),
        charts.columnChart({
            days: daysList, label: 'Conversations per day',
            series: [
                { label: 'Conversations', color: COLORS[0], values: data.daily.map((d) => d.conversations) },
                { label: 'Callback requests', tooltipOnly: true, values: data.daily.map((d) => d.leads) },
            ],
        }));
    const tokensChart = h('section', { class: 'card card-pad' },
        h('h2', { text: 'Tokens per day' }),
        charts.columnChart({
            days: daysList, label: 'Tokens per day', format: charts.compactNumber,
            series: [
                { label: 'Replies', color: COLORS[0], values: data.daily.map((d) => d.chat_tokens) },
                { label: 'Summaries & tests', color: COLORS[1], values: data.daily.map((d) => d.other_tokens) },
            ],
        }));

    const answered = h('section', { class: 'card card-pad' },
        h('h2', { text: 'How questions were answered' }),
        charts.shareBar([
            { label: fmt.TIER[1], value: t.tier_faq, color: COLORS[0] },
            { label: fmt.TIER[3], value: t.tier_rag, color: COLORS[1] },
            { label: fmt.TIER[2], value: t.tier_ai, color: COLORS[2] },
        ], { label: 'Answer types' }));

    const interest = h('section', { class: 'card card-pad' },
        h('h2', { text: 'Visitor interest' }),
        h('div', { class: 'interest-list' },
            ['hot', 'warm', 'cold'].map((level) => h('a', { class: 'interest-row', href: `/admin/chat-history?interest=${level}` },
                fmt.interestPill(level), h('strong', { text: (data.interest[level] || 0).toLocaleString() }))),
            h('div', { class: 'interest-row' }, h('span', { class: 'pill', text: 'Not analysed yet' }),
                h('strong', { text: (data.interest.unknown || 0).toLocaleString() }))),
        h('p', { class: 'muted small', text: 'Chats are sorted once they have been quiet for 30 minutes.' }));

    const unanswered = h('section', { class: 'card list-card' },
        h('h2', { class: 'card-pad-x', text: 'Recent unanswered questions' }),
        data.unanswered.length
            ? data.unanswered.map((u) => h('div', { class: 'row mini-row unanswered-row' },
                h('a', { class: 'row-title', href: `/admin/chat-history/${u.conversation_id}`, text: u.question || '(question not found)' }),
                h('span', { class: 'row-meta' },
                    u.question ? h('a', { class: 'link-btn', href: `/admin/faqs/new?q=${encodeURIComponent(u.question)}`, text: 'Add as FAQ' }) : null,
                    h('span', { text: fmt.when(u.created_at) }))))
            : h('p', { class: 'empty', text: 'Nothing unanswered in this period.' }));

    const faqs = h('section', { class: 'card list-card' },
        h('h2', { class: 'card-pad-x', text: 'Most-used FAQs' }),
        data.top_faqs.length
            ? data.top_faqs.map((f) => h('div', { class: 'row mini-row' },
                h('span', { class: 'row-title', text: f.question }),
                h('span', { class: 'row-meta', text: `${f.hits.toLocaleString()} ${f.hits === 1 ? 'answer' : 'answers'}` })))
            : h('p', { class: 'empty', text: 'No FAQ answers in this period.' }));

    return [
        tiles,
        h('div', { class: 'grid-2' }, conversationsChart, tokensChart),
        h('div', { class: 'grid-2' }, answered, interest),
        h('div', { class: 'grid-2' }, unanswered, faqs),
    ];
}

// --- Quick re-crawl (pages and results are on the Knowledge base page) ---

async function quickCrawl(box, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let state = await api.get('/admin/api/crawl');
    let pollTimer = null;
    ctx.signal.addEventListener('abort', () => clearTimeout(pollTimer));

    const status = h('a', { class: 'quick-crawl-status', href: '/admin/knowledge', title: 'Manage pages in Knowledge base' });
    const button = h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: start });
    box.append(status, button);

    function update() {
        const run = state.runs[0] || null;
        status.textContent = describeRun(run, fmt).replace(/ · took .*$/, '');
        status.classList.toggle('crawl-failed', run?.status === 'failed');
        button.disabled = state.running || !state.sources.some((s) => s.enabled);
        button.textContent = state.running ? 'Crawling…' : 'Re-crawl website';
        clearTimeout(pollTimer);
        if (state.running && !ctx.signal.aborted) {
            pollTimer = setTimeout(async () => { state = await api.get('/admin/api/crawl'); update(); }, CRAWL_POLL_MS);
        }
    }

    async function start() {
        button.disabled = true;
        try {
            state = await api.post('/admin/api/crawl');
        } catch (e) {
            if (e.status !== 409) { status.textContent = e.message; button.disabled = false; return; }
            state = await api.get('/admin/api/crawl');  // Someone else started one: show it
        }
        update();
    }

    update();
}
