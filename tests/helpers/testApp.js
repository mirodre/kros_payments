/** Zloží PGlite DB, falošný auth service, falošné KROS a aplikáciu na náhodnom porte. */
import http from 'node:http';
import { createDb, migrate } from '../../src/db.js';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { startFakeAuthService } from './fakeAuthService.js';
import { startFakeKros } from './fakeKros.js';
import { createBrowser } from './browser.js';

export async function createTestContext() {
  const db = await createDb('pglite:memory');
  await migrate(db);
  const auth = await startFakeAuthService();
  const kros = await startFakeKros();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = loadConfig({
    APP_URL: base,
    DATABASE_URL: 'pglite:memory',
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    AUTH_SERVICE_URL: auth.url,
    AUTH_SERVICE_CLIENT_ID: 'client-1',
    AUTH_SERVICE_CLIENT_SECRET: 'secret-1',
    AUTH_SERVICE_REDIRECT_URI: `${base}/auth/sso/callback`,
    KROS_API_BASE: kros.url,
  });
  const clock = { now: Date.now() };
  const app = createApp({ config, db, now: () => clock.now });
  server.on('request', app);

  return {
    base, db, config, auth, kros, clock,
    browser: createBrowser,
    async login(userKey = 'alice') {
      auth.setUser(userKey);
      const b = createBrowser();
      const { res } = await b.follow(`${base}/login`);
      if (res.status !== 200) throw new Error(`login zlyhal: ${res.status}`);
      return b;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await auth.close();
      await kros.close();
      await db.close();
    },
  };
}
