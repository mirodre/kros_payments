/** Webhook s výsledkami spracovania platieb z KROS. */
import express, { Router } from 'express';
import crypto from 'node:crypto';
import { decrypt, safeEqual } from '../crypto.js';
import { findOrganizationByWebhookKey, listConnectionSecrets, insertCallback } from '../repos.js';
import { applyRequestResult } from '../automation/repo.js';

/**
 * KROS podpisuje telo webhook secretom („HMACSHA256, Base64, UTF-16LE“). Presný tvar
 * overíme na reálnom webhooku – dovtedy akceptujeme rozumné varianty kódovania.
 */
export function verifyKrosSignature(rawBody, secret, header) {
  if (!header || !secret) return false;
  const provided = String(header).trim().replace(/^sha256=/i, '');
  if (!provided) return false;
  const bodyText = rawBody.toString('utf8');
  const messages = [Buffer.from(bodyText, 'utf16le'), rawBody];
  const keys = [Buffer.from(secret, 'utf8'), Buffer.from(secret, 'utf16le')];
  for (const key of keys) {
    for (const msg of messages) {
      const mac = crypto.createHmac('sha256', key).update(msg).digest();
      if (safeEqual(mac.toString('base64'), provided)) return true;
      if (safeEqual(mac.toString('hex'), provided.toLowerCase())) return true;
    }
  }
  return false;
}

/** Výsledok spracovania requestu: hlavičkový status aj status/problémy jednotlivých entít. */
export function summarizeResult(payload) {
  const problems = [];
  const entities = payload?.results?.entities;
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      for (const p of entity?.problems || []) {
        problems.push([p?.title, p?.detail].filter(Boolean).join(' – ') || JSON.stringify(p));
      }
      const st = Number(entity?.status);
      if (Number.isFinite(st) && (st < 200 || st > 299) && !(entity?.problems || []).length) {
        problems.push(`stav ${st}`);
      }
    }
  }
  const status = Number(payload?.status);
  return { ok: status === 200 && problems.length === 0, error: problems.join('; ') || (status ? `stav ${status}` : 'neznámy výsledok') };
}

function parsePayload(raw) {
  const text = raw.toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 100_000) };
  }
}

export function createWebhookRouter({ config, db }) {
  const router = Router();
  const paths = ['/kros/payments-callback/:key', '/kros/payments-callback/:key/*'];

  // Starý endpoint bez kľúča: KROS ho mal zaregistrovaný pred prechodom na prihlasovanie.
  router.post('/kros/payments-callback', (req, res) => {
    console.warn('[kros-webhook] webhook na starú URL bez kľúča – zahadzujem (treba nové prepojenie)');
    res.status(200).json({ ok: true, ignored: true });
  });

  router.get(paths, async (req, res, next) => {
    try {
      const org = await findOrganizationByWebhookKey(db, req.params.key);
      if (!org) return res.status(404).json({ ok: false });
      res.json({ ok: true, message: 'Webhook endpoint pre výsledky platieb je pripravený (očakáva POST).' });
    } catch (err) {
      next(err);
    }
  });

  router.post(paths, express.raw({ type: () => true, limit: '2mb' }), async (req, res, next) => {
    try {
      const org = await findOrganizationByWebhookKey(db, req.params.key);
      if (!org) return res.status(404).json({ ok: false });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signature = req.get('x-kros-signature-256') || null;
      let connectionId = null;
      for (const c of await listConnectionSecrets(db, org.id)) {
        let secret;
        try {
          secret = decrypt(c.webhookSecretEnc, config.encryptionKey);
        } catch {
          continue;
        }
        if (verifyKrosSignature(raw, secret, signature)) {
          connectionId = c.id;
          break;
        }
      }
      if (!connectionId) console.warn('[kros-webhook] neplatný alebo chýbajúci podpis, organizácia %s', org.id);
      await insertCallback(db, {
        organizationId: org.id,
        connectionId,
        signatureHeader: signature,
        signatureValid: Boolean(connectionId),
        payload: parsePayload(raw),
      });
      // Výsledok platby odoslanej automatizáciou → stav položky (len v rámci organizácie z URL;
      // tvar podpisu ešte nie je overený na reálnom webhooku, tak ho tu nevyžadujeme).
      const payload = parsePayload(raw);
      if (payload?.requestId) {
        await applyRequestResult(db, org.id, payload.requestId, summarizeResult(payload))
          .catch((err) => console.warn('[kros-webhook] automatizácia: %s', err.message));
      }
      // KROS musí dostať rýchlu 200, inak bude webhook opakovať.
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
