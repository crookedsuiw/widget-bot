// /admin/prompt-rules: named prompt settings. Each has saved versions in a straight line and at most one draft.
// The list page opens /admin/prompt-rules/{id}, where edits autosave into the draft and
// "Merge to live" / "Save as vN" turns the draft into the next version.

const AUTOSAVE_MS = 800;
const MAX_TEST_HISTORY = 20;  // Messages sent back with each test question (server keeps the last 10 turns)
const MAX_LINKS = 20;

const TEXT_FIELDS = [
    { name: 'bot_name', label: 'Bot name', help: 'How the assistant refers to itself.', input: true },
    { name: 'persona', label: 'Personality & tone', help: 'Who the assistant is and how it talks.', rows: 4 },
    { name: 'instructions', label: 'Instructions', help: 'How to answer: length, when to use links, what to ask back.', rows: 4 },
    { name: 'do_not_rules', label: 'Never do', help: 'Things the assistant must never say or do. One per line.', rows: 4 },
];

const NUMBER_FIELDS = [
    { name: 'rag_top_k', label: 'Website extracts per answer', help: '1–10. More gives the AI more to go on but uses more tokens.', step: '1', min: '1', max: '10', integer: true },
    { name: 'callback_after_messages', label: 'Offer callback after', help: 'Visitor messages before the callback card appears anyway. 0 = only when interest is detected.', step: '1', min: '0', max: '20', integer: true },
];

// Fields inside the "Advanced" fold; an error on one of them opens it
const ADVANCED_FIELDS = new Set(['model', ...NUMBER_FIELDS.map((f) => f.name)]);

const FRIENDLY_ERRORS = {
    string_too_short: 'Required',
    missing: 'Required',
    float_type: 'Enter a number',
    float_parsing: 'Enter a number',
    int_type: 'Enter a whole number',
    int_parsing: 'Enter a whole number',
    int_from_float: 'Enter a whole number',
};

export async function render(view, ctx) {
    if (ctx.item) return renderEditor(view, ctx, Number(ctx.item));
    return renderList(view, ctx);
}

