import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/testApp.js';
import { decrypt } from '../src/crypto.js';
import { parseCallbackCompanies } from '../src/kros/consent.js';

let ctx;
before(async () => { ctx = await createTestContext(); });
after(() => ctx.close());

async function startConsent(b) {
  const res = await b.request(`${ctx.base}/kros/connect`);
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location'));
}

function postCallback(state, companies, b = ctx.browser()) {
  const body = new URLSearchParams({ state });
  companies.forEach((c, i) => {
    body.set(`data[${i}][companyId]`, String(c.companyId));
    body.set(`data[${i}][companyName]`, c.companyName);
    body.set(`data[${i}][token]`, c.token);
    if (c.webhookSecret) body.set(`data[${i}][webhookSecret]`, c.webhookSecret);
  });
  // KROS posiela cross-site POST – bez cookies (SameSite=Lax), preto čerstvý browser.
  return b.request(`${ctx.base}/kros/callback`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://firma.kros.sk' }, body,
  });
}

test('parseCallbackCompanies: nested aj ploché kľúče, filtruje neúplné', () => {
  assert.deepEqual(parseCallbackCompanies({ data: [{ companyId: '5', companyName: 'A', token: 't' }, { companyId: 'x' }] }),
    [{ companyId: 5, companyName: 'A', token: 't', webhookSecret: undefined }]);
  assert.deepEqual(parseCallbackCompanies({ 'data[0][companyId]': '6', 'data[0][companyName]': 'B', 'data[0][token]': 'u', 'data[0][webhookSecret]': 'w' }),
    [{ companyId: 6, companyName: 'B', token: 'u', webhookSecret: 'w' }]);
  assert.deepEqual(parseCallbackCompanies(null), []);
});

test('/kros/connect vyžaduje prihlásenie', async () => {
  const res = await ctx.browser().request(`${ctx.base}/kros/connect`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);
});

test('consent URL obsahuje parametre a webhook organizácie (len pri https)', async () => {
  const b = await ctx.login();
  const url = await startConsent(b);
  assert.equal(url.origin + url.pathname, 'https://firma.kros.sk/integration-consent');
  assert.equal(url.searchParams.get('plugin_name'), 'PlatformaUhrady');
  assert.equal(url.searchParams.get('response_mode'), 'post');
  assert.equal(url.searchParams.get('company_mode'), 'multiple');
  assert.equal(url.searchParams.get('redirect_url'), `${ctx.base}/kros/callback`);
  assert.equal(url.searchParams.get('webhook'), null); // test beží na http
  assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
});

test('callback bez cookie uloží šifrované prepojenia pod organizáciu', async () => {
  const b = await ctx.login('alice');
  const state = (await startConsent(b)).searchParams.get('state');
  const res = await postCallback(state, [
    { companyId: 11, companyName: 'Alfa', token: 'kros-good', webhookSecret: 'whsec' },
    { companyId: 12, companyName: 'Beta', token: 'tok-2' },
  ]);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/?kros_connected=2');
  const { rows } = await ctx.db.query(
    'select organization_id, kros_company_id, token_enc, webhook_secret_enc, created_by_user_id from kros_connections order by kros_company_id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].organization_id, 'org-a');
  assert.equal(rows[0].created_by_user_id, 'user-alice');
  assert.notEqual(rows[0].token_enc, 'kros-good');
  assert.equal(decrypt(rows[0].token_enc, ctx.config.encryptionKey), 'kros-good');
  assert.equal(decrypt(rows[0].webhook_secret_enc, ctx.config.encryptionKey), 'whsec');
  assert.equal(rows[1].webhook_secret_enc, null);
});

test('opakovaný, neznámy alebo expirovaný state → kros_error=state, nič sa nezmení', async () => {
  const b = await ctx.login('bob');
  const state = (await startConsent(b)).searchParams.get('state');
  assert.equal((await postCallback(state, [{ companyId: 21, companyName: 'B1', token: 't' }])).status, 303);
  const again = await postCallback(state, [{ companyId: 22, companyName: 'B2', token: 't' }]);
  assert.equal(again.headers.get('location'), '/?kros_error=state');
  const unknown = await postCallback('nope', [{ companyId: 23, companyName: 'B3', token: 't' }]);
  assert.equal(unknown.headers.get('location'), '/?kros_error=state');
  await ctx.db.query(
    "insert into kros_consent_requests(state, organization_id, user_id, expires_at) values ('old', 'org-b', 'user-bob', now() - interval '1 minute')");
  const expired = await postCallback('old', [{ companyId: 24, companyName: 'B4', token: 't' }]);
  assert.equal(expired.headers.get('location'), '/?kros_error=state');
  const { rows } = await ctx.db.query("select kros_company_id from kros_connections where organization_id = 'org-b'");
  assert.deepEqual(rows.map((r) => r.kros_company_id), ['21']);
});

test('prázdna odpoveď → kros_error=empty', async () => {
  const b = await ctx.login();
  const state = (await startConsent(b)).searchParams.get('state');
  const res = await postCallback(state, []);
  assert.equal(res.headers.get('location'), '/?kros_error=empty');
});

test('GET /kros/callback → /', async () => {
  const res = await ctx.browser().request(`${ctx.base}/kros/callback`);
  assert.equal(res.headers.get('location'), '/');
});
