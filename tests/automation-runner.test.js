import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, fastKrosClient } from './helpers/testApp.js';
import * as repos from '../src/repos.js';
import * as repo from '../src/automation/repo.js';
import { encrypt } from '../src/crypto.js';
import { runRule, computeSince } from '../src/automation/runner.js';
import { runAllRules } from '../src/automation/scheduler.js';

let ctx;
let connId;
let badConnId;

before(async () => {
  ctx = await createTestContext();
  await ctx.login('alice');
  const key = ctx.config.encryptionKey;
  ({ id: connId } = await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: '1', companyName: 'Alfa',
    tokenEnc: encrypt('kros-good', key), webhookSecretEnc: null, createdByUserId: 'user-alice',
  }));
  ({ id: badConnId } = await repos.upsertConnection(ctx.db, {
    organizationId: 'org-a', krosCompanyId: '2', companyName: 'Beta',
    tokenEnc: encrypt('kros-revoked', key), webhookSecretEnc: null, createdByUserId: 'user-alice',
  }));
});
after(() => ctx.close());

beforeEach(async () => {
  await ctx.db.query('delete from automation_items');
  await ctx.db.query('delete from automation_rules');
  ctx.kros.requests.length = 0;
});

const run = async (rule) => runRule({ db: ctx.db, config: ctx.config, rule: await repo.getRule(ctx.db, 'org-a', rule.id), createClient: fastKrosClient });

const mkRule = (over = {}) => repo.createRule(ctx.db, {
  organizationId: 'org-a', connectionId: connId, kind: 'invoice_payment', enabled: true, partnerText: 'acme',
  docTypes: 'all', accountId: 5, targetAccountId: null, startDate: '2026-10-01', createdByUserId: 'user-alice', ...over,
});

const invoice = (id, over = {}) => ({
  id, issueDate: '2026-10-05', numberingSequence: 'FA', documentNumber: `00${id}`, variableSymbol: `2026${id}`,
  partner: { address: { businessName: 'ACME s.r.o.' } }, sumForPayment: 120, sumOfPayments: 0,
  prices: { currency: 'EUR', documentPrices: { totalPriceInclVat: 120 }, legislativePrices: { totalPriceInclVat: 120 } },
  lastModifiedTimestamp: '2026-10-05T10:00:00', ...over,
});

test('úhrada: filter partnera a dátumu, payload ako ručné tlačidlo, druhý beh nič neduplikuje', async () => {
  ctx.kros.setData({
    invoices: [
      invoice(1),
      invoice(2, { partner: { address: { businessName: 'Iný partner' } } }),
      invoice(3, { issueDate: '2026-09-30' }),
      invoice(4, { sumOfPayments: 120 }),
    ],
    expenses: [{
      id: 9, issueDate: '2026-10-06', documentNumber: 'D-77', partner: { address: { businessName: 'Acme Slovakia' } },
      prices: { currency: 'EUR', documentPrices: { totalPriceInclVat: 50, sumForPayment: 50, sumOfPayments: 0 } },
    }],
  });
  const rule = await mkRule();
  const first = await run(rule);
  assert.equal(first.status, 'ok');
  assert.equal(first.summary.sent, 2);

  const posted = ctx.kros.data.payments.filter((p) => p.externalId?.startsWith('AUTO-'));
  assert.deepEqual(posted.map((p) => p.externalId).sort(), ['AUTO-EXP-9', 'AUTO-INV-1']);
  const inv = posted.find((p) => p.externalId === 'AUTO-INV-1');
  assert.equal(inv.dateOfPayment, '2026-10-05');
  assert.equal(inv.sumOfPayment, 120);
  assert.equal(inv.variableSymbol, '20261');
  assert.equal(inv.accountId, 5);
  const exp = posted.find((p) => p.externalId === 'AUTO-EXP-9');
  assert.equal(exp.sumOfPayment, -50);
  assert.equal(exp.paymentReference, 'D-77');

  // KROS ešte nestihol doklady označiť ako uhradené a watermark je vynulovaný (zmena pravidla)
  // → druhý beh ich vidí znova, ale nepošle.
  await ctx.db.query('update automation_rules set watermark = null where id = $1', [rule.id]);
  const second = await run(rule);
  assert.equal(second.summary.sent, 0);
  assert.equal(second.summary.alreadyProcessed, 2);
  assert.equal(ctx.kros.posted().length, 2);

  const items = await repo.listItems(ctx.db, 'org-a', rule.id);
  assert.deepEqual(items.map((i) => i.status), ['sent', 'sent']);
  assert.ok(items.every((i) => i.requestId?.startsWith('req-')));
});

