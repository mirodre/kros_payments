/** Plánovač automatizácií: raz za interval prejde všetky zapnuté pravidlá. */
import { listEnabledRules } from './repo.js';
import { runRule } from './runner.js';

const SCHEDULER_LOCK_ID = 727002;

/** Jeden tick. Advisory lock: pri viacerých inštanciách servera beží tick len v jednej. */
export async function runAllRules({ db, config, createClient, now, log = console }) {
  return db.withClient(async (c) => {
    const { rows } = await c.query('select pg_try_advisory_lock($1) as ok', [SCHEDULER_LOCK_ID]);
    if (!rows[0].ok) return { skipped: true, results: [] };
    try {
      const results = [];
      for (const rule of await listEnabledRules(db)) {
        try {
          const result = await runRule({ db, config, rule, createClient, now });
          results.push({ ruleId: rule.id, ...result });
          if (result.summary && (result.summary.sent || result.summary.failed || result.status !== 'ok')) {
            log.log('[automation] pravidlo %s (%s): %s %j', rule.id, rule.kind, result.status, result.summary);
          }
        } catch (err) {
          log.error('[automation] pravidlo %s zlyhalo: %s', rule.id, err.message);
          results.push({ ruleId: rule.id, status: 'error', error: err.message });
        }
      }
      return { skipped: false, results };
    } finally {
      await c.query('select pg_advisory_unlock($1)', [SCHEDULER_LOCK_ID]);
    }
  });
}

export function startAutomationScheduler({ db, config, intervalMs, firstRunDelayMs = 60_000, log = console }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAllRules({ db, config, log });
    } catch (err) {
      log.error('[automation] tick zlyhal:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstRunDelayMs);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