// "New setting", "New setting 2", … whichever isn't taken yet
function uniqueName(profiles, base) {
    const taken = new Set(profiles.map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
    return `${base} ${n}`;
}

// Swaps nameEl for a text box. Enter or leaving the box calls save(newName); Esc puts the name back.
function inlineRename(h, nameEl, current, save) {
    const input = h('input', { class: 'input rename-input', value: current, maxlength: 60, 'aria-label': 'Setting name' });
    let done = false;
    const finish = async (commit) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        input.replaceWith(nameEl);
        if (commit && name && name !== current) await save(name);
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    nameEl.replaceWith(input);
    input.focus();
    input.select();
}

// --- List page ---

async function renderList(view, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let list = await api.get('/admin/api/prompts');

    const rows = h('div', { class: 'card list profile-list' });
    const listError = h('p', { class: 'form-error', 'aria-live': 'polite' });
    view.append(
        h('div', { class: 'page-head' },
            h('div', {}, h('h1', { text: 'Prompt rules' }),
                h('p', { class: 'muted', text: 'What the assistant is told before every answer. Open a setting to edit it in a draft, test it, then save it.' }))),
        rows,
        h('div', { class: 'list-foot' }, listError,
            h('button', { type: 'button', class: 'btn btn-primary', text: '+ New', onclick: startNew })));

    function meta(p) {
        if (!p.latest_version) return 'Not saved yet';
        return `v${p.latest_version} · edited ${fmt.when(p.updated_at)}`;
    }

    function iconButton(name, label, onclick, extra = {}) {
        return h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, ...extra, onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            onclick();
        } }, fmt.icon(name));
    }

    function profileRow(p) {
        const error = h('span', { class: 'field-error item-error', 'aria-live': 'polite' });
        const name = h('a', { class: 'row-title item-link', href: `/admin/prompt-rules/${p.id}`, text: p.name });
        const rename = () => inlineRename(h, name, p.name, async (next) => {
            try {
                const res = await api.patch(`/admin/api/prompts/${p.id}`, { name: next });
                p.name = name.textContent = res.name;
                error.textContent = '';
            } catch (e) {
                error.textContent = e.message;
            }
        });
        return h('div', { class: 'row item-row' },
            h('div', { class: 'item-name' }, name,
                p.is_live ? h('span', { class: 'pill pill-lead', text: 'Live' }) : null,
                p.has_draft ? h('span', { class: 'pill', text: 'Draft' }) : null),
            h('span', { class: 'row-meta', text: meta(p) }),
            h('div', { class: 'item-actions' },
                iconButton('pencil', `Rename ${p.name}`, rename),
                iconButton('copy', `Duplicate ${p.name}`, () => create(p)),
                iconButton('trash', p.is_live ? 'The live setting can\'t be deleted' : `Delete ${p.name}`, () => remove(p), { disabled: p.is_live })),
            error);
    }

    function update() {
        rows.replaceChildren(...(list.profiles.length ? list.profiles.map(profileRow)
            : [h('p', { class: 'empty', text: 'No settings yet.' })]));
    }

    // New: a row with a name box at the end of the list. Enter creates the setting and opens it; Esc cancels.
    let newRow = null;
    function startNew() {
        if (newRow) return newRow.querySelector('input').focus();
        const error = h('span', { class: 'field-error item-error', 'aria-live': 'polite' });
        const input = h('input', { class: 'input rename-input', value: uniqueName(list.profiles, 'New setting'), maxlength: 60,
            'aria-label': 'Name for the new setting' });
        const cancel = () => { newRow.remove(); newRow = null; };
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const name = input.value.trim();
            if (!name) { error.textContent = 'Enter a name'; return; }
            input.disabled = true;
            try {
                const res = await api.post('/admin/api/prompts', { name, copy_from: null });
                ctx.navigate(`/admin/prompt-rules/${res.profile.id}`);
            } catch (err) {
                error.textContent = err.message;
                input.disabled = false;
                input.focus();
            }
        });
        // Clicking away from an empty box drops the row; a typed name stays until Enter or Esc
        input.addEventListener('blur', () => { if (!input.value.trim() && !input.disabled) cancel(); });
        newRow = h('div', { class: 'row item-row item-new' },
            h('div', { class: 'item-name' }, input),
            h('span', { class: 'row-meta', text: 'Enter to create · Esc to cancel' }),
            h('span', {}),
            error);
        rows.querySelector('.empty')?.remove();
        rows.append(newRow);
        input.focus();
        input.select();
    }

    // Duplicate copies the given setting (its draft, else latest version) and opens the copy
    async function create(from) {
        listError.textContent = '';
        try {
            const name = uniqueName(list.profiles, `${from.name} copy`);
            const res = await api.post('/admin/api/prompts', { name, copy_from: from.id });
            ctx.navigate(`/admin/prompt-rules/${res.profile.id}`);
        } catch (e) {
            listError.textContent = e.message;
        }
    }

    async function remove(p) {
        if (!confirm(`Delete "${p.name}" and all its versions?`)) return;
        listError.textContent = '';
        try {
            await api.delete(`/admin/api/prompts/${p.id}`);
            list = await api.get('/admin/api/prompts');
            update();
        } catch (e) {
            listError.textContent = e.message;
        }
    }

    update();
}

// --- Editor page ---