test('úhrada: docTypes=invoices nevolá výdavky; posiela LastModifiedTimestamp a IssueDateFrom', async () => {
  ctx.kros.setData({ invoices: [invoice(1)] });
  const rule = await mkRule({ docTypes: 'invoices', partnerText: '' });
  await run(rule);
  const gets = ctx.kros.requests.filter((r) => r.method === 'GET');
  assert.ok(!gets.some((r) => r.path.startsWith('/api/expenses')));
  const invGet = gets.find((r) => r.path.startsWith('/api/invoices'));
  assert.equal(invGet.query.LastModifiedTimestamp, '2026-10-01T00:00:00');
  assert.equal(invGet.query.IssueDateFrom, '2026-10-01');
  assert.equal(invGet.query.PaymentStatus, '0');
});

test('platba s rovnakým ExternalId už v KROS je → nepošle sa (skipped_exists)', async () => {
  ctx.kros.setData({ invoices: [invoice(1)], payments: [{ id: 50, externalId: 'AUTO-INV-1' }] });
  const rule = await mkRule();
  const r = await run(rule);
  assert.equal(r.summary.sent, 0);
  assert.equal(r.summary.skippedExisting, 1);
  assert.equal(ctx.kros.posted().length, 0);
});

test('watermark: posun po úspechu, ďalší beh pýta zmeny od watermarku − 10 min', async () => {
  ctx.kros.setData({ invoices: [] });
  const rule = await mkRule();
  const t0 = Date.parse('2026-10-13T08:00:00Z');
  await runRule({ db: ctx.db, config: ctx.config, rule, createClient: fastKrosClient, now: () => t0 });
  const after1 = await repo.getRule(ctx.db, 'org-a', rule.id);
  assert.equal(after1.watermark, '2026-10-13T08:00:00.000Z');
  assert.equal(computeSince(after1).toISOString(), '2026-10-13T07:50:00.000Z');
  ctx.kros.requests.length = 0;
  await run(after1);
  assert.equal(ctx.kros.requests.find((r) => r.path.startsWith('/api/invoices')).query.LastModifiedTimestamp, '2026-10-13T07:50:00');
});

test('watermark sa neposunie, keď načítanie zlyhá; zmena kritérií ho vynuluje', async () => {
  ctx.kros.setData({ invoices: [] });
  const rule = await mkRule();
  await runRule({ db: ctx.db, config: ctx.config, rule, createClient: fastKrosClient, now: () => Date.parse('2026-10-13T08:00:00Z') });
  ctx.kros.failNext('GET', '/api/invoices', 500);
  const r = await runRule({
    db: ctx.db, config: ctx.config, rule: await repo.getRule(ctx.db, 'org-a', rule.id),
    createClient: fastKrosClient, now: () => Date.parse('2026-10-13T09:00:00Z'),
  });
  assert.equal(r.status, 'error');
  const after = await repo.getRule(ctx.db, 'org-a', rule.id);
  assert.equal(after.watermark, '2026-10-13T08:00:00.000Z');
  assert.equal(after.lastStatus, 'error');

  const changed = await repo.updateRule(ctx.db, 'org-a', rule.id, { ...after, partnerText: 'beta' });
  assert.equal(changed.watermark, null);
  const toggled = await repo.updateRule(ctx.db, 'org-a', rule.id, { ...after, enabled: false });
  assert.equal(toggled.watermark, null, 'vynulovaný už ostáva');
});

test('dočasná chyba odoslania sa zopakuje v ďalšom behu, 400 sa neopakuje', async () => {
  ctx.kros.setData({ invoices: [invoice(1), invoice(2)] });
  const rule = await mkRule();
  ctx.kros.failNext('POST', '/api/payments/batch', 503);
  ctx.kros.failNext('POST', '/api/payments/batch', 400);
  const first = await run(rule);
  assert.equal(first.status, 'warning');
  assert.equal(first.summary.failed, 2);
  const second = await run(rule);
  assert.equal(second.summary.retried, 1);
  assert.equal(second.summary.sent, 1);
  const items = await repo.listItems(ctx.db, 'org-a', rule.id);
  const byKey = Object.fromEntries(items.map((i) => [i.itemKey, i]));
  const statuses = Object.values(byKey).map((i) => i.status).sort();
  assert.deepEqual(statuses, ['failed', 'sent']);
  assert.equal(Object.values(byKey).find((i) => i.status === 'failed').attempts, 3);
  assert.equal(ctx.kros.data.payments.filter((p) => p.externalId?.startsWith('AUTO-')).length, 1);
});

