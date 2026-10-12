import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/testApp.js';
import * as repos from '../src/repos.js';
import { encrypt } from '../src/crypto.js';

let ctx;
let alice;
let bob;
let good;
let bad;
let broken;
before(async () => {
  ctx = await createTestContext();
  alice = await ctx.login('alice');
  bob = await ctx.login('bob');
  const key = ctx.config.encryptionKey;
  const mk = async (companyId, token) => (await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: companyId, companyName: `F${companyId}`,
    tokenEnc: token === null ? 'v1.broken.x.y' : encrypt(token, key), webhookSecretEnc: null, createdByUserId: 'user-alice',
  })).id;
  good = await mk('1', 'kros-good');
  bad = await mk('2', 'kros-revoked');
  broken = await mk('3', null);
});
after(() => ctx.close());

const call = (b, path, conn, init = {}) => b.request(`${ctx.base}${path}`, {
  ...init, headers: { ...(conn ? { 'x-kros-connection': conn } : {}), origin: ctx.base, ...(init.headers || {}) },
});

test('generický proxy doplní token a nič citlivé nepreposiela', async () => {
  const res = await call(alice, '/api/payments/accounts', good, { headers: { 'x-kros-base-url': 'https://evil.example' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  const last = ctx.kros.requests.at(-1);
  assert.equal(last.path, '/api/payments/accounts');
  assert.equal(last.headers.authorization, 'Bearer kros-good');
  for (const h of ['cookie', 'x-kros-connection', 'x-kros-base-url', 'origin', 'referer']) {
    assert.equal(last.headers[h], undefined, h);
  }
});

test('vlastné handlery (invoices filter, payments, batch) používajú token prepojenia', async () => {
  const inv = await (await call(alice, '/api/invoices?NumberingSequence=fa', good)).json();
  assert.deepEqual(inv.data.map((d) => d.id), [1]);
  const pay = await (await call(alice, '/api/payments?DateFrom=2026-01-01', good)).json();
  assert.deepEqual(pay.data.map((d) => d.id), [7]);
  const batch = await call(alice, '/api/payments/batch', good, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ x: 1 }]),
  });
  assert.equal(batch.status, 202);
  assert.deepEqual((await batch.json()).received, [{ x: 1 }]);
  assert.equal(ctx.kros.requests.at(-1).headers.authorization, 'Bearer kros-good');
});

test('chýbajúce / cudzie / neexistujúce prepojenie', async () => {
  assert.equal((await call(alice, '/api/auth/check', null)).status, 400);
  assert.equal((await call(bob, '/api/auth/check', good)).status, 404);
  assert.equal((await call(alice, '/api/auth/check', '00000000-0000-0000-0000-000000000000')).status, 404);
});

test('KROS 401 → prepošle sa a prepojenie sa označí ako neplatné; úspech ho vyčistí', async () => {
  const res = await call(alice, '/api/auth/check', bad);
  assert.equal(res.status, 401);
  assert.notDeepEqual(await res.json(), { error: 'unauthenticated' });
  await new Promise((r) => setTimeout(r, 50));
  const list = await repos.listConnections(ctx.db, 'org-a');
  assert.equal(list.find((c) => c.id === bad).invalid, true);
  await repos.setConnectionInvalid(ctx.db, good, true);
  assert.equal((await call(alice, '/api/auth/check', good)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await repos.listConnections(ctx.db, 'org-a')).find((c) => c.id === good).invalid, false);
});

test('nedešifrovateľný token → 409 connection_invalid', async () => {
  const res = await call(alice, '/api/auth/check', broken);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'connection_invalid');
});
