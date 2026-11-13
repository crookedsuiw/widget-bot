// /admin/leads: visitors who asked to be called back.

const SEEN_DELAY_MS = 1500;  // Long enough that "New" is noticed before it clears

export async function render(view, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    // Current filters; updated in place so the dropdowns keep focus
    const params = new URLSearchParams(ctx.params);

    function apply(changes) {
        for (const [k, v] of Object.entries(changes)) v ? params.set(k, v) : params.delete(k);
        if (!('page' in changes)) params.delete('page');
        ctx.setQuery(params.toString());
        loadResults();
    }

    view.append(h('div', { class: 'page-head' },
        h('div', {}, h('h1', { text: 'Leads' }),
            h('p', { class: 'muted', text: 'Visitors who asked your team to call them back.' }))));

    view.append(h('div', { class: 'filters' },
        fmt.select({ '': 'All statuses', ...fmt.STATUS }, params.get('status'), { 'aria-label': 'Status', onchange: (e) => apply({ status: e.target.value }) }),
        fmt.select({ '': 'All interest levels', ...fmt.INTEREST }, params.get('interest'), { 'aria-label': 'Interest', onchange: (e) => apply({ interest: e.target.value }) }),
    ));

    // Only this part is replaced when filters change
    const results = h('div', {});
    view.append(results);

    let latestRequest = 0;
    async function loadResults() {
        const requestId = ++latestRequest;
        const status = params.get('status') || '';
        const interest = params.get('interest') || '';
        const qs = new URLSearchParams({ page: Number(params.get('page')) || 1 });
        if (status) qs.set('status', status);
        if (interest) qs.set('interest', interest);

        const data = await api.get(`/admin/api/leads?${qs}`);
        if (requestId !== latestRequest) return;  // A newer filter change started while this one was in flight

        const list = h('div', { class: 'card list' });
        if (!data.items.length) {
            list.append(h('p', { class: 'empty', text: status || interest
                ? 'No leads match these filters.'
                : 'No callback requests yet. They appear here as soon as a visitor leaves their number.' }));
        }
        for (const lead of data.items) list.append(leadRow(lead, ctx));
        results.replaceChildren(list, fmt.pager(data, (p) => apply({ page: p })));

        const unseen = data.items.filter((l) => !l.seen_at).map((l) => l.id);
        if (unseen.length) setTimeout(() => ctx.markLeadsSeen(unseen), SEEN_DELAY_MS);
    }

    // A new lead while this page is open: refresh the results so it shows up on the first page
    window.addEventListener('widgetbot:lead', () => { if ((Number(params.get('page')) || 1) === 1) loadResults(); }, { signal: ctx.signal });

    await loadResults();
}

function leadRow(lead, { api, fmt }) {
    const { h } = fmt;
    const saved = h('span', { class: 'saved-note', 'aria-live': 'polite' });
    const flash = (text) => { saved.textContent = text; setTimeout(() => { saved.textContent = ''; }, 2000); };

    const statusSelect = fmt.select(fmt.STATUS, lead.status, {
        'aria-label': 'Lead status',
        onchange: async (e) => {
            try {
                await api.patch(`/admin/api/leads/${lead.id}`, { status: e.target.value });
                flash('Status saved');
            } catch {
                e.target.value = lead.status;
                flash("Couldn't save");
            }
        },
    });

    const notes = h('textarea', { class: 'textarea', rows: 2, placeholder: 'Notes for the team (saved automatically)',
        value: lead.notes || '', 'aria-label': 'Notes' });
    let lastSaved = lead.notes || '';
    notes.addEventListener('blur', async () => {
        if (notes.value === lastSaved) return;
        try {
            await api.patch(`/admin/api/leads/${lead.id}`, { notes: notes.value });
            lastSaved = notes.value;
            flash('Notes saved');
        } catch {
            flash("Couldn't save notes");
        }
    });

    return h('div', { class: `row lead-row${lead.seen_at ? '' : ' unseen'}` },
        h('div', { class: 'lead-who' },
            h('div', { class: 'row-title' }, lead.seen_at ? null : h('span', { class: 'pill pill-new', text: 'New' }), ' ',
                lead.name || 'Unnamed visitor'),
            fmt.phoneLink(lead.phone, 'lead-phone'),
            h('span', { class: 'row-meta', text: fmt.when(lead.created_at) })),
        h('div', {},
            h('div', { class: 'row-meta' }, fmt.interestPill(lead.interest_level)),
            h('p', { class: 'row-sub', text: lead.summary || 'Summary is being prepared…' })),
        h('div', { class: 'lead-actions' },
            statusSelect,
            h('a', { class: 'btn btn-small', href: `/admin/chat-history/${lead.conversation_id}`, text: 'View chat' })),
        h('div', { class: 'lead-notes' }, notes, saved),
    );
}
