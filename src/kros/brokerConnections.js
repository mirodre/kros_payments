/**
 * Prepojenia s KROS z launchu v obchode doplnkov (Token Broker). Tokeny prevezme
 * login.krosdoplnky.sk a aplikácia si ich jednorazovo vyzdvihne v `/api/me?kros=1`
 * – tu sa uložia rovnako ako prepojenia z integration consent.
 * Broker nenastavuje webhook, takže webhook secret nemajú (existujúci sa zachová).
 */
import { encrypt } from '../crypto.js';
import { upsertConnection } from '../repos.js';

function normalize(c) {
  return {
    companyId: String(c?.companyId ?? '').trim(),
    companyName: String(c?.companyName ?? '').trim(),
    token: String(c?.token ?? ''),
  };
}

/** Uloží prepojenia pod aktívnu organizáciu používateľa. Vráti počet uložených firiem. */
export async function storeBrokerConnections(db, { encryptionKey, organizationId, userId, connections }) {
  if (!organizationId || !Array.isArray(connections)) return 0;
  let stored = 0;
  for (const c of connections.map(normalize)) {
    if (!/^\d+$/.test(c.companyId) || !c.token) continue;
    await upsertConnection(db, {
      organizationId,
      krosCompanyId: c.companyId,
      companyName: c.companyName || `Firma ${c.companyId}`,
      tokenEnc: encrypt(c.token, encryptionKey),
      webhookSecretEnc: null,
      createdByUserId: userId,
    });
    stored += 1;
  }
  return stored;
}
