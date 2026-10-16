/**
 * Falošný login.krosdoplnky.sk pre testy a lokálny vývoj.
 * /oauth/authorize automaticky „prihlási“ aktuálneho používateľa (setUser).
 */
import express from 'express';
import crypto from 'node:crypto';

export const FAKE_USERS = {
  alice: { sub: 'user-alice', email: 'alice@example.sk', email_verified: true, name: 'Alica Testová', avatar: null,
    organizations: [{ id: 'org-a', name: 'Firma A', role: 'owner' }], active_organization: 'org-a' },
  bob: { sub: 'user-bob', email: 'bob@example.sk', email_verified: true, name: 'Boris Testový', avatar: null,
    organizations: [{ id: 'org-b', name: 'Firma B', role: 'owner' }], active_organization: 'org-b' },
  unverified: { sub: 'user-unv', email: 'unv@example.sk', email_verified: false, name: 'Neoverený', avatar: null,
    organizations: [{ id: 'org-u', name: 'Firma U', role: 'owner' }], active_organization: 'org-u' },
  noorg: { sub: 'user-noorg', email: 'noorg@example.sk', email_verified: true, name: 'Bez firmy', avatar: null,
    organizations: [], active_organization: null },
};

const rand = () => crypto.randomBytes(16).toString('hex');

export async function startFakeAuthService({ clientId = 'client-1', clientSecret = 'secret-1', port = 0, host = '127.0.0.1' } = {}) {
  const app = express();
  const codes = new Map();
  const access = new Map();
  const refresh = new Map();
  const state = { userKey: 'alice', down: false, meDown: false };
  // Úschovňa tokenov z Token Broker launchu (userKey → prepojenia), vyzdvihnutie je jednorazové ako v login službe.
  const krosStash = new Map();
  const counts = { token: 0, refresh: 0, me: 0, tokenHits: 0 };

  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/oauth/token') counts.tokenHits += 1;
    next();
  });
  app.use((req, res, next) => (state.down ? res.status(503).send('down') : next()));
  app.use('/api/me', (req, res, next) => (state.meDown ? res.status(503).send('down') : next()));
  app.use(express.urlencoded({ extended: false }));

  app.get('/oauth/authorize', (req, res) => {
    const q = req.query;
    if (q.client_id !== clientId || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) {
      return res.status(400).send('bad authorize request');
    }
    const code = rand();
    codes.set(code, { userKey: state.userKey, challenge: q.code_challenge, redirectUri: q.redirect_uri });
    const target = new URL(q.redirect_uri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', q.state);
    res.redirect(target.toString());
  });

  function issue(userKey) {
    const at = rand();
    const rt = rand();
    access.set(at, userKey);
    refresh.set(rt, userKey);
    return { token_type: 'Bearer', expires_in: 900, access_token: at, refresh_token: rt };
  }

  app.post('/oauth/token', (req, res) => {
    const b = req.body;
    if (b.client_id !== clientId || b.client_secret !== clientSecret) return res.status(401).json({ error: 'invalid_client' });
    if (b.grant_type === 'authorization_code') {
      counts.token += 1;
      const entry = codes.get(b.code);
      codes.delete(b.code);
      const challenge = b.code_verifier
        ? crypto.createHash('sha256').update(b.code_verifier).digest('base64url') : null;
      if (!entry || entry.redirectUri !== b.redirect_uri || challenge !== entry.challenge) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      return res.json(issue(entry.userKey));
    }
    if (b.grant_type === 'refresh_token') {
      counts.refresh += 1;
      const userKey = refresh.get(b.refresh_token);
      refresh.delete(b.refresh_token); // rotácia ako Passport
      if (!userKey) return res.status(400).json({ error: 'invalid_grant' });
      return res.json(issue(userKey));
    }
    return res.status(400).json({ error: 'unsupported_grant_type' });
  });

  app.get('/api/me', (req, res) => {
    counts.me += 1;
    const token = String(req.get('authorization') || '').replace(/^Bearer /, '');
    const userKey = access.get(token);
    if (!userKey) return res.status(401).json({ message: 'Unauthenticated.' });
    if (req.query.kros !== '1') return res.json(FAKE_USERS[userKey]);
    const kros = krosStash.get(userKey) || [];
    krosStash.delete(userKey);
    res.json({ ...FAKE_USERS[userKey], kros_connections: kros });
  });

  app.all('/logout', (req, res) => res.type('text').send(`logged out (app=${req.query.app})`));

  const server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  return {
    url: `http://${host}:${server.address().port}`,
    users: FAKE_USERS,
    counts,
    setUser: (key) => { state.userKey = key; },
    setDown: (down) => { state.down = down; },
    setMeDown: (down) => { state.meDown = down; },
    /** Simuluje token-delivery po launchi z KROS. */
    deliverKrosTokens: (userKey, connections) => { krosStash.set(userKey, connections); },
    revokeRefreshTokens: () => refresh.clear(),
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
}
