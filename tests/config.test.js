import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const valid = {
  APP_URL: 'https://financie.krosdoplnky.sk/',
  DATABASE_URL: 'postgres://u:p@db/financie',
  SESSION_SECRET: 's'.repeat(32),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  AUTH_SERVICE_URL: 'https://login.krosdoplnky.sk/',
  AUTH_SERVICE_CLIENT_ID: 'cid',
  AUTH_SERVICE_CLIENT_SECRET: 'csecret',
  AUTH_SERVICE_REDIRECT_URI: 'https://financie.krosdoplnky.sk/auth/sso/callback',
};

test('loadConfig: platná konfigurácia a defaulty', () => {
  const c = loadConfig(valid);
  assert.equal(c.appUrl, 'https://financie.krosdoplnky.sk');
  assert.equal(c.appOrigin, 'https://financie.krosdoplnky.sk');
  assert.equal(c.port, 3000);
  assert.equal(c.secureCookies, true);
  assert.equal(c.encryptionKey.length, 32);
  assert.equal(c.authService.url, 'https://login.krosdoplnky.sk');
  assert.equal(c.authService.appKey, 'financie');
  assert.equal(c.authService.claimsTtlMs, 900_000);
  assert.equal(c.authService.gracePeriodMs, 86_400_000);
  assert.equal(c.authService.timeoutMs, 5000);
  assert.equal(c.krosApiBase, 'https://api-economy.kros.sk');
  assert.equal(c.krosConsentUrl, 'https://firma.kros.sk/integration-consent');
});

test('loadConfig: chýbajúce premenné sú vymenované', () => {
  assert.throws(() => loadConfig({ ...valid, DATABASE_URL: '', AUTH_SERVICE_CLIENT_ID: undefined }),
    /DATABASE_URL.*AUTH_SERVICE_CLIENT_ID/);
});

test('loadConfig: krátky SESSION_SECRET a zlý kľúč', () => {
  assert.throws(() => loadConfig({ ...valid, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ ...valid, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }), /APP_ENCRYPTION_KEY/);
});

test('loadConfig: http APP_URL → nezabezpečené cookies', () => {
  assert.equal(loadConfig({ ...valid, APP_URL: 'http://localhost:3000' }).secureCookies, false);
});
