# Prihlasovanie cez login.krosdoplnky.sk + serverové KROS prepojenia

Dátum: 2026-10-12 · Stav: schválené

## Cieľ

Aplikácia „Financie“ (kros_payments) beží na `https://financie.krosdoplnky.sk`. Doplníme:

1. Povinné prihlásenie cez centrálny auth service `https://login.krosdoplnky.sk` (OAuth2 Authorization Code + PKCE, confidential klient).
2. Postgres databázu.
3. KROS prepojenia (tokeny firiem) a webhook výsledky uložené na serveri, vlastnené **organizáciou** (z `/api/me`), s auditom, **ktorý používateľ** prepojenie vytvoril.

Mimo rozsahu (ďalší projekt): plánovač kontroly transakcií v KROS a pravidlá pre automatické úhrady / prevody. Schéma ich nesmie blokovať.

Existujúce prepojenia v `localStorage` sa **neprenášajú** — používateľ sa po prihlásení prepojí s KROS znova.

## Architektúra

Jeden Node proces (Express 4, plain JS ESM, bez build kroku). Nové závislosti:
`express-session`, `pg`; dev: `@electric-sql/pglite` (Postgres vo WASM — testy a lokálny vývoj bez Dockeru cez `DATABASE_URL=pglite:memory` alebo `pglite:./.data/pg`). Migrácie aj session store sú vlastné (malé, nad spoločným rozhraním `db.query`/`db.exec`/`db.withClient`), aby fungovali s `pg` aj PGlite. Session dáta sa v DB ukladajú **šifrované** (`APP_ENCRYPTION_KEY`), lebo obsahujú refresh token. OAuth klient je vlastný (~150 riadkov, `fetch` + `node:crypto`), port logiky `AuthServiceClient`/`SsoFlow`/`RefreshSsoClaims` z `C:\Cursor\payment_connector`.

Server kód sa rozdelí do modulov v `src/`:

| modul | zodpovednosť |
|---|---|
| `src/config.js` | načítanie a validácia env |
| `src/db.js` | `pg` Pool, health check |
| `src/crypto.js` | AES-256-GCM encrypt/decrypt, náhodné tokeny, PKCE |
| `src/auth/authServiceClient.js` | HTTP volania na auth service (token, refresh, `/api/me`) |
| `src/auth/routes.js` | `/login`, `/auth/sso/callback`, `/logout` |
| `src/auth/requireAuth.js` | middleware: session → refresh claims → `req.user`, `req.organizationId` |
| `src/repos/*.js` | SQL dotazy (users, organizations, connections, consentRequests, callbacks) |
| `src/kros/consent.js` | `/kros/connect`, `POST /kros/callback` |
| `src/kros/webhook.js` | `/kros/payments-callback/:webhookKey`, overenie podpisu |
| `src/kros/connectionsApi.js` | `/api/kros/connections` |
| `src/kros/proxy.js` | doplnenie KROS tokenu podľa `X-Kros-Connection` |
| `src/app.js` | zostavenie Express app (exportuje `createApp(deps)` pre testy) |
| `server.js` | štart: config → migrácie → `createApp` → listen |

Existujúce vlastné handlery (`/api/payments/batch`, `/api/payments`, `/api/invoices`) sa presunú do `src/kros/` bez zmeny logiky, len token berú z `req.krosToken`.

## Dátový model

```sql
organizations (
  id text primary key,              -- ULID z auth service
  name text not null,
  webhook_key text not null unique, -- náhodných 32 B base64url
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

users (
  id text primary key,              -- sub z /api/me
  email text not null,
  name text,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
)

kros_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id),
  kros_company_id text not null,
  company_name text not null,
  token_enc text not null,
  webhook_secret_enc text,
  invalid_at timestamptz,           -- napr. token nejde dešifrovať / KROS 401
  created_by_user_id text not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kros_company_id)
)

kros_consent_requests (
  state text primary key,           -- 32 B base64url
  organization_id text not null references organizations(id),
  user_id text not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz
)

kros_payment_callbacks (
  id bigserial primary key,
  organization_id text not null references organizations(id),
  connection_id uuid references kros_connections(id) on delete set null,
  received_at timestamptz not null default now(),
  signature_header text,
  signature_valid boolean not null,
  payload jsonb not null
)

sessions (
  sid text primary key,
  data text not null,               -- AES-256-GCM(JSON session)
  expires_at timestamptz not null
)

schema_migrations (name text primary key, applied_at timestamptz)  -- runner migrácií
```

