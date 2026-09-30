// JSON API access. Errors are converted into operator-readable messages; the
// technical detail stays in the server log.

let clockSkewMs = 0;

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

function friendlyMessage(status, detail) {
    if (status === 400 || status === 404) return detail || 'The request was not valid.';
    if (status === 503) return 'The dashboard cannot read the database right now.';
    return `The dashboard server returned an error (${status}).`;
}

export async function api(path, { signal } = {}) {
    let response;
    try {
        response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new ApiError('The dashboard server cannot be reached. Check the network connection.', 0);
    }
    // Ages ("12 s ago") are measured against the server clock, not the browser's.
    const serverDate = response.headers.get('Date');
    if (serverDate) clockSkewMs = new Date(serverDate).getTime() - Date.now();
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(friendlyMessage(response.status, body.error), response.status);
    return body;
}

export function serverNow() {
    return Date.now() + clockSkewMs;
}

export function query(values) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
        if (value !== '' && value !== null && value !== undefined) params.set(key, value);
    }
    const text = params.toString();
    return text ? `?${text}` : '';
}

export function devicePath(deviceId, suffix = '') {
    return `/api/devices/${encodeURIComponent(deviceId)}${suffix}`;
}

export const isAbort = (error) => error?.name === 'AbortError';
