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
// Počas výpadku auth service neskúšame refresh pri každej požiadavke (timeout 5 s by brzdil každý klik).
const REFRESH_RETRY_MS = 60_000;

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

  /**
   * Refresh token sa pri použití rotuje – nové tokeny preto vrátime aj vtedy, keď potom
   * zlyhá /api/me alebo DB (claimsError), inak by sa stratili a ďalší refresh by odhlásil.
   */
  async function refresh(auth) {
    const tokens = await authClient.refresh(auth.tokens.refreshToken);
    try {
      const claims = await authClient.me(tokens.accessToken);
      await upsertUser(db, claims);
      await upsertOrganizations(db, claims.organizations);
      return { tokens, claims, claimsFetchedAt: now() };
    } catch (claimsError) {
      return { tokens, claimsError };
    }
  }

  // Prechodný výpadok (auth service alebo naša DB) je v grace perióde tolerovaný.
  const isTransient = (err) => err.kind === 'unavailable' || !err.kind;

  return async function requireAuth(req, res, next) {
    const auth = req.session?.auth;
    if (!auth) return unauthenticated(req, res);

    const stale = now() - auth.claimsFetchedAt >= claimsTtlMs;
    const withinGrace = now() - auth.claimsFetchedAt < gracePeriodMs;
    const backingOff = withinGrace && now() < (auth.nextRefreshAt || 0);
    if (stale && !backingOff) {
      const logout = (err) => {
        console.warn('[auth] odhlasujem po zlyhaní refreshu:', err.kind || err.message);
        req.session.destroy(() => unauthenticated(req, res));
      };
      try {
        const fresh = await refreshOnce(auth.tokens.refreshToken, () => refresh(auth));
        if (fresh.claimsError) {
          if (!isTransient(fresh.claimsError) || !withinGrace) return logout(fresh.claimsError);
          req.session.auth = { ...auth, tokens: fresh.tokens, nextRefreshAt: now() + REFRESH_RETRY_MS };
        } else {
          if (!fresh.claims.email_verified || !fresh.claims.active_organization) {
            return req.session.destroy(() => unauthenticated(req, res));
          }
          req.session.auth = fresh;
        }
      } catch (err) {
        if (err.kind !== 'unavailable' || !withinGrace) return logout(err);
        req.session.auth = { ...auth, nextRefreshAt: now() + REFRESH_RETRY_MS };
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
