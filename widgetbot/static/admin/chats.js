// /admin/chat-history: every conversation, filterable, with a full-transcript detail view.

const LIST_STATE_KEY = 'widgetbot-admin:chat-list-query';  // So "back" returns to the same filters
const SEARCH_DEBOUNCE_MS = 400;
const FLAGS = { has_lead: 'Callback requested', thumbs_down: 'Marked not helpful', unanswered: 'Unanswered', errors: 'Errors' };

export async function render(view, ctx) {
    return ctx.item ? renderDetail(view, ctx) : renderList(view, ctx);
}

// --- List ---

async function renderList(view, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    // Current filters; updated in place so the filter bar (and the search box's focus) is never rebuilt
    const params = new URLSearchParams(ctx.params);

    function apply(changes) {
        for (const [k, v] of Object.entries(changes)) v ? params.set(k, v) : params.delete(k);
        if (!('page' in changes)) params.delete('page');
        ctx.setQuery(params.toString());
        loadResults();
    }

    const exportLink = h('a', { class: 'btn', download: 'chat-history.csv', text: 'Export CSV' });
    view.append(h('div', { class: 'page-head' },
        h('div', {}, h('h1', { text: 'Chat history' }),
            h('p', { class: 'muted', text: 'Every conversation with the website assistant. Interest and summaries are added by AI about 30 minutes after a chat goes quiet.' })),
        exportLink));

    let searchTimer;
    view.append(h('div', { class: 'filters' },
        h('input', { class: 'input', type: 'search', placeholder: 'Search messages, names, phones', value: params.get('q') || '',
            'aria-label': 'Search', oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => apply({ q: e.target.value.trim() }), SEARCH_DEBOUNCE_MS); } }),
        h('input', { class: 'input', type: 'date', value: params.get('from') || '', 'aria-label': 'From date', onchange: (e) => apply({ from: e.target.value }) }),
        h('input', { class: 'input', type: 'date', value: params.get('to') || '', 'aria-label': 'To date', onchange: (e) => apply({ to: e.target.value }) }),
        fmt.select({ '': 'Any interest', ...fmt.INTEREST }, params.get('interest'), { 'aria-label': 'Interest', onchange: (e) => apply({ interest: e.target.value }) }),
        fmt.select({ '': 'Any intent', ...fmt.INTENT }, params.get('intent'), { 'aria-label': 'Intent', onchange: (e) => apply({ intent: e.target.value }) }),
        Object.entries(FLAGS).map(([flag, label]) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: params.get(flag) === '1', onchange: (e) => apply({ [flag]: e.target.checked ? '1' : '' }) }),
            label)),
    ));

    // Only this part is replaced when filters change
    const results = h('div', {});
    view.append(results);

    let latestRequest = 0;
    async function loadResults() {
        const requestId = ++latestRequest;
        try { sessionStorage.setItem(LIST_STATE_KEY, location.search); } catch { /* storage blocked */ }

        const apiQuery = new URLSearchParams(params);
        for (const flag of Object.keys(FLAGS)) if (apiQuery.get(flag) !== '1') apiQuery.delete(flag);
        const exportQuery = new URLSearchParams(apiQuery);
        exportQuery.delete('page');
        exportLink.href = `/admin/api/conversations.csv?${exportQuery}`;

        const data = await api.get(`/admin/api/conversations?${apiQuery}`);
        if (requestId !== latestRequest) return;  // A newer search started while this one was in flight

        const list = h('div', { class: 'card list' });
        if (!data.items.length) list.append(h('p', { class: 'empty', text: 'No conversations match these filters.' }));
        for (const c of data.items) {
            list.append(h('a', { class: 'row chat-row', href: `/admin/chat-history/${c.id}` },
                h('div', { class: 'cell-shrink' },
                    h('div', { class: 'row-title', text: c.title || '(no visitor message)' }),
                    h('div', { class: 'row-sub', text: c.summary || 'Not analysed yet' })),
                h('div', { class: 'row-meta' },
                    fmt.interestPill(c.interest_level),
                    c.lead_id ? h('span', { class: 'pill pill-lead', text: `Callback · ${fmt.STATUS[c.lead_status]}` }) : null,
                    c.thumbs_down ? h('span', { class: 'pill pill-flag', text: `${c.thumbs_down} not helpful` }) : null,
                    c.unanswered ? h('span', { class: 'pill pill-flag', text: `${c.unanswered} unanswered` }) : null,
                    c.errors ? h('span', { class: 'pill pill-flag', text: `${c.errors} error${c.errors > 1 ? 's' : ''}` }) : null,
                    h('span', { text: `${c.message_count} messages · ${fmt.when(c.last_message_at)}` })),
            ));
        }
        results.replaceChildren(list, fmt.pager(data, (p) => apply({ page: p })));
    }

    await loadResults();
}

// --- Detail ---

