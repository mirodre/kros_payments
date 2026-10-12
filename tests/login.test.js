import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/testApp.js';
import { safeReturnPath } from '../src/auth/routes.js';

let ctx;
before(async () => { ctx = await createTestContext(); });
after(() => ctx.close());

test('safeReturnPath odmieta open redirect', () => {
  assert.equal(safeReturnPath('/a?b=1'), '/a?b=1');
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', '', null, '/x'.repeat(2000)]) {
    assert.equal(safeReturnPath(bad), null, String(bad).slice(0, 20));
  }
});

test('bez session: HTML → /login, API → 401 JSON, ping verejný', async () => {
  const b = ctx.browser();
  const page = await b.request(`${ctx.base}/`);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login?return=%2F');
  const idx = await b.request(`${ctx.base}/index.html`);
  assert.equal(idx.status, 302);
  const api = await b.request(`${ctx.base}/api/invoices`);
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: 'unauthenticated' });
  const ping = await b.request(`${ctx.base}/api/ping`);
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).db, true);
  const css = await b.request(`${ctx.base}/styles.css`);
  assert.equal(css.status, 200);
});

test('celý login flow → index, cookie, používateľ v DB, return path', async () => {
  const b = ctx.browser();
  const { res, url } = await b.follow(`${ctx.base}/login?return=${encodeURIComponent('/?x=1')}`);
  assert.equal(res.status, 200);
  assert.equal(url, `${ctx.base}/?x=1`);
  assert.match(await res.text(), /<title>Financie/);
  assert.ok(b.cookies(new URL(ctx.base).host).has('financie_sid'));
  const u = await ctx.db.query('select email from users where id = $1', ['user-alice']);
  assert.equal(u.rows[0].email, 'alice@example.sk');
  const o = await ctx.db.query('select name from organizations where id = $1', ['org-a']);
  assert.equal(o.rows[0].name, 'Firma A');
});

test('session ID sa po prihlásení mení (session fixation)', async () => {
  const b = ctx.browser();
  await b.request(`${ctx.base}/login`);
  const host = new URL(ctx.base).host;
  const preSid = b.cookies(host).get('financie_sid');
  assert.ok(preSid);
  await b.follow(`${ctx.base}/login`);
  assert.notEqual(b.cookies(host).get('financie_sid'), preSid);
});

test('zlý state → stránka chyby', async () => {
  const b = ctx.browser();
  await b.request(`${ctx.base}/login`);
  const res = await b.request(`${ctx.base}/auth/sso/callback?code=x&state=wrong`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Prihlásenie zlyhalo/);
  const noSession = await ctx.browser().request(`${ctx.base}/auth/sso/callback?code=x&state=y`);
  assert.equal(noSession.status, 400);
  const err = await b.request(`${ctx.base}/auth/sso/callback?error=access_denied`);
  assert.equal(err.status, 400);
});

test('neoverený e-mail a bez organizácie → nepustí', async () => {
  ctx.auth.setUser('unverified');
  let r = await ctx.browser().follow(`${ctx.base}/login`);
  assert.equal(r.res.status, 403);
  assert.match(await r.res.text(), /Over/);
  ctx.auth.setUser('noorg');
  r = await ctx.browser().follow(`${ctx.base}/login`);
  assert.equal(r.res.status, 403);
  assert.match(await r.res.text(), /organizáci/);
  ctx.auth.setUser('alice');
});

test('auth service nedostupný pri prihlásení → 503', async () => {
  const b = ctx.browser();
  const start = await b.request(`${ctx.base}/login`);
  const authorize = await b.request(start.headers.get('location'));
  ctx.auth.setDown(true);
  try {
    const res = await b.request(new URL(authorize.headers.get('location')).toString());
    assert.equal(res.status, 503);
  } finally {
    ctx.auth.setDown(false);
  }
});

test('logout zruší session a presmeruje na auth service', async () => {
  const b = await ctx.login();
  const res = await b.request(`${ctx.base}/logout`, { method: 'POST', headers: { origin: ctx.base } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `${ctx.auth.url}/logout?app=financie&path=%2F`);
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 401);
});

test('POST z cudzieho originu → 403', async () => {
  const b = await ctx.login();
  const res = await b.request(`${ctx.base}/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});
