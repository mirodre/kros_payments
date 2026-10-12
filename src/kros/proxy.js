/** Proxy na KROS Open API s tokenom prepojenia vybraného cez X-Kros-Connection. */
import { Router } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { decrypt } from '../crypto.js';
import { findConnection, setConnectionInvalid, UUID_RE } from '../repos.js';

function normalizeSequence(value) {
  return String(value ?? '').trim().toLowerCase();
}

function filterByNumberingSequence(items, rawSequence) {
  const sequence = normalizeSequence(rawSequence);
  if (!sequence) return items;
  return items.filter((item) => {
    const current = normalizeSequence(item?.numberingSequence);
    return current.includes(sequence);
  });
}

function normalizeYmdDate(value) {
  const s = String(value ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  return s;
}

function readDateRange(query) {
  return {
    from: normalizeYmdDate(query.DateFrom || query.dateFrom || query.from || ''),
    to: normalizeYmdDate(query.DateTo || query.dateTo || query.to || ''),
  };
}

function filterByDateRange(items, dateRange, getItemDate) {
  if (!Array.isArray(items)) return [];
  if (!dateRange.from && !dateRange.to) return items;
  return items.filter((item) => {
    const date = normalizeYmdDate(getItemDate(item));
    if (!date) return false;
    if (dateRange.from && date < dateRange.from) return false;
    if (dateRange.to && date > dateRange.to) return false;
    return true;
  });
}

function parsePositiveInt(value, fallback, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

const MAX_FILTER_SCAN_PAGES = 8;

function buildForwardParams(query, excludedKeys = []) {
  const excluded = new Set(excludedKeys.map((k) => String(k).toLowerCase()));
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (excluded.has(String(key).toLowerCase())) continue;
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (v != null && v !== '') params.append(key, String(v));
      });
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

// Dedikovaná obsluha POST /api/payments/batch – 3 pokusy s backoff pri 408/timeout
const PAYMENTS_BATCH_TIMEOUT_MS = 180000; // 180 s
const RETRY_DELAYS_MS = [10000, 20000]; // po 1. chybe čakaj 10 s, po 2. chybe čakaj 20 s

function callKrosPaymentsBatch(url, token, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PAYMENTS_BATCH_TIMEOUT_MS);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
    },
    body: body.length ? body : undefined,
    signal: controller.signal,
  })
    .then((krosRes) => {
      clearTimeout(timeoutId);
      return krosRes;
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      throw err;
    });
}

/** 401 z KROS = token firmy neplatný; úspech po predchádzajúcej chybe stav vyčistí. */
function trackKrosStatus(db, req, status) {
  const conn = req.krosConnection;
  if (!conn) return;
  if (status === 401) {
    setConnectionInvalid(db, conn.id, true).catch(() => {});
  } else if (status >= 200 && status < 300 && conn.invalidAt) {
    setConnectionInvalid(db, conn.id, false).catch(() => {});
  }
}

function sendKrosError(res, krosRes, text) {
  const contentType = krosRes.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  // Pri 429 KROS hovorí, koľko sekúnd počkať – klient podľa toho opakuje požiadavku
  const retryAfter = krosRes.headers.get('retry-after');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);
  return res.status(krosRes.status).send(text);
}

