/** /api/me, /api/kros/connections, /api/kros-callbacks (za requireAuth). */
import { Router } from 'express';
import { listConnections, deleteConnection, listCallbacks, getOrganization } from '../repos.js';

export function createApiRouter({ config, db }) {
  const router = Router();

  router.get('/me', (req, res) => {
    res.json({ user: req.user, organization: req.organization });
  });

  router.get('/kros/connections', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await listConnections(db, req.organizationId));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/kros/connections/:id', async (req, res, next) => {
    try {
      const deleted = await deleteConnection(db, req.organizationId, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'connection_not_found' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/kros-callbacks', async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const org = await getOrganization(db, req.organizationId);
      const result = await listCallbacks(db, req.organizationId, req.query.sinceSeq);
      res.json({ ...result, callbackUrl: org ? `${config.appUrl}/kros/payments-callback/${org.webhookKey}` : null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
