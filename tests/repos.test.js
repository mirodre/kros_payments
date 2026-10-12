import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, migrate } from '../src/db.js';
import * as repos from '../src/repos.js';

let db;
before(async () => {
  db = await createDb('pglite:memory');
  await migrate(db);
  await repos.upsertUser(db, { sub: 'uA', email: 'a@x.sk', name: 'Anna' });
  await repos.upsertUser(db, { sub: 'uB', email: 'b@x.sk', name: 'Boris' });
  await repos.upsertOrganizations(db, [{ id: 'oA', name: 'Firma A' }, { id: 'oB', name: 'Firma B' }]);
});

test('organizácia má stabilný webhook kľúč a aktualizuje meno', async () => {
  const before1 = await repos.getOrganization(db, 'oA');
  await repos.upsertOrganizations(db, [{ id: 'oA', name: 'Firma A2' }]);
  const after = await repos.getOrganization(db, 'oA');
  assert.equal(after.name, 'Firma A2');
  assert.equal(after.webhookKey, before1.webhookKey);
  assert.deepEqual(await repos.findOrganizationByWebhookKey(db, after.webhookKey), after);
  assert.equal(await repos.findOrganizationByWebhookKey(db, 'nope'), null);
});

test('consent request je jednorazový a expiruje', async () => {
  await repos.createConsentRequest(db, { state: 's1', organizationId: 'oA', userId: 'uA' });
  assert.deepEqual(await repos.consumeConsentRequest(db, 's1'), { organizationId: 'oA', userId: 'uA' });
  assert.equal(await repos.consumeConsentRequest(db, 's1'), null);
  await repos.createConsentRequest(db, { state: 's2', organizationId: 'oA', userId: 'uA', ttlMinutes: -1 });
  assert.equal(await repos.consumeConsentRequest(db, 's2'), null);
  assert.equal(await repos.consumeConsentRequest(db, 'unknown'), null);
});

test('prepojenia: upsert, izolácia organizácií, mazanie', async () => {
  const { id } = await repos.upsertConnection(db, {
    organizationId: 'oA', krosCompanyId: '42', companyName: 'Alfa', tokenEnc: 't1', webhookSecretEnc: 'w1', createdByUserId: 'uA',
  });
  const again = await repos.upsertConnection(db, {
    organizationId: 'oA', krosCompanyId: '42', companyName: 'Alfa s.r.o.', tokenEnc: 't2', webhookSecretEnc: null, createdByUserId: 'uB',
  });
  assert.equal(again.id, id);
  const list = await repos.listConnections(db, 'oA');
  assert.equal(list.length, 1);
  assert.equal(list[0].companyName, 'Alfa s.r.o.');
  assert.equal(list[0].companyId, '42');
  assert.deepEqual(list[0].createdBy, { id: 'uA', name: 'Anna', email: 'a@x.sk' });
  assert.equal((await repos.findConnection(db, 'oA', id)).tokenEnc, 't2');
  assert.equal(await repos.findConnection(db, 'oB', id), null);
  assert.deepEqual(await repos.listConnections(db, 'oB'), []);

  await repos.setConnectionInvalid(db, id, true);
  assert.equal((await repos.listConnections(db, 'oA'))[0].invalid, true);
  await repos.setConnectionInvalid(db, id, false);
  assert.equal((await repos.listConnections(db, 'oA'))[0].invalid, false);

  assert.equal(await repos.deleteConnection(db, 'oB', id), false);
  assert.equal(await repos.deleteConnection(db, 'oA', id), true);
  assert.equal(await repos.findConnection(db, 'oA', id), null);
});

test('callbacky: filtrované podľa organizácie a sinceSeq', async () => {
  await repos.insertCallback(db, { organizationId: 'oA', connectionId: null, signatureHeader: 'x', signatureValid: false, payload: { a: 1 } });
  await repos.insertCallback(db, { organizationId: 'oB', connectionId: null, signatureHeader: null, signatureValid: false, payload: { b: 1 } });
  await repos.insertCallback(db, { organizationId: 'oA', connectionId: null, signatureHeader: null, signatureValid: true, payload: { a: 2 } });
  const all = await repos.listCallbacks(db, 'oA', 0);
  assert.deepEqual(all.items.map((i) => i.body), [{ a: 1 }, { a: 2 }]);
  assert.equal(all.lastSeq, all.items[1].seq);
  assert.equal(typeof all.items[0].seq, 'number');
  const since = await repos.listCallbacks(db, 'oA', all.items[0].seq);
  assert.deepEqual(since.items.map((i) => i.body), [{ a: 2 }]);
  assert.deepEqual((await repos.listCallbacks(db, 'oC', 0)), { items: [], lastSeq: 0 });
});
