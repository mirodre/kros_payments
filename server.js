/**
 * Backend proxy pre Platformu úhrady.
 * Preposiela požiadavky na KROS OpenAPI s Bearer tokenom; frontend nemusí riešiť CORS.
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vždy production Open API (bez prepínania test/prod).
const DEFAULT_API_BASE = 'https://api-economy.kros.sk';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

function normalizeCallbackCompany(company) {
  const companyId = Number(company?.companyId);
  return {
    companyId,
    companyName: String(company?.companyName || ''),
    token: String(company?.token || ''),
    webhookSecret: company?.webhookSecret ? String(company.webhookSecret) : undefined,
  };
}

function parseCallbackCompanies(body) {
  if (!body || typeof body !== 'object') return [];

  // extended: true (qs): data[0][pole]=… → { data: [ { pole: … } ] }
  const nested = body.data;
  if (Array.isArray(nested) && nested.length > 0) {
    return nested
      .map(normalizeCallbackCompany)
      .filter((company) => Number.isFinite(company.companyId) && company.companyName && company.token);
  }

  const grouped = new Map();
  const keyRegex = /^data\[(\d+)\]\[(companyId|companyName|token|webhookSecret)\]$/;
  for (const [key, rawValue] of Object.entries(body)) {
    const match = key.match(keyRegex);
    if (!match) continue;
    const idx = Number(match[1]);
    const field = match[2];
    const current = grouped.get(idx) || {};
    current[field] = String(rawValue ?? '');
    grouped.set(idx, current);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, company]) => normalizeCallbackCompany(company))
    .filter((company) => Number.isFinite(company.companyId) && company.companyName && company.token);
}

function renderKrosCallbackPage(payload) {
  const safePayload = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="sk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dokončujem prepojenie...</title>
  </head>
  <body style="font-family: Inter, Arial, sans-serif; background:#0f1320; color:#eef3ff; margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center;">
    <p>Dokončujem prepojenie s KROS...</p>
    <script>
      try {
        sessionStorage.setItem("kros_post_result", '${safePayload}');
      } catch (error) {
        console.error(error);
      }
      window.location.replace("/?kros_post_result=1");
    </script>
  </body>
</html>`;
}

// CORS – umožní volať API aj keď je stránka otvorená z inej adresy alebo zo súboru
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Kros-Base-URL');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Vyhnúť sa zastaralému app.js v cache (inak ostane connect() s disabled tlačidlom atď.)
app.use((req, res, next) => {
  if (req.method === 'GET' && /\.(?:js|html|webmanifest)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

/** Zápis klientovských debug logov (NDJSON) – musí byť pred express.static. */
const CLIENT_DEBUG_LOG = path.join(__dirname, '.debug-fed1bd.log');
app.post('/api/client-debug', express.json({ limit: '64kb' }), (req, res) => {
  try {
    const line = JSON.stringify({ ...req.body, _receivedAt: Date.now() }) + '\n';
    fs.appendFileSync(CLIENT_DEBUG_LOG, line, 'utf8');
  } catch (err) {
    console.error('client-debug append failed:', err?.message || err);
  }
  res.json({ ok: true });
});

// Statické súbory (frontend)
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('manifest.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    },
  })
);

// Kontrola, či beží náš server (pred proxy)
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, message: 'Financie – server beží.' });
});

app.post('/kros/callback', (req, res) => {
  const state = req.body?.state ? String(req.body.state) : null;
  const companies = parseCallbackCompanies(req.body);
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(renderKrosCallbackPage({ state, companies }));
});

app.get('/kros/callback', (req, res) => {
  res.redirect('/');
});

/* ------------------------------------------------------------------
 * Webhook s výsledkom spracovania platieb (POST /api/payments/batch je
 * asynchrónne – dôvod neúspechu príde až sem). Prijaté payloady držíme
 * v pamäti (posledných MAX) a zároveň ich zapisujeme do NDJSON súboru,
 * frontend si ich vyzdvihne cez GET /api/kros-callbacks.
 * ------------------------------------------------------------------ */
const PAYMENT_CALLBACK_LOG = path.join(__dirname, 'kros-payment-callbacks.log');
const MAX_KEPT_CALLBACKS = 200;
const paymentCallbacks = [];
let paymentCallbackSeq = 0;

function storePaymentCallback(entry) {
  paymentCallbackSeq += 1;
  const stored = { seq: paymentCallbackSeq, receivedAt: new Date().toISOString(), ...entry };
  paymentCallbacks.push(stored);
  if (paymentCallbacks.length > MAX_KEPT_CALLBACKS) paymentCallbacks.shift();
  try {
    fs.appendFileSync(PAYMENT_CALLBACK_LOG, JSON.stringify(stored) + '\n', 'utf8');
  } catch (err) {
    console.error('payment callback append failed:', err?.message || err);
  }
  console.log('[kros-callback] #%d %s', stored.seq, JSON.stringify(stored.body).slice(0, 500));
  return stored;
}

