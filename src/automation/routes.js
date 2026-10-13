/** REST API automatizácií pre UI (za requireAuth, pred KROS proxy). */
import express, { Router } from 'express';
import { findConnection } from '../repos.js';
import * as repo from './repo.js';
import { runRule } from './runner.js';

const KINDS = new Set(['invoice_payment', 'transfer']);
const DOC_TYPES = new Set(['all', 'invoices', 'expenses']);

class ValidationError extends Error {}

function toAccountId(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`Vyberte ${label}.`);
  return n;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Validuje telo pravidla; `kind` sa po vytvorení nemení. */
function parseRuleBody(body, kind) {
  if (!KINDS.has(kind)) throw new ValidationError('Neznámy typ automatizácie.');
  const startDate = body.startDate ? String(body.startDate) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(startDate))) {
    throw new ValidationError('Neplatný dátum „Spracovať od“.');
  }
  const rule = {
    kind,
    enabled: body.enabled !== false,
    partnerText: String(body.partnerText ?? '').trim().slice(0, 200),
    docTypes: 'all',
    accountId: toAccountId(body.accountId, kind === 'transfer' ? 'zdrojový účet' : 'účet úhrady'),
    targetAccountId: null,
    startDate,
  };
  if (kind === 'invoice_payment') {
    rule.docTypes = DOC_TYPES.has(body.docTypes) ? body.docTypes : 'all';
  } else {
    rule.targetAccountId = toAccountId(body.targetAccountId, 'cieľový účet');
    if (rule.targetAccountId === rule.accountId) throw new ValidationError('Zdrojový a cieľový účet musia byť rôzne.');
  }
  return rule;
}

export function createAutomationRouter({ config, db, createClient }) {
  const router = Router();
  const json = express.json({ limit: '100kb' });

  const handle = (fn) => async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      await fn(req, res);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'validation', message: err.message });
      next(err);
    }
  };

  router.get('/automations', handle(async (req, res) => {
    res.json(await repo.listRules(db, req.organizationId, {
      connectionId: req.query.connectionId || undefined,
      kind: KINDS.has(req.query.kind) ? req.query.kind : undefined,
    }));
  }));

  router.post('/automations', json, handle(async (req, res) => {
    const body = req.body || {};
    const conn = await findConnection(db, req.organizationId, body.connectionId);
    if (!conn) return res.status(404).json({ error: 'connection_not_found', message: 'Prepojenie s firmou neexistuje.' });
    const rule = parseRuleBody(body, body.kind);
    const created = await repo.createRule(db, {
      ...rule, organizationId: req.organizationId, connectionId: conn.id, createdByUserId: req.user.id,
    });
    res.status(201).json(created);
  }));

  router.put('/automations/:id', json, handle(async (req, res) => {
    const existing = await repo.getRule(db, req.organizationId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const rule = parseRuleBody({ ...existing, ...(req.body || {}) }, existing.kind);
    res.json(await repo.updateRule(db, req.organizationId, existing.id, rule));
  }));

  router.delete('/automations/:id', handle(async (req, res) => {
    const deleted = await repo.deleteRule(db, req.organizationId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  }));

  router.post('/automations/:id/run', handle(async (req, res) => {
    const rule = await repo.getRule(db, req.organizationId, req.params.id);
    if (!rule) return res.status(404).json({ error: 'not_found' });
    const result = await runRule({ db, config, rule, ...(createClient ? { createClient } : {}) });
    if (result.status === 'busy') {
      return res.status(409).json({ error: 'busy', message: 'Automatizácia práve beží, skúste to o chvíľu.' });
    }
    res.json({ ...result, rule: await repo.getRule(db, req.organizationId, rule.id) });
  }));

  router.get('/automations/:id/items', handle(async (req, res) => {
    res.json(await repo.listItems(db, req.organizationId, req.params.id, req.query.limit));
  }));

  return router;
}
