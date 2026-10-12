import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('server bez env skončí s chybou o chýbajúcich premenných', async () => {
  const child = spawn(process.execPath, ['server.js'], { env: { PATH: process.env.PATH }, cwd: process.cwd() });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  assert.notEqual(code, 0);
  assert.match(stderr, /Chýbajú povinné env premenné: APP_URL/);
});

test('server so pglite:memory naštartuje a odpovedá na /api/ping', async () => {
  const env = {
    PATH: process.env.PATH,
    PORT: '3917',
    APP_URL: 'http://localhost:3917',
    DATABASE_URL: 'pglite:memory',
    SESSION_SECRET: 'x'.repeat(40),
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    AUTH_SERVICE_URL: 'http://127.0.0.1:9',
    AUTH_SERVICE_CLIENT_ID: 'c',
    AUTH_SERVICE_CLIENT_SECRET: 's',
    AUTH_SERVICE_REDIRECT_URI: 'http://localhost:3917/auth/sso/callback',
  };
  const child = spawn(process.execPath, ['server.js'], { env, cwd: process.cwd() });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => { if (String(d).includes('Financie beží')) resolve(); });
      child.on('exit', (c) => reject(new Error('exit ' + c)));
      setTimeout(() => reject(new Error('timeout')), 15000).unref();
    });
    const res = await fetch('http://localhost:3917/api/ping');
    assert.deepEqual(await res.json(), { ok: true, db: true, message: 'Financie – server beží.' });
  } finally {
    child.kill();
  }
});
