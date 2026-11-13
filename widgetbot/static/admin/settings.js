// /admin/settings: lead alerts, business details, chat history retention, and the shared login's password and sessions.
// Each card saves on its own.

const RETENTION_LABELS = { 90: '90 days', 180: '6 months', 365: '1 year', 730: '2 years' };
const FIELD_NAMES = { name: 'Business name', current: 'Current password' };

export async function render(view, ctx) {
    const { api, fmt } = ctx;
    const { h } = fmt;
    let data = await api.get('/admin/api/settings');

    view.append(h('div', { class: 'page-head' },
        h('div', {}, h('h1', { text: 'Settings' }),
            h('p', { class: 'muted', text: 'Alerts, business details, how long chats are kept, and the dashboard login.' }))));

    // Two independent columns, so a short card doesn't leave a gap under it (stacked on narrow screens)
    const left = h('div', { class: 'settings-col' });
    const right = h('div', { class: 'settings-col' });
    view.append(h('div', { class: 'settings-grid' }, left, right));

    // A card with a heading, help text, body and a save row whose message sits next to the button
    function card(title, help, ...body) {
        return h('section', { class: 'card card-pad prompt-form settings-card' },
            h('h2', { text: title }), help ? h('p', { class: 'field-help', text: help }) : null, ...body);
    }

    function saveRow(label, onclick, extra = []) {
        const message = h('span', { class: 'muted settings-msg', 'aria-live': 'polite' });
        const button = h('button', { type: 'button', class: 'btn btn-primary btn-small', text: label });
        button.addEventListener('click', async () => {
            button.disabled = true;
            message.className = 'muted settings-msg';
            message.textContent = 'Saving…';
            try {
                const text = await onclick();
                message.className = 'status-ok settings-msg';
                message.textContent = text || 'Saved';
            } catch (e) {
                message.className = 'status-error settings-msg';
                message.textContent = e.fieldErrors?.length ? e.fieldErrors.map((f) => (f.type === 'string_too_short'
                    ? `${FIELD_NAMES[f.loc.at(-1)] || 'This field'} is required` : f.msg.replace(/^Value error, /, ''))).join(' · ') : e.message;
            }
            button.disabled = false;
        });
        return { node: h('div', { class: 'settings-actions' }, ...extra, message, button), message };
    }

    function field(label, control, help) {
        control.id ||= `sf-${label.toLowerCase().replace(/\W+/g, '-')}`;
        return h('div', { class: 'pfield' }, h('label', { for: control.id, text: label }), control,
            help ? h('span', { class: 'field-help', text: help }) : null);
    }

    // --- Lead alerts ---

    const emailInput = h('input', { class: 'input', type: 'email', maxlength: 200, value: data.alerts.alert_email,
        placeholder: 'team@example.com', autocomplete: 'email' });
    const smtpNote = h('p', { class: 'settings-note' });
    const testMsg = h('span', { class: 'muted settings-msg', 'aria-live': 'polite' });
    const testBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Send test email', onclick: async () => {
        testBtn.disabled = true;
        testMsg.className = 'muted settings-msg';
        testMsg.textContent = 'Sending…';
        try {
            const res = await api.post('/admin/api/settings/alerts/test');
            testMsg.className = 'status-ok settings-msg';
            testMsg.textContent = `Sent to ${res.sent_to}. Check the inbox (and spam).`;
        } catch (e) {
            testMsg.className = 'status-error settings-msg';
            testMsg.textContent = e.message;
        }
        updateAlerts();
    } });
    const notifyState = h('span', { class: 'muted' });
    const notifyBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Turn on', onclick: async () => {
        await Notification.requestPermission();
        updateNotify();
    } });

    function updateAlerts() {
        smtpNote.className = data.alerts.smtp_configured ? 'settings-note ok' : 'settings-note warn';
        smtpNote.textContent = data.alerts.smtp_configured
            ? 'Email sending is set up on the server.'
            : 'Email sending isn\'t set up on the server yet, so no emails go out. Add SMTP_HOST, SMTP_FROM, SMTP_USER and SMTP_PASSWORD to .env and restart.';
        testBtn.disabled = !data.alerts.smtp_configured || !data.alerts.alert_email;
        testBtn.title = !data.alerts.alert_email ? 'Save an address first' : '';
    }

    function updateNotify() {
        const supported = 'Notification' in window;
        const state = supported ? Notification.permission : 'unsupported';
        notifyState.textContent = {
            granted: 'On for this browser: a pop-up appears when a request arrives while the dashboard is in the background.',
            denied: 'Blocked in this browser\'s site settings. Allow notifications for this site there to turn them on.',
            default: 'Off for this browser.',
            unsupported: 'This browser doesn\'t support notifications.',
        }[state];
        notifyBtn.hidden = state !== 'default';
    }

    const alertsSave = saveRow('Save', async () => {
        data = await api.put('/admin/api/settings/alerts', { alert_email: emailInput.value });
        emailInput.value = data.alerts.alert_email;
        testMsg.textContent = '';
        updateAlerts();
        return data.alerts.alert_email ? 'Saved' : 'Saved · emails are off';
    });
    left.append(card('Callback alerts', 'Where new callback requests are emailed, with the visitor\'s details, a summary and the chat.',
        field('Alert email', emailInput, 'Leave empty to stop emails. The dashboard still shows every request.'),
        alertsSave.node,
        smtpNote,
        h('div', { class: 'settings-actions settings-actions-left' }, testBtn, testMsg),
        h('div', { class: 'settings-sub' },
            h('span', { class: 'pfield-label', text: 'Browser notifications' }),
            h('div', { class: 'settings-inline' }, notifyState, notifyBtn))));

    // --- Business details ---

    const nameInput = h('input', { class: 'input', maxlength: 80, value: data.business.name });
    const consentInput = h('textarea', { class: 'textarea', rows: 2, maxlength: 300, value: data.business.consent_text,
        placeholder: data.business.default_consent_text });
    const businessSave = saveRow('Save', async () => {
        data = await api.put('/admin/api/settings/business', { name: nameInput.value, consent_text: consentInput.value });
        consentInput.placeholder = data.business.default_consent_text;
        return 'Saved · reload to see the new name in the sidebar';
    });
    right.append(card('Business details', null,
        field('Business name', nameInput, 'Shown in the dashboard, alert emails and the default consent wording.'),
        field('Callback consent wording', consentInput, 'What visitors agree to by ticking the box in the callback form. Each request stores the exact wording. Leave empty for the default shown in grey.'),
        businessSave.node));

    // --- Chat history ---

    const retentionSelect = fmt.select({ ...RETENTION_LABELS, '': 'Keep forever' }, String(data.retention.days ?? ''), {
        id: 'sf-retention', onchange: () => previewRetention().catch((e) => {
            retentionNote.className = 'settings-note warn';
            retentionNote.textContent = e.message;
        }) });
    const retentionNote = h('p', { class: 'settings-note', 'aria-live': 'polite' });

    async function previewRetention() {
        const days = retentionSelect.value;
        if (!days) {
            retentionNote.className = 'settings-note';
            retentionNote.textContent = 'Chats and callback requests are kept until you delete them.';
            return null;
        }
        const res = await api.get(`/admin/api/settings/retention/preview?days=${days}`);
        retentionNote.className = res.conversations ? 'settings-note warn' : 'settings-note';
        retentionNote.textContent = res.conversations
            ? `Saving deletes ${res.conversations} ${res.conversations === 1 ? 'chat' : 'chats'}`
                + (res.leads ? ` and ${res.leads} callback ${res.leads === 1 ? 'request' : 'requests'}` : '')
                + ` older than ${RETENTION_LABELS[days]} right away, then keeps doing so daily. This can't be undone.`
            : `Nothing is older than ${RETENTION_LABELS[days]} yet. From then on, older chats are deleted daily.`;
        return res;
    }

    const retentionSave = saveRow('Save', async () => {
        const days = retentionSelect.value ? Number(retentionSelect.value) : null;
        if (days) {
            const res = await previewRetention();
            if (res?.conversations && !confirm(`Delete ${res.conversations} old ${res.conversations === 1 ? 'chat' : 'chats'} now? This can't be undone.`)) {
                return 'Not saved';
            }
        }
        data = await api.put('/admin/api/settings/retention', { days });
        await previewRetention();
        return 'Saved';
    });
    left.append(card('Chat history', 'Delete old chats automatically, with their callback requests. Usage totals on the Overview keep only what remains.',
        field('Keep chats for', retentionSelect), retentionNote, retentionSave.node));

    // --- Password & sessions ---

    const currentInput = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 200 });
    const newInput = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 200 });
    const repeatInput = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: 200 });
    const sessionList = h('div', { class: 'session-list' });

    function renderSessions(sessions) {
        sessionList.replaceChildren(...sessions.map((s) => h('div', { class: 'session-row' },
            h('div', { class: 'kb-body' },
                h('strong', { text: s.device }),
                h('span', { class: 'muted', text: `${s.ip || 'Unknown IP'} · signed in ${fmt.when(s.created_at)}` })),
            s.current ? h('span', { class: 'pill pill-lead', text: 'This browser' }) : h('span', {}))));
        logoutOthersBtn.disabled = !sessions.some((s) => !s.current);
    }

    const passwordSave = saveRow('Change password', async () => {
        if (newInput.value.length < data.min_password_length) throw new Error(`The new password needs at least ${data.min_password_length} characters`);
        if (newInput.value !== repeatInput.value) throw new Error('The new passwords don\'t match');
        const res = await api.put('/admin/api/settings/password', { current: currentInput.value, new: newInput.value });
        currentInput.value = newInput.value = repeatInput.value = '';
        renderSessions(res.sessions);
        return 'Changed · other browsers were logged out';
    });
    const logoutMsg = h('span', { class: 'muted settings-msg', 'aria-live': 'polite' });
    const logoutOthersBtn = h('button', { type: 'button', class: 'btn btn-small', text: 'Log out other browsers', onclick: async () => {
        if (!confirm('Log out every other browser using this login?')) return;
        const res = await api.post('/admin/api/settings/sessions/logout-others');
        renderSessions(res.sessions);
        logoutMsg.className = 'status-ok settings-msg';
        logoutMsg.textContent = 'Done';
    } });

    right.append(card('Login', `Everyone on the team signs in as "${data.username}". Change the password when someone leaves.`,
        field('Current password', currentInput),
        h('div', { class: 'settings-pair' },
            field('New password', newInput, `At least ${data.min_password_length} characters.`),
            field('Repeat new password', repeatInput)),
        passwordSave.node,
        h('div', { class: 'settings-sub' },
            h('span', { class: 'pfield-label', text: 'Signed-in browsers' }),
            sessionList,
            h('div', { class: 'settings-actions settings-actions-left' }, logoutOthersBtn, logoutMsg))));

    updateAlerts();
    updateNotify();
    renderSessions(data.sessions);
    previewRetention();
}
