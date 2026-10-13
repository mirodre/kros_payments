/** Jeden beh pravidla automatizácie. */
import { decrypt } from '../crypto.js';
import { findConnection, setConnectionInvalid } from '../repos.js';
import * as repo from './repo.js';
import { createKrosClient, KrosError } from './krosClient.js';
import {
  buildDocumentPayment, buildTransferPayment, docPartnerName, getSumForPayment, normalizeExpense,
  partnerMatches, rawPaymentId, transferKey, ymd,
} from './paymentBuilders.js';

export const MAX_ATTEMPTS = 3;
// Prekryv pri čítaní zmien – rozdiel hodín medzi nami a KROS; duplicity zachytí automation_items.
const WATERMARK_OVERLAP_MS = 10 * 60 * 1000;
const RULE_LOCK_NS = 727100;

/** KROS očakáva „yyyy-MM-ddTHH:mm:ss“ (bez zóny). Posielame UTC – pri KROS v miestnom čase to len rozšíri okno. */
function krosTimestamp(date) {
  return date.toISOString().slice(0, 19);
}

export function computeSince(rule) {
  const start = new Date(`${rule.startDate}T00:00:00Z`);
  if (!rule.watermark) return start;
  const fromWatermark = new Date(new Date(rule.watermark).getTime() - WATERMARK_OVERLAP_MS);
  return fromWatermark > start ? fromWatermark : start;
}

async function collectDocuments(client, rule, since) {
  const query = { PaymentStatus: 0, LastModifiedTimestamp: krosTimestamp(since), IssueDateFrom: rule.startDate };
  const docs = [];
  if (rule.docTypes !== 'expenses') {
    for (const inv of await client.getAll('/api/invoices', query)) docs.push({ doc: inv, type: 'invoice' });
  }
  if (rule.docTypes !== 'invoices') {
    let expenses = [];
    try {
      expenses = await client.getAll('/api/expenses', query);
    } catch (err) {
      // Ako ručný modul: firma nemusí mať výdavky dostupné – pri „oboje“ pokračujeme len s faktúrami.
      const optional = rule.docTypes === 'all' && err instanceof KrosError && !err.transient && err.status !== 401;
      if (!optional) throw err;
    }
    for (const exp of expenses) docs.push({ doc: normalizeExpense(exp), type: 'expense' });
  }
  return docs
    .filter(({ doc }) => doc?.id != null)
    .filter(({ doc }) => ymd(doc.issueDate) >= rule.startDate)
    .filter(({ doc }) => partnerMatches(docPartnerName(doc), rule.partnerText))
    .filter(({ doc }) => getSumForPayment(doc) !== 0)
    .map(({ doc, type }) => {
      const itemKey = `AUTO-${type === 'expense' ? 'EXP' : 'INV'}-${doc.id}`;
      const payload = buildDocumentPayment(doc, { accountId: rule.accountId, externalId: itemKey });
      const number = [doc.numberingSequence, doc.documentNumber].filter(Boolean).join(' ') || `#${doc.id}`;
      return {
        itemKey,
        sourceType: type,
        sourceId: doc.id,
        label: `${type === 'expense' ? 'Výdavok' : 'Faktúra'} ${number} – ${docPartnerName(doc) || 'bez partnera'}`,
        amount: payload.sumOfPayment,
        currency: 'EUR',
        payload,
      };
    });
}

async function collectTransfers(client, rule, since) {
  const src = String(rule.accountId);
  const payments = await client.getAll('/api/payments', {
    AccountId: src, LastModifiedTimestamp: krosTimestamp(since), PaymentDateFrom: rule.startDate,
  });
  return payments
    .filter((p) => rawPaymentId(p))
    .filter((p) => p.accountId == null || String(p.accountId) === src)
    // Samotné prevody (aj ručné) nepreposielame ďalej.
    .filter((p) => !String(p.externalId ?? '').startsWith('PID-'))
    .filter((p) => ymd(p.dateOfPayment) >= rule.startDate)
    .filter((p) => partnerMatches(p.partnerName, rule.partnerText))
    .map((p) => {
      const itemKey = transferKey(p, src);
      const payload = buildTransferPayment(p, { targetAccountId: rule.targetAccountId, externalId: itemKey });
      return {
        itemKey,
        sourceType: 'payment',
        sourceId: rawPaymentId(p),
        label: `Platba ${ymd(p.dateOfPayment)} – ${p.partnerName || 'bez partnera'}`,
        amount: payload.sumOfPayment,
        currency: payload.originalCurrency,
        payload,
      };
    });
}

