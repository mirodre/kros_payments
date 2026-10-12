/** Falošné KROS Open API: platný token je `Bearer kros-good`. */
import express from 'express';

export async function startFakeKros() {
  const app = express();
  const requests = [];
  app.use((req, res, next) => {
    requests.push({ method: req.method, path: req.originalUrl, headers: { ...req.headers } });
    if (req.get('authorization') !== 'Bearer kros-good') return res.status(401).json({ title: 'Unauthorized' });
    next();
  });
  app.get('/api/auth/check', (req, res) => res.json({ ok: true }));
  app.get('/api/payments/accounts', (req, res) => {
    res.setHeader('set-cookie', 'kros=1; Path=/');
    res.json({ data: [{ id: 1, name: 'Účet', iban: 'SK00', currency: 'EUR' }] });
  });
  app.get('/api/invoices', (req, res) => res.json({ data: [
    { id: 1, issueDate: '2026-01-05', numberingSequence: 'FA' },
    { id: 2, issueDate: '2026-02-05', numberingSequence: 'OF' },
  ] }));
  app.get('/api/payments', (req, res) => res.json({ data: [{ id: 7, dateOfPayment: '2026-03-01' }] }));
  app.post('/api/payments/batch', express.json(), (req, res) => res.status(202).json({ requestId: 'r1', received: req.body }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    validToken: 'kros-good',
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}
