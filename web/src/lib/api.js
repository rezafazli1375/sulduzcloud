function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

let csrfToken = readCookie('sc_csrf');

export function setCsrfToken(token) {
  csrfToken = token || readCookie('sc_csrf');
}

export function refreshCsrfFromCookie() {
  csrfToken = readCookie('sc_csrf');
  return csrfToken;
}

export class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message || 'Request failed');
    this.code = code || 'error';
    this.status = status || 0;
    this.details = details;
  }
}

const listeners = new Set();
export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitUnauthorized() {
  for (const fn of listeners) {
    try { fn(); } catch (_) {}
  }
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...headers },
    signal,
  };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
    opts.headers['X-CSRF-Token'] = csrfToken || readCookie('sc_csrf');
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (err) {
    throw new ApiError('اتصال به سرور برقرار نشد / Cannot reach the server', 'network', 0);
  }
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/setup')) {
    emitUnauthorized();
  }
  if (!res.ok || (json && json.ok === false)) {
    const error = (json && json.error) || {};
    throw new ApiError(error.message || `HTTP ${res.status}`, error.code || 'error', res.status, error.details);
  }
  return json ? json.data : null;
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
  upload: (path, formData) => request(path, { method: 'POST', body: formData }),
  raw: request,
};

export function downloadFile(path, filename) {
  const link = document.createElement('a');
  link.href = `/api${path}`;
  if (filename) link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
