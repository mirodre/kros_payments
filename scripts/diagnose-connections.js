/**
 * Diagnostika prepojení s KROS: pre každú firmu vypíše odtlačok tokenu (nie token)
 * a bankové účty, ktoré KROS pre ten token vráti. Odhalí, či viac firiem zdieľa
 * jeden token, alebo či KROS pre token firmy vracia aj účty iných firiem.
 *
 * Spustenie v kontajneri aplikácie (používa jej env):
 *   node scripts/diagnose-connections.js [organizationId]
 */
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { decrypt } from '../src/crypto.js';

const config = loadConfig();
const db = await createDb(config.databaseUrl);
const orgFilter = process.argv[2] || null;

const { rows } = await db.query(
  `select id, organization_id, kros_company_id, company_name, token_enc, invalid_at
   from kros_connections
   where ($1::text is null or organization_id = $1)
   order by organization_id, company_name`,
  [orgFilter],
);

const accountsByToken = new Map();
const companiesByToken = new Map();
for (const r of rows) {
  let token;
  try {
    token = decrypt(r.token_enc, config.encryptionKey);
  } catch {
    console.log(`${r.organization_id} | ${r.company_name} (${r.kros_company_id}) | token sa nedá dešifrovať`);
    continue;
  }
  const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
  companiesByToken.set(fingerprint, (companiesByToken.get(fingerprint) || 0) + 1);
  let accounts = accountsByToken.get(fingerprint);
  if (!accounts) {
    const res = await fetch(`${config.krosApiBase}/api/payments/accounts`, { headers: { Authorization: `Bearer ${token}` } });
    accounts = res.ok ? ((await res.json())?.data || []) : `HTTP ${res.status}`;
    accountsByToken.set(fingerprint, accounts);
  }
  console.log(`\n${r.organization_id} | ${r.company_name} (${r.kros_company_id}) | token ${fingerprint}${r.invalid_at ? ' | neplatné' : ''}`);
  if (typeof accounts === 'string') console.log(`  účty: ${accounts}`);
  else for (const a of accounts) console.log(`  ${a.id}\t${a.name}\t…${String(a.iban || '').slice(-4)}`);
}

const shared = [...companiesByToken].filter(([, n]) => n > 1).map(([fp]) => fp);
console.log(shared.length ? `\nPOZOR: rovnaký token má viac firiem: ${shared.join(', ')}` : '\nKaždá firma má vlastný token.');
await db.close?.();
