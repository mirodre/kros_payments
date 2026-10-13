# Automatizácia úhrad a prevodov – návrh

Dátum: 2026-10-13 · Stav: schválené

## Cieľ

Moduly „Úhrada faktúr“ a „Prevod medzi účtami“ dnes vyžadujú ručné klikanie. Používateľ si nad oboma nastaví **pravidlá**, server ich sám raz za hodinu vyhodnotí a pošle platby do KROS. Ručné ovládanie ostáva.

- **Úhrada dokladov** – partner (text, ktorý názov partnera obsahuje), typ dokladov (faktúry / výdavky / oboje), účet úhrady.
- **Prevod medzi účtami** – zdrojový účet, cieľový účet, partner (text v názve partnera platby).

Spoločné: `Spracovať od` (dátum, predvolene deň vytvorenia), zapnuté/vypnuté.

## Nefunkčné požiadavky

- Nikdy nič dvakrát (idempotencia aj pri súbežných behoch a opakovaných pokusoch).
- Nespracúva sa celá história – len doklady/platby od `start_date` a len zmenené od posledného behu (watermark).
- Beží na serveri bez používateľa; latencia do 1 hodiny je OK.

## Architektúra

In-process plánovač v Node serveri (`src/automation/scheduler.js`), interval `AUTOMATION_INTERVAL_MINUTES` (predvolene 60), prvý beh 1 min po štarte. Každý tick si vezme `pg_try_advisory_lock` – viac inštancií/prekryv tickov nič nespustí dvakrát. Tlačidlo „Spustiť teraz“ spustí jedno pravidlo okamžite (tiež pod zámkom pravidla).

Moduly v `src/automation/`:

| súbor | účel |
|---|---|
| `repo.js` | SQL nad `automation_rules` a `automation_items` |
| `krosClient.js` | volania KROS zo servera: token prepojenia, stránkovanie, 429 + `Retry-After`, odstup medzi volaniami |
| `paymentBuilders.js` | payload platby – zrkadlí `paySingleInvoice` a `transferSinglePayment` z `public/app.js` |
| `runner.js` | jeden beh pravidla |
| `scheduler.js` | hodinový plánovač |
| `routes.js` | REST API pre UI (pred KROS proxy) |

## Dáta (`migrations/002_automations.sql`)

`automation_rules`: `id`, `organization_id`, `connection_id` (cascade delete), `kind` (`invoice_payment` \| `transfer`), `enabled`, `partner_text`, `doc_types` (`all` \| `invoices` \| `expenses`), `account_id` (účet úhrady / zdrojový účet), `target_account_id` (len prevod), `start_date`, `watermark`, `last_run_at`, `last_status` (`ok` \| `error` \| `connection_invalid`), `last_error`, `last_summary` (jsonb), `created_by_user_id`, časové pečiatky.

`automation_items`: `id`, `rule_id` (set null pri zmazaní pravidla), `connection_id`, `item_key`, `source_type` (`invoice` \| `expense` \| `payment`), `source_id`, `label`, `amount`, `currency`, `payload` (jsonb), `request_id`, `status` (`pending` \| `sent` \| `confirmed` \| `failed` \| `rejected` \| `skipped_exists`), `attempts`, `error`, časové pečiatky. **UNIQUE (`connection_id`, `item_key`)**.

Kľúče položiek (zároveň `externalId` platby v KROS):
- doklad: `AUTO-INV-<id>` / `AUTO-EXP-<id>`
- prevod: `PID-<zdroj>-<idPlatby>` – rovnaký kľúč ako ručný prevod, ručný modul aj automat sa navzájom vidia. Unikátnosť per firma; pri dvoch pravidlách s rovnakým zdrojom do rôznych cieľov vyhrá prvé (prevod jednej platby na dva účty nedáva zmysel).

## Beh pravidla

1. Token prepojenia; nedešifrovateľný alebo KROS 401 → `connection_invalid`, prepojenie sa označí neplatné, koniec.
2. Opakovanie: položky `failed` s `attempts < 3` (dočasná chyba) sa pošlú znova (z uloženého payloadu, po kontrole ExternalId).
3. `since = max(watermark − 10 min, start_date 00:00)`; pri prvom behu `start_date 00:00`.
4. Načítanie (Top=100, Skip):
   - úhrada: `/api/invoices` a/alebo `/api/expenses` s `PaymentStatus=0&LastModifiedTimestamp=since`; filter: `issueDate ≥ start_date`, názov partnera obsahuje `partner_text` (bez rozlíšenia veľkosti písmen, prázdny = všetci), suma k úhrade ≠ 0.
   - prevod: `/api/payments?AccountId=zdroj&LastModifiedTimestamp=since`; filter: `dateOfPayment ≥ start_date`, `partnerName` obsahuje text, platba má ID. Platby, ktoré sú samy prevodom (`externalId` začína `PID-`), sa preskočia.
5. Pre každú položku: `INSERT … ON CONFLICT DO NOTHING` (pending); konflikt → preskočiť. `GET /api/payments?ExternalId=<key>` – ak existuje → `skipped_exists`. Inak `POST /api/payments/batch` s jednou platbou → 202 `sent` + `requestId`; 400/409/422 → `failed` bez opakovania (attempts=3); 429/5xx/sieť → `failed`, opakuje sa v ďalšom behu.
6. Watermark sa posunie na čas začiatku behu len ak sa načítali všetky stránky.
7. Zmena kritérií pravidla (partner, typ dokladov, účty, start_date) → `watermark = null`.

Webhook s výsledkom (`src/kros/webhook.js`): po uložení callbacku sa položky s rovnakým `requestId` prepnú na `confirmed` (bez problémov) alebo `rejected` (s textom problémov).

Rate limit KROS (10/s, 300/min): volania sekvenčne s odstupom 250 ms, pri 429 čakanie podľa `Retry-After` (max 3×).

## API

Za `requireAuth`, organizácia z session:
- `GET /api/automations?connectionId=…&kind=…`
- `POST /api/automations` · `PUT /api/automations/:id` · `DELETE /api/automations/:id`
- `POST /api/automations/:id/run` – okamžitý beh, vráti súhrn
- `GET /api/automations/:id/items?limit=50`

## UI

V oboch moduloch sekcia „Automatizácia“: zoznam pravidiel aktívnej firmy (popis, stav posledného behu, prepínač, Spustiť teraz, Upraviť, Zmazať), formulár (účty z `/api/payments/accounts`, partner, typ dokladov, Spracovať od) a zoznam posledných položiek so stavom.

## Akceptované riziko

Ručná úhrada faktúry a súčasne bežiaci automat pred spracovaním ručnej úhrady v KROS → možná dvojitá úhrada (ručná úhrada nemá `externalId`). Používateľ akceptoval.

## Testy

PGlite + rozšírený `fakeKros` (dáta, filtre `AccountId`/`ExternalId`/`LastModifiedTimestamp`, zápis prijatých platieb). Pokrytie: druhý beh nič neduplikuje, platba už existujúca v KROS sa nepošle, watermark sa posúva / neposúva pri chybe, filtre partnera a dátumu, prevod kľúčom PID, neplatný token, webhook → confirmed/rejected, API izolované podľa organizácie, advisory lock.
