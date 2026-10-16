import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/testApp.js';
import { decrypt, encrypt } from '../src/crypto.js';
import * as repos from '../src/repos.js';

let ctx;
before(async () => { ctx = await createTestContext(); });
after(() => ctx.close());
beforeEach(() => ctx.db.query('delete from kros_connections'));

const connections = () => ctx.db.query(
  'select organization_id, kros_company_id, company_name, token_enc, webhook_secret_enc, created_by_user_id from kros_connections order by kros_company_id');

test('launch z KROS bez session: prihlásenie uloží tokeny z brokera a ukáže výsledok', async () => {
  ctx.auth.setUser('alice');
  ctx.auth.deliverKrosTokens('alice', [
    { companyId: '11', companyName: 'Alfa s.r.o.', token: 'broker-tok-11' },
    { companyId: '12', companyName: 'Beta a.s.', token: 'broker-tok-12' },
    { companyId: '', companyName: 'Bez id', token: 'x' },
  ]);
  const b = ctx.browser();
  const { url } = await b.follow(`${ctx.base}/kros/launch`);
  assert.equal(url, `${ctx.base}/?kros_connected=2`);

  const { rows } = await connections();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].organization_id, 'org-a');
  assert.equal(rows[0].kros_company_id, '11');
  assert.equal(rows[0].company_name, 'Alfa s.r.o.');
  assert.equal(rows[0].created_by_user_id, 'user-alice');
  assert.equal(rows[0].webhook_secret_enc, null);
  assert.notEqual(rows[0].token_enc, 'broker-tok-11');
  assert.equal(decrypt(rows[0].token_enc, ctx.config.encryptionKey), 'broker-tok-11');

  // Tokeny sa nedostanú do session (ani do odpovede pre prehliadač).
  const sess = await ctx.db.query('select data from sessions');
  for (const r of sess.rows) assert.doesNotMatch(r.data, /broker-tok/);
});

test('bežné prihlásenie bez launchu: žiadne prepojenie, návrat na pôvodnú cestu', async () => {
  ctx.auth.setUser('alice');
  const b = ctx.browser();
  const { url } = await b.follow(`${ctx.base}/login?return=${encodeURIComponent('/?x=1')}`);
  assert.equal(url, `${ctx.base}/?x=1`);
  assert.equal((await connections()).rows.length, 0);
});

test('launch pri živej session: hneď obnoví claims a vyzdvihne tokeny', async () => {
  const b = await ctx.login('alice');
  const refreshes = ctx.auth.counts.refresh;
  ctx.auth.deliverKrosTokens('alice', [{ companyId: '21', companyName: 'Gama', token: 'broker-tok-21' }]);
  const res = await b.request(`${ctx.base}/kros/launch`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?kros_connected=1');
  assert.equal(ctx.auth.counts.refresh, refreshes + 1);
  const { rows } = await connections();
  assert.equal(rows.length, 1);
  assert.equal(decrypt(rows[0].token_enc, ctx.config.encryptionKey), 'broker-tok-21');

  // Úschovňa je jednorazová: ďalší launch bez nových tokenov len presmeruje domov.
  const again = await b.request(`${ctx.base}/kros/launch`);
  assert.equal(again.headers.get('location'), '/');
  const api = await b.request(`${ctx.base}/api/kros/connections`);
  assert.equal(api.status, 200);
});

test('obnova claims vyzdvihne tokeny aj mimo /kros/launch', async () => {
  const b = await ctx.login('alice');
  ctx.auth.deliverKrosTokens('alice', [{ companyId: '31', companyName: 'Delta', token: 'broker-tok-31' }]);
  ctx.clock.now += ctx.config.authService.claimsTtlMs + 1;
  const res = await b.request(`${ctx.base}/api/kros/connections`);
  assert.equal(res.status, 200);
  assert.equal((await connections()).rows[0].kros_company_id, '31');
});

test('token z brokera prepíše existujúce prepojenie firmy a zachová webhook secret', async () => {
  const key = ctx.config.encryptionKey;
  await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: '41', companyName: 'Epsilon', tokenEnc: encrypt('old-tok', key),
    webhookSecretEnc: encrypt('whsec', key), createdByUserId: 'user-alice',
  });
  ctx.auth.deliverKrosTokens('alice', [{ companyId: '41', companyName: 'Epsilon s.r.o.', token: 'new-tok' }]);
  await ctx.login('alice');
  const { rows } = await connections();
  assert.equal(rows.length, 1);
  assert.equal(decrypt(rows[0].token_enc, key), 'new-tok');
  assert.equal(decrypt(rows[0].webhook_secret_enc, key), 'whsec');
  assert.equal(rows[0].company_name, 'Epsilon s.r.o.');
});
