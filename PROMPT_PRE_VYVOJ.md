# Prompt pre vytvorenie aplikácie (skopíruj do Cursor / ChatGPT)

---

**Zadanie:**  
Vytvor malú webovú aplikáciu (frontend + voliteľne jednoduchý backend), ktorá:

1. **Pripojí sa na KROS OpenAPI** pomocou Bearer tokenu. Používateľ zadá token do formulára; aplikácia overí platnosť volaním **GET** `https://esw-testlab-openapigateway-api.azurewebsites.net/api/auth/check` s hlavičkou `Authorization: Bearer <token>`.

2. **Načíta neuhradené faktúry** volaním **GET** `/api/invoices?PaymentStatus=0&Top=100&Skip=0` (a ďalšie strany podľa potreby). V zozname zobraz: číslo faktúry, partner (názov), dátum vystavenia, dátum splatnosti, sumu k úhrade (napr. sumForPayment alebo totalPriceInclVat − sumOfPayments), variabilný symbol. Umožni pagináciu ak je faktúr viac ako 100.

3. **Umožni výber faktúr** (checkboxy). Pred vytvorením platieb načítaj bankové účty cez **GET** `/api/payments/accounts` a umožni výber jedného účtu (accountId).

4. **Pre vybrané faktúry vytvor platby** a odošli ich cez **POST** `/api/payments/batch`. Telo: `{ "data": [ { "dateOfPayment": "yyyy-MM-dd", "sumOfPayment": <number>, "variableSymbol": "<z faktúry>", "accountId": <id z účtu> }, ... ] }`. Dátum úhrady nech je napr. dnešný (UTC). API vracia 202 Accepted a requestId; spracovanie je asynchrónne (výsledok cez webhook v KROS).

5. **Ošetri chyby:** 401 (neplatný token), 429 (rate limit), 409 (duplicitný request), 400 (validačné chyby). Zobraz používateľovi zrozumiteľné hlášky.

**API dokumentácia (OpenAPI/Swagger):**  
https://esw-testlab-openapigateway-api.azurewebsites.net/swagger/Api%20endpoints/swagger.json  

**Obmedzenia API:** max 10 req/s, max 300 req/min; duplicitný POST do 120 s sa ignoruje; paginácia Top max 100.

Aplikácia je na interné servisné použitie: používateľ zadá token, zobrazia sa neuhradené faktúry, vyberie čo uhradiť, zvolí účet a odošle platby. Jednoduché, prehľadné UI (môže byť jedna stránka s sekciami: token → zoznam faktúr → výber → odoslanie platieb).

---

*Podrobná špecifikácia je v súbore SPECIFIKACIA_APLIKACIE.md.*