// KROS posiela výsledok sem. Prijímame ľubovoľný content-type aj ľubovoľnú
// podcestu (/kros/payments-callback/xyz), nech sa to nedá pokaziť nastavením.
app.post(
  ['/kros/payments-callback', '/kros/payments-callback/*'],
  express.raw({ type: () => true, limit: '2mb' }),
  (req, res) => {
    // Pozor: urlencoded telo už zjedol globálny parser vyššie – vtedy je req.body objekt.
    let parsed = null;
    let raw = '';
    if (Buffer.isBuffer(req.body)) {
      raw = req.body.toString('utf8');
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch (_) {}
    } else if (req.body && typeof req.body === 'object') {
      parsed = req.body;
    } else {
      raw = String(req.body ?? '');
    }
    storePaymentCallback({
      path: req.originalUrl,
      contentType: req.headers['content-type'] || '',
      headers: {
        // KROS podpisuje telo notifikácie webhook secretom (HMACSHA256, Base64, UTF-16LE).
        'x-kros-signature-256': req.headers['x-kros-signature-256'],
        'user-agent': req.headers['user-agent'],
      },
      body: parsed ?? raw,
      parsed: parsed != null,
    });
    // KROS musí dostať rýchlu 200, inak bude webhook opakovať.
    res.status(200).json({ ok: true });
  }
);

// Rýchla kontrola v prehliadači, či je endpoint dostupný zvonku.
app.get(['/kros/payments-callback', '/kros/payments-callback/*'], (req, res) => {
  res.json({ ok: true, message: 'Webhook endpoint pre výsledky platieb je pripravený (očakáva POST).', received: paymentCallbackSeq });
});

// Frontend si sem chodí po nové callbacky (musí byť pred /api proxy!).
app.get('/api/kros-callbacks', (req, res) => {
  const sinceSeq = Number(req.query.sinceSeq);
  const since = Number.isFinite(sinceSeq) ? sinceSeq : 0;
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    lastSeq: paymentCallbackSeq,
    callbackUrl: `${req.protocol}://${req.get('host')}/kros/payments-callback`,
    items: paymentCallbacks.filter((c) => c.seq > since),
  });
});

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

app.post('/api/payments/batch', (req, res, next) => {
  const token = req.headers.authorization;
  const baseUrl = (req.headers['x-kros-base-url'] || DEFAULT_API_BASE).replace(/\/$/, '');
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chýba Authorization hlavička (Bearer token).' });
  }
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
      res.status(krosRes.status);
      const contentType = krosRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
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

app.get('/api/payments', async (req, res) => {
  const token = req.headers.authorization;
  const baseUrl = (req.headers['x-kros-base-url'] || DEFAULT_API_BASE).replace(/\/$/, '');
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chýba Authorization hlavička (Bearer token).' });
  }

  try {
    const dateRange = readDateRange(req.query);
    const params = buildForwardParams(req.query, ['DateFrom', 'dateFrom', 'from', 'DateTo', 'dateTo', 'to']);
    const url = `${baseUrl}/api/payments${params.toString() ? `?${params.toString()}` : ''}`;
    const krosRes = await fetch(url, {
      method: 'GET',
      headers: { Authorization: token },
    });
    const text = await krosRes.text();
    if (!krosRes.ok) {
      const contentType = krosRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      return res.status(krosRes.status).send(text);
    }

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

app.get('/api/invoices', async (req, res) => {
  const token = req.headers.authorization;
  const baseUrl = (req.headers['x-kros-base-url'] || DEFAULT_API_BASE).replace(/\/$/, '');
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chýba Authorization hlavička (Bearer token).' });
  }

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
      const text = await krosRes.text();
      if (!krosRes.ok) {
        const contentType = krosRes.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        return res.status(krosRes.status).send(text);
      }

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

// Proxy na KROS API – ostatné /api požiadavky (GET atď.)
app.use('/api', (req, res, next) => {
  const token = req.headers.authorization;
  const baseUrl = req.headers['x-kros-base-url'] || DEFAULT_API_BASE;
  const target = baseUrl.replace(/\/$/, '');

  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chýba Authorization hlavička (Bearer token).' });
  }

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    // KROS API môže odpovedať pomaly (asynchrónne spracovanie) – čakáme až 90 s na odpoveď
    proxyTimeout: 90000,
    // V Express pri app.use('/api', ...) je req.url len časť za /api (napr. /auth/check). KROS očakáva /api/auth/check.
    pathRewrite: (path) => '/api' + path,
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader('Authorization', token);
      proxyReq.removeHeader('x-kros-base-url');
    },
    onProxyRes: (proxyRes) => {
      // Odstrániť hlavičky, ktoré môžu spôsobiť problémy
      delete proxyRes.headers['x-frame-options'];
    },
    onError: (err, req, res) => {
      res.status(502).json({ error: 'Chyba proxy: ' + err.message });
    },
  });
  proxy(req, res, next);
});

// JSON body len pre iné cesty (proxy nepotrebuje)
app.use(express.json({ limit: '2mb' }));

// SPA fallback – všetky ostatné cesty na index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let retryTimer = null;
function startServer() {
  const server = app.listen(PORT, () => {
    retryTimer = null;
    console.log(`Financie beží na http://localhost:${PORT}`);
    console.log(`Predvolená KROS API: ${DEFAULT_API_BASE}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !retryTimer) {
      console.log(`Port ${PORT} je obsadený, čakám 2 s a skúšam znova...`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        startServer();
      }, 2000);
    } else {
      throw err;
    }
  });
}
startServer();
