# Platforma úhrady

Malá servisná webová aplikácia na načítanie neuhradených faktúr z KROS Fakturácie a odoslanie platieb cez KROS OpenAPI.

## Požiadavky

- Node.js 18+

## Inštalácia a spustenie

```bash
npm install
npm start
```

Aplikácia beží na [http://localhost:3000](http://localhost:3000).

## Použitie

1. **Pripojenie** – vyberte prevádzku API (testovacia / ostrá), zadajte API token z nastavení v [fakturacia.kros.sk](https://fakturacia.kros.sk/) a kliknite na „Pripojiť“.
2. **Bankový účet** – vyberte účet, z ktorého sa majú evidovať úhrady (zoznam z KROS).
3. **Načítať faktúry** – stlačte „Načítať neuhradené faktúry“. Zobrazia sa len neuhradené (PaymentStatus=0).
4. **Filtre** – stav splatnosti (všetky / po splatnosti / v termíne), dátum vystavenia, suma od, partner, číselný rad. Filtre sa aplikujú na už načítaný zoznam.
5. **Výber** – označte checkboxom faktúry, ktoré chcete uhradiť. Môžete použiť „Označiť všetky“ / „Odznačiť všetky“.
6. **Dátum úhrady** – nastavte dátum, ktorý sa použije pre všetky vybrané platby.
7. **Uhradiť vybrané** – odošle sa `POST /api/payments/batch` do KROS. Odpoveď 202 znamená prijaté; finálny výsledok príde cez váš webhook v KROS.

## Konfigurácia

- **Premenná prostredia** (voliteľné):
  - `PORT` – port servera (predvolene 3000)
  - `KROS_API_BASE_URL` – predvolená base URL KROS API (ak frontend neposiela X-Kros-Base-URL)

## Štruktúra

- `server.js` – Express server, proxy na KROS API, servuje statický frontend
- `public/index.html` – štruktúra stránky
- `public/styles.css` – štýly
- `public/app.js` – logika prihlásenia, načítania faktúr, filtrov, výberu a odoslania platieb

## API (KROS OpenAPI)

- Overenie tokenu: `GET /api/auth/check`
- Neuhradené faktúry: `GET /api/invoices?PaymentStatus=0&Top=100&Skip=...`
- Bankové účty: `GET /api/payments/accounts`
- Odoslanie platieb: `POST /api/payments/batch` s `{ "data": [ { "dateOfPayment", "sumOfPayment", "variableSymbol", "accountId" }, ... ] }`

Dokumentácia: [KROS OpenAPI dokumentácia](https://www.kros.sk/openapi-dokumentacia/).
