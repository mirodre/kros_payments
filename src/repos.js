/** SQL dotazy. Všetko, čo patrí organizácii, sa filtruje cez organization_id. */
import { randomToken } from './crypto.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toOrg = (r) => (r ? { id: r.id, name: r.name, webhookKey: r.webhook_key } : null);

export async function upsertUser(db, { sub, email, name }) {
  await db.query(
    `insert into users (id, email, name, last_login_at) values ($1, $2, $3, now())
     on conflict (id) do update set email = excluded.email, name = excluded.name, last_login_at = now()`,
    [sub, email, name ?? null],
  );
}

export async function upsertOrganizations(db, organizations) {
  for (const org of organizations || []) {
    await db.query(
      `insert into organizations (id, name, webhook_key) values ($1, $2, $3)
       on conflict (id) do update set name = excluded.name, updated_at = now()`,
      [org.id, org.name || org.id, randomToken()],
    );
  }
}

export async function getOrganization(db, id) {
  const { rows } = await db.query('select id, name, webhook_key from organizations where id = $1', [id]);
  return toOrg(rows[0]);
}

export async function findOrganizationByWebhookKey(db, key) {
  const { rows } = await db.query('select id, name, webhook_key from organizations where webhook_key = $1', [String(key)]);
  return toOrg(rows[0]);
}

export async function createConsentRequest(db, { state, organizationId, userId, ttlMinutes = 15 }) {
  await db.query(
    `insert into kros_consent_requests (state, organization_id, user_id, expires_at)
     values ($1, $2, $3, now() + make_interval(mins => $4::int))`,
    [state, organizationId, userId, ttlMinutes],
  );
}

export async function consumeConsentRequest(db, state) {
  const { rows } = await db.query(
    `update kros_consent_requests set used_at = now()
     where state = $1 and used_at is null and expires_at > now()
     returning organization_id, user_id`,
    [String(state)],
  );
  return rows[0] ? { organizationId: rows[0].organization_id, userId: rows[0].user_id } : null;
}

export async function upsertConnection(db, c) {
  const { rows } = await db.query(
    `insert into kros_connections
       (organization_id, kros_company_id, company_name, token_enc, webhook_secret_enc, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (organization_id, kros_company_id) do update set
       company_name = excluded.company_name,
       token_enc = excluded.token_enc,
       webhook_secret_enc = coalesce(excluded.webhook_secret_enc, kros_connections.webhook_secret_enc),
       invalid_at = null,
       updated_at = now()
     returning id`,
    [c.organizationId, String(c.krosCompanyId), c.companyName, c.tokenEnc, c.webhookSecretEnc ?? null, c.createdByUserId],
  );
  return { id: rows[0].id };
}

export async function listConnections(db, organizationId) {
  const { rows } = await db.query(
    `select c.id, c.kros_company_id, c.company_name, c.created_at, c.invalid_at,
            u.id as user_id, u.name as user_name, u.email as user_email
     from kros_connections c join users u on u.id = c.created_by_user_id
     where c.organization_id = $1
     order by c.company_name, c.created_at`,
    [organizationId],
  );
  return rows.map((r) => ({
    id: r.id,
    companyId: r.kros_company_id,
    companyName: r.company_name,
    createdAt: new Date(r.created_at).toISOString(),
    invalid: r.invalid_at != null,
    createdBy: { id: r.user_id, name: r.user_name, email: r.user_email },
  }));
}

export async function findConnection(db, organizationId, id) {
  if (!UUID_RE.test(String(id))) return null;
  const { rows } = await db.query(
    `select id, organization_id, kros_company_id, company_name, token_enc, invalid_at
     from kros_connections where organization_id = $1 and id = $2`,
    [organizationId, id],
  );
  const r = rows[0];
  return r ? {
    id: r.id,
    organizationId: r.organization_id,
    companyId: r.kros_company_id,
    companyName: r.company_name,
    tokenEnc: r.token_enc,
    invalidAt: r.invalid_at,
  } : null;
}

export async function listConnectionSecrets(db, organizationId) {
  const { rows } = await db.query(
    'select id, webhook_secret_enc from kros_connections where organization_id = $1 and webhook_secret_enc is not null',
    [organizationId],
  );
  return rows.map((r) => ({ id: r.id, webhookSecretEnc: r.webhook_secret_enc }));
}

export async function deleteConnection(db, organizationId, id) {
  if (!UUID_RE.test(String(id))) return false;
  const { rowCount } = await db.query(
    'delete from kros_connections where organization_id = $1 and id = $2', [organizationId, id]);
  return rowCount > 0;
}

export async function setConnectionInvalid(db, id, invalid) {
  await db.query(
    `update kros_connections set invalid_at = ${invalid ? 'now()' : 'null'}, updated_at = now() where id = $1`, [id]);
}

export async function insertCallback(db, { organizationId, connectionId, signatureHeader, signatureValid, payload }) {
  await db.query(
    `insert into kros_payment_callbacks (organization_id, connection_id, signature_header, signature_valid, payload)
     values ($1, $2, $3, $4, $5)`,
    [organizationId, connectionId ?? null, signatureHeader ?? null, Boolean(signatureValid), JSON.stringify(payload ?? null)],
  );
}

export async function listCallbacks(db, organizationId, sinceSeq) {
  const since = Number.isFinite(Number(sinceSeq)) ? Number(sinceSeq) : 0;
  const { rows } = await db.query(
    `select id, received_at, connection_id, signature_valid, payload
     from kros_payment_callbacks where organization_id = $1 and id > $2
     order by id limit 200`,
    [organizationId, since],
  );
  const last = await db.query(
    'select coalesce(max(id), 0) as last from kros_payment_callbacks where organization_id = $1', [organizationId]);
  return {
    items: rows.map((r) => ({
      seq: Number(r.id),
      receivedAt: new Date(r.received_at).toISOString(),
      connectionId: r.connection_id,
      signatureValid: r.signature_valid,
      body: r.payload,
    })),
    lastSeq: Number(last.rows[0].last),
  };
}
