/** /login, /auth/sso/callback, /logout */
import { Router } from 'express';
import { randomToken, pkceChallenge, safeEqual } from '../crypto.js';
import { upsertUser, upsertOrganizations } from '../repos.js';
import { renderAuthPage } from './pages.js';
import { storeBrokerConnections } from '../kros/brokerConnections.js';

export const SESSION_COOKIE = 'financie_sid';

export function safeReturnPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

export function createAuthRouter({ config, db, authClient, now }) {
  const router = Router();
  const page = (res, status, kind) =>
    res.status(status).type('html').send(renderAuthPage(kind, { authServiceUrl: config.authService.url }));

  router.get('/login', (req, res, next) => {
    const state = randomToken();
    const verifier = randomToken(48);
    req.session.sso = { state, verifier, returnTo: safeReturnPath(req.query.return) };
    req.session.save((err) => {
      if (err) return next(err);
      res.redirect(authClient.authorizeUrl({ state, codeChallenge: pkceChallenge(verifier) }));
    });
  });

  router.get('/auth/sso/callback', async (req, res, next) => {
    const sso = req.session.sso;
    delete req.session.sso;
    const { code, state, error } = req.query;
    if (error || !sso || typeof code !== 'string' || typeof state !== 'string' || !safeEqual(sso.state, state)) {
      return page(res, 400, 'failed');
    }
    let tokens;
    let claims;
    let krosConnections;
    try {
      tokens = await authClient.exchangeCode({ code, codeVerifier: sso.verifier });
      ({ claims, krosConnections } = await authClient.meWithKros(tokens.accessToken));
    } catch (err) {
      console.warn('[auth] callback zlyhal:', err.kind || err.message);
      const unavailable = err.kind === 'unavailable';
      return page(res, unavailable ? 503 : 400, unavailable ? 'unavailable' : 'failed');
    }
    if (!claims.email_verified) return page(res, 403, 'unverified');
    if (!claims.active_organization) return page(res, 403, 'no_org');

    let krosConnected = 0;
    try {
      await upsertUser(db, claims);
      await upsertOrganizations(db, claims.organizations);
      krosConnected = await storeBrokerConnections(db, {
        encryptionKey: config.encryptionKey,
        organizationId: claims.active_organization,
        userId: claims.sub,
        connections: krosConnections,
      });
    } catch (err) {
      return next(err);
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.auth = { tokens, claims, claimsFetchedAt: now() };
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.redirect(krosConnected > 0 ? `/?kros_connected=${krosConnected}` : (sso.returnTo || '/'));
      });
    });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE);
      res.redirect(303, authClient.logoutUrl(config.authService.appKey));
    });
  });

  return router;
}
