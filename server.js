/**
 * Financie – server: SSO cez login.krosdoplnky.sk, Postgres, proxy na KROS Open API.
 */
import { loadConfig } from './src/config.js';
import { createDb, migrate } from './src/db.js';
import { createApp } from './src/app.js';
import { DbSessionStore } from './src/sessionStore.js';
import { startAutomationScheduler } from './src/automation/scheduler.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = await createDb(config.databaseUrl);
const applied = await migrate(db);
if (applied.length) console.log('Aplikované migrácie:', applied.join(', '));

const app = createApp({ config, db });
const server = app.listen(config.port, () => {
  console.log(`Financie beží na porte ${config.port} (${config.appUrl})`);
  console.log(`KROS API: ${config.krosApiBase} · Auth: ${config.authService.url}`);
});

// Raz za hodinu zmaž expirované sessions.
const sessionStore = new DbSessionStore(db, { key: config.encryptionKey });
const pruneTimer = setInterval(() => {
  sessionStore.pruneExpired().catch((err) => console.warn('[sessions] prune zlyhal:', err.message));
}, 60 * 60 * 1000);
pruneTimer.unref();

// Automatizácie úhrad a prevodov.
const stopAutomations = config.automationIntervalMinutes > 0
  ? startAutomationScheduler({ db, config, intervalMs: config.automationIntervalMinutes * 60 * 1000 })
  : () => {};
if (config.automationIntervalMinutes > 0) console.log(`Automatizácie: každých ${config.automationIntervalMinutes} min`);

function shutdown() {
  stopAutomations();
  server.close(() => db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
