// Small DOM and formatting helpers shared by the dashboard pages.
// Everything visitor-written goes in via textContent; bot replies go through DOMPurify.

export const INTEREST = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };
export const INTENT = {
    purchase_interest: 'Buying interest',
    product_question: 'Product question',
    support: 'Support',
    other: 'Other',
};
export const STATUS = { new: 'New', contacted: 'Contacted', converted: 'Converted', not_interested: 'Not interested' };
export const TIER = { 1: 'FAQ answer', 2: 'AI answer', 3: 'AI + website' };

/** h('div', {class: 'x', text: 'hi', onclick: fn, href: '...'}, child, child) */
export function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key in node && key !== 'list') node[key] = value;
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : String(child));
    }
    return node;
}

// Small line icons for icon buttons (decorative; the button carries the label)
const ICONS = {
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};

export function icon(name) {
    const span = h('span', { 'aria-hidden': 'true' });
    span.insertAdjacentHTML('beforeend', `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`);
    return span;
}

export function interestPill(level) {
    return level ? h('span', { class: `pill pill-${level}`, text: INTEREST[level] || level }) : null;
}

const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function when(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const minutes = Math.round((Date.now() - date) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const today = new Date();
    if (date.toDateString() === today.toDateString()) return `Today, ${timeOnly.format(date)}`;
    return dateTime.format(date);
}

export function fullDate(iso) {
    return iso ? dateTime.format(new Date(iso)) : '';
}

export function phoneLink(phone, className) {
    return h('a', { class: className, href: `tel:${phone}`, text: phone });
}

/** Bot replies may contain links, line breaks, bold and ~~strikethrough~~; everything else is stripped. */
export function botHtml(text) {
    const html = String(text || '')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>')  // same rule as the widget
        .replace(/\n/g, '<br>');
    const fragment = window.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['a', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'ul', 'ol', 'li', 'p'],
        ALLOWED_ATTR: ['href', 'class'],
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
        RETURN_DOM_FRAGMENT: true,
    });
    fragment.querySelectorAll('a').forEach((a) => {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (!a.classList.contains('action-btn')) a.removeAttribute('class');
        else a.className = 'action-btn';
    });
    return fragment;
}

export function sourceLabel(url) {
    try {
        const u = new URL(url);
        return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
    } catch {
        return url;
    }
}

export function pager(data, onPage) {
    const from = data.total ? (data.page - 1) * data.page_size + 1 : 0;
    const to = Math.min(data.page * data.page_size, data.total);
    return h('div', { class: 'pager' },
        h('span', { text: data.total ? `Showing ${from}–${to} of ${data.total}` : '' }),
        h('div', {},
            h('button', { class: 'btn btn-small', type: 'button', text: 'Previous', disabled: data.page <= 1,
                onclick: () => onPage(data.page - 1) }),
            h('button', { class: 'btn btn-small', type: 'button', text: 'Next', disabled: to >= data.total,
                onclick: () => onPage(data.page + 1) }),
        ),
    );
}

export function select(options, value, attrs) {
    return h('select', { class: 'select', ...attrs },
        Object.entries(options).map(([v, label]) => h('option', { value: v, text: label, selected: v === (value || '') })));
}
