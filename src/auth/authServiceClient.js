/** HTTP klient na login.krosdoplnky.sk (OAuth2 authorization code + PKCE, /api/me). */

export class AuthServiceError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'AuthServiceError';
    this.kind = kind;
    this.status = status;
  }
}

export function createAuthServiceClient({ url, clientId, clientSecret, redirectUri, timeoutMs }, fetchImpl = fetch) {
  async function call(path, init) {
    let res;
    try {
      res = await fetchImpl(url + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new AuthServiceError('unavailable', `Auth service nedostupný: ${err.name}`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status >= 500) throw new AuthServiceError('unavailable', `Auth service vrátil ${res.status}`, res.status);
    if (res.status === 401) throw new AuthServiceError('unauthorized', 'Neplatný token', 401);
    if (res.status === 400 && body?.error === 'invalid_grant') {
      throw new AuthServiceError('invalid_grant', 'Neplatný grant', 400);
    }
    if (!res.ok || !body) throw new AuthServiceError('bad_response', `Neočakávaná odpoveď ${res.status}`, res.status);
    return body;
  }

  async function token(params, previousRefreshToken) {
    const body = await call('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    if (!body.access_token) throw new AuthServiceError('bad_response', 'Chýba access_token');
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || previousRefreshToken,
      expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
    };
  }

  return {
    authorizeUrl({ state, codeChallenge }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      });
      return `${url}/oauth/authorize?${params}`;
    },
    exchangeCode({ code, codeVerifier }) {
      return token({ grant_type: 'authorization_code', redirect_uri: redirectUri, code, code_verifier: codeVerifier });
    },
    refresh(refreshToken) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
    },
    async me(accessToken) {
      return (await this.meWithKros(accessToken)).claims;
    },
    /**
     * `/api/me?kros=1`: claims + access tokeny na KROS OpenAPI, ktoré po launchi z KROS
     * (Token Broker) doručil broker. Vyzdvihnutie je jednorazové – kto ich dostane, musí ich uložiť.
     */
    async meWithKros(accessToken) {
      const body = await call('/api/me?kros=1', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
      if (!body.sub) throw new AuthServiceError('bad_response', '/api/me bez sub');
      const { kros_connections: krosConnections, ...claims } = body;
      return {
        claims: { ...claims, organizations: Array.isArray(claims.organizations) ? claims.organizations : [] },
        krosConnections: Array.isArray(krosConnections) ? krosConnections : [],
      };
    },
    logoutUrl(appKey) {
      return `${url}/logout?${new URLSearchParams({ app: appKey, path: '/' })}`;
    },
  };
}
