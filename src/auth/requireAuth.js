/** Overenie prihlásenia + ochrana proti CSRF cez Origin. */

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

export function createRequireAuth() {
  return function requireAuth(req, res, next) {
    const auth = req.session?.auth;
    if (!auth) return unauthenticated(req, res);
    attachUser(req, auth.claims);
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
