/* widgetbot chat panel. Loaded inside the iframe that /widget.js creates. */
(function () {
    'use strict';

    var config = JSON.parse(document.getElementById('widgetbot-config').textContent);
    var params = new URLSearchParams(location.search);
    var hostOrigin = params.get('origin');
    // The panel is 380px wide on desktop, so a width media query can't tell it apart from a phone;
    // the loader says when the panel fills the screen instead
    document.documentElement.classList.toggle('fullscreen', params.get('fs') === '1');
    var KEY = config.widgetKey;
    var STORE_CURRENT = 'widgetbot:' + KEY + ':current';   // conversation shown when the panel opens
    var STORE_HISTORY = 'widgetbot:' + KEY + ':history';   // conversation ids, newest first
    var MIN_TYPING_MS = 450;  // Instant FAQ answers would otherwise flash the typing dots
    var MAX_SOURCE_CHIPS = 2;

    var QUICK_REPLY_ICONS = {
        download: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
        games: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="10" rx="5"/><path d="M8 11v4M6 13h4M15 12h.01M18 14h.01"/></svg>',
        sparkle: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
        phone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>'
    };
    var THUMB_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 10v10H4V10zM7 10l4-7a2 2 0 0 1 3 2l-1 5h6a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/></svg>';
    var ARROW_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
    var CHEVRON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';

    var el = {
        app: document.querySelector('.app'),
        chatView: document.getElementById('view-chat'),
        historyView: document.getElementById('view-history'),
        brandMark: document.getElementById('brand-mark'),
        messages: document.getElementById('messages'),
        composer: document.getElementById('composer'),
        input: document.getElementById('input'),
        send: document.getElementById('send'),
        privacy: document.getElementById('privacy'),
        historyBtn: document.getElementById('btn-history'),
        historyList: document.getElementById('history-list')
    };

    // --- Storage (can be blocked in private windows; the widget still works without it) ---

    function load(key, fallback) {
        try {
            var value = localStorage.getItem(key);
            return value === null ? fallback : JSON.parse(value);
        } catch (e) {
            return fallback;
        }
    }

    function save(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    }

    var state = {
        sessionId: load(STORE_CURRENT, ''),
        history: load(STORE_HISTORY, []),
        sending: false
    };

    function setSession(id) {
        state.sessionId = id;
        save(STORE_CURRENT, id);
        if (id) {
            state.history = [id].concat(state.history.filter(function (x) { return x !== id; }))
                .slice(0, config.maxHistory);
            save(STORE_HISTORY, state.history);
        }
        updateHistoryButton();
    }

    function forgetConversation(id) {
        state.history = state.history.filter(function (x) { return x !== id; });
        save(STORE_HISTORY, state.history);
        if (state.sessionId === id) setSession('');
        updateHistoryButton();
    }

    // History only appears once there is an earlier conversation to go back to
    function updateHistoryButton() {
        el.historyBtn.hidden = !state.history.some(function (id) { return id !== state.sessionId; });
    }

    // --- Helpers ---

    function make(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function api(path, options) {
        return fetch(path, options).then(function (res) {
            if (!res.ok) {
                var err = new Error('HTTP ' + res.status);
                err.status = res.status;
                throw err;
            }
            return res.json();
        });
    }

    function postJson(path, body) {
        return api(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function scrollToBottom() {
        requestAnimationFrame(function () { el.messages.scrollTop = el.messages.scrollHeight; });
    }

    function notifyHost(type) {
        if (window.parent !== window && hostOrigin) window.parent.postMessage({ widgetbot: type }, hostOrigin);
    }

    // --- Bot reply rendering ---

    // Bot replies may contain links and light formatting. Everything else is stripped, so a reply
    // (or prompt-injected page content) can never run script inside the widget.
    function renderBotContent(text) {
        var html = String(text || '')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // ~~text~~ strikethrough; must hug the text, so "~~ x ~~" and lone "~5 min" stay as typed
            .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>')
            .replace(/\n/g, '<br>');
        var fragment = DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['a', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'ul', 'ol', 'li', 'p'],
            ALLOWED_ATTR: ['href', 'class'],
            ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:)/i,
            RETURN_DOM_FRAGMENT: true
        });

        fragment.querySelectorAll('a').forEach(function (a) {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            if (a.classList.contains('action-btn')) {
                a.className = 'action-btn';
                a.insertAdjacentHTML('beforeend', ARROW_ICON);
                // The button already has its own spacing; drop the <br>s the model puts before it
                var prev = a.previousSibling;
                while (prev && (prev.nodeName === 'BR' || (prev.nodeType === 3 && !prev.textContent.trim()))) {
                    var next = prev.previousSibling;
                    prev.remove();
                    prev = next;
                }
            } else {
                a.removeAttribute('class');
            }
        });
        return fragment;
    }

    function sourceLabel(url) {
        try {
            var u = new URL(url);
            if (!/^https?:$/.test(u.protocol)) return null;
            return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '');
        } catch (e) {
            return null;
        }
    }

    // --- Messages ---

    function clearMessages() {
        el.messages.textContent = '';
    }

    function addUserMessage(text) {
        el.messages.appendChild(make('div', 'msg msg-user', text));
        scrollToBottom();
    }

    function addBotMessage(message) {
        var wrap = make('div', 'msg msg-bot');
        var bubble = make('div', 'bubble-bot');
        bubble.appendChild(renderBotContent(message.content));
        wrap.appendChild(bubble);

        var meta = make('div', 'msg-meta');
        var sources = (message.sources || []).map(function (url) {
            return { url: url, label: sourceLabel(url) };
        }).filter(function (s) { return s.label; }).slice(0, MAX_SOURCE_CHIPS);

        if (sources.length) {
            meta.appendChild(make('span', 'sources-label', 'Sources'));
            sources.forEach(function (s) {
                var chip = make('a', 'source-chip', s.label);
                chip.href = s.url;
                chip.target = '_blank';
                chip.rel = 'noopener noreferrer';
                meta.appendChild(chip);
            });
            meta.appendChild(make('span', 'meta-spacer'));
        }
        if (message.id) addFeedbackButtons(meta, message.id, message.feedback || 0);
        if (meta.childNodes.length) wrap.appendChild(meta);

        el.messages.appendChild(wrap);
        scrollToBottom();
    }

    function addFeedbackButtons(container, messageId, current) {
        var buttons = [
            { value: 1, label: 'Helpful', className: 'feedback-btn' },
            { value: -1, label: 'Not helpful', className: 'feedback-btn feedback-down' }
        ].map(function (spec) {
            var btn = make('button', spec.className);
            btn.type = 'button';
            btn.setAttribute('aria-label', spec.label);
            btn.innerHTML = THUMB_ICON;
            btn.dataset.value = spec.value;
            container.appendChild(btn);
            return btn;
        });

        function show(value) {
            buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.value) === value)); });
        }
        show(current);

        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var previous = current;
                current = current === Number(btn.dataset.value) ? 0 : Number(btn.dataset.value);
                show(current);
                postJson('/messages/' + messageId + '/feedback', { session_id: state.sessionId, value: current })
                    .catch(function () { current = previous; show(current); });
            });
        });
    }

    var typingNode = null;

    function showTyping() {
        typingNode = make('div', 'msg typing');
        typingNode.setAttribute('role', 'status');
        typingNode.setAttribute('aria-label', 'Assistant is typing');
        typingNode.innerHTML = '<span></span><span></span><span></span>';
        el.messages.appendChild(typingNode);
        scrollToBottom();
    }

    function hideTyping() {
        if (typingNode) typingNode.remove();
        typingNode = null;
    }

    // --- "Want our team to call you?" card (offered at most once per conversation by the server) ---

    function showCallbackCard() {
        var card = make('form', 'msg callback-card');
        card.noValidate = true;
        card.appendChild(make('p', 'callback-title', 'Want our team to call you?'));
        card.appendChild(make('p', 'callback-sub', "Leave your number and we'll get in touch."));

        var name = make('input', 'callback-input');
        name.type = 'text';
        name.placeholder = 'Your name (optional)';
        name.autocomplete = 'name';
        name.maxLength = 80;
        name.setAttribute('aria-label', 'Your name (optional)');
        card.appendChild(name);

        var phoneRow = make('div', 'callback-phone');
        phoneRow.appendChild(make('span', 'callback-prefix', '+91'));
        var phone = make('input', 'callback-input');
        phone.type = 'tel';
        phone.placeholder = 'Phone number';
        phone.autocomplete = 'tel-national';
        phone.inputMode = 'tel';
        phone.maxLength = 20;
        phone.required = true;
        phone.setAttribute('aria-label', 'Phone number');
        phoneRow.appendChild(phone);
        card.appendChild(phoneRow);

        var consentLabel = make('label', 'callback-consent');
        var consent = make('input');
        consent.type = 'checkbox';
        consentLabel.appendChild(consent);
        consentLabel.appendChild(make('span', null, config.consentText));
        card.appendChild(consentLabel);

        var error = make('p', 'callback-error');
        error.setAttribute('role', 'alert');
        card.appendChild(error);

        var actions = make('div', 'callback-actions');
        var submit = make('button', 'callback-submit', 'Request a call');
        submit.type = 'submit';
        var later = make('button', 'callback-later', 'Not now');
        later.type = 'button';
        actions.appendChild(submit);
        actions.appendChild(later);
        card.appendChild(actions);

        later.addEventListener('click', function () { card.remove(); });

        card.addEventListener('submit', function (e) {
            e.preventDefault();
            error.textContent = '';
            var raw = phone.value.trim();
            if (!raw) { error.textContent = 'Please enter your phone number.'; phone.focus(); return; }
            if (!consent.checked) { error.textContent = 'Please tick the box so we can contact you.'; return; }

            submit.disabled = true;
            postJson('/leads', {
                widget_key: KEY,
                session_id: state.sessionId,
                name: name.value.trim(),
                // The server treats numbers without a +country code as Indian (+91)
                phone: raw,
                consent: true
            }).then(function () {
                var thanks = make('div', 'msg callback-card callback-done');
                thanks.appendChild(make('p', 'callback-title', 'Thanks! Our team will call you soon.'));
                card.replaceWith(thanks);
                scrollToBottom();
            }).catch(function (err) {
                submit.disabled = false;
                error.textContent = err.status === 422
                    ? 'Please check the phone number and try again.'
                    : "Sorry, that didn't go through. Please try again.";
            });
        });

        el.messages.appendChild(card);
        scrollToBottom();
    }

    // --- Welcome screen ---

    function showWelcome() {
        clearMessages();
        var welcome = make('div', 'welcome msg');
        welcome.appendChild(make('h1', null, config.welcomeTitle));
        if (config.greeting) welcome.appendChild(make('p', null, config.greeting));

        if (config.quickReplies && config.quickReplies.length) {
            var grid = make('div', 'quick-replies');
            config.quickReplies.forEach(function (qr) {
                var btn = make('button', 'quick-reply');
                btn.type = 'button';
                if (QUICK_REPLY_ICONS[qr.icon]) btn.dataset.icon = qr.icon;  // picks the icon colour in theme.css
                btn.innerHTML = QUICK_REPLY_ICONS[qr.icon] || QUICK_REPLY_ICONS.sparkle;
                btn.appendChild(document.createTextNode(qr.label));
                btn.addEventListener('click', function () { sendMessage(qr.message || qr.label); });
                grid.appendChild(btn);
            });
            welcome.appendChild(grid);
        }
        el.messages.appendChild(welcome);
    }

    function removeWelcome() {
        var welcome = el.messages.querySelector('.welcome');
        if (welcome) welcome.remove();
    }

    // --- Sending ---

    function updateSendButton() {
        el.send.disabled = state.sending || !el.input.value.trim();
    }

    function autosize() {
        el.input.style.height = 'auto';
        el.input.style.height = Math.min(el.input.scrollHeight, 96) + 'px';
    }

    function sendMessage(text) {
        text = text.trim();
        if (!text || state.sending) return;

        state.sending = true;
        updateSendButton();
        removeWelcome();
        addUserMessage(text);
        el.input.value = '';
        autosize();
        showTyping();

        var request = postJson('/chat', {
            session_id: state.sessionId,
            message: text,
            widget_key: KEY,
            origin: hostOrigin
        });

        Promise.all([request, delay(MIN_TYPING_MS)])
            .then(function (results) {
                var data = results[0];
                hideTyping();
                setSession(data.session_id);
                addBotMessage({ id: data.message_id, content: data.response, sources: data.sources });
                if (data.offer_callback) showCallbackCard();
            })
            .catch(function (err) {
                hideTyping();
                addBotMessage({
                    content: err.status === 429
                        ? "You're sending messages quite quickly. Please wait a moment and try again."
                        : "Sorry, I'm having trouble connecting right now. Please try again in a moment."
                });
            })
            .then(function () {
                state.sending = false;
                updateSendButton();
            });
    }

    // --- Conversations ---

    function startNewChat() {
        setSession('');
        showWelcome();
        closeHistory();
        el.input.focus();
    }

    function loadConversation(id) {
        return api('/conversations/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(KEY))
            .then(function (data) {
                setSession(id);
                clearMessages();
                data.messages.forEach(function (m) {
                    if (m.role === 'user') addUserMessage(m.content);
                    else addBotMessage(m);
                });
            })
            .catch(function (err) {
                if (err.status === 404) forgetConversation(id);
                showWelcome();
            });
    }

    // --- History view ---

    var timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    var weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
    var dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

    function startOfDay(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    }

    function whenLabel(date) {
        var days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
        if (days === 0) return timeFormat.format(date);
        if (days === 1) return 'Yesterday';
        if (days < 7) return weekdayFormat.format(date);
        return dateFormat.format(date);
    }

    function renderHistory(items) {
        el.historyList.textContent = '';
        if (!items.length) {
            el.historyList.appendChild(make('p', 'history-empty', 'No earlier chats yet.'));
            return;
        }
        var today = startOfDay(new Date());
        var lastGroup = null;
        items.forEach(function (item) {
            var date = new Date(item.last_message_at);
            var group = startOfDay(date) === today ? 'Today' : 'Earlier';
            if (group !== lastGroup) {
                el.historyList.appendChild(make('h2', 'history-group', group));
                lastGroup = group;
            }

            var btn = make('button', 'history-item');
            btn.type = 'button';
            var text = make('span', 'history-text');
            text.appendChild(make('span', 'history-item-title', item.title || 'Conversation'));
            var count = item.message_count + (item.message_count === 1 ? ' message' : ' messages');
            text.appendChild(make('span', 'history-item-meta', whenLabel(date) + ' · ' + count));
            btn.appendChild(text);

            if (item.session_id === state.sessionId) {
                btn.appendChild(make('span', 'history-current', 'Current'));
            } else {
                btn.insertAdjacentHTML('beforeend', CHEVRON_ICON);
            }
            btn.addEventListener('click', function () {
                if (item.session_id === state.sessionId) {
                    closeHistory();
                    return;
                }
                loadConversation(item.session_id).then(closeHistory);
            });
            el.historyList.appendChild(btn);
        });
    }

    function openHistory() {
        el.historyList.textContent = '';
        el.historyList.appendChild(make('p', 'history-empty', 'Loading…'));
        setHistoryOpen(true);

        postJson('/conversations/summaries', { widget_key: KEY, ids: state.history })
            .then(function (items) {
                // Drop ids the server no longer knows (deleted or from another client)
                var known = items.map(function (i) { return i.session_id; });
                state.history = state.history.filter(function (id) { return known.indexOf(id) !== -1; });
                save(STORE_HISTORY, state.history);
                updateHistoryButton();
                renderHistory(items);
            })
            .catch(function () {
                el.historyList.textContent = '';
                el.historyList.appendChild(make('p', 'history-empty', "Couldn't load your chats. Please try again."));
            });
    }

    function closeHistory() {
        setHistoryOpen(false);
    }

    function setHistoryOpen(open) {
        el.app.classList.toggle('history-open', open);
        el.historyView.inert = !open;
        el.historyView.setAttribute('aria-hidden', String(!open));
        el.chatView.inert = open;
        if (open) document.getElementById('btn-back').focus();
    }

    // --- Wiring ---

    function renderBrand() {
        if (config.logoUrl) {
            var img = make('img', 'brand-logo');
            img.src = config.logoUrl;
            img.alt = config.botName;
            el.brandMark.appendChild(img);
        } else {
            el.brandMark.appendChild(make('span', 'brand-name', config.botName));
        }
        if (config.privacyUrl) {
            var link = make('a', null, 'Privacy');
            link.href = config.privacyUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            el.privacy.appendChild(document.createTextNode(' · '));
            el.privacy.appendChild(link);
        }
        el.input.placeholder = 'Ask about ' + config.clientName + '…';
        el.input.maxLength = config.maxMessageChars;
    }

    el.composer.addEventListener('submit', function (e) {
        e.preventDefault();
        sendMessage(el.input.value);
    });

    el.input.addEventListener('input', function () {
        autosize();
        updateSendButton();
    });

    el.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            sendMessage(el.input.value);
        }
    });

    document.getElementById('btn-new').addEventListener('click', startNewChat);
    document.getElementById('btn-new-from-history').addEventListener('click', startNewChat);
    document.getElementById('btn-back').addEventListener('click', closeHistory);
    document.getElementById('btn-close').addEventListener('click', function () { notifyHost('close'); });
    el.historyBtn.addEventListener('click', openHistory);

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (el.app.classList.contains('history-open')) closeHistory();
        else notifyHost('close');
    });

    window.addEventListener('message', function (e) {
        if (e.source !== window.parent || !e.data || !e.data.widgetbot) return;
        document.documentElement.classList.toggle('fullscreen', !!e.data.fullscreen);
        // Focus the input on desktop only; on phones it would pop the keyboard over the welcome screen
        if (e.data.widgetbot === 'opened' && window.matchMedia('(pointer: fine)').matches) el.input.focus();
    });

    renderBrand();
    updateHistoryButton();
    if (state.sessionId) loadConversation(state.sessionId);
    else showWelcome();
    notifyHost('ready');
})();
