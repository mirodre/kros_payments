import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeAuthService } from './helpers/fakeAuthService.js';
import { createAuthServiceClient, AuthServiceError } from '../src/auth/authServiceClient.js';
import { pkceChallenge } from '../src/crypto.js';

let fake;
let client;
const redirectUri = 'http://127.0.0.1:1/auth/sso/callback';
before(async () => {
  fake = await startFakeAuthService();
  client = createAuthServiceClient({ url: fake.url, clientId: 'client-1', clientSecret: 'secret-1', redirectUri, timeoutMs: 1000 });
});
after(() => fake.close());

async function obtainCode(verifier) {
  const res = await fetch(client.authorizeUrl({ state: 'st', codeChallenge: pkceChallenge(verifier) }), { redirect: 'manual' });
  return new URL(res.headers.get('location')).searchParams.get('code');
}

test('authorizeUrl obsahuje PKCE S256 a parametre klienta', () => {
  const u = new URL(client.authorizeUrl({ state: 'abc', codeChallenge: 'ch' }));
  assert.equal(u.origin + u.pathname, `${fake.url}/oauth/authorize`);
  assert.equal(u.searchParams.get('client_id'), 'client-1');
  assert.equal(u.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 'abc');
});

test('exchangeCode → me → refresh', async () => {
  const verifier = 'v'.repeat(43);
  const tokens = await client.exchangeCode({ code: await obtainCode(verifier), codeVerifier: verifier });
  assert.ok(tokens.accessToken && tokens.refreshToken);
  assert.ok(tokens.expiresAt > Date.now());
  const claims = await client.me(tokens.accessToken);
  assert.equal(claims.sub, 'user-alice');
  assert.equal(claims.active_organization, 'org-a');
  const next = await client.refresh(tokens.refreshToken);
  assert.notEqual(next.refreshToken, tokens.refreshToken);
  await assert.rejects(client.refresh(tokens.refreshToken), (e) => e instanceof AuthServiceError && e.kind === 'invalid_grant');
});

test('zlý verifier → invalid_grant; zlý access token → unauthorized', async () => {
  const code = await obtainCode('a'.repeat(43));
  await assert.rejects(client.exchangeCode({ code, codeVerifier: 'b'.repeat(43) }), (e) => e.kind === 'invalid_grant');
  await assert.rejects(client.me('nope'), (e) => e.kind === 'unauthorized');
});

test('výpadok → unavailable (5xx aj sieť)', async () => {
  fake.setDown(true);
  try {
    await assert.rejects(client.me('x'), (e) => e.kind === 'unavailable');
  } finally {
    fake.setDown(false);
  }
  const dead = createAuthServiceClient({ url: 'http://127.0.0.1:9', clientId: 'c', clientSecret: 's', redirectUri, timeoutMs: 500 });
  await assert.rejects(dead.refresh('x'), (e) => e.kind === 'unavailable');
});

test('logoutUrl', () => {
  assert.equal(client.logoutUrl('financie'), `${fake.url}/logout?app=financie&path=%2F`);
});

test('meWithKros: tokeny z brokera oddelené od claims, vyzdvihnutie jednorazové', async () => {
  const verifier = 'k'.repeat(43);
  const tokens = await client.exchangeCode({ code: await obtainCode(verifier), codeVerifier: verifier });
  fake.deliverKrosTokens('alice', [{ companyId: '7', companyName: 'Zeta', token: 'tok-7' }]);
  const first = await client.meWithKros(tokens.accessToken);
  assert.equal(first.claims.sub, 'user-alice');
  assert.equal(first.claims.kros_connections, undefined);
  assert.deepEqual(first.krosConnections, [{ companyId: '7', companyName: 'Zeta', token: 'tok-7' }]);
  assert.deepEqual((await client.meWithKros(tokens.accessToken)).krosConnections, []);
});
