/**
 * Volania KROS Open API zo servera (bez používateľa). Sekvenčne s odstupom kvôli limitu
 * 10 req/s a 300 req/min, pri 429 čaká podľa Retry-After.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const MAX_429_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 90_000;

export class KrosError extends Error {
  constructor(status, body, message) {
    super(message || `KROS API vrátilo ${status}`);
    this.status = status;
    this.body = body;
  }

  /** Dočasná chyba – má zmysel skúsiť znova neskôr. */
  get transient() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

function describeBody(body) {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 500) : '';
  const errors = body.errors || body.validationResult?.errors;
  if (errors) return JSON.stringify(errors).slice(0, 500);
  return [body.title, body.detail, body.error, body.message].filter(Boolean).join(' – ').slice(0, 500);
}

export function createKrosClient({ baseUrl, token, fetchImpl = fetch, delayMs = 250, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastCallAt = 0;

  async function request(method, path, { query, body } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const gap = lastCallAt + delayMs - Date.now();
      if (gap > 0) await wait(gap);
      lastCallAt = Date.now();
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new KrosError(0, null, `Chyba spojenia s KROS: ${err.message}`);
      }
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await wait((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5 * (attempt + 1)) * 1000);
        continue;
      }
      if (!res.ok) {
        const detail = describeBody(parsed);
        throw new KrosError(res.status, parsed, `KROS ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      return parsed;
    }
  }

  function listFrom(payload) {
    if (Array.isArray(payload)) return payload;
    return payload?.data || payload?.items || payload?.payments || [];
  }

  return {
    get: (path, query) => request('GET', path, { query }),

    /** Všetky stránky zoznamu (Top/Skip). */
    async getAll(path, query = {}) {
      const all = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = listFrom(await request('GET', path, { query: { ...query, Top: PAGE_SIZE, Skip: page * PAGE_SIZE } }));
        all.push(...batch);
        if (batch.length < PAGE_SIZE) return all;
      }
      throw new KrosError(0, null, `Príliš veľa stránok pre ${path} (viac ako ${MAX_PAGES * PAGE_SIZE} záznamov).`);
    },

    async paymentExists(externalId) {
      const list = listFrom(await request('GET', '/api/payments', { query: { ExternalId: externalId, Top: 1 } }));
      return list.some((p) => String(p?.externalId ?? '') === String(externalId));
    },

    postPayments: (data) => request('POST', '/api/payments/batch', { body: { data } }),
  };
}
