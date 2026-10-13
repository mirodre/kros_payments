/**
 * Falošné KROS Open API: platný token je `Bearer kros-good`.
 * Dáta sa dajú nahradiť cez `setData()`; bez toho vracia pevné ukážky pre proxy testy.
 * Prijaté platby (POST /api/payments/batch) sa pridajú do zoznamu platieb (s externalId),
 * aby fungovala kontrola duplicít cez ExternalId.
 */
import express from 'express';

const DEFAULT_DATA = () => ({
  invoices: [
    { id: 1, issueDate: '2026-01-05', numberingSequence: 'FA' },
    { id: 2, issueDate: '2026-02-05', numberingSequence: 'OF' },
  ],
  expenses: [],
  payments: [{ id: 7, dateOfPayment: '2026-03-01' }],
});

function page(list, query) {
  const top = Number(query.Top ?? query.top ?? 100);
  const skip = Number(query.Skip ?? query.skip ?? 0);
  return list.slice(skip, skip + top);
}

const byModified = (list, query) => {
  const ts = query.LastModifiedTimestamp;
  return ts ? list.filter((x) => !x.lastModifiedTimestamp || x.lastModifiedTimestamp >= ts) : list;
};

export async function startFakeKros() {
  const app = express();
  const requests = [];
  let data = DEFAULT_DATA();
  let nextPaymentId = 1000;
  let nextRequestId = 1;
  const failures = [];

  app.use((req, res, next) => {
    requests.push({ method: req.method, path: req.originalUrl, query: { ...req.query }, headers: { ...req.headers } });
    if (req.get('authorization') !== 'Bearer kros-good') return res.status(401).json({ title: 'Unauthorized' });
    const fail = failures.find((f) => f.method === req.method && req.path === f.path && f.times > 0);
    if (fail) {
      fail.times--;
      return res.status(fail.status).json({ title: `forced ${fail.status}` });
    }
    next();
  });
  app.get('/api/auth/check', (req, res) => res.json({ ok: true }));
  app.get('/api/payments/accounts', (req, res) => {
    res.setHeader('set-cookie', 'kros=1; Path=/');
    res.json({ data: data.accounts || [{ id: 1, name: 'Účet', iban: 'SK00', currency: 'EUR' }] });
  });
  app.get('/api/invoices', (req, res) => res.json({ data: page(byModified(data.invoices, req.query), req.query) }));
  app.get('/api/expenses', (req, res) => res.json({ data: page(byModified(data.expenses, req.query), req.query) }));
  app.get('/api/payments', (req, res) => {
    let list = byModified(data.payments, req.query);
    if (req.query.AccountId) list = list.filter((p) => p.accountId == null || String(p.accountId) === String(req.query.AccountId));
    if (req.query.ExternalId) list = list.filter((p) => String(p.externalId ?? '') === String(req.query.ExternalId));
    res.json({ data: page(list, req.query) });
  });
  app.post('/api/payments/batch', express.json(), (req, res) => {
    const items = Array.isArray(req.body?.data) ? req.body.data : [];
    for (const p of items) data.payments.push({ ...p, id: nextPaymentId++ });
    res.status(202).json({ requestId: `req-${nextRequestId++}`, received: req.body });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    validToken: 'kros-good',
    get data() {
      return data;
    },
    setData(next) {
      data = { ...DEFAULT_DATA(), invoices: [], payments: [], ...next };
    },
    /** Nasledujúcich `times` volaní method+path vráti `status`. */
    failNext(method, path, status, times = 1) {
      failures.push({ method, path, status, times });
    },
    posted: () => requests.filter((r) => r.method === 'POST' && r.path === '/api/payments/batch'),
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}
