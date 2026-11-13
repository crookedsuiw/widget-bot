// /admin/faqs: canned answers given instantly (and for free) when a visitor's question is close to one of an
// FAQ's wordings. The list page tests matching and sets the strictness; /admin/faqs/{id} and /admin/faqs/new edit one.

const MAX_WORDINGS = 20;
const MAX_ANSWERS = 10;
const SUGGEST_SIMILARITY = 0.6;  // "Add as FAQ" offers an existing FAQ this close instead of a new one

const FRIENDLY_ERRORS = {
    string_too_short: 'Required',
    missing: 'Required',
    too_short: 'Add at least one',
    too_long: 'Too many',
};

export async function render(view, ctx) {
    if (ctx.item) return renderEditor(view, ctx, ctx.item === 'new' ? null : Number(ctx.item));
    return renderList(view, ctx);
}

function title(faq) {
    return faq.questions?.[0] || '(no wording)';
}

function score(similarity) {
    return similarity.toFixed(2);
}

// --- List page ---

async function renderList(view, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let data = await api.get('/admin/api/faqs');   // { faqs, threshold, usage_days }
    let threshold = data.threshold;
    let matches = null;                            // Last test result, re-judged as the slider moves
    let testedQuestion = '';

    // --- Test & strictness ---

    const testInput = h('input', { class: 'input', placeholder: 'Type a question a visitor might ask…', maxlength: 1000, 'aria-label': 'Question to test' });
    const testBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Test' });
    const slider = h('input', { type: 'range', class: 'strictness-range', min: '0.5', max: '0.95', step: '0.01', value: threshold,
        'aria-label': 'Match strictness', oninput: () => { threshold = Number(slider.value); showThreshold(); renderMatches(); },
        onchange: saveThreshold });
    const sliderValue = h('strong', { class: 'strictness-value' });
    const sliderStatus = h('span', { class: 'muted strictness-status', 'aria-live': 'polite' });
    const results = h('div', { class: 'match-list', 'aria-live': 'polite' });
    const verdict = h('p', { class: 'match-verdict' });
    const fullBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Full answer', hidden: true,
        title: 'Run the live bot on this question (uses AI tokens)', onclick: fullAnswer });
    const fullBox = h('div', { class: 'match-full' });

    view.append(
        h('div', { class: 'page-head' },
            h('div', {}, h('h1', { text: 'FAQs' }),
                h('p', { class: 'muted', text: 'Ready-made answers, given instantly and for free when a visitor\'s question is close enough to one of the wordings.' }))),
        h('section', { class: 'card card-pad faq-test' },
            h('h2', { text: 'Test & strictness' }),
            h('form', { class: 'test-form', onsubmit: (e) => { e.preventDefault(); runTest(); } }, testInput, testBtn),
            h('div', { class: 'strictness' },
                h('label', { class: 'pfield-label', text: 'Match strictness' }), slider, sliderValue, sliderStatus),
            h('p', { class: 'field-help', text: 'Higher = a question must be closer to a wording to get the FAQ answer; anything below the line goes to the AI. Saved when you let go.' }),
            results,
            h('div', { class: 'match-foot' }, verdict, fullBtn),
            fullBox));

    function showThreshold() {
        sliderValue.textContent = threshold.toFixed(2);
    }

    async function saveThreshold() {
        sliderStatus.textContent = 'Saving…';
        try {
            threshold = (await api.put('/admin/api/faqs/threshold', { value: Number(slider.value) })).threshold;
            sliderStatus.textContent = 'Saved · visitors get it now';
        } catch (e) {
            sliderStatus.textContent = e.message;
        }
    }

    async function runTest() {
        const question = testInput.value.trim();
        if (!question) return;
        testBtn.disabled = true;
        fullBox.replaceChildren();
        try {
            matches = (await api.post('/admin/api/faqs/match', { question })).matches;
            testedQuestion = question;
        } catch (e) {
            matches = null;
            verdict.textContent = e.message;
        }
        testBtn.disabled = false;
        renderMatches();
    }

    function renderMatches() {
        if (!matches) return;
        fullBtn.hidden = false;
        results.replaceChildren(...matches.map((m) => {
            const fill = h('span', { class: 'match-fill' });
            const line = h('span', { class: 'match-line', title: `Strictness ${threshold.toFixed(2)}` });
            fill.style.width = `${Math.max(0, m.similarity) * 100}%`;
            line.style.left = `${threshold * 100}%`;
            const passes = m.similarity >= threshold;
            fill.classList.toggle('pass', passes);
            return h('div', { class: 'match-row' },
                h('strong', { class: passes ? 'match-score pass' : 'match-score', text: score(m.similarity) }),
                h('div', { class: 'match-text' },
                    h('a', { class: 'match-title', href: `/admin/faqs/${m.faq_id}`, text: m.title }),
                    m.question !== m.title ? h('span', { class: 'muted', text: `via "${m.question}"` }) : null,
                    h('span', { class: 'match-bar' }, fill, line)));
        }));
        const best = matches[0];
        verdict.className = best && best.similarity >= threshold ? 'match-verdict status-ok' : 'match-verdict';
        verdict.textContent = !best ? 'No FAQs yet: this goes to the AI.'
            : best.similarity >= threshold ? `Gets the FAQ answer for "${best.title}".`
            : 'Goes to the AI: the closest FAQ is below the line.';
    }

    async function fullAnswer() {
        fullBtn.disabled = true;
        fullBox.replaceChildren(h('div', { class: 't-bot-bubble test-wait', text: 'Thinking…' }));
        try {
            const a = await api.post('/admin/api/prompts/test', { target: 'live', message: testedQuestion, history: [] });
            const tokens = (a.prompt_tokens || 0) + (a.completion_tokens || 0);
            fullBox.replaceChildren(...[
                h('div', { class: 't-bot-bubble' }, fmt.botHtml(a.text)),
                a.error ? h('div', { class: 't-error', text: `Model error: ${a.error}` }) : null,
                h('div', { class: 't-meta' },
                    h('span', { text: fmt.TIER[a.tier] }),
                    tokens ? h('span', { text: `${tokens.toLocaleString()} tokens` }) : null,
                    h('span', { text: `${(a.latency_ms / 1000).toFixed(1)} s` }),
                    a.wants_callback ? h('span', { class: 'pill pill-lead', text: 'Callback card' }) : null,
                    a.unanswered ? h('span', { class: 'pill pill-flag', text: 'Unanswered' }) : null),
            ].filter(Boolean));
        } catch (e) {
            fullBox.replaceChildren(h('div', { class: 't-error', text: e.message }));
        }
        fullBtn.disabled = false;
    }

    // --- FAQ list ---

    const rows = h('div', { class: 'card list faq-list' });
    const listError = h('p', { class: 'form-error', 'aria-live': 'polite' });
    view.append(rows, h('div', { class: 'list-foot' }, listError,
        h('a', { class: 'btn btn-primary', href: '/admin/faqs/new', text: '+ New FAQ' })));

    function meta(faq) {
        const extra = faq.questions.length - 1;
        return [
            extra ? `+${extra} ${extra === 1 ? 'wording' : 'wordings'}` : null,
            `${faq.answers.length} ${faq.answers.length === 1 ? 'answer' : 'answers'}`,
            faq.uses ? `used ${faq.uses}× in ${data.usage_days} days` : 'not used lately',
        ].filter(Boolean).join(' · ');
    }

    function iconButton(name, label, onclick) {
        return h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            onclick();
        } }, fmt.icon(name));
    }

    function faqRow(faq) {
        return h('div', { class: 'row item-row' },
            h('div', { class: 'item-name' },
                h('a', { class: 'row-title item-link', href: `/admin/faqs/${faq.id}`, text: title(faq) }),
                faq.button_url ? h('span', { class: 'pill', text: 'Button' }) : null),
            h('span', { class: 'row-meta', text: meta(faq) }),
            h('div', { class: 'item-actions' },
                iconButton('pencil', `Edit ${title(faq)}`, () => ctx.navigate(`/admin/faqs/${faq.id}`)),
                iconButton('trash', `Delete ${title(faq)}`, () => remove(faq))));
    }

    function update() {
        rows.replaceChildren(...(data.faqs.length ? data.faqs.map(faqRow)
            : [h('p', { class: 'empty', text: 'No FAQs yet. Every question goes to the AI.' })]));
    }

    async function remove(faq) {
        if (!confirm(`Delete the FAQ "${title(faq)}"? Past chats keep their answers.`)) return;
        listError.textContent = '';
        try {
            await api.delete(`/admin/api/faqs/${faq.id}`);
            data = await api.get('/admin/api/faqs');
            update();
        } catch (e) {
            listError.textContent = e.message;
        }
    }

    showThreshold();
    update();
}

