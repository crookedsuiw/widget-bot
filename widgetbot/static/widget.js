/*
 * widgetbot embed loader. Clients add:
 *   <script src="https://<host>/widget.js" data-key="<widget_key>" async></script>
 *
 * Only the launcher button lives on the host page (inside a shadow root so neither page's CSS
 * leaks into the other). The chat panel is an iframe created on the first click.
 */
(function () {
    if (window.__widgetbotLoaded) return;
    window.__widgetbotLoaded = true;

    var script = document.currentScript;
    var widgetKey = script && script.getAttribute('data-key');
    if (!widgetKey) {
        console.warn('[widgetbot] widget.js needs a data-key attribute');
        return;
    }
    var base = new URL(script.src).origin;
    // Matches the full-screen rule in CSS below; the panel is told so it can show its own close button
    var fullscreenQuery = window.matchMedia('(max-width: 480px)');
    var panelUrl = base + '/widget?key=' + encodeURIComponent(widgetKey) +
        '&origin=' + encodeURIComponent(location.origin) +
        '&fs=' + (fullscreenQuery.matches ? 1 : 0);

    // Launcher and panel-frame colours. These run on the client's page, outside the iframe, so they
    // can't read static/widget/theme.css: keep them in step with --accent-gradient, --accent and --panel-bg there.
    var THEME = {
        launcherBg: 'linear-gradient(135deg,#1EC8E6 0%,#8B5CF6 100%)',
        launcherShadow: '0 10px 24px -8px rgba(124,58,237,.55)',
        launcherIcon: '#fff',
        focusRing: '#8B5CF6',
        panelBorder: '#fff',
        panelBg: 'linear-gradient(135deg,#E8F8FC 0%,#F2EEFA 55%,#FBEFEA 100%)',
        panelShadow: '0 24px 48px -16px rgba(31,37,51,.18),0 2px 6px rgba(31,37,51,.06)'
    };

    var CHAT_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>';
    var CLOSE_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

    // Only transform and opacity animate, so the browser can run them on the compositor
    var CSS = [
        ':host{all:initial}',
        '.launcher{position:fixed;right:24px;bottom:24px;z-index:2147483000;width:56px;height:56px;padding:0;border:0;border-radius:50%;cursor:pointer;',
        'background:' + THEME.launcherBg + ';box-shadow:' + THEME.launcherShadow + ';color:' + THEME.launcherIcon + ';',
        'display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.2,.8,.2,1);-webkit-tap-highlight-color:transparent}',
        '.launcher:hover{transform:scale(1.06)}',
        '.launcher:active{transform:scale(.96)}',
        '.launcher:focus-visible{outline:3px solid ' + THEME.focusRing + ';outline-offset:3px}',
        '.icon{position:absolute;display:flex;transition:opacity .2s ease,transform .22s cubic-bezier(.2,.8,.2,1)}',
        '.icon-close{opacity:0;transform:rotate(-90deg) scale(.6)}',
        '.open .icon-chat{opacity:0;transform:rotate(90deg) scale(.6)}',
        '.open .icon-close{opacity:1;transform:none}',
        '.panel{position:fixed;right:24px;bottom:96px;z-index:2147483000;width:380px;height:min(600px,calc(100vh - 120px));',
        'border-radius:28px;overflow:hidden;border:1px solid ' + THEME.panelBorder + ';box-sizing:border-box;',
        'background:' + THEME.panelBg + ';',
        'box-shadow:' + THEME.panelShadow + ';',
        'transform-origin:bottom right;opacity:0;transform:translateY(12px) scale(.96);visibility:hidden;',
        'transition:opacity .22s cubic-bezier(.2,.8,.2,1),transform .22s cubic-bezier(.2,.8,.2,1),visibility 0s linear .22s}',
        '.panel.open{opacity:1;transform:none;visibility:visible;transition-delay:0s}',
        '.panel iframe{width:100%;height:100%;border:0;display:block;background:transparent}',
        // Phones: the panel fills the screen and the iframe shows its own close button
        '@media (max-width:480px){.panel{inset:0;width:auto;height:auto;border-radius:0;border:0;transform-origin:bottom center}.launcher.open{opacity:0;pointer-events:none}}',
        '@media (prefers-reduced-motion:reduce){.panel,.icon,.launcher{transition:opacity .15s linear,visibility 0s linear .15s}.panel{transform:none}}'
    ].join('');

    var host = document.createElement('div');
    host.setAttribute('data-widgetbot', '');
    var root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' +
        '<div class="panel" role="dialog" aria-label="Chat with us" aria-hidden="true"></div>' +
        '<button class="launcher" type="button" aria-label="Open chat" aria-expanded="false">' +
        '<span class="icon icon-chat">' + CHAT_ICON + '</span><span class="icon icon-close">' + CLOSE_ICON + '</span></button>';

    var panel = root.querySelector('.panel');
    var launcher = root.querySelector('.launcher');
    var iframe = null;
    var isOpen = false;
    var warmed = false;

    // Hovering warms the panel page so the first open feels instant
    function warm() {
        if (warmed) return;
        warmed = true;
        var link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = panelUrl;
        document.head.appendChild(link);
    }

    function ensureIframe() {
        if (iframe) return;
        iframe = document.createElement('iframe');
        iframe.src = panelUrl;
        iframe.title = 'Chat assistant';
        iframe.setAttribute('allow', 'clipboard-write');
        panel.appendChild(iframe);
    }

    function post(type) {
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage({ widgetbot: type, fullscreen: fullscreenQuery.matches }, base);
        }
    }

    fullscreenQuery.addEventListener('change', function () { post('layout'); });

    function setOpen(open) {
        if (open === isOpen) return;
        isOpen = open;
        if (open) ensureIframe();
        panel.classList.toggle('open', open);
        launcher.classList.toggle('open', open);
        panel.setAttribute('aria-hidden', String(!open));
        launcher.setAttribute('aria-expanded', String(open));
        launcher.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
        if (open) {
            post('opened');
            iframe.focus();
        } else {
            launcher.focus();
        }
    }

    launcher.addEventListener('click', function () { setOpen(!isOpen); });
    launcher.addEventListener('pointerenter', warm, { once: true });
    launcher.addEventListener('focus', warm, { once: true });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && isOpen) setOpen(false);
    });

    // The panel asks to close (its close button on phones, or Escape pressed inside it)
    window.addEventListener('message', function (e) {
        if (e.origin !== base || !iframe || e.source !== iframe.contentWindow) return;
        if (e.data && e.data.widgetbot === 'close') setOpen(false);
        if (e.data && e.data.widgetbot === 'ready' && isOpen) post('opened');
    });

    (document.body || document.documentElement).appendChild(host);
})();
