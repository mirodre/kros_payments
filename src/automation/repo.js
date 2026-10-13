/** SQL pre automatizácie. Všetko, čo vidí používateľ, sa filtruje cez organization_id. */
import { UUID_RE } from '../repos.js';

const RULE_COLUMNS = `r.id, r.organization_id, r.connection_id, r.kind, r.enabled, r.partner_text, r.doc_types,
  r.account_id, r.target_account_id, to_char(r.start_date, 'YYYY-MM-DD') as start_date, r.watermark,
  r.last_run_at, r.last_status, r.last_error, r.last_summary, r.created_at, r.updated_at`;

const iso = (v) => (v ? new Date(v).toISOString() : null);

function toRule(r) {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    connectionId: r.connection_id,
    kind: r.kind,
    enabled: r.enabled,
    partnerText: r.partner_text,
    docTypes: r.doc_types,
    accountId: Number(r.account_id),
    targetAccountId: r.target_account_id == null ? null : Number(r.target_account_id),
    startDate: r.start_date,
    watermark: iso(r.watermark),
    lastRunAt: iso(r.last_run_at),
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastSummary: r.last_summary,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toItem(r) {
  return {
    id: Number(r.id),
    ruleId: r.rule_id,
    itemKey: r.item_key,
    sourceType: r.source_type,
    sourceId: r.source_id,
    label: r.label,
    amount: r.amount == null ? null : Number(r.amount),
    currency: r.currency,
    payload: r.payload,
    requestId: r.request_id,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export async function listRules(db, organizationId, { connectionId, kind } = {}) {
  const params = [organizationId];
  let where = 'r.organization_id = $1';
  if (connectionId) {
    if (!UUID_RE.test(String(connectionId))) return [];
    params.push(connectionId);
    where += ` and r.connection_id = $${params.length}`;
  }
  if (kind) {
    params.push(kind);
    where += ` and r.kind = $${params.length}`;
  }
  const { rows } = await db.query(`select ${RULE_COLUMNS} from automation_rules r where ${where} order by r.created_at`, params);
  return rows.map(toRule);
}

export async function getRule(db, organizationId, id) {
  if (!UUID_RE.test(String(id))) return null;
  const { rows } = await db.query(
    `select ${RULE_COLUMNS} from automation_rules r where r.organization_id = $1 and r.id = $2`, [organizationId, id]);
  return toRule(rows[0]);
}

/** Pre plánovač – všetky zapnuté pravidlá naprieč organizáciami. */
export async function listEnabledRules(db) {
  const { rows } = await db.query(`select ${RULE_COLUMNS} from automation_rules r where r.enabled order by r.created_at`);
  return rows.map(toRule);
}

export async function createRule(db, rule) {
  const { rows } = await db.query(
    `insert into automation_rules (organization_id, connection_id, kind, enabled, partner_text, doc_types,
       account_id, target_account_id, start_date, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [rule.organizationId, rule.connectionId, rule.kind, rule.enabled, rule.partnerText, rule.docTypes,
      rule.accountId, rule.targetAccountId, rule.startDate, rule.createdByUserId],
  );
  return getRule(db, rule.organizationId, rows[0].id);
}

/** Zmena kritérií vynuluje watermark – ďalší beh začne znova od start_date (duplicity stráži automation_items). */
export async function updateRule(db, organizationId, id, rule) {
  const { rowCount } = await db.query(
    `update automation_rules set
       watermark = case when partner_text is distinct from $3 or doc_types is distinct from $4
                          or account_id is distinct from $5 or target_account_id is distinct from $6
                          or start_date is distinct from $7::date
                        then null else watermark end,
       partner_text = $3, doc_types = $4, account_id = $5, target_account_id = $6, start_date = $7,
       enabled = $8, updated_at = now()
     where organization_id = $1 and id = $2`,
    [organizationId, id, rule.partnerText, rule.docTypes, rule.accountId, rule.targetAccountId, rule.startDate, rule.enabled],
  );
  return rowCount > 0 ? getRule(db, organizationId, id) : null;
}

export async function deleteRule(db, organizationId, id) {
  if (!UUID_RE.test(String(id))) return false;
  const { rowCount } = await db.query('delete from automation_rules where organization_id = $1 and id = $2', [organizationId, id]);
  return rowCount > 0;
}

export async function finishRuleRun(db, id, { status, error = null, summary = null, watermark }) {
  await db.query(
    `update automation_rules set last_run_at = now(), last_status = $2, last_error = $3, last_summary = $4,
       watermark = coalesce($5::timestamptz, watermark)
     where id = $1`,
    [id, status, error, summary ? JSON.stringify(summary) : null, watermark ?? null],
  );
}

/** Rezervuje položku; vráti null, ak už existuje (spracoval ju iný beh / pravidlo). */
export async function claimItem(db, item) {
  const { rows } = await db.query(
    `insert into automation_items (rule_id, connection_id, item_key, source_type, source_id, label, amount, currency, payload, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     on conflict (connection_id, item_key) do nothing
     returning *`,
    [item.ruleId, item.connectionId, item.itemKey, item.sourceType, String(item.sourceId), item.label ?? null,
      item.amount ?? null, item.currency ?? null, JSON.stringify(item.payload)],
  );
  return rows[0] ? toItem(rows[0]) : null;
}

export async function updateItem(db, id, { status, requestId, error, attempts }) {
  await db.query(
    `update automation_items set status = $2, request_id = coalesce($3, request_id), error = $4,
       attempts = coalesce($5, attempts), updated_at = now()
     where id = $1`,
    [id, status, requestId ?? null, error ?? null, attempts ?? null],
  );
}

/**
 * Na opakovanie: dočasne zlyhané položky a „visiace“ pending (beh spadol uprostred odoslania –
 * či platba odišla, rozhodne kontrola ExternalId v KROS).
 */
export async function listRetryableItems(db, ruleId, maxAttempts) {
  const { rows } = await db.query(
    `select * from automation_items
     where rule_id = $1 and attempts < $2
       and (status = 'failed' or (status = 'pending' and updated_at < now() - interval '30 minutes'))
     order by id`,
    [ruleId, maxAttempts],
  );
  return rows.map(toItem);
}

export async function listItems(db, organizationId, ruleId, limit = 50) {
  if (!UUID_RE.test(String(ruleId))) return [];
  const { rows } = await db.query(
    `select i.* from automation_items i join automation_rules r on r.id = i.rule_id
     where r.organization_id = $1 and i.rule_id = $2 order by i.id desc limit $3`,
    [organizationId, ruleId, Math.min(Math.max(Number(limit) || 50, 1), 500)],
  );
  return rows.map(toItem);
}

/** Výsledok spracovania z KROS webhooku → stav položky podľa requestId. */
export async function applyRequestResult(db, organizationId, requestId, { ok, error }) {
  if (!requestId) return 0;
  const { rowCount } = await db.query(
    `update automation_items i set status = $3, error = $4, updated_at = now()
     from kros_connections c
     where c.id = i.connection_id and c.organization_id = $1
       and i.request_id = $2 and i.status in ('sent', 'confirmed', 'rejected')`,
    [organizationId, String(requestId), ok ? 'confirmed' : 'rejected', ok ? null : error],
  );
  return rowCount;
}
