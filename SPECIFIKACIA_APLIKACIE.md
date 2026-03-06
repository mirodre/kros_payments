# Špecifikácia: Servisná aplikácia „Platforma úhrady“ (KROS OpenAPI)

## Účel

Malá webová aplikácia na interné/servisné použitie, ktorá:
1. sa pripojí k KROS Fakturácii cez **API token** (Bearer),
2. **načíta neuhradené faktúry** z API,
3. zobrazí ich používateľovi s možnosťou **výberu podľa kritérií**,
4. pre vybrané faktúry **vytvorí a odošle platby** cez KROS OpenAPI.

Token si používateľ zadá sám, uloží sa lokálne.

---

## Technické predpoklady API (KROS OpenAPI)

- **Base URL (test):** `https://esw-testlab-openapigateway-api.azurewebsites.net` (toto bude konfigurovateľné, lebo existuje testovacia prevádzka a ostrá prevádzka a chcem sa vedieť medzi nimi prepínať)
- **Autentizácia:** Bearer token v hlavičke `Authorization: Bearer <token>`
- **Dokumentácia:** https://www.kros.sk/openapi-dokumentacia/  
- **Token a callback URL:** používateľ si ich nastaví v aplikácii https://fakturacia.kros.sk/ v sekcii nastavení.

### Dôležité obmedzenia API
- **Rate limit:** max 10 požiadaviek / 1 s, max 300 / 1 min.
- **Duplicitné POST** v časovom okne 120 s sa nebudú spracovávať.
- **Paginácia:** parametre `Top` (max 100) a `Skip` pri zoznamoch.

---

## Funkčné požiadavky

### 1. Prihlásenie / Token
- Stránka (alebo modál) na **zadanie API tokenu**.
- Po zadaní tokenu zavolať **GET /api/auth/check** – ak vráti 200, token je platný a zobrazí sa hlavná funkcionalita; ak 401, zobraziť chybu a možnosť token zmeniť.
- Token nemusí byť trvalo uložený (stačí session alebo „zapamätaj si token v tomto prehliadači“ do localStorage, podľa tvojho rozhodnutia).

### 2. Zoznam neuhradených faktúr
- Zavolať **GET /api/invoices** s parametrom **PaymentStatus=0** (NotPaid).
- Voliteľne použiť:
  - **DueDateStatus=2** (OverDue) ak chceš zobraziť len po splatnosti,
  - **IssueDateFrom** / **IssueDateTo** v formáte `yyyy-MM-dd` (ISO 8601),
  - **ExtendedFields**: napr. `Payments` ak potrebuješ detaily platieb.
- Zohľadniť **pagináciu**: `Top=100`, `Skip` pre ďalšie strany (API vracia max 100 záznamov na požiadavku).
- V zozname zobraziť aspoň:**číselný rad**, **číslo faktúry**, **partner** (názov), **dátum vystavenia**, **dátum splatnosti**, **suma k úhrade** (sumForPayment alebo totalPriceInclVat − sumOfPayments), **variabilný symbol**, **stav splatnosti** (v termíne / po splatnosti).

### 3. Výber faktúr na úhradu
- Používateľ môže **označiť** (checkbox) konkrétne faktúry, ktoré chce uhradiť. Bude tam možnosť aj hromadne označiť.
- Prípadne **filtre / kritériá**: napr. „iba po splatnosti“, „iba nad X eur“, „iba partner X“, číselný rad – podľa toho, čo budeš potrebovať (môžeš začať len checkboxom a filtre doplniť neskôr).
- Pre každú vybranú faktúru bude potrebné pri vytváraní platby použiť:
  - **sumOfPayment** = suma k úhrade (z API napr. `sumForPayment` alebo (totalPriceInclVat − sumOfPayments)),
  - **variableSymbol** = z faktúry (variableSymbol),
  - **dateOfPayment** = dátum úhrady (typicky dnešný dátum v UTC, formát `yyyy-MM-dd`),
  - **accountId** = ID bankového účtu v KROS (získať z **GET /api/payments/accounts** – používateľ môže vybrať účet zo zoznamu).

### 4. Bankové účty
- Pred vytvorením platieb zavolať **GET /api/payments/accounts** a zobraziť zoznam účtov (názov, IBAN, mena).
- V UI umožniť **výber účtu**, z ktorého sa „úhrady“ evidujú (do platby sa pošle **accountId**).

### 5. Vytvorenie a odoslanie platieb
- Po výbere faktúr a účtu tlačidlom „Uhradiť vybrané“ (alebo podobne):
  - Pre každú vybranú faktúru zostaviť objekt **Payment** podľa schémy API:
    - **dateOfPayment** (povinné), **sumOfPayment** (povinné),
    - **variableSymbol**, **accountId**, prípadne **remittanceInformation** (správa pre prijímateľa) alebo **paymentReference**.
  - Zavolať **POST /api/payments/batch** s telom typu **PaymentListApiRequestBody**: `{ "data": [ ...pole platieb... ] }`.
