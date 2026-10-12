import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestContext } from './helpers/testApp.js';
import { verifyKrosSignature } from '../src/kros/webhook.js';
import * as repos from '../src/repos.js';
import { encrypt } from '../src/crypto.js';

const body = Buffer.from(JSON.stringify({ companyId: 11, status: 200, requestId: 'r1' }));
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();

test('verifyKrosSignature: Base64 nad UTF-16LE (dokumentovaný KROS formát) aj hex/sha256=', () => {
  const sigUtf16 = hmac(Buffer.from('sec', 'utf8'), Buffer.from(body.toString('utf8'), 'utf16le')).toString('base64');
  assert.equal(verifyKrosSignature(body, 'sec', sigUtf16), true);
  const hex = hmac(Buffer.from('sec', 'utf8'), body).toString('hex');
  assert.equal(verifyKrosSignature(body, 'sec', `sha256=${hex.toUpperCase()}`), true);
  assert.equal(verifyKrosSignature(body, 'other', sigUtf16), false);
  assert.equal(verifyKrosSignature(body, 'sec', null), false);
  assert.equal(verifyKrosSignature(body, 'sec', ''), false);
});

let ctx;
let org;
let connId;
before(async () => {
  ctx = await createTestContext();
  await ctx.login('alice');
  org = await repos.getOrganization(ctx.db, 'org-a');
  ({ id: connId } = await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: '11', companyName: 'Alfa',
    tokenEnc: encrypt('kros-good', ctx.config.encryptionKey),
    webhookSecretEnc: encrypt('sec', ctx.config.encryptionKey), createdByUserId: 'user-alice',
  }));
});
after(() => ctx.close());

const post = (path, headers = {}) => fetch(`${ctx.base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
});

test('platný podpis → uložené s connection_id a signature_valid', async () => {
  const sig = hmac(Buffer.from('sec'), Buffer.from(body.toString('utf8'), 'utf16le')).toString('base64');
  const res = await post(`/kros/payments-callback/${org.webhookKey}`, { 'x-kros-signature-256': sig });
  assert.equal(res.status, 200);
  const { rows } = await ctx.db.query('select connection_id, signature_valid, payload from kros_payment_callbacks order by id desc limit 1');
  assert.equal(rows[0].connection_id, connId);
  assert.equal(rows[0].signature_valid, true);
  assert.equal(rows[0].payload.requestId, 'r1');
});

test('neplatný podpis → uložené s signature_valid=false, stále 200; podcesta funguje', async () => {
  const res = await post(`/kros/payments-callback/${org.webhookKey}/extra`, { 'x-kros-signature-256': 'bad' });
  assert.equal(res.status, 200);
  const { rows } = await ctx.db.query('select connection_id, signature_valid from kros_payment_callbacks order by id desc limit 1');
  assert.deepEqual(rows[0], { connection_id: null, signature_valid: false });
});

test('neznámy kľúč → 404; starý endpoint bez kľúča → 200 a zahodí', async () => {
  const count = async () => Number((await ctx.db.query('select count(*)::int as n from kros_payment_callbacks')).rows[0].n);
  const n = await count();
  assert.equal((await post('/kros/payments-callback/unknown')).status, 404);
  assert.equal((await post('/kros/payments-callback')).status, 200);
  assert.equal(await count(), n);
});

test('GET reachability check', async () => {
  const res = await fetch(`${ctx.base}/kros/payments-callback/${org.webhookKey}`);
  assert.equal(res.status, 200);
});

test('ne-JSON telo sa uloží ako { raw }', async () => {
  await fetch(`${ctx.base}/kros/payments-callback/${org.webhookKey}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
  const { rows } = await ctx.db.query('select payload from kros_payment_callbacks order by id desc limit 1');
  assert.deepEqual(rows[0].payload, { raw: 'hello' });
});
