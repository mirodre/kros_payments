import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers/testApp.js';

let ctx;
before(async () => { ctx = await createTestContext(); });
after(() => ctx.close());

const TTL = 900_000;

test('čerstvé claims → bez refreshu', async () => {
  const b = await ctx.login();
  const before1 = ctx.auth.counts.refresh;
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
  assert.equal(ctx.auth.counts.refresh, before1);
});

test('staré claims → refresh a nové claims', async () => {
  const b = await ctx.login();
  const before1 = ctx.auth.counts.refresh;
  ctx.clock.now += TTL + 1;
  const res = await b.request(`${ctx.base}/api/me`);
  assert.equal(res.status, 200);
  assert.equal(ctx.auth.counts.refresh, before1 + 1);
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
  assert.equal(ctx.auth.counts.refresh, before1 + 1);
});

test('paralelné požiadavky → jeden refresh, nikto nie je odhlásený', async () => {
  const b = await ctx.login();
  const before1 = ctx.auth.counts.refresh;
  ctx.clock.now += TTL + 1;
  const results = await Promise.all(Array.from({ length: 5 }, () => b.request(`${ctx.base}/api/me`)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(ctx.auth.counts.refresh, before1 + 1);
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
});

test('revokovaný refresh token → odhlásenie', async () => {
  const b = await ctx.login();
  ctx.auth.revokeRefreshTokens();
  ctx.clock.now += TTL + 1;
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 401);
  const html = await b.request(`${ctx.base}/`);
  assert.equal(html.status, 302);
});

test('refresh prejde, /api/me spadne → nový refresh token sa nestratí, používateľ ostane prihlásený', async () => {
  const b = await ctx.login();
  ctx.auth.setMeDown(true);
  try {
    ctx.clock.now += TTL + 1;
    assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
  } finally {
    ctx.auth.setMeDown(false);
  }
  ctx.clock.now += 61_000;
  const refreshesBefore = ctx.auth.counts.refresh;
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
  assert.equal(ctx.auth.counts.refresh, refreshesBefore + 1);
  assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
});

test('počas výpadku sa refresh neopakuje pri každej požiadavke (backoff 60 s)', async () => {
  const b = await ctx.login();
  ctx.auth.setDown(true);
  try {
    ctx.clock.now += TTL + 1;
    const hits = ctx.auth.counts.tokenHits;
    for (let i = 0; i < 3; i++) assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
    assert.equal(ctx.auth.counts.tokenHits, hits + 1);
    ctx.clock.now += 61_000;
    assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
    assert.equal(ctx.auth.counts.tokenHits, hits + 2);
  } finally {
    ctx.auth.setDown(false);
  }
});

test('výpadok auth service → grace 24 h, potom odhlásenie', async () => {
  const b = await ctx.login();
  ctx.auth.setDown(true);
  try {
    ctx.clock.now += TTL + 1;
    assert.equal((await b.request(`${ctx.base}/api/me`)).status, 200);
    ctx.clock.now += 86_400_000;
    assert.equal((await b.request(`${ctx.base}/api/me`)).status, 401);
  } finally {
    ctx.auth.setDown(false);
  }
});
