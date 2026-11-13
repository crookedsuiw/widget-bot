// Dashboard shell: sidebar, page routing, and live lead alerts.
// Imports carry this file's ?v= so a deploy never mixes old and new modules.
const V = new URL(import.meta.url).search;
const [{ api }, fmt] = await Promise.all([import('./api.js' + V), import('./format.js' + V)]);
const { h } = fmt;

const ICONS = {
    overview: '<path d="M4 13h6V4H4zM14 20h6V11h-6zM4 20h6v-4H4zM14 7h6V4h-6z"/>',
    leads: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    'chat-history': '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    'prompt-rules': '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    faqs: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    knowledge: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z"/>',
};

const NAV = [
    { page: 'overview', label: 'Overview' },
    { page: 'leads', label: 'Leads' },
    { page: 'chat-history', label: 'Chat history' },
    { page: 'prompt-rules', label: 'Prompt rules' },
    { page: 'faqs', label: 'FAQs' },
    { page: 'knowledge', label: 'Knowledge base' },
    { page: 'settings', label: 'Settings' },
];

const PAGES = {
    overview: () => import('./overview.js' + V),
    leads: () => import('./leads.js' + V),
    'chat-history': () => import('./chats.js' + V),
    'prompt-rules': () => import('./prompts.js' + V),
    faqs: () => import('./faqs.js' + V),
    knowledge: () => import('./knowledge.js' + V),
    settings: () => import('./settings.js' + V),
};

const view = document.getElementById('view');
const nav = document.getElementById('nav');
let unseenCount = 0;
let pageListeners = null;  // Aborted on every route change, so pages can't leave listeners behind

// --- Navigation ---

function navigate(url, { replace = false } = {}) {
    history[replace ? 'replaceState' : 'pushState'](null, '', url);
    route();
}

// Updates the address bar's query string without re-rendering the page (used by filter bars)
function setQuery(query) {
    history.replaceState(null, '', location.pathname + (query ? '?' + query : ''));
}

function renderNav(current) {
    nav.textContent = '';
    for (const item of NAV) {
        const link = h('a', { href: `/admin/${item.page}`, class: item.soon ? 'soon' : null,
            'aria-current': item.page === current ? 'page' : null });
        link.insertAdjacentHTML('beforeend', `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[item.page]}</svg>`);
        link.append(item.label);
        if (item.page === 'leads' && unseenCount > 0) {
            link.append(h('span', { class: 'badge', text: unseenCount > 99 ? '99+' : unseenCount,
                'aria-label': `${unseenCount} new` }));
        }
        nav.append(link);
    }
}

async function route() {
    const [, , page = 'overview', item] = location.pathname.split('/');
    renderNav(page);
    const entry = NAV.find((n) => n.page === page);
    document.title = `${entry ? entry.label : 'Dashboard'} · Dashboard`;
    view.textContent = '';
    pageListeners?.abort();
    pageListeners = new AbortController();

    if (!PAGES[page]) {
        view.append(h('div', { class: 'card soon-card' },
            h('h1', { text: entry ? entry.label : 'Not found' }),
            h('p', { class: 'muted', text: 'This section is coming in a later update.' })));
        return;
    }
    const module = await PAGES[page]();
    await module.render(view, {
        api, fmt, navigate, setQuery, item,
        params: new URLSearchParams(location.search),
        signal: pageListeners.signal,
        markLeadsSeen,
    });
    view.focus({ preventScroll: true });
}

// Same-tab navigation for dashboard links; everything else (tel:, CSV downloads, new tabs) behaves normally
document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/admin/') || url.pathname.startsWith('/admin/api/')
        || link.target || link.hasAttribute('download')) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
});
window.addEventListener('popstate', route);

// --- Lead alerts ---

const toasts = document.getElementById('toasts');
const MAX_TOASTS = 4;

async function markLeadsSeen(ids) {
    if (!ids.length) return;
    await api.post('/admin/api/leads/seen', { ids });
    const res = await api.get('/admin/api/leads/unseen');
    setUnseen(res.length);
}

function setUnseen(count) {
    unseenCount = count;
    renderNav(location.pathname.split('/')[2] || 'overview');
}

function showLeadToast(lead) {
    toasts.querySelector(`[data-lead="${lead.id}"]`)?.remove();
    const dismiss = () => { toast.remove(); markLeadsSeen([lead.id]); };
    const toast = h('div', { class: 'toast', role: 'alert', 'data-lead': lead.id },
        h('div', { class: 'toast-head' }, h('strong', { text: 'New callback request' }), h('span', { text: fmt.when(lead.created_at) })),
        lead.name ? h('div', { class: 'toast-name', text: lead.name }) : null,
        h('div', {}, fmt.phoneLink(lead.phone, 'toast-phone'), ' ', fmt.interestPill(lead.interest_level)),
        h('p', { class: 'toast-summary', text: lead.summary || 'Summary is being prepared…' }),
        h('div', { class: 'toast-actions' },
            h('a', { class: 'btn btn-primary btn-small', href: `/admin/chat-history/${lead.conversation_id}`,
                text: 'View full chat', onclick: () => dismiss() }),
            h('button', { class: 'btn btn-small', type: 'button', text: 'Dismiss', onclick: dismiss })),
    );
    toasts.prepend(toast);
    while (toasts.children.length > MAX_TOASTS) toasts.lastElementChild.remove();
}

function desktopNotify(lead) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    const n = new Notification('New callback request', {
        body: `${lead.name ? lead.name + ' · ' : ''}${lead.phone}\n${lead.summary || ''}`,
        tag: `lead-${lead.id}`,
    });
    n.onclick = () => { window.focus(); navigate(`/admin/chat-history/${lead.conversation_id}`); n.close(); };
}

function listenForLeads() {
    const events = new EventSource('/admin/api/events');
    events.addEventListener('lead', (e) => {
        const lead = JSON.parse(e.data);
        setUnseen(unseenCount + 1);
        showLeadToast(lead);
        desktopNotify(lead);
        window.dispatchEvent(new CustomEvent('widgetbot:lead', { detail: lead }));
    });
    // EventSource reconnects by itself; leads that arrive while disconnected show up as unseen on reload
}

function setupDesktopAlertsButton() {
    const button = document.getElementById('enable-alerts');
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    button.hidden = false;
    button.addEventListener('click', async () => {
        await Notification.requestPermission();
        button.hidden = true;
    });
}

// --- Start ---

document.getElementById('logout').addEventListener('click', async () => {
    await api.post('/admin/logout');
    location.href = '/admin/login';
});

const [me, unseen] = await Promise.all([api.get('/admin/api/me'), api.get('/admin/api/leads/unseen')]);
const brand = document.getElementById('brand');
if (me.logo_url) brand.append(h('img', { src: me.logo_url, alt: me.client_name }));
else brand.append(h('span', { text: me.client_name }));
document.getElementById('account').textContent = `Signed in as ${me.username}`;

unseenCount = unseen.length;
if (location.pathname === '/admin' || location.pathname === '/admin/') navigate('/admin/overview', { replace: true });
else await route();
unseen.slice(0, 3).reverse().forEach(showLeadToast);
setupDesktopAlertsButton();
listenForLeads();