test('prevod: kľúč PID ako ručný prevod, záporná suma na cieľový účet, prevody sa neprevádzajú znova', async () => {
  ctx.kros.setData({
    payments: [
      { id: 11, accountId: 5, dateOfPayment: '2026-10-02', sumOfPayment: 80, partnerName: 'ACME s.r.o.', variableSymbol: '123', currency: 'EUR' },
      { id: 12, accountId: 5, dateOfPayment: '2026-10-03', sumOfPayment: 10, partnerName: 'Iný' },
      { id: 13, accountId: 5, dateOfPayment: '2026-09-20', sumOfPayment: 10, partnerName: 'ACME' },
      { id: 14, accountId: 5, dateOfPayment: '2026-10-03', sumOfPayment: 10, partnerName: 'ACME', externalId: 'PID-6-99' },
      { id: 15, accountId: 6, dateOfPayment: '2026-10-03', sumOfPayment: 10, partnerName: 'ACME' },
      // ručne prevedená skôr
      { id: 16, accountId: 5, dateOfPayment: '2026-10-04', sumOfPayment: 30, partnerName: 'ACME' },
      { id: 17, accountId: 6, dateOfPayment: '2026-10-04', sumOfPayment: -30, partnerName: 'ACME', externalId: 'PID-5-16' },
    ],
  });
  const rule = await mkRule({ kind: 'transfer', accountId: 5, targetAccountId: 6, docTypes: 'all' });
  const r = await run(rule);
  assert.equal(r.summary.sent, 1);
  assert.equal(r.summary.skippedExisting, 1);
  const created = ctx.kros.data.payments.filter((p) => p.externalId === 'PID-5-11');
  assert.equal(created.length, 1);
  assert.equal(created[0].accountId, 6);
  assert.equal(created[0].sumOfPayment, -80);
  assert.equal(created[0].isWithoutDocument, true);
  assert.equal((await run(rule)).summary.sent, 0);
});

test('neplatný token → connection_invalid, prepojenie označené', async () => {
  const rule = await mkRule({ connectionId: badConnId });
  const r = await run(rule);
  assert.equal(r.status, 'connection_invalid');
  assert.equal((await repos.listConnections(ctx.db, 'org-a')).find((c) => c.id === badConnId).invalid, true);
  assert.equal((await repo.getRule(ctx.db, 'org-a', rule.id)).lastStatus, 'connection_invalid');
});

test('súbežný beh toho istého pravidla sa preskočí; plánovač spúšťa len zapnuté', async () => {
  ctx.kros.setData({ invoices: [invoice(1)] });
  const on = await mkRule();
  const off = await mkRule({ enabled: false });
  const [a, b] = await Promise.all([run(on), run(on)]);
  assert.deepEqual([a.status, b.status].sort(), ['busy', 'ok'].sort());
  assert.equal(ctx.kros.posted().length, 1);

  const tick = await runAllRules({ db: ctx.db, config: ctx.config, createClient: fastKrosClient, log: { log() {}, error() {} } });
  assert.deepEqual(tick.results.map((x) => x.ruleId), [on.id]);
  assert.equal((await repo.getRule(ctx.db, 'org-a', off.id)).lastRunAt, null);
});

test('výsledok z webhooku prepne položku na confirmed / rejected', async () => {
  ctx.kros.setData({ invoices: [invoice(1), invoice(2)] });
  const rule = await mkRule();
  await run(rule);
  const items = await repo.listItems(ctx.db, 'org-a', rule.id);
  const [i1, i2] = items;
  assert.equal(await repo.applyRequestResult(ctx.db, 'org-b', i1.requestId, { ok: true }), 0, 'cudzia organizácia');
  await repo.applyRequestResult(ctx.db, 'org-a', i1.requestId, { ok: true });
  await repo.applyRequestResult(ctx.db, 'org-a', i2.requestId, { ok: false, error: 'doklad sa nenašiel' });
  const after = Object.fromEntries((await repo.listItems(ctx.db, 'org-a', rule.id)).map((i) => [i.id, i]));
  assert.equal(after[i1.id].status, 'confirmed');
  assert.equal(after[i2.id].status, 'rejected');
  assert.equal(after[i2.id].error, 'doklad sa nenašiel');
});

test('docTypes=all: nedostupné výdavky (403) nezastavia úhradu faktúr', async () => {
  ctx.kros.setData({ invoices: [invoice(1)] });
  ctx.kros.failNext('GET', '/api/expenses', 403);
  const r = await run(await mkRule());
  assert.equal(r.status, 'ok');
  assert.equal(r.summary.sent, 1);
});
