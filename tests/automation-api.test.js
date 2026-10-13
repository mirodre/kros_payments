import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestContext } from './helpers/testApp.js';
import * as repos from '../src/repos.js';
import { encrypt } from '../src/crypto.js';

let ctx;
let alice;
let bob;
let connId;

before(async () => {
  ctx = await createTestContext();
  alice = await ctx.login('alice');
  bob = await ctx.login('bob');
  ({ id: connId } = await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: '1', companyName: 'Alfa',
    tokenEnc: encrypt('kros-good', ctx.config.encryptionKey),
    webhookSecretEnc: encrypt('sec', ctx.config.encryptionKey), createdByUserId: 'user-alice',
  }));
});
after(() => ctx.close());

const call = (b, path, init = {}) => b.request(`${ctx.base}${path}`, {
  ...init,
  headers: { origin: ctx.base, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
  body: init.body ? JSON.stringify(init.body) : undefined,
});

test('CRUD, validácia a izolácia podľa organizácie', async () => {
  let res = await call(alice, '/api/automations', {
    method: 'POST', body: { connectionId: connId, kind: 'transfer', accountId: 5, targetAccountId: 5 },
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /rôzne/);

  res = await call(alice, '/api/automations', {
    method: 'POST',
    body: { connectionId: connId, kind: 'invoice_payment', accountId: 5, partnerText: ' ACME ', docTypes: 'expenses', startDate: '2026-10-01' },
  });
  assert.equal(res.status, 201);
  const rule = await res.json();
  assert.equal(rule.partnerText, 'ACME');
  assert.equal(rule.docTypes, 'expenses');
  assert.equal(rule.startDate, '2026-10-01');
  assert.equal(rule.enabled, true);

  assert.equal((await call(bob, '/api/automations', {
    method: 'POST', body: { connectionId: connId, kind: 'invoice_payment', accountId: 5 },
  })).status, 404, 'cudzie prepojenie');
  assert.deepEqual(await (await call(bob, '/api/automations')).json(), []);
  assert.equal((await call(bob, `/api/automations/${rule.id}`, { method: 'PUT', body: { enabled: false } })).status, 404);

  const list = await (await call(alice, `/api/automations?connectionId=${connId}&kind=invoice_payment`)).json();
  assert.deepEqual(list.map((r) => r.id), [rule.id]);

  res = await call(alice, `/api/automations/${rule.id}`, { method: 'PUT', body: { enabled: false } });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.enabled, false);
  assert.equal(updated.partnerText, 'ACME', 'neposlané polia ostávajú');

  assert.equal((await call(alice, `/api/automations/${rule.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(alice, `/api/automations/${rule.id}`, { method: 'DELETE' })).status, 404);
});

test('Spustiť teraz + položky + výsledok z webhooku', async () => {
  ctx.kros.setData({
    invoices: [{
      id: 1, issueDate: '2026-10-05', documentNumber: '001', variableSymbol: '1',
      partner: { address: { businessName: 'ACME' } }, sumForPayment: 10, sumOfPayments: 0,
      prices: { currency: 'EUR', documentPrices: { totalPriceInclVat: 10 } },
    }],
  });
  const rule = await (await call(alice, '/api/automations', {
    method: 'POST', body: { connectionId: connId, kind: 'invoice_payment', accountId: 5, startDate: '2026-10-01' },
  })).json();
  const res = await call(alice, `/api/automations/${rule.id}/run`, { method: 'POST' });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.status, 'ok');
  assert.equal(result.summary.sent, 1);
  assert.equal(result.rule.lastStatus, 'ok');

  let items = await (await call(alice, `/api/automations/${rule.id}/items`)).json();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'sent');
  assert.deepEqual(await (await call(bob, `/api/automations/${rule.id}/items`)).json(), []);

  const org = await repos.getOrganization(ctx.db, 'org-a');
  const body = Buffer.from(JSON.stringify({
    companyId: 1, status: 207, requestId: items[0].requestId,
    results: { entities: [{ index: 0, status: 404, problems: [{ title: 'Doklad sa nenašiel' }] }] },
  }));
  const sig = crypto.createHmac('sha256', Buffer.from('sec')).update(Buffer.from(body.toString('utf8'), 'utf16le')).digest('base64');
  const hook = await fetch(`${ctx.base}/kros/payments-callback/${org.webhookKey}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-kros-signature-256': sig }, body,
  });
  assert.equal(hook.status, 200);
  items = await (await call(alice, `/api/automations/${rule.id}/items`)).json();
  assert.equal(items[0].status, 'rejected');
  assert.match(items[0].error, /nenašiel/);
});