/** Pošle jednu rezervovanú položku. 401 vyhodí ďalej (zastaví celé pravidlo). */
async function sendItem({ db, client, item, summary }) {
  try {
    if (await client.paymentExists(item.itemKey)) {
      await repo.updateItem(db, item.id, { status: 'skipped_exists', error: null });
      summary.skippedExisting++;
      return;
    }
    const res = await client.postPayments([item.payload]);
    await repo.updateItem(db, item.id, {
      status: 'sent', requestId: res?.requestId ? String(res.requestId) : null, error: null, attempts: item.attempts + 1,
    });
    summary.sent++;
  } catch (err) {
    const status = err instanceof KrosError ? err.status : 0;
    const transient = err instanceof KrosError ? err.transient || status === 401 : true;
    await repo.updateItem(db, item.id, {
      status: 'failed',
      error: err.message,
      attempts: transient ? item.attempts + 1 : MAX_ATTEMPTS,
    });
    summary.failed++;
    if (summary.errors.length < 5) summary.errors.push(`${item.label || item.itemKey}: ${err.message}`);
    if (status === 401) throw err;
  }
}

async function runRuleUnlocked({ db, config, rule, createClient, now }) {
  const runStartedAt = new Date(now());
  const summary = { found: 0, sent: 0, skippedExisting: 0, alreadyProcessed: 0, retried: 0, failed: 0, errors: [] };

  const conn = await findConnection(db, rule.organizationId, rule.connectionId);
  if (!conn) {
    await repo.finishRuleRun(db, rule.id, { status: 'error', error: 'Prepojenie s firmou neexistuje.', summary });
    return { status: 'error', summary };
  }
  let token;
  try {
    token = decrypt(conn.tokenEnc, config.encryptionKey);
  } catch {
    await setConnectionInvalid(db, conn.id, true);
    await repo.finishRuleRun(db, rule.id, { status: 'connection_invalid', error: 'Prepojenie je neplatné, prepojte firmu znova.', summary });
    return { status: 'connection_invalid', summary };
  }
  const client = createClient({ baseUrl: config.krosApiBase, token });

  try {
    for (const item of await repo.listRetryableItems(db, rule.id, MAX_ATTEMPTS)) {
      summary.retried++;
      await sendItem({ db, client, item, summary });
    }

    const since = computeSince(rule);
    const candidates = rule.kind === 'transfer'
      ? await collectTransfers(client, rule, since)
      : await collectDocuments(client, rule, since);
    summary.found = candidates.length;

    for (const c of candidates) {
      const item = await repo.claimItem(db, { ...c, ruleId: rule.id, connectionId: rule.connectionId });
      if (!item) {
        summary.alreadyProcessed++;
        continue;
      }
      await sendItem({ db, client, item, summary });
    }

    if (conn.invalidAt) await setConnectionInvalid(db, conn.id, false);
    const status = summary.failed > 0 ? 'warning' : 'ok';
    await repo.finishRuleRun(db, rule.id, {
      status,
      error: summary.failed > 0 ? summary.errors.join('\n') : null,
      summary,
      // Všetko načítané → posun. Zlyhané odoslania sa zopakujú z automation_items.
      watermark: runStartedAt.toISOString(),
    });
    return { status, summary };
  } catch (err) {
    if (err instanceof KrosError && err.status === 401) {
      await setConnectionInvalid(db, conn.id, true);
      await repo.finishRuleRun(db, rule.id, { status: 'connection_invalid', error: 'KROS odmietol token (401) – prepojte firmu znova.', summary });
      return { status: 'connection_invalid', summary };
    }
    await repo.finishRuleRun(db, rule.id, { status: 'error', error: err.message, summary });
    return { status: 'error', summary, error: err.message };
  }
}

/**
 * Beh pravidla pod advisory lockom – súbežný beh toho istého pravidla (plánovač + „Spustiť teraz“)
 * sa preskočí. Duplicitám aj tak bráni unikátny kľúč v automation_items.
 */
const runningRules = new Set();

export async function runRule({ db, config, rule, createClient = createKrosClient, now = Date.now }) {
  // Advisory lock je na úrovni DB session a je reentrantný – v rámci jedného procesu
  // (a pri PGlite s jedným spojením) chráni až tento Set.
  if (runningRules.has(rule.id)) return { status: 'busy', summary: null };
  runningRules.add(rule.id);
  try {
    return await db.withClient(async (c) => {
      const { rows } = await c.query('select pg_try_advisory_lock($1, hashtext($2)) as ok', [RULE_LOCK_NS, rule.id]);
      if (!rows[0].ok) return { status: 'busy', summary: null };
      try {
        return await runRuleUnlocked({ db, config, rule, createClient, now });
      } finally {
        await c.query('select pg_advisory_unlock($1, hashtext($2))', [RULE_LOCK_NS, rule.id]);
      }
    });
  } finally {
    runningRules.delete(rule.id);
  }
}
