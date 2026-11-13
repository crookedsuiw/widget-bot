// JSON calls to /admin/api. A 401 means the session ended, so go back to the login page.

export class ApiError extends Error {
    constructor(status, detail, fieldErrors = []) {
        super(detail || `Request failed (${status})`);
        this.status = status;
        this.fieldErrors = fieldErrors;  // FastAPI validation errors: [{loc: ['body', 'fields', 'persona'], msg}]
    }
}

async function request(method, url, body) {
    const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        location.href = '/admin/login?next=' + encodeURIComponent(location.pathname + location.search);
        throw new ApiError(401, 'Not logged in');
    }
    if (!res.ok) {
        let detail;
        try { detail = (await res.json()).detail; } catch { /* not JSON */ }
        if (Array.isArray(detail)) throw new ApiError(res.status, 'Please fix the highlighted fields.', detail);
        throw new ApiError(res.status, typeof detail === 'string' ? detail : undefined);
    }
    return res.json();
}

export const api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
    put: (url, body) => request('PUT', url, body),
    patch: (url, body) => request('PATCH', url, body),
    delete: (url) => request('DELETE', url),
};
