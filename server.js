/**
 * Backend proxy pre Platformu úhrady.
 * Preposiela požiadavky na KROS OpenAPI s Bearer tokenom; frontend nemusí riešiť CORS.
 */

import express from 'express';
import multer from 'multer';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import * as XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_API_BASE = process.env.KROS_API_BASE_URL || 'https://esw-testlab-openapigateway-api.azurewebsites.net';
const PORT = process.env.PORT || 3000;

const app = express();

// CORS – umožní volať API aj keď je stránka otvorená z inej adresy alebo zo súboru
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Kros-Base-URL');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Statické súbory (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Kontrola, či beží náš server (pred proxy)
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, message: 'Platforma úhrady – server beží.' });
});

// Import dokladov zo XLSX (štruktúra ako import_dokladov_example.xlsx)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const COL = {
  druhDokladu: 0,
  cisloDokladu: 3,
  partner: 8,
  datumVystavenia: 21,
  datumSplatnosti: 22,
  naUhradu: 30,
  mena: 31,
  vs: 37,
};

function excelDateToISO(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const d = new Date((n - 25569) * 86400 * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function parseImportXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', rawNumbers: true });
  if (rows.length < 2) return [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const druh = String(row[COL.druhDokladu] ?? '').trim();
    const cislo = row[COL.cisloDokladu] != null ? String(row[COL.cisloDokladu]) : '';
    const partnerName = String(row[COL.partner] ?? '').trim();
    const naUhraduRaw = row[COL.naUhradu];
    const num = Number(naUhraduRaw);
    if (!Number.isFinite(num) || num === 0) continue;
    const isDosla = /došlá\s*faktúra/i.test(druh);
    const sumForPayment = isDosla ? -1 * num : num;
    const issueDate = excelDateToISO(row[COL.datumVystavenia]) || new Date().toISOString().slice(0, 10);
    const dueDate = excelDateToISO(row[COL.datumSplatnosti]) || issueDate;
    const mena = (String(row[COL.mena] ?? 'EUR').trim()) || 'EUR';
    const vs = row[COL.vs] != null ? String(row[COL.vs]).trim() : '';
    out.push({
      id: 'import-' + i,
      documentNumber: cislo,
      numberingSequence: '',
      issueDate,
      dueDate,
      variableSymbol: vs,
      partner: { address: { businessName: partnerName } },
      sumForPayment,
      sumOfPayments: 0,
      prices: {
        currency: mena,
        documentPrices: { totalPriceInclVat: sumForPayment },
        legislativePrices: { totalPriceInclVat: sumForPayment },
      },
    });
  }
  return out;
}

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

app.post('/api/import/invoices', upload.single('file'), (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'Chýba súbor. Vyberte XLSX súbor.' });
  }
  try {
    const sequence = req.query.NumberingSequence || req.query.numberingSequence || req.query.sequence || '';
    const data = filterByNumberingSequence(parseImportXlsx(req.file.buffer), sequence);
    res.json({ data });
  } catch (err) {
    res.status(400).json({ error: 'Nepodarilo sa spracovať súbor: ' + (err.message || String(err)) });
  }
});

// Reštart služby (iba z localhostu) – spustí nový Node s server.js v priečinku servera
app.post('/api/restart', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const localhost = /^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/i.test(ip);
  if (!localhost) {
    return res.status(403).json({ error: 'Reštart je povolený len z localhostu.' });
  }
  res.status(202).json({ message: 'Reštartujem službu…' });
  const scriptPath = path.join(__dirname, 'server.js');
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
});

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

app.get('/api/invoices', async (req, res) => {
  const token = req.headers.authorization;
  const baseUrl = (req.headers['x-kros-base-url'] || DEFAULT_API_BASE).replace(/\/$/, '');
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Chýba Authorization hlavička (Bearer token).' });
  }

  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (value == null || value === '') continue;
      if (Array.isArray(value)) {
        value.forEach((v) => {
          if (v != null && v !== '') params.append(key, String(v));
        });
      } else {
        params.set(key, String(value));
      }
    }

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

    const rawSequence = req.query.NumberingSequence || req.query.numberingSequence || req.query.sequence || '';
    if (Array.isArray(payload?.data)) {
      payload.data = filterByNumberingSequence(payload.data, rawSequence);
    }
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
    console.log(`Platforma úhrady beží na http://localhost:${PORT}`);
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