Členstvo v organizácii sa neukladá — pravdou sú claims v session (`organizations`, `active_organization` z `/api/me`), obnovované každých 15 min.

Odpojenie prepojenia (`DELETE`) je hard delete riadku; callbacky ostávajú (`connection_id → null`).

## Prihlásenie a session

**Login flow**

1. `GET /login?return=/cesta` — vygeneruje `state` + PKCE `code_verifier` (S256), uloží ich spolu s `return` (len relatívna cesta začínajúca `/`, nie `//`) do session, redirect na `${AUTH_SERVICE_URL}/oauth/authorize` s `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `state`.
2. `GET /auth/sso/callback?code&state` — overí `state` (a zmaže ho zo session), `POST /oauth/token` (`grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code`, `code_verifier`), `GET /api/me`, upsert `users` + `organizations`, `req.session.regenerate()`, uloží `auth = { tokens: {access, refresh, expiresAt}, claims, claimsFetchedAt }`, redirect na `return` alebo `/`.
3. `email_verified=false` → stránka „Over si e-mail“ s odkazom na `${AUTH_SERVICE_URL}/profil`; do aplikácie sa nepustí.
4. `active_organization=null` → chybová stránka „Účet nemá organizáciu“.

**`requireAuth`**

- Bez `session.auth`: HTML požiadavka → 302 `/login?return=<pôvodná cesta>`, `/api/*` → `401 {error:"unauthenticated"}`.
- `claimsFetchedAt` starší ako `CLAIMS_TTL` (900 s): `refresh_token` grant → `/api/me` → uloží nové tokeny a claims.
  - `invalid_grant` alebo 401 → `session.destroy()`, správa sa ako bez session.
  - Sieťová chyba / timeout (5 s) / 5xx a `now - claimsFetchedAt < GRACE_PERIOD` (86400 s) → pokračuje so starými claims.
  - Inak → odhlásenie.
- Nastaví `req.user = {id, email, name}`, `req.organizationId = claims.active_organization`.

**Odhlásenie:** `POST /logout` → `session.destroy()` → 303 na `${AUTH_SERVICE_URL}/logout?app=${AUTH_SERVICE_APP_KEY}&path=/`.

**Cookie:** `financie_sid`, `HttpOnly`, `Secure` (v produkcii), `SameSite=Lax`, `maxAge` 30 dní. `app.set('trust proxy', 1)` (Traefik).

**CSRF:** `SameSite=Lax` + kontrola `Origin` (musí sa rovnať `APP_URL` origin) na POST/PUT/PATCH/DELETE pod `/api/*` a `/logout`. Odstrániť `Access-Control-Allow-Origin: *`.

**Verejné cesty (bez `requireAuth`):** `/api/ping`, `/login`, `/auth/sso/callback`, `POST /kros/callback`, `/kros/payments-callback/*`, statické assety okrem `index.html` (ikony, manifest, css, js — neobsahujú dáta).

## KROS prepojenia

**Consent flow** (KROS posiela výsledok cross-site POST-om, pri ktorom sa `SameSite=Lax` cookie nepošle — preto väzba cez DB, nie session):

1. `GET /kros/connect` (prihlásený) — vloží `kros_consent_requests` (`state`, org, user, `expires_at = now + 15 min`), redirect na `https://firma.kros.sk/integration-consent` s parametrami ako dnes (`plugin_name=PlatformaUhrady`, `response_mode=post`, `company_mode=multiple`, `state`, `redirect_url=${APP_URL}/kros/callback`, `webhook=${APP_URL}/kros/payments-callback/${webhook_key}`).
2. `POST /kros/callback` — atomicky označí požiadavku ako použitú (`update … set used_at=now() where state=$1 and used_at is null and expires_at > now() returning …`); pri neúspechu 303 na `/?kros_error=state`. Pre každé `data[i]` upsert `kros_connections` (šifrovaný `token`, `webhookSecret`; `invalid_at = null`). 303 na `/?kros_connected=<počet>`.
3. `GET /kros/callback` → redirect `/` (ako dnes).

Tokeny už neprechádzajú prehliadačom; medzistránka so `sessionStorage` zaniká.

**API** (vždy filtrované `organization_id = req.organizationId`):

- `GET /api/kros/connections` → `[{id, companyId, companyName, createdBy:{id,name,email}, createdAt, invalid}]`
- `DELETE /api/kros/connections/:id` → 204 / 404
- `GET /api/kros-callbacks?sinceSeq=` → `{ items: [{seq:id, receivedAt, connectionId, signatureValid, payload}], lastSeq }` (zachovať tvar, ktorý dnes číta frontend)

**Proxy:** frontend posiela `X-Kros-Connection: <uuid>` namiesto `Authorization`. Middleware `withKrosConnection` načíta prepojenie v rámci organizácie (inak 404 `connection_not_found`), dešifruje token (pri zlyhaní nastaví `invalid_at`, vráti 409 `connection_invalid`), nastaví `req.krosToken`. Generický proxy aj vlastné handlery posielajú `Authorization: Bearer ${req.krosToken}` na `KROS_API_BASE`. Hlavička `X-Kros-Base-URL` sa ignoruje a odstráni z frontendu. Ak KROS vráti 401, prepojenie sa označí `invalid_at` a odpoveď sa prepošle.

**Webhook `POST /kros/payments-callback/:webhookKey[/*]`:** raw body (`express.raw`), organizácia podľa `webhook_key` (neznámy → 404). Podpis `x-kros-signature-256`: podľa poznámky v dnešnom kóde KROS podpisuje „HMACSHA256, Base64, UTF-16LE“. Overuje sa HMAC-SHA256 so `webhookSecret` každého prepojenia organizácie, kandidáti: kľúč UTF-8/UTF-16LE × telo UTF-16LE/raw bajty × výstup Base64/hex, voliteľný prefix `sha256=`; porovnanie `timingSafeEqual`. Zhoda → `signature_valid=true`, `connection_id` = to prepojenie. Bez zhody → uloží sa s `signature_valid=false`, warn log (bez obsahu secretov). Odpoveď vždy 200 (ako dnes). Presný formát podpisu sa overí na reálnom webhooku; potom sa neplatné podpisy začnú odmietať (mimo tohto projektu). `GET` na rovnakú cestu = reachability check 200. Starý endpoint bez kľúča (`/kros/payments-callback`) vráti 200 a webhook zahodí s warn logom (nevieme ho priradiť organizácii; po novom prepojení KROS dostane novú URL).

Proxy na KROS nikdy nepreposiela `cookie`, `origin`, `referer`, `x-kros-connection` ani `set-cookie` z odpovede.

## Frontend (`public/app.js`, `public/index.html`)

- Pri štarte vymazať `localStorage` kľúče `platforma_uhrady_token`, `platforma_uhrady_api_base`, `platforma_uhrady_kros_connections`, `platforma_uhrady_kros_pending_state`. Ponechať `_kros_selected_company_id` (teraz uchováva `connection id`), `_settings`, `_transfer`.
- Zoznam firiem z `GET /api/kros/connections`; „Prepojiť s KROS“ → `location.href='/kros/connect'`; možnosť firmu odpojiť.
- Spracovať `?kros_connected=N` / `?kros_error=state` toastom a vyčistiť URL.
- Používateľ (`GET /api/me` aplikácie → `{name, email, organization}`) v hlavičke + tlačidlo „Odhlásiť“ (form `POST /logout`).
- Spoločný `apiCall` wrapper: posiela `X-Kros-Connection` vybranej firmy; pri `401` s telom `{error:"unauthenticated"}` (naša session) → `location.href='/login?return=' + aktuálna cesta`. Iný `401` je od KROS (neplatný token firmy) → hláška „Prepojenie s firmou je neplatné, prepojte znova“ (prepojenie sa už nemaže lokálne).
- „Zrušiť prepojenie“ → `DELETE /api/kros/connections/:id` aktívnej firmy (s potvrdením).
- Odstrániť hidden input `api-base`, hlavičky `Authorization` a `X-Kros-Base-URL`, hlášky s `localhost:3000`.

## Konfigurácia

```
APP_URL=https://financie.krosdoplnky.sk
DATABASE_URL=postgres://…
SESSION_SECRET=…                 # min. 32 znakov
APP_ENCRYPTION_KEY=…             # 32 B base64
AUTH_SERVICE_URL=https://login.krosdoplnky.sk
AUTH_SERVICE_CLIENT_ID=…
AUTH_SERVICE_CLIENT_SECRET=…
AUTH_SERVICE_REDIRECT_URI=https://financie.krosdoplnky.sk/auth/sso/callback
AUTH_SERVICE_APP_KEY=financie
KROS_API_BASE=https://api-economy.kros.sk
PORT=3000
```

Chýbajúca povinná premenná → štart zlyhá s jasnou hláškou. Migrácie (`migrations/*.sql`, vlastný runner s `pg_advisory_lock`) sa spúšťajú pri štarte. Lokálny vývoj: `DATABASE_URL=pglite:./.data/pg` + `npm run dev:auth` (falošný auth service na `localhost:8100`, automaticky prihlási testovacieho používateľa); `npm run dev` načíta `.env` cez `node --env-file-if-exists`.

## Nasadenie (`docs/DEPLOY.md`)

1. Dokploy: služba Postgres + zálohy, `DATABASE_URL` do aplikácie.
2. authentication_service (produkčný kontajner) — vykoná používateľ:
   `php artisan passport:client --public=0 --name="financie" --redirect_uri="https://financie.krosdoplnky.sk/auth/sso/callback"`
3. authentication_service env: client ID do `PASSPORT_TRUSTED_CLIENTS`, `financie=https://financie.krosdoplnky.sk` do `AUTH_RETURN_APPS`, `php artisan auth:check-config`.
4. Env aplikácie, deploy, overenie `/api/ping`, prihlásenie, prepojenie s KROS.

## Chybové stavy

| situácia | správanie |
|---|---|
| zlý/expirovaný `state` pri SSO | stránka „Prihlásenie zlyhalo“ + odkaz `/login` |
| chyba z `/oauth/authorize` (`?error=`) | rovnaká stránka |
| auth service nedostupný pri prvom logine | 503 stránka |
| auth service nedostupný pri refreshi | grace 24 h |
| zlý/expirovaný `state` pri KROS consente | `/?kros_error=state` + toast |
| DB nedostupná | 503 na API, `/api/ping` → `{ok:false, db:false}` |
| token nejde dešifrovať | `invalid_at`, 409, výzva na nové prepojenie |

Nikdy nelogovať tokeny, secrety, `code`, `code_verifier`.

## Testovanie

`node:test` (`npm test`), bez ďalších frameworkov.

- **Unit:** PKCE (S256 vektor z RFC 7636), encrypt/decrypt round-trip + poškodený ciphertext zlyhá, rozhodovanie refresh/grace/logout, overenie podpisu webhooku (hex aj `sha256=`), validácia `return` cesty, config validácia.
- **Integračné** (PGlite in-memory, čistá DB pre každý test súbor; falošný auth service ako in-process Express; falošné KROS API ako in-process Express):
  - celý login flow → session → `/api/me`
  - `/api/*` bez session → 401; HTML → 302 `/login`
  - refresh po expirácii claims; `invalid_grant` → odhlásenie; výpadok → grace
  - consent callback bez cookie uloží prepojenie pod správnu organizáciu; použitý/expirovaný `state` odmietnutý
  - izolácia: organizácia B nevidí prepojenia ani callbacky A, proxy s cudzím `X-Kros-Connection` → 404
  - proxy doplní `Authorization` a ignoruje `X-Kros-Base-URL`
  - webhook s platným/neplatným podpisom
- **Manuálne na produkcii:** login, prepojenie s KROS, platba, formát podpisu reálneho webhooku.
