import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/testApp.js';
import * as repos from '../src/repos.js';
import { encrypt } from '../src/crypto.js';

let ctx;
let alice;
let bob;
let connA;
before(async () => {
  ctx = await createTestContext();
  alice = await ctx.login('alice');
  bob = await ctx.login('bob');
  ({ id: connA } = await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: '11', companyName: 'Alfa',
    tokenEnc: encrypt('kros-good', ctx.config.encryptionKey), webhookSecretEnc: null, createdByUserId: 'user-alice',
  }));
  await repos.insertCallback(ctx.db, { organizationId: 'org-a', connectionId: connA, signatureHeader: null, signatureValid: true, payload: { a: 1 } });
  await repos.insertCallback(ctx.db, { organizationId: 'org-b', connectionId: null, signatureHeader: null, signatureValid: false, payload: { b: 1 } });
});
after(() => ctx.close());

const json = async (b, path, init) => {
  const res = await b.request(`${ctx.base}${path}`, init);
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

test('/api/me', async () => {
  const { body } = await json(alice, '/api/me');
  assert.deepEqual(body, {
    user: { id: 'user-alice', email: 'alice@example.sk', name: 'Alica Testová' },
    organization: { id: 'org-a', name: 'Firma A' },
  });
});

test('zoznam prepojení bez tokenov a izolovaný', async () => {
  const a = await json(alice, '/api/kros/connections');
  assert.equal(a.body.length, 1);
  assert.equal(a.body[0].companyName, 'Alfa');
  assert.equal(JSON.stringify(a.body).includes('token'), false);
  assert.deepEqual((await json(bob, '/api/kros/connections')).body, []);
});

test('callbacky len vlastnej organizácie + callbackUrl', async () => {
  const a = await json(alice, '/api/kros-callbacks?sinceSeq=0');
  assert.deepEqual(a.body.items.map((i) => i.body), [{ a: 1 }]);
  assert.equal(a.body.lastSeq, a.body.items[0].seq);
  const org = await repos.getOrganization(ctx.db, 'org-a');
  assert.equal(a.body.callbackUrl, `${ctx.base}/kros/payments-callback/${org.webhookKey}`);
  const b = await json(bob, '/api/kros-callbacks');
  assert.deepEqual(b.body.items.map((i) => i.body), [{ b: 1 }]);
});

test('DELETE: cudzia organizácia 404, vlastná 204', async () => {
  const del = (b) => json(b, `/api/kros/connections/${connA}`, { method: 'DELETE', headers: { origin: ctx.base } });
  assert.equal((await del(bob)).status, 404);
  assert.equal((await json(alice, '/api/kros/connections/not-a-uuid', { method: 'DELETE', headers: { origin: ctx.base } })).status, 404);
  assert.equal((await del(alice)).status, 204);
  assert.deepEqual((await json(alice, '/api/kros/connections')).body, []);
});