- API vracia **202 Accepted** a v odpovedi **requestId** (UUID). Spracovanie je asynchrónne – výsledok príde cez **callback (webhook)** na URL, ktorú má používateľ nastavenú v KROS Fakturácii. V aplikácii stačí zobraziť používateľovi, že platby boli odoslané (202) a že výsledky dostane cez svoj callback / v systéme.

### 6. Ošetrenie chýb a limitov
- Pri **401** zobraziť správu o neplatnom tokene a vrátiť na zadanie tokenu.
- Pri **429** (Too Many Requests) zobraziť upozornenie a odporučiť počkať (v hlavičke môže byť **retry-after**).
- Pri **409** (Conflict) – duplicitná požiadavka – informovať používateľa, že rovnaký request už bol nedávno odoslaný (počkať 120 s).
- Pri **400** (Bad Request) zobraziť validačné chyby z odpovede (ValidationResult.errors).

---

## Odporúčaná štruktúra obrazoviek / flow

1. **Úvodná stránka**  
   - Pole na API token + tlačidlo „Pripojiť“ (volanie `/api/auth/check`).

2. **Hlavná stránka (po prihlásení)**  
   - Výber bankového účtu (dropdown zo `/api/payments/accounts`).  
   - Tlačidlo „Načítať neuhradené faktúry“ → GET `/api/invoices?PaymentStatus=0&Top=100&Skip=...` (paginácia podľa potreby).  
   - Tabuľka/zoznam faktúr s checkboxmi na výber.  
   - Voliteľné filtre (dátum, partner, suma, po splatnosti).  
   - Tlačidlo „Uhradiť vybrané“ → POST `/api/payments/batch` s vybranými platbami.  
   - Zobrazenie výsledku (úspech 202 + informácia o callbacku, alebo chybová hláška).

3. **Odhlásenie / zmena tokenu**  
   - Možnosť vymazať token a vrátiť sa na úvodnú obrazovku.

---

## Štruktúra dát z API (stručný prehľad)

### Faktúra (reakcia GET /api/invoices, položky v `data[]`)
- `id`, `documentNumber`, `numberingSequence`, `externalId`
- `partner` (objekt s adresou, názvom)
- `issueDate`, `dueDate`, `deliveryDate`
- `paymentStatus` (0 = NotPaid, 1 = FullyPaid, …)
- `prices` (documentPrices.totalPriceInclVat, …), `sumOfPayments`, `sumForPayment`
- `variableSymbol`, `bankAccount`, `orderNumber`

### Platba na odoslanie (POST /api/payments/batch, položky v `data[]`)
- **dateOfPayment** (string, `yyyy-MM-dd`) – povinné
- **sumOfPayment** (number) – povinné
- **variableSymbol** (string, max 10) – odporúčané (pre párovanie s faktúrou)
- **accountId** (long, nullable) – ID z GET /api/payments/accounts
- Voliteľné: remittanceInformation, paymentReference, partnerName, note, externalId, paymentType (1=BankTransfer, 2=CardPayment)

### Odpoveď POST /api/payments/batch (202)
- `requestId` (UUID) – na identifikáciu requestu; finálny výsledok príde cez webhook na callback URL.

---

## Technológie (návrh – môžeš upraviť)

- **Frontend:** React, Vue alebo čistý HTML/JS – podľa preferencií.
- **Backend:**  
  - Buď **žiadny** (čisto SPA s CORS – ak API povolí volania z prehliadača z tvojej domény).  
  - Alebo **minimal backend** (Node/Express, .NET, atď.) ako proxy, ktorý pridáva Bearer token k requestom (aby token nebol v kóde frontendu). Pre servisnú internú aplikáciu môže stačiť aj SPA s tokenom v pamäti/localStorage, ak to s tebou súhlasí bezpečnostné nastavenie.
- **Štýlovanie:** podľa uváženia (Tailwind, Bootstrap, alebo vlastné minimum).

---

## Checklist pre vývojára / AI

- [ ] Zadanie a overenie API tokenu (GET /api/auth/check).
- [ ] Načítanie neuhradených faktúr (GET /api/invoices, PaymentStatus=0, paginácia).
- [ ] Zobrazenie zoznamu s číslami, partnerom, sumou, VS, splatnosťou.
- [ ] Výber faktúr (checkboxy) a výber bankového účtu (GET /api/payments/accounts).
- [ ] Zostavenie payloadu platieb a odoslanie POST /api/payments/batch.
- [ ] Spracovanie 202, 400, 401, 409, 429 a zobrazenie používateľovi.
- [ ] Voliteľné: filtre (po splatnosti, dátum, partner, suma).
- [ ] Voliteľné: uloženie tokenu do session/localStorage.

Tento dokument môžeš použiť ako **prompt pre AI** (napr. Cursor) alebo ako **špecifikáciu pre vývojára** na implementáciu aplikácie „Platforma úhrady“.
