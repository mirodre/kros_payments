/** Overenie prihlásenia (s obnovou claims) + ochrana proti CSRF cez Origin. */
import { upsertUser, upsertOrganizations } from '../repos.js';

export function unauthenticated(req, res) {
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  return res.redirect(`/login?return=${encodeURIComponent(req.originalUrl)}`);
}

function attachUser(req, claims) {
  req.user = { id: claims.sub, email: claims.email, name: claims.name };
  req.organizationId = claims.active_organization;
  const org = claims.organizations.find((o) => o.id === claims.active_organization);
  req.organization = { id: claims.active_organization, name: org?.name || '' };
}

// Single-flight: auth service rotuje refresh tokeny, paralelné refreshe jednej session by sa
// navzájom zneplatnili. Výsledok držíme ešte chvíľu, lebo požiadavky, ktoré načítali session
// pred uložením nových tokenov, prídu so starým refresh tokenom aj po dokončení refreshu.
const inflight = new Map();
const RESULT_REUSE_MS = 60_000;

function refreshOnce(key, fn) {
  if (!inflight.has(key)) {
    const promise = fn().then(
      (result) => {
        setTimeout(() => inflight.delete(key), RESULT_REUSE_MS).unref();
        return result;
      },
      (err) => {
        inflight.delete(key);
        throw err;
      },
    );
    inflight.set(key, promise);
  }
  return inflight.get(key);
}

export function createRequireAuth({ config, db, authClient, now }) {
  const { claimsTtlMs, gracePeriodMs } = config.authService;

  async function refresh(auth) {
    const tokens = await authClient.refresh(auth.tokens.refreshToken);
    const claims = await authClient.me(tokens.accessToken);
    await upsertUser(db, claims);
    await upsertOrganizations(db, claims.organizations);
    return { tokens, claims, claimsFetchedAt: now() };
  }

  return async function requireAuth(req, res, next) {
    const auth = req.session?.auth;
    if (!auth) return unauthenticated(req, res);

    if (now() - auth.claimsFetchedAt >= claimsTtlMs) {
      try {
        const fresh = await refreshOnce(auth.tokens.refreshToken, () => refresh(auth));
        if (!fresh.claims.email_verified || !fresh.claims.active_organization) {
          return req.session.destroy(() => unauthenticated(req, res));
        }
        req.session.auth = fresh;
      } catch (err) {
        const withinGrace = err.kind === 'unavailable' && now() - auth.claimsFetchedAt < gracePeriodMs;
        if (!withinGrace) {
          console.warn('[auth] odhlasujem po zlyhaní refreshu:', err.kind || err.message);
          return req.session.destroy(() => unauthenticated(req, res));
        }
      }
    }
    attachUser(req, req.session.auth.claims);
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireSameOrigin(appOrigin) {
  return function sameOrigin(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    const referer = req.get('referer');
    const ok = origin ? origin === appOrigin : (!referer || referer.startsWith(`${appOrigin}/`));
    if (!ok) return res.status(403).json({ error: 'forbidden_origin' });
    next();
  };
}
