# Platforma úhrady

Malá servisná webová aplikácia na načítanie neuhradených faktúr z KROS aplikácie a odoslanie platieb cez KROS OpenAPI.

## Požiadavky

- Node.js 22+
- Produkcia: PostgreSQL a OAuth klient v [login.krosdoplnky.sk](https://login.krosdoplnky.sk) – pozri [docs/DEPLOY.md](docs/DEPLOY.md)

## Lokálny vývoj

Bez Dockeru aj bez Postgresu – databáza beží v procese (PGlite), prihlásenie obsluhuje falošný auth service.

1. `npm install`
2. Skopíruj `.env.example` → `.env` a nastav:
   - `APP_URL=http://localhost:3000`
   - `DATABASE_URL=pglite:./.data/pg`
   - `AUTH_SERVICE_URL=http://localhost:8100`, `AUTH_SERVICE_CLIENT_ID=client-1`, `AUTH_SERVICE_CLIENT_SECRET=secret-1`
   - `AUTH_SERVICE_REDIRECT_URI=http://localhost:3000/auth/sso/callback`
   - `SESSION_SECRET` (`openssl rand -base64 48`) a `APP_ENCRYPTION_KEY` (`openssl rand -base64 32`)
3. V jednom termináli `npm run dev:auth` (falošný login, automaticky prihlási „Alica Testová“; iný používateľ: `DEV_AUTH_USER=bob`).
4. V druhom `npm run dev` → [http://localhost:3000](http://localhost:3000).

Testy: `npm test`.

## Použitie

1. **Prihlásenie** – aplikácia vyžaduje účet na login.krosdoplnky.sk. **Prepojenie** – tlačidlo „Prepojiť s KROS“ presmeruje na KROS consent stránku; tokeny firiem uloží server (šifrované) pod vašu organizáciu, do prehliadača sa nedostanú.
2. **Bankový účet** – vyberte účet, z ktorého sa majú evidovať úhrady (zoznam z KROS).
3. **Načítať faktúry** – stlačte „Načítať neuhradené faktúry“. Zobrazia sa len neuhradené (PaymentStatus=0).
4. **Filtre** – stav splatnosti (všetky / po splatnosti / v termíne), dátum vystavenia, suma od, partner, číselný rad. Filtre sa aplikujú na už načítaný zoznam.
5. **Výber** – označte checkboxom faktúry, ktoré chcete uhradiť. Môžete použiť „Označiť všetky“ / „Odznačiť všetky“.
6. **Dátum úhrady** – nastavte dátum, ktorý sa použije pre všetky vybrané platby.
7. **Uhradiť vybrané** – odošle sa `POST /api/payments/batch` do KROS. Odpoveď 202 znamená prijaté; finálny výsledok príde cez váš webhook v KROS aplikácii.

## Konfigurácia

Všetko cez env premenné – pozri [.env.example](.env.example) a [docs/DEPLOY.md](docs/DEPLOY.md).

## Štruktúra

- `server.js` – štart: konfigurácia, migrácie, Express
- `src/app.js` – zostavenie aplikácie (session, prihlásenie, KROS routy)
- `src/auth/` – OAuth2 + PKCE klient na login.krosdoplnky.sk, prihlásenie, obnova session
- `src/kros/` – prepojenie s KROS, webhook, API prepojení, proxy na KROS Open API
- `src/db.js`, `src/repos.js`, `migrations/` – databáza (Postgres / PGlite)
- `public/` – frontend (SPA)
- `tests/` – testy (`node:test`)

## API (KROS OpenAPI)

- Overenie tokenu: `GET /api/auth/check`
- Neuhradené faktúry: `GET /api/invoices?PaymentStatus=0&Top=100&Skip=...`
- Bankové účty: `GET /api/payments/accounts`
- Odoslanie platieb: `POST /api/payments/batch` s `{ "data": [ { "dateOfPayment", "sumOfPayment", "variableSymbol", "accountId" }, ... ] }`

Dokumentácia: [KROS OpenAPI dokumentácia](https://www.kros.sk/openapi-dokumentacia/).