async function renderEditor(view, ctx, profileId) {
    const { api, fmt } = ctx;
    const { h } = fmt;

    view.append(h('a', { class: 'back', href: '/admin/prompt-rules', text: '← Prompt rules' }));
    let list = await api.get('/admin/api/prompts');   // { profiles, system_rules }
    if (!list.profiles.some((p) => p.id === profileId)) {
        view.append(h('div', { class: 'card empty', text: 'This setting doesn\'t exist anymore.' }));
        return;
    }

    let detail = null;        // { profile, latest, draft, versions }
    let dirty = false;        // Form differs from what the server has
    let invalid = false;      // Last autosave was refused by validation
    let conflicted = false;   // Someone else changed the draft; stop autosaving until reload
    let saving = null;        // Promise of the autosave in flight
    let saveTimer = null;
    let turns = [];           // Test conversation: [{ user, targets, labels, answers }]
    let testMode = 'draft';
    let compare = false;
    let links = [];           // approved_links as shown in the form

    const isLive = () => Boolean(list.profiles.find((p) => p.id === profileId)?.is_live);
    const nextVersion = () => (detail.latest?.version || 0) + 1;

    // --- Status bar ---

    const statusName = h('strong', { class: 'status-name' });
    const renameBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Rename', title: 'Rename', onclick: renameProfile }, fmt.icon('pencil'));
    const livePill = h('span', { class: 'pill pill-lead', text: 'Live' });
    const statusText = h('span', { class: 'muted' });
    const statusAction = h('span', {});
    const noteInput = h('input', { class: 'input note-input', placeholder: 'What changed? (optional)', maxlength: 200, 'aria-label': 'Note for this version' });
    const discardBtn = h('button', { type: 'button', class: 'btn', text: 'Discard draft', onclick: discardDraft });
    const mergeBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: mergeDraft });
    const liveBtn = h('button', { type: 'button', class: 'btn', onclick: makeLive });
    view.append(h('div', { class: 'card prompt-status' },
        h('div', { class: 'status-left' }, h('div', { class: 'status-title' }, statusName, renameBtn, livePill),
            h('p', { class: 'status-line', 'aria-live': 'polite' }, statusText, statusAction)),
        h('div', { class: 'status-actions' }, noteInput, discardBtn, mergeBtn, liveBtn)));

    function setStatus(text, kind = '', action = null) {
        statusText.textContent = text;
        statusText.className = kind === 'error' ? 'status-error' : kind === 'ok' ? 'status-ok' : 'muted';
        statusAction.replaceChildren(...(action ? [' ', action] : []));
    }

    function updateStatus(message) {
        const live = isLive();
        const draft = detail.draft;
        statusName.textContent = detail.profile.name;
        document.title = `${detail.profile.name} · Prompt rules · Dashboard`;
        livePill.hidden = !live;
        noteInput.hidden = discardBtn.hidden = mergeBtn.hidden = !draft;
        discardBtn.disabled = !detail.latest;
        discardBtn.title = detail.latest ? '' : 'Nothing saved yet to go back to. Delete the setting instead.';
        mergeBtn.textContent = live ? 'Merge to live' : `Save as v${nextVersion()}`;
        mergeBtn.disabled = dirty || invalid || conflicted || Boolean(saving);
        liveBtn.hidden = live || !detail.latest;
        if (detail.latest) liveBtn.textContent = `Make v${detail.latest.version} live`;
        updateTestToggle();

        if (conflicted) return;
        if (message) return setStatus(message, 'ok');
        if (invalid) return setStatus('Not saved yet: fix the highlighted fields.', 'error');
        if (saving) return setStatus('Saving draft…');
        if (dirty) return setStatus('Unsaved changes…');
        if (draft) {
            const note = draft.note ? ` (${draft.note})` : '';
            return setStatus(`Draft${note} · saved ${fmt.when(draft.updated_at)} · ${live ? 'visitors still get' : 'latest saved is'} `
                + (detail.latest ? `v${detail.latest.version}` : 'nothing yet'));
        }
        setStatus(`v${detail.latest.version}${live ? ' · what visitors get' : ''} · edit any field to start a draft`);
    }

    // --- Form ---

    const inputs = {};
    const errors = {};
    function field(name, label, help, control) {
        inputs[name] = control;
        errors[name] = h('span', { class: 'field-error', 'aria-live': 'polite' });
        control.id = `pf-${name}`;
        control.addEventListener('input', onEdit);
        return h('div', { class: 'pfield' },
            h('label', { for: control.id, text: label }),
            control,
            help ? h('span', { class: 'field-help', text: help }) : null,
            errors[name]);
    }

    const textFields = TEXT_FIELDS.map((f) => field(f.name, f.label, f.help, f.input
        ? h('input', { class: 'input', maxlength: 60 })
        : h('textarea', { class: 'textarea', rows: f.rows, maxlength: 4000 })));

    // Links: a plain list like the website pages on Overview; change one by removing and re-adding it
    const linksBox = h('div', { class: 'source-list link-list' });
    errors.approved_links = h('span', { class: 'field-error', 'aria-live': 'polite' });
    const linkLabel = h('input', { class: 'input link-label', placeholder: 'Button text', maxlength: 60, 'aria-label': 'Button text' });
    const linkUrl = h('input', { class: 'input source-url', type: 'url', placeholder: 'https://…', maxlength: 500, 'aria-label': 'Address' });
    const linkAddBtn = h('button', { type: 'submit', class: 'btn', text: 'Add link' });
    const linkFormError = h('p', { class: 'form-error', 'aria-live': 'polite' });
    const linksField = h('div', { class: 'pfield' },
        h('span', { class: 'pfield-label', text: 'Links the bot may use' }),
        h('span', { class: 'field-help', text: 'The only pages the assistant may link to; they appear as buttons in its answers.' }),
        linksBox, errors.approved_links,
        h('form', { class: 'source-add', novalidate: true, onsubmit: addLink }, linkLabel, linkUrl, linkAddBtn),
        linkFormError);

    function renderLinks() {
        linksBox.replaceChildren(...(links.length ? links.map((link) => h('div', { class: 'link-item' },
            h('strong', { class: 'link-item-label', text: link.label }),
            h('a', { class: 'source-link link-item-url', href: link.url, target: '_blank', rel: 'noopener noreferrer', text: fmt.sourceLabel(link.url), title: link.url }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${link.label}`, title: 'Remove', onclick: () => {
                links = links.filter((l) => l !== link);
                renderLinks();
                onEdit();
            } }, fmt.icon('x'))))
            : [h('p', { class: 'muted link-empty', text: 'No links yet. The assistant won\'t link anywhere.' })]));
        const full = links.length >= MAX_LINKS;
        linkLabel.disabled = linkUrl.disabled = linkAddBtn.disabled = full;
        linkFormError.textContent = full ? `That's the maximum of ${MAX_LINKS} links.` : '';
    }

    function addLink(e) {
        e.preventDefault();
        const label = linkLabel.value.trim();
        const url = linkUrl.value.trim();
        linkFormError.textContent = !label ? 'Enter the button text.'
            : !/^https:\/\/\S+\.\S+/.test(url) ? 'Enter an address starting with https://'
            : links.some((l) => l.url === url) ? 'That address is already in the list.' : '';
        if (linkFormError.textContent) return;
        links.push({ label, url });
        linkLabel.value = linkUrl.value = '';
        renderLinks();
        onEdit();
        linkLabel.focus();
    }

    const modelList = h('datalist', { id: 'model-options' });
    const modelField = field('model', 'AI model', 'The Groq model name. A wrong name shows up as an error in the test box.',
        h('input', { class: 'input', list: 'model-options', maxlength: 100, autocomplete: 'off' }));
    const numberFields = NUMBER_FIELDS.map((f) => field(f.name, f.label, f.help,
        h('input', { class: 'input', type: 'number', step: f.step, min: f.min, max: f.max, inputmode: f.integer ? 'numeric' : 'decimal' })));

    const advanced = h('details', { class: 'fold' },
        h('summary', { text: 'Advanced' }),
        h('div', { class: 'tuning' }, modelField, ...numberFields));

    const systemRules = h('details', { class: 'fold' },
        h('summary', { text: 'Always added by the system' }),
        h('p', { class: 'field-help', text: 'These rules let the dashboard detect callback requests and unanswered questions, so they can\'t be edited.' }),
        h('pre', { text: list.system_rules }));

    const form = h('section', { class: 'card card-pad prompt-form' },
        h('h2', { text: 'Prompt' }), ...textFields, linksField, advanced, systemRules, modelList);

    function fillForm(fields) {
        for (const f of [...TEXT_FIELDS, ...NUMBER_FIELDS, { name: 'model' }]) inputs[f.name].value = fields[f.name] ?? '';
        links = (fields.approved_links || []).map((l) => ({ ...l }));
        renderLinks();
        const models = new Set([fields.model, detail.latest?.model].filter(Boolean));
        modelList.replaceChildren(...[...models].map((m) => h('option', { value: m })));
        clearErrors();
    }

    function collect() {
        const number = (name, integer) => {
            const raw = inputs[name].value.trim();
            if (raw === '') return null;
            const value = integer ? Number(raw) : Number.parseFloat(raw);
            return Number.isFinite(value) ? value : null;
        };
        return {
            bot_name: inputs.bot_name.value.trim(),
            persona: inputs.persona.value,
            instructions: inputs.instructions.value,
            do_not_rules: inputs.do_not_rules.value,
            approved_links: links.map((l) => ({ ...l })),
            model: inputs.model.value.trim(),
            rag_top_k: number('rag_top_k', true),
            callback_after_messages: number('callback_after_messages', true),
        };
    }

    function clearErrors() {
        Object.values(errors).forEach((e) => { e.textContent = ''; });
        form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    }

    function showErrors(fieldErrors) {
        clearErrors();
        for (const err of fieldErrors) {
            const at = err.loc.findIndex((part) => part === 'fields' || part === 'draft');
            const name = err.loc[at + 1];
            const message = err.type === 'less_than_equal' ? `Must be ${err.ctx.le} or less`
                : err.type === 'greater_than_equal' ? `Must be ${err.ctx.ge} or more`
                : FRIENDLY_ERRORS[err.type] || err.msg.replace(/^Value error, /, '');
            if (name === 'approved_links') {
                const index = err.loc[at + 2];
                errors.approved_links.textContent = typeof index === 'number' && links[index]
                    ? `"${links[index].label}": ${message}. Remove it and add it again.` : message;
            } else if (errors[name]) {
                errors[name].textContent = message;
                inputs[name]?.classList.add('invalid');
                if (ADVANCED_FIELDS.has(name)) advanced.open = true;
            }
        }
    }

    // --- Autosave ---

    function onEdit() {
        if (conflicted) return;
        dirty = true;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveDraft, AUTOSAVE_MS);
        updateStatus();
    }

    async function saveDraft() {
        clearTimeout(saveTimer);
        if (saving) await saving;
        if (!dirty || conflicted) return;
        dirty = false;
        const fields = collect();
        saving = api.put(`/admin/api/prompts/${profileId}/draft`, { fields, updated_at: detail.draft?.updated_at ?? null })
            .then((res) => {
                detail.draft = { ...(detail.draft || { note: null }), ...fields, updated_at: res.updated_at };
                invalid = false;
                clearErrors();
            })
            .catch((e) => {
                if (e.fieldErrors?.length) {
                    invalid = true;
                    showErrors(e.fieldErrors);
                } else if (e.status === 409) {
                    conflicted = true;
                    setStatus(e.message, 'error', h('button', { type: 'button', class: 'link-btn', text: 'Reload', onclick: loadProfile }));
                } else {
                    dirty = true;  // Network or server error: try again on the next edit
                    setStatus(`Couldn't save the draft: ${e.message}`, 'error');
                }
            })
            .finally(() => {
                saving = null;
                updateStatus();
            });
        updateStatus();
        await saving;
    }

    // Leaving the page: save what's typed rather than drop it
    ctx.signal.addEventListener('abort', () => { if (dirty) saveDraft(); });
    window.addEventListener('beforeunload', (e) => { if (dirty || saving) e.preventDefault(); }, { signal: ctx.signal });

    // --- Versions ---

    const versionsBox = h('div', { class: 'version-list' });
    const versionsCard = h('section', { class: 'card card-pad' }, h('h2', { text: 'Versions' }), versionsBox);

    function renderVersions() {
        versionsBox.replaceChildren(...(detail.versions.length ? detail.versions.map((v) => h('div', { class: 'version-row' },
            h('strong', { text: `v${v.version}` }),
            v.is_active ? h('span', { class: 'pill pill-lead', text: 'Live' }) : h('span', {}),
            h('span', { class: v.note ? 'version-note' : 'version-note muted', text: v.note || 'No note' }),
            h('span', { class: 'muted version-time', text: fmt.fullDate(v.created_at) }),
            h('button', { type: 'button', class: 'btn btn-small', text: 'Load into draft', onclick: () => restore(v.version) }),
        )) : [h('p', { class: 'muted', text: 'No saved versions yet. Save the draft to create v1.' })]));
    }

    // --- Test box ---

    // Live = what visitors get (whichever setting is live); Saved = this setting's latest version, shown only when it isn't live
    const liveTestBtn = h('button', { type: 'button', class: 'seg-btn', onclick: () => setTestMode('live') });
    const savedBtn = h('button', { type: 'button', class: 'seg-btn', onclick: () => setTestMode('saved') });
    const draftBtn = h('button', { type: 'button', class: 'seg-btn', text: 'Draft', onclick: () => setTestMode('draft') });
    const compareBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Compare', 'aria-pressed': 'false',
        title: 'Ask the draft and the live setting the same question and show the answers side by side', onclick: () => {
            compare = !compare;
            updateTestToggle();
        } });
    const thread = h('div', { class: 'test-thread', 'aria-live': 'polite' });
    const testInput = h('input', { class: 'input', placeholder: 'Ask something a visitor might ask…', maxlength: 1000, 'aria-label': 'Test message' });
    const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Send' });
    const testPanel = h('section', { class: 'card test-panel' },
        h('div', { class: 'test-head' }, h('h2', { text: 'Test' }),
            h('div', { class: 'test-controls' },
                h('div', { class: 'seg', role: 'group', 'aria-label': 'Version to test' }, liveTestBtn, savedBtn, draftBtn), compareBtn)),
        h('p', { class: 'field-help test-help', text: 'Answers use the real FAQs and website search. Nothing is shown to visitors or added to chat history.' }),
        thread,
        h('form', { class: 'test-form', onsubmit: (e) => { e.preventDefault(); sendTest(); } }, testInput, sendBtn),
        h('button', { type: 'button', class: 'link-btn test-reset', text: 'Clear conversation', onclick: resetTest }));

    const liveProfile = () => list.profiles.find((p) => p.is_live);

    function testLabels() {
        const live = liveProfile();
        return {
            live: live ? (isLive() ? `Live v${live.latest_version}` : `Live · ${live.name} v${live.latest_version}`) : 'Live',
            saved: detail.latest ? `Saved v${detail.latest.version}` : 'Saved',
            draft: 'Draft',
        };
    }

    function setTestMode(mode) {
        testMode = mode;
        compare = false;
        updateTestToggle();
    }

    function updateTestToggle() {
        if (!detail) return;
        const hasLive = Boolean(liveProfile());
        const showSaved = Boolean(detail.latest) && !isLive();
        if ((testMode === 'live' && !hasLive) || (testMode === 'saved' && !showSaved)) testMode = 'draft';
        if (!hasLive) compare = false;
        const labels = testLabels();
        liveTestBtn.textContent = isLive() ? labels.live : 'Live';
        liveTestBtn.title = labels.live;
        liveTestBtn.disabled = compareBtn.disabled = !hasLive;
        savedBtn.textContent = labels.saved;
        savedBtn.hidden = !showSaved;
        compareBtn.setAttribute('aria-pressed', String(compare));
        for (const [mode, btn] of [['live', liveTestBtn], ['saved', savedBtn], ['draft', draftBtn]]) {
            btn.setAttribute('aria-pressed', String(!compare && testMode === mode));
        }
        compareBtn.classList.toggle('btn-on', compare);
    }

    function resetTest() {
        turns = [];
        renderThread();
    }

    function historyFor(target) {
        const messages = [];
        for (const turn of turns.slice(0, -1)) {
            messages.push({ role: 'user', content: turn.user });
            const answer = turn.answers[target] || Object.values(turn.answers)[0];
            if (answer?.text) messages.push({ role: 'bot', content: answer.text });
        }
        return messages.slice(-MAX_TEST_HISTORY);
    }

    async function sendTest() {
        const message = testInput.value.trim();
        if (!message) return;
        const targets = compare ? ['live', 'draft'] : [testMode];
        const turn = { user: message, targets, answers: {}, labels: testLabels() };
        turns.push(turn);
        testInput.value = '';
        sendBtn.disabled = true;
        renderThread();
        const draftFields = collect();
        await Promise.all(targets.map(async (target) => {
            try {
                turn.answers[target] = await api.post('/admin/api/prompts/test', {
                    profile_id: profileId, target, message, history: historyFor(target),
                    draft: target === 'draft' ? draftFields : null,
                });
            } catch (e) {
                if (e.fieldErrors?.length) showErrors(e.fieldErrors);
                turn.answers[target] = { failed: e.fieldErrors?.length ? 'Fix the highlighted fields to test the draft.' : e.message };
            }
            renderThread();
        }));
        sendBtn.disabled = false;
        testInput.focus();
    }

    function answerView(turn, target) {
        const answer = turn.answers[target];
        const label = h('span', { class: 'test-label', text: turn.labels[target] });
        if (!answer) return h('div', { class: 'test-answer' }, label, h('div', { class: 't-bot-bubble test-wait', text: 'Thinking…' }));
        if (answer.failed) return h('div', { class: 'test-answer' }, label, h('div', { class: 't-error', text: answer.failed }));
        const tokens = (answer.prompt_tokens || 0) + (answer.completion_tokens || 0);
        return h('div', { class: 'test-answer' }, label,
            h('div', { class: 't-bot-bubble' }, fmt.botHtml(answer.text)),
            answer.error ? h('div', { class: 't-error', text: `Model error: ${answer.error}` }) : null,
            h('div', { class: 't-meta' },
                h('span', { text: fmt.TIER[answer.tier] }),
                tokens ? h('span', { text: `${tokens.toLocaleString()} tokens` }) : null,
                h('span', { text: `${(answer.latency_ms / 1000).toFixed(1)} s` }),
                answer.wants_callback ? h('span', { class: 'pill pill-lead', text: 'Callback card' }) : null,
                answer.unanswered ? h('span', { class: 'pill pill-flag', text: 'Unanswered' }) : null),
            answer.sources.length ? h('div', { class: 't-sources' }, answer.sources.map((url) =>
                h('a', { class: 'pill', href: url, target: '_blank', rel: 'noopener noreferrer', text: fmt.sourceLabel(url) }))) : null);
    }

    function renderThread() {
        thread.replaceChildren(...(turns.length ? turns.map((turn) => h('div', { class: 'test-turn' },
            h('div', { class: 't-user', text: turn.user }),
            h('div', { class: turn.targets.length > 1 ? 'test-answers test-compare' : 'test-answers' },
                turn.targets.map((target) => answerView(turn, target)))))
            : [h('p', { class: 'test-empty', text: 'Try a few questions visitors ask, then switch versions or press Compare.' })]));
        thread.scrollTop = thread.scrollHeight;
    }

    view.append(h('div', { class: 'prompt-layout' },
        h('div', { class: 'prompt-main' }, form, versionsCard), testPanel));

    // --- Loading and actions ---

    async function refreshList() {
        list = await api.get('/admin/api/prompts');
    }

    function applyDetail(next, message) {
        detail = next;
        dirty = invalid = conflicted = false;
        clearTimeout(saveTimer);
        fillForm(next.draft || next.latest);
        noteInput.value = '';
        renderVersions();
        updateStatus(message);
    }

    async function loadProfile() {
        if (saving) await saving;
        const next = await api.get(`/admin/api/prompts/${profileId}`);
        await refreshList();
        applyDetail(next);
    }

    async function run(action) {
        try {
            await action();
        } catch (e) {
            setStatus(e.message, 'error');
        }
    }

    function mergeDraft() {
        return run(async () => {
            await saveDraft();
            if (dirty || invalid || conflicted) return;
            const res = await api.post(`/admin/api/prompts/${profileId}/merge`, { note: noteInput.value });
            await refreshList();
            applyDetail(res, `Saved as v${res.merged_version}${res.went_live ? ' · visitors get it now' : ''}`);
        });
    }

    function discardDraft() {
        if (!confirm('Discard the draft? Saved versions stay as they are.')) return;
        return run(async () => {
            clearTimeout(saveTimer);
            dirty = false;
            if (saving) await saving;
            const res = await api.delete(`/admin/api/prompts/${profileId}/draft`);
            await refreshList();
            applyDetail(res, 'Draft discarded');
        });
    }

    function restore(version) {
        if (detail.draft && !confirm(`Replace the current draft with v${version}?`)) return;
        return run(async () => {
            clearTimeout(saveTimer);
            dirty = false;
            if (saving) await saving;
            const res = await api.post(`/admin/api/prompts/${profileId}/draft/from/${version}`);
            await refreshList();
            applyDetail(res, `v${version} loaded into the draft. Save it to make it the newest version.`);
        });
    }

    function makeLive() {
        if (!confirm(`Visitors will get "${detail.profile.name}" v${detail.latest.version} from now on.`)) return;
        return run(async () => {
            const res = await api.post(`/admin/api/prompts/${profileId}/live`);
            await refreshList();
            applyDetail(res, 'Live for visitors now');
        });
    }

    function renameProfile() {
        inlineRename(h, statusName, detail.profile.name, (name) => run(async () => {
            const res = await api.patch(`/admin/api/prompts/${profileId}`, { name });
            detail.profile.name = res.name;
            await refreshList();
            updateStatus('Renamed');
        }));
    }

    await loadProfile();
    resetTest();
}