async function renderDetail(view, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let listQuery = '';
    try { listQuery = sessionStorage.getItem(LIST_STATE_KEY) || ''; } catch { /* storage blocked */ }
    view.append(h('a', { class: 'back', href: `/admin/chat-history${listQuery}`, text: '← Chat history' }));

    let data;
    try {
        data = await api.get(`/admin/api/conversations/${encodeURIComponent(ctx.item)}`);
    } catch (e) {
        view.append(h('div', { class: 'card empty', text: e.status === 404 || e.status === 422 ? 'This conversation was not found.' : "Couldn't load this conversation." }));
        return;
    }
    const { conversation: c, messages, lead } = data;
    const firstQuestion = messages.find((m) => m.role === 'user');

    view.append(h('div', { class: 'page-head' },
        h('div', {}, h('h1', { text: firstQuestion ? truncate(firstQuestion.content, 70) : 'Conversation' }),
            h('p', { class: 'muted', text: `Started ${fmt.fullDate(c.started_at)}` }))));

    const transcript = h('div', { class: 'card transcript' });
    let lastQuestion = null;  // So an unanswered reply can offer its question as a new FAQ
    for (const m of messages) {
        if (m.role === 'user') lastQuestion = m.content;
        transcript.append(m.role === 'user' ? userMessage(m, fmt) : botMessage(m, fmt, lastQuestion));
    }

    const side = h('div', { class: 'side' },
        analysisCard(c, fmt),
        lead ? leadCard(lead, ctx) : h('div', { class: 'card card-pad' }, h('h2', { text: 'Callback' }), h('p', { class: 'muted', text: 'No callback requested.' })),
        h('div', { class: 'card card-pad' }, h('h2', { text: 'Visit' }),
            h('dl', {},
                h('dt', { text: 'Started' }), h('dd', { text: fmt.fullDate(c.started_at) }),
                h('dt', { text: 'Last message' }), h('dd', { text: fmt.fullDate(c.last_message_at) }),
                h('dt', { text: 'Messages' }), h('dd', { text: messages.length }),
                h('dt', { text: 'Website' }), h('dd', { text: c.origin || 'Unknown' }))),
    );
    view.append(h('div', { class: 'detail' }, transcript, side));
}

function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function userMessage(m, fmt) {
    return fmt.h('div', { class: 't-user', title: fmt.fullDate(m.created_at), text: m.content });
}

function botMessage(m, fmt, question) {
    const { h } = fmt;
    const tokens = m.prompt_tokens != null ? `${m.prompt_tokens} in / ${m.completion_tokens} out tokens` : null;
    const feedback = m.feedback === 1 ? 'Visitor: helpful' : m.feedback === -1 ? 'Visitor: not helpful' : null;
    return h('div', { class: 't-bot' },
        h('div', { class: 't-bot-bubble' }, fmt.botHtml(m.content)),
        m.error ? h('div', { class: 't-error', text: `Error: ${m.error}` }) : null,
        m.sources && m.sources.length ? h('div', { class: 't-sources' }, 'Sources:',
            m.sources.map((url) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: fmt.sourceLabel(url) }))) : null,
        h('div', { class: 't-meta' },
            h('span', { text: fmt.TIER[m.tier] || 'Reply' }),
            tokens ? h('span', { text: tokens }) : null,
            m.latency_ms != null ? h('span', { text: `${(m.latency_ms / 1000).toFixed(1)} s` }) : null,
            m.unanswered ? h('span', { class: 'pill pill-flag', text: 'Unanswered' }) : null,
            m.unanswered && question ? h('a', { class: 'link-btn', href: `/admin/faqs/new?q=${encodeURIComponent(question)}`, text: 'Add as FAQ' }) : null,
            feedback ? h('span', { class: m.feedback === -1 ? 'pill pill-flag' : 'pill', text: feedback }) : null,
            h('span', { text: fmt.when(m.created_at) })),
    );
}

function analysisCard(c, fmt) {
    const { h } = fmt;
    return h('div', { class: 'card card-pad' }, h('h2', { text: 'AI summary' }),
        c.summary
            ? [h('div', { class: 'row-meta gap-below' }, fmt.interestPill(c.interest_level),
                c.intent ? h('span', { class: 'pill', text: fmt.INTENT[c.intent] }) : null),
               h('p', { text: c.summary }),
               h('p', { class: 'muted', text: `Analysed ${fmt.when(c.analyzed_at)}` })]
            : h('p', { class: 'muted', text: 'Not analysed yet. Chats are analysed about 30 minutes after they go quiet (and straight away when a visitor asks for a call).' }),
    );
}

function leadCard(lead, { api, fmt }) {
    const { h } = fmt;
    const saved = h('span', { class: 'saved-note', 'aria-live': 'polite' });
    const flash = (text) => { saved.textContent = text; setTimeout(() => { saved.textContent = ''; }, 2000); };
    const notes = h('textarea', { class: 'textarea', rows: 3, value: lead.notes || '', placeholder: 'Notes for the team', 'aria-label': 'Notes' });
    let lastSaved = lead.notes || '';
    notes.addEventListener('blur', async () => {
        if (notes.value === lastSaved) return;
        try {
            await api.patch(`/admin/api/leads/${lead.id}`, { notes: notes.value });
            lastSaved = notes.value;
            flash('Notes saved');
        } catch { flash("Couldn't save notes"); }
    });

    return h('div', { class: 'card card-pad' }, h('h2', { text: 'Callback request' }),
        h('p', {}, h('strong', { text: lead.name || 'Unnamed visitor' })),
        h('p', {}, fmt.phoneLink(lead.phone, 'lead-phone')),
        h('p', {}, fmt.select(fmt.STATUS, lead.status, {
            'aria-label': 'Lead status',
            onchange: async (e) => {
                try { await api.patch(`/admin/api/leads/${lead.id}`, { status: e.target.value }); flash('Status saved'); }
                catch { e.target.value = lead.status; flash("Couldn't save"); }
            },
        })),
        notes, saved,
        h('dl', { class: 'gap-above' },
            h('dt', { text: 'Requested' }), h('dd', { text: fmt.fullDate(lead.created_at) }),
            h('dt', { text: 'Consent' }), h('dd', { text: `"${lead.consent_text}"` }),
            h('dt', { text: 'Email alert' }), h('dd', { text: lead.email_sent_at ? `Sent ${fmt.when(lead.email_sent_at)}` : 'Not sent' })),
    );
}
