/** Zostavenie Express aplikácie. */
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbSessionStore } from './sessionStore.js';
import { createAuthServiceClient } from './auth/authServiceClient.js';
import { createAuthRouter, SESSION_COOKIE } from './auth/routes.js';
import { createRequireAuth, requireSameOrigin } from './auth/requireAuth.js';
import { createConsentCallbackRouter, createConnectRouter } from './kros/consent.js';
import { createWebhookRouter } from './kros/webhook.js';
import { createApiRouter } from './kros/api.js';
import { createKrosProxyRouter } from './kros/proxy.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createApp({ config, db, now = Date.now }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  const authClient = createAuthServiceClient(config.authService);

  // Zastaralý app.js v cache by po nasadení robil problémy.
  app.use((req, res, next) => {
    if (req.method === 'GET' && /\.(?:js|html|webmanifest)$/i.test(req.path)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
  });

  app.get('/api/ping', async (req, res) => {
    try {
      await db.query('select 1');
      res.json({ ok: true, db: true, message: 'Financie – server beží.' });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });

  // --- Cesty bez session ---
  app.use(createWebhookRouter({ config, db }));
  app.use(createConsentCallbackRouter({ config, db }));

  app.use(session({
    name: SESSION_COOKIE,
    secret: config.sessionSecret,
    store: new DbSessionStore(db, { key: config.encryptionKey }),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', maxAge: SESSION_MAX_AGE_MS },
  }));

  app.use(['/api', '/logout', '/kros/connect'], requireSameOrigin(config.appOrigin));
  app.use(createAuthRouter({ config, db, authClient, now }));
  const requireAuth = createRequireAuth({ config, db, authClient, now });
  app.use(createConnectRouter({ config, db, requireAuth }));

  // index.html len cez SPA fallback (za requireAuth); ostatné statické súbory sú verejné.
  app.get('/index.html', (req, res) => res.redirect('/'));
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('manifest.webmanifest')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    },
  }));

  app.use('/api', requireAuth);
  app.use('/api', createApiRouter({ config, db }));
  // Bez globálneho body parsera: /payments/batch číta stream sám a proxy potrebuje surové telo.
  app.use('/api', createKrosProxyRouter({ config, db }));

  app.get('*', requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err, req, res, next) => {
    console.error('[app] chyba:', err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: 'internal_error' });
  });

  return app;
}
