# Nasadenie – financie.krosdoplnky.sk

Aplikácia sa inštaluje z `package-lock.json` (`npm ci`), `node_modules` nie je v repe. Potrebuje Node.js 22+.

## 1. Postgres (Dokploy)
1. V projekte pridaj službu **PostgreSQL** (napr. `financie-db`), zapni zálohy (Backups → S3, denne).
2. Internú connection string vlož do aplikácie ako `DATABASE_URL`.
3. Migrácie sa spustia automaticky pri štarte aplikácie.

## 2. OAuth klient v authentication_service
V produkčnom kontajneri login.krosdoplnky.sk:

```bash
php artisan passport:client --public=0 --name="financie" --redirect_uri="https://financie.krosdoplnky.sk/auth/sso/callback"
```

Vypíše `Client ID` a `Client secret` → `AUTH_SERVICE_CLIENT_ID`, `AUTH_SERVICE_CLIENT_SECRET`.

V env authentication_service:
- pridaj Client ID do `PASSPORT_TRUSTED_CLIENTS` (čiarkou oddelené) – inak každé prihlásenie skončí 403,
- pridaj `financie=https://financie.krosdoplnky.sk` do `AUTH_RETURN_APPS` (návrat po odhlásení),
- redeploy a `php artisan auth:check-config`.

## 3. Env aplikácie
Pozri `.env.example`. Produkčné hodnoty:

```
APP_URL=https://financie.krosdoplnky.sk
DATABASE_URL=postgres://…
SESSION_SECRET=…
APP_ENCRYPTION_KEY=…
AUTH_SERVICE_URL=https://login.krosdoplnky.sk
AUTH_SERVICE_CLIENT_ID=…
AUTH_SERVICE_CLIENT_SECRET=…
AUTH_SERVICE_REDIRECT_URI=https://financie.krosdoplnky.sk/auth/sso/callback
AUTH_SERVICE_APP_KEY=financie
```

Tajomstvá vygeneruj:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # APP_ENCRYPTION_KEY (zmena = všetky KROS prepojenia treba obnoviť)
```

## 4. Overenie
1. `https://financie.krosdoplnky.sk/api/ping` → `{"ok":true,"db":true,…}`
2. Otvor aplikáciu → presmeruje na login → po prihlásení späť.
3. „Prepojiť s KROS“ → po návrate je firma v zozname, moduly fungujú. (Staré prepojenia z prehliadača sa neprenášajú – každá firma sa prepojí znova, KROS tým dostane aj novú URL webhooku.)
4. Po prvej úhrade skontroluj v logoch, či webhook nemá `neplatný alebo chýbajúci podpis`. Ak áno, pozri `signature_header` v tabuľke `kros_payment_callbacks` a uprav `verifyKrosSignature` v `src/kros/webhook.js`.
