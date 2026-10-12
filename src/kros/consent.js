/**
 * Prepojenie s KROS (integration consent). KROS vracia výsledok cross-site POST-om,
 * pri ktorom prehliadač nepošle SameSite=Lax cookie → väzba na organizáciu cez `state` v DB.
 */
import express, { Router } from 'express';
import { encrypt, randomToken } from '../crypto.js';
import { getOrganization, createConsentRequest, consumeConsentRequest, upsertConnection } from '../repos.js';

function normalizeCallbackCompany(company) {
  return {
    companyId: Number(company?.companyId),
    companyName: String(company?.companyName || ''),
    token: String(company?.token || ''),
    webhookSecret: company?.webhookSecret ? String(company.webhookSecret) : undefined,
  };
}

const isComplete = (c) => Number.isFinite(c.companyId) && c.companyName && c.token;

export function parseCallbackCompanies(body) {
  if (!body || typeof body !== 'object') return [];
  // extended: true (qs): data[0][pole]=… → { data: [ { pole: … } ] }
  if (Array.isArray(body.data) && body.data.length > 0) {
    return body.data.map(normalizeCallbackCompany).filter(isComplete);
  }
  const grouped = new Map();
  const keyRegex = /^data\[(\d+)\]\[(companyId|companyName|token|webhookSecret)\]$/;
  for (const [key, rawValue] of Object.entries(body)) {
    const match = key.match(keyRegex);
    if (!match) continue;
    const idx = Number(match[1]);
    grouped.set(idx, { ...(grouped.get(idx) || {}), [match[2]]: String(rawValue ?? '') });
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, company]) => normalizeCallbackCompany(company))
    .filter(isComplete);
}

export function createConsentCallbackRouter({ config, db }) {
  const router = Router();

  router.post('/kros/callback', express.urlencoded({ extended: true }), async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const state = typeof req.body?.state === 'string' ? req.body.state : '';
      const request = state ? await consumeConsentRequest(db, state) : null;
      if (!request) return res.redirect(303, '/?kros_error=state');
      const companies = parseCallbackCompanies(req.body);
      if (companies.length === 0) return res.redirect(303, '/?kros_error=empty');
      for (const c of companies) {
        await upsertConnection(db, {
          organizationId: request.organizationId,
          krosCompanyId: String(c.companyId),
          companyName: c.companyName,
          tokenEnc: encrypt(c.token, config.encryptionKey),
          webhookSecretEnc: c.webhookSecret ? encrypt(c.webhookSecret, config.encryptionKey) : null,
          createdByUserId: request.userId,
        });
      }
      res.redirect(303, `/?kros_connected=${companies.length}`);
    } catch (err) {
      next(err);
    }
  });

  router.get('/kros/callback', (req, res) => res.redirect('/'));
  return router;
}

export function createConnectRouter({ config, db, requireAuth }) {
  const router = Router();
  router.get('/kros/connect', requireAuth, async (req, res, next) => {
    try {
      const org = await getOrganization(db, req.organizationId);
      const state = randomToken();
      await createConsentRequest(db, { state, organizationId: req.organizationId, userId: req.user.id });
      const params = new URLSearchParams({
        plugin_name: 'PlatformaUhrady',
        integrator_name: 'PlatformaUhrady',
        version: '1',
        response_mode: 'post',
        redirect_url: `${config.appUrl}/kros/callback`,
        company_mode: 'multiple',
        state,
      });
      // KROS prijíma webhook len cez HTTPS.
      if (config.appUrl.startsWith('https://')) {
        params.set('webhook', `${config.appUrl}/kros/payments-callback/${org.webhookKey}`);
      }
      res.redirect(`${config.krosConsentUrl}?${params}`);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