// --- Old answers: HTML with the button inside → text + button ---

function convertAnswer(answer) {
    if (!/<[a-z]/i.test(answer)) return { text: answer, button: null };
    const doc = new DOMParser().parseFromString(`<body>${answer}</body>`, 'text/html');
    let button = null;
    doc.querySelectorAll('a.action-btn').forEach((a) => {
        button ||= { label: a.textContent.trim(), url: a.getAttribute('href') || '' };
        a.remove();
    });
    doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    doc.querySelectorAll('strong, b').forEach((b) => b.replaceWith(`**${b.textContent}**`));
    const text = doc.body.textContent.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, button };
}

// --- Editor page ---

async function renderEditor(view, ctx, faqId) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let dirty = false;
    let saving = false;
    const warnings = new Map();   // wording → overlap message

    const backLink = h('a', { class: 'back', href: '/admin/faqs', text: '← FAQs' });
    view.append(backLink);

    let faq = { questions: [], answers: [''], button_label: null, button_url: null };
    let threshold;
    try {
        const [list, loaded] = await Promise.all([api.get('/admin/api/faqs'),
            faqId ? api.get(`/admin/api/faqs/${faqId}`) : Promise.resolve(null)]);
        threshold = list.threshold;
        if (loaded) faq = loaded;
    } catch (e) {
        view.append(h('div', { class: 'card empty', text: e.status === 404 ? 'This FAQ doesn\'t exist anymore.' : e.message }));
        return;
    }

    // Old answers have their button inside the HTML: show them as text + button
    const converted = faq.answers.map(convertAnswer);
    const wasConverted = faq.answers.some((a, i) => converted[i].text !== a);
    const foundButton = converted.find((c) => c.button)?.button;
    let wordings = [...faq.questions];
    let answers = converted.map((c) => c.text);
    const button = { label: faq.button_label || foundButton?.label || '', url: faq.button_url || foundButton?.url || '' };

    const params = ctx.params;
    const prefill = params.get('q')?.trim();
    const addWording = params.get('add')?.trim();
    if (!faqId && prefill) wordings = [prefill];
    if (faqId && addWording && !wordings.some((w) => w.toLowerCase() === addWording.toLowerCase())) {
        wordings.push(addWording);
        dirty = true;
    }

    // --- Status bar ---

    const heading = h('strong', { class: 'status-name' });
    const statusText = h('span', { class: 'muted' });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', text: 'Save', onclick: save });
    const deleteBtn = h('button', { type: 'button', class: 'btn', text: 'Delete', hidden: !faqId, onclick: remove });
    view.append(h('div', { class: 'card prompt-status' },
        h('div', { class: 'status-left' }, h('div', { class: 'status-title' }, heading),
            h('p', { class: 'status-line', 'aria-live': 'polite' }, statusText)),
        h('div', { class: 'status-actions' }, deleteBtn,
            h('a', { class: 'btn', href: '/admin/faqs', text: 'Cancel' }), saveBtn)));

    function setStatus(text, kind = '') {
        statusText.textContent = text;
        statusText.className = kind === 'error' ? 'status-error' : kind === 'ok' ? 'status-ok' : 'muted';
    }

    function updateStatus(message, kind) {
        heading.textContent = faqId ? (wordings[0] || title(faq)) : 'New FAQ';
        document.title = `${heading.textContent} · FAQs · Dashboard`;
        saveBtn.disabled = saving;
        if (message) return setStatus(message, kind);
        if (saving) return setStatus('Saving…');
        if (dirty) return setStatus('Unsaved changes');
        if (wasConverted && faqId) return setStatus('Converted from the old format. Save to keep it this way.');
        setStatus(faqId ? `Last saved ${fmt.when(faq.updated_at)}` : 'Not saved yet');
    }

    function onEdit() {
        dirty = true;
        updateStatus();
    }

    // Unsaved edits: warn before leaving the page or following the back/cancel links
    window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); }, { signal: ctx.signal });
    view.addEventListener('click', (e) => {
        const link = e.target.closest('a[href="/admin/faqs"]');
        if (link && dirty && !confirm('Leave without saving your changes?')) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, { capture: true, signal: ctx.signal });

    // --- Suggestion: this question is already close to another FAQ ---

    const suggestion = h('div', { class: 'card card-pad faq-suggest', hidden: true });
    view.append(suggestion);

    // --- Wordings ---

    const errors = { questions: h('span', { class: 'field-error', 'aria-live': 'polite' }),
        answers: h('span', { class: 'field-error', 'aria-live': 'polite' }),
        button: h('span', { class: 'field-error', 'aria-live': 'polite' }) };
    const wordingList = h('div', { class: 'source-list link-list' });
    const warningBox = h('div', { class: 'faq-warnings', 'aria-live': 'polite' });
    const wordingInput = h('input', { class: 'input source-url', placeholder: 'Another way visitors ask this…', maxlength: 300, 'aria-label': 'New wording' });
    const wordingAdd = h('button', { type: 'submit', class: 'btn', text: 'Add wording' });
    const wordingError = h('p', { class: 'form-error', 'aria-live': 'polite' });

    function renderWordings() {
        wordingList.replaceChildren(...(wordings.length ? wordings.map((w, i) => h('div', { class: 'link-item wording-item' },
            h('span', { class: 'wording-text', text: w }),
            h('span', { class: 'muted wording-note', text: i === 0 ? 'Shown as the title' : '' }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove "${w}"`, title: 'Remove', onclick: () => {
                wordings = wordings.filter((x) => x !== w);
                warnings.delete(w);
                renderWordings();
                onEdit();
            } }, fmt.icon('x'))))
            : [h('p', { class: 'muted link-empty', text: 'Add at least one wording.' })]));
        warningBox.replaceChildren(...[...warnings.values()].map((text) => h('p', { class: 'faq-warning', text })));
        const full = wordings.length >= MAX_WORDINGS;
        wordingInput.disabled = wordingAdd.disabled = full;
        if (full) wordingError.textContent = `That's the maximum of ${MAX_WORDINGS} wordings.`;
    }

    // Warns when a wording would also match another FAQ, so visitors might get that one instead
    async function checkOverlap(wording) {
        try {
            const { matches } = await api.post('/admin/api/faqs/match', { question: wording, exclude_faq_id: faqId });
            const best = matches[0];
            if (best && best.similarity >= threshold && wordings.includes(wording)) {
                warnings.set(wording, `"${wording}" is also close to the FAQ "${best.title}" (${score(best.similarity)}). Visitors asking it may get that answer instead.`);
                renderWordings();
            }
            return best;
        } catch {
            return null;  // The check is a hint; saving still works without it
        }
    }

    function addWordingFromForm(e) {
        e.preventDefault();
        const wording = wordingInput.value.trim();
        wordingError.textContent = !wording ? 'Type a wording first.'
            : wordings.some((w) => w.toLowerCase() === wording.toLowerCase()) ? 'That wording is already in the list.' : '';
        if (wordingError.textContent) return;
        wordings.push(wording);
        wordingInput.value = '';
        renderWordings();
        onEdit();
        checkOverlap(wording);
        wordingInput.focus();
    }

    const wordingsCard = h('section', { class: 'card card-pad prompt-form' },
        h('h2', { text: 'Question wordings' }),
        h('p', { class: 'field-help', text: 'Different ways visitors ask this. The wording closest to a visitor\'s question decides whether this FAQ answers.' }),
        h('div', { class: 'pfield' }, wordingList, errors.questions, warningBox,
            h('form', { class: 'source-add', novalidate: true, onsubmit: addWordingFromForm }, wordingInput, wordingAdd),
            wordingError));

    // --- Answers ---

    const answerList = h('div', { class: 'answer-list' });
    const addAnswerBtn = h('button', { type: 'button', class: 'link-btn', text: '+ Add answer', onclick: () => {
        answers.push('');
        renderAnswers();
        answerList.querySelector('.answer-row:last-child textarea')?.focus();
        onEdit();
    } });
    let answerErrors = [];

    function previewHtml(text) {
        const fragment = fmt.botHtml(text || ' ');
        if (button.label && /^https:\/\//.test(button.url)) {
            fragment.append(document.createElement('br'), h('a', { class: 'action-btn', href: button.url, target: '_blank', rel: 'noopener noreferrer', text: button.label }));
        }
        return fragment;
    }

    function renderAnswers() {
        answerErrors = [];
        answerList.replaceChildren(...answers.map((text, i) => {
            const preview = h('div', { class: 't-bot-bubble answer-preview' }, previewHtml(text));
            const error = h('span', { class: 'field-error', 'aria-live': 'polite' });
            answerErrors.push(error);
            const box = h('textarea', { class: 'textarea', rows: 3, maxlength: 2000, value: text, 'aria-label': `Answer ${i + 1}`,
                oninput: () => { answers[i] = box.value; preview.replaceChildren(previewHtml(box.value)); onEdit(); } });
            return h('div', { class: 'answer-row' },
                h('div', { class: 'answer-edit' },
                    h('div', { class: 'answer-head' }, h('span', { class: 'pfield-label', text: `Answer ${i + 1}` }),
                        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove answer ${i + 1}`, title: 'Remove', disabled: answers.length === 1, onclick: () => {
                            answers.splice(i, 1);
                            renderAnswers();
                            onEdit();
                        } }, fmt.icon('x'))),
                    box, error),
                h('div', { class: 'answer-side' }, h('span', { class: 'test-label', text: 'Preview' }), preview));
        }));
        addAnswerBtn.hidden = answers.length >= MAX_ANSWERS;
    }

    const answersCard = h('section', { class: 'card card-pad prompt-form' },
        h('h2', { text: 'Answers' }),
        h('p', { class: 'field-help', text: 'Replies take turns, so returning visitors don\'t see the same text every time. **bold** and line breaks work.' }),
        answerList, errors.answers, addAnswerBtn);

    // --- Button ---

    const buttonLabel = h('input', { class: 'input link-label', placeholder: 'Button text', maxlength: 40, value: button.label, 'aria-label': 'Button text',
        oninput: () => { button.label = buttonLabel.value.trim(); renderAnswers(); onEdit(); } });
    const buttonUrl = h('input', { class: 'input source-url', type: 'url', placeholder: 'https://…', maxlength: 500, value: button.url, 'aria-label': 'Button address',
        oninput: () => { button.url = buttonUrl.value.trim(); renderAnswers(); onEdit(); } });
    const buttonCard = h('section', { class: 'card card-pad prompt-form' },
        h('h2', { text: 'Button (optional)' }),
        h('p', { class: 'field-help', text: 'Shown under every answer, e.g. "Download app". Leave both empty for no button.' }),
        h('div', { class: 'source-add button-fields' }, buttonLabel, buttonUrl), errors.button);

    view.append(h('div', { class: 'faq-editor' }, wordingsCard, answersCard, buttonCard));

    // --- Saving ---

    function clearErrors() {
        Object.values(errors).forEach((e) => { e.textContent = ''; });
        answerErrors.forEach((e) => { e.textContent = ''; });
        view.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    }

    function showErrors(fieldErrors) {
        clearErrors();
        for (const err of fieldErrors) {
            const [, name, index] = err.loc;
            const message = FRIENDLY_ERRORS[err.type] || err.msg.replace(/^Value error, /, '');
            if (name === 'answers' && typeof index === 'number' && answerErrors[index]) {
                answerErrors[index].textContent = message;
                answerList.querySelectorAll('textarea')[index]?.classList.add('invalid');
            } else if (name === 'questions') {
                errors.questions.textContent = typeof index === 'number' ? `"${wordings[index]}": ${message}` : message;
            } else if (name === 'answers') {
                errors.answers.textContent = message;
            } else {  // button_label, button_url, or the label-and-address pair
                errors.button.textContent = message;
                if (name === 'button_url') buttonUrl.classList.add('invalid');
                if (name === 'button_label') buttonLabel.classList.add('invalid');
            }
        }
    }

    async function save() {
        saving = true;
        clearErrors();
        updateStatus();
        try {
            const saved = await (faqId
                ? api.put(`/admin/api/faqs/${faqId}`, collect())
                : api.post('/admin/api/faqs', collect()));
            dirty = false;
            if (!faqId) return ctx.navigate(`/admin/faqs/${saved.id}?saved=1`, { replace: true });
            faq = saved;
            saving = false;
            updateStatus('Saved · visitors get it now', 'ok');
        } catch (e) {
            saving = false;
            if (e.fieldErrors?.length) {
                showErrors(e.fieldErrors);
                updateStatus('Not saved: fix the highlighted fields.', 'error');
            } else {
                updateStatus(`Not saved: ${e.message}`, 'error');
            }
        }
    }

    function collect() {
        return { questions: wordings, answers: answers.map((a) => a.trim()), button_label: button.label, button_url: button.url };
    }

    async function remove() {
        if (!confirm(`Delete this FAQ? Past chats keep their answers.`)) return;
        try {
            await api.delete(`/admin/api/faqs/${faqId}`);
            dirty = false;
            ctx.navigate('/admin/faqs');
        } catch (e) {
            updateStatus(e.message, 'error');
        }
    }

    // --- From "Add as FAQ": offer the existing FAQ this question is close to ---

    async function suggestExisting(question) {
        const best = await checkOverlap(question);
        warnings.delete(question);  // The suggestion card says it better
        renderWordings();
        if (!best || best.similarity < SUGGEST_SIMILARITY) return;
        suggestion.hidden = false;
        suggestion.replaceChildren(
            h('p', {}, `This question is close to the FAQ "${best.title}" (${score(best.similarity)}). `,
                best.similarity >= threshold ? 'Visitors asking it already get that answer.' : 'It falls just below the strictness line.'),
            h('a', { class: 'btn btn-small', href: `/admin/faqs/${best.faq_id}?add=${encodeURIComponent(question)}`,
                text: 'Add as a wording there instead' }));
    }

    renderWordings();
    renderAnswers();
    if (params.get('saved')) ctx.setQuery('');
    updateStatus(params.get('saved') ? 'Saved · visitors get it now' : faqId && addWording && dirty ? `Added "${addWording}" as a wording. Save to keep it.` : '',
        params.get('saved') ? 'ok' : '');
    if (!faqId && prefill) suggestExisting(prefill);
    if (faqId && addWording) checkOverlap(addWording);
    if (!faqId && !prefill) wordingInput.focus();
}
