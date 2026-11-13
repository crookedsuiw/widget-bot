(function () {
    'use strict';
    var form = document.getElementById('login-form');
    var error = document.getElementById('login-error');

    // Only same-site paths are followed after login, so the ?next= link can't send people elsewhere
    function nextPath() {
        var next = new URLSearchParams(location.search).get('next') || '';
        return /^\/admin\/[a-z-]/.test(next) ? next : '/admin/';
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        error.textContent = '';
        var button = form.querySelector('button');
        button.disabled = true;
        fetch('/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: form.username.value, password: form.password.value })
        }).then(function (res) {
            if (res.ok) {
                location.href = nextPath();
                return;
            }
            button.disabled = false;
            error.textContent = res.status === 429
                ? 'Too many failed attempts. Try again in 15 minutes.'
                : 'Wrong username or password.';
            form.password.value = '';
            form.password.focus();
        }).catch(function () {
            button.disabled = false;
            error.textContent = "Couldn't reach the server. Please try again.";
        });
    });
})();