export function createKrosProxyRouter({ config, db }) {
  const router = Router();
  const baseUrl = config.krosApiBase;

  router.use(async (req, res, next) => {
    try {
      const id = req.get('x-kros-connection');
      if (!id || !UUID_RE.test(id)) {
        return res.status(400).json({ error: 'connection_required', message: 'Vyberte firmu (chýba prepojenie s KROS).' });
      }
      const conn = await findConnection(db, req.organizationId, id);
      if (!conn) return res.status(404).json({ error: 'connection_not_found', message: 'Prepojenie s firmou neexistuje.' });
      try {
        req.krosToken = `Bearer ${decrypt(conn.tokenEnc, config.encryptionKey)}`;
      } catch {
        await setConnectionInvalid(db, conn.id, true);
        return res.status(409).json({ error: 'connection_invalid', message: 'Prepojenie s firmou je neplatné, prepojte ju znova.' });
      }
      req.krosConnection = conn;
      next();
    } catch (err) {
      next(err);
    }
  });

  router.post('/payments/batch', (req, res) => {
    const token = req.krosToken;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', (err) => {
      res.status(400).json({ error: 'Chyba čítania tela: ' + err.message });
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = baseUrl + '/api/payments/batch';
      let responseSent = false;

      function sendResponse(krosRes, text) {
        if (responseSent) return;
        responseSent = true;
        trackKrosStatus(db, req, krosRes.status);
        res.status(krosRes.status);
        const contentType = krosRes.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        // Pri 429 KROS hovorí, koľko sekúnd počkať – klient podľa toho opakuje požiadavku
        const retryAfter = krosRes.headers.get('retry-after');
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        res.send(text);
      }

      function send408() {
        if (responseSent) return;
        responseSent = true;
        res.status(408).json({
          error: 'Vypršal časový limit (408). KROS API neodpovedalo ani po 3 pokusoch. Skúste to neskôr alebo kontaktujte podporu KROS.',
        });
      }

      function send502(err) {
        if (responseSent) return;
        responseSent = true;
        res.status(502).json({ error: 'Chyba volania KROS API: ' + (err.message || String(err)) });
      }

      function doAttempt(attemptIndex) {
        callKrosPaymentsBatch(url, token, body)
          .then((krosRes) => krosRes.text().then((text) => ({ krosRes, text })))
          .then(({ krosRes, text }) => {
            if (krosRes.status === 408 && attemptIndex < 2) {
              const delay = RETRY_DELAYS_MS[attemptIndex] || 10000;
              setTimeout(() => doAttempt(attemptIndex + 1), delay);
            } else {
              sendResponse(krosRes, text);
            }
          })
          .catch((err) => {
            if ((err.name === 'AbortError' || err.message?.includes('timeout')) && attemptIndex < 2) {
              const delay = RETRY_DELAYS_MS[attemptIndex] || 10000;
              setTimeout(() => doAttempt(attemptIndex + 1), delay);
            } else if (err.name === 'AbortError') {
              send408();
            } else {
              send502(err);
            }
          });
      }

      doAttempt(0);
    });
  });

  router.get('/payments', async (req, res) => {
    const token = req.krosToken;
    try {
      const dateRange = readDateRange(req.query);
      const params = buildForwardParams(req.query, ['DateFrom', 'dateFrom', 'from', 'DateTo', 'dateTo', 'to']);
      const url = `${baseUrl}/api/payments${params.toString() ? `?${params.toString()}` : ''}`;
      const krosRes = await fetch(url, {
        method: 'GET',
        headers: { Authorization: token },
      });
      trackKrosStatus(db, req, krosRes.status);
      const text = await krosRes.text();
      if (!krosRes.ok) return sendKrosError(res, krosRes, text);

      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (_) {
        return res.status(502).json({ error: 'Neplatná JSON odpoveď z KROS API pre /api/payments.' });
      }

      if (Array.isArray(payload)) {
        const rawCount = payload.length;
        const filtered = filterByDateRange(payload, dateRange, (item) => item?.dateOfPayment);
        return res.json({ data: filtered, meta: { rawCount } });
      }

      if (Array.isArray(payload?.data)) {
        const rawCount = payload.data.length;
        payload.data = filterByDateRange(payload.data, dateRange, (item) => item?.dateOfPayment);
        payload.meta = { ...(payload.meta || {}), rawCount };
      } else if (Array.isArray(payload?.items)) {
        const rawCount = payload.items.length;
        payload.items = filterByDateRange(payload.items, dateRange, (item) => item?.dateOfPayment);
        payload.meta = { ...(payload.meta || {}), rawCount };
      } else if (Array.isArray(payload?.payments)) {
        const rawCount = payload.payments.length;
        payload.payments = filterByDateRange(payload.payments, dateRange, (item) => item?.dateOfPayment);
        payload.meta = { ...(payload.meta || {}), rawCount };
      }
      return res.json(payload);
    } catch (err) {
      return res.status(502).json({ error: 'Chyba volania KROS API: ' + (err.message || String(err)) });
    }
  });

  router.get('/invoices', async (req, res) => {
    const token = req.krosToken;
    try {
      const rawSequence = req.query.NumberingSequence || req.query.numberingSequence || req.query.sequence || '';
      const dateRange = readDateRange(req.query);
      const usesExtraFiltering = Boolean(rawSequence || dateRange.from || dateRange.to);
      const requestedTop = parsePositiveInt(req.query.Top, 100, 500);
      const requestedSkip = parsePositiveInt(req.query.Skip, 0, 1000000);
      const targetCount = requestedSkip + requestedTop + 1;
      const upstreamTop = 100;
      let upstreamSkip = 0;
      let firstPayload = null;
      const filtered = [];
      let scannedPages = 0;

      while (filtered.length < targetCount) {
        const params = buildForwardParams(req.query, [
          'Top',
          'Skip',
          'NumberingSequence',
          'numberingSequence',
          'sequence',
        ]);
        params.set('Top', String(upstreamTop));
        params.set('Skip', String(upstreamSkip));

        const url = `${baseUrl}/api/invoices${params.toString() ? `?${params.toString()}` : ''}`;
        const krosRes = await fetch(url, {
          method: 'GET',
          headers: { Authorization: token },
        });
        trackKrosStatus(db, req, krosRes.status);
        const text = await krosRes.text();
        if (!krosRes.ok) return sendKrosError(res, krosRes, text);

        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (_) {
          return res.status(502).json({ error: 'Neplatná JSON odpoveď z KROS API pre /api/invoices.' });
        }
        if (!firstPayload) firstPayload = payload;
        const batch = Array.isArray(payload?.data) ? payload.data : [];
        const filteredBatch = filterByDateRange(
          filterByNumberingSequence(batch, rawSequence),
          dateRange,
          (item) => item?.issueDate,
        );
        filtered.push(...filteredBatch);
        scannedPages += 1;

        if (batch.length < upstreamTop) break;
        if (usesExtraFiltering && scannedPages >= MAX_FILTER_SCAN_PAGES) break;
        upstreamSkip += upstreamTop;
      }

      const payload = (firstPayload && typeof firstPayload === 'object') ? { ...firstPayload } : {};
      payload.data = filtered.slice(requestedSkip, requestedSkip + requestedTop);
      payload.meta = {
        ...(payload.meta || {}),
        serverFiltered: true,
        scannedPages,
        scanCapped: usesExtraFiltering && scannedPages >= MAX_FILTER_SCAN_PAGES && filtered.length < targetCount,
      };
      return res.json(payload);
    } catch (err) {
      return res.status(502).json({ error: 'Chyba volania KROS API: ' + (err.message || String(err)) });
    }
  });

  // Ostatné /api požiadavky idú priamo na KROS.
  router.use(createProxyMiddleware({
    target: baseUrl,
    changeOrigin: true,
    // KROS API môže odpovedať pomaly (asynchrónne spracovanie) – čakáme až 90 s na odpoveď
    proxyTimeout: 90000,
    // Router je pod /api, req.url je časť za /api (napr. /auth/check). KROS očakáva /api/auth/check.
    pathRewrite: (p) => '/api' + p,
    on: {
      proxyReq(proxyReq, req) {
        proxyReq.setHeader('authorization', req.krosToken);
        for (const h of ['cookie', 'origin', 'referer', 'x-kros-connection', 'x-kros-base-url']) proxyReq.removeHeader(h);
      },
      proxyRes(proxyRes, req) {
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['set-cookie'];
        trackKrosStatus(db, req, proxyRes.statusCode);
      },
      error(err, req, res) {
        if (typeof res.status === 'function' && !res.headersSent) res.status(502).json({ error: 'Chyba proxy: ' + err.message });
      },
    },
  }));

  return router;
}
