/** Načítanie a validácia konfigurácie z env. */

const REQUIRED = [
  'APP_URL',
  'DATABASE_URL',
  'SESSION_SECRET',
  'APP_ENCRYPTION_KEY',
  'AUTH_SERVICE_URL',
  'AUTH_SERVICE_CLIENT_ID',
  'AUTH_SERVICE_CLIENT_SECRET',
  'AUTH_SERVICE_REDIRECT_URI',
];

const stripSlash = (s) => String(s).replace(/\/+$/, '');

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length) {
    throw new Error(`Chýbajú povinné env premenné: ${missing.join(', ')}`);
  }
  if (env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET musí mať aspoň 32 znakov.');
  }
  const encryptionKey = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY musí byť 32 bajtov v base64 (napr. `openssl rand -base64 32`).');
  }
  const appUrl = stripSlash(env.APP_URL);
  return {
    appUrl,
    appOrigin: new URL(appUrl).origin,
    port: Number(env.PORT) || 3000,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    encryptionKey,
    secureCookies: appUrl.startsWith('https://'),
    authService: {
      url: stripSlash(env.AUTH_SERVICE_URL),
      clientId: env.AUTH_SERVICE_CLIENT_ID,
      clientSecret: env.AUTH_SERVICE_CLIENT_SECRET,
      redirectUri: env.AUTH_SERVICE_REDIRECT_URI,
      appKey: env.AUTH_SERVICE_APP_KEY || 'financie',
      claimsTtlMs: 900_000,
      gracePeriodMs: 86_400_000,
      timeoutMs: 5000,
    },
    krosApiBase: stripSlash(env.KROS_API_BASE || 'https://api-economy.kros.sk'),
    krosConsentUrl: 'https://firma.kros.sk/integration-consent',
    // 0 = plánovač automatizácií vypnutý (ručné „Spustiť teraz“ funguje stále).
    automationIntervalMinutes: env.AUTOMATION_INTERVAL_MINUTES === undefined || env.AUTOMATION_INTERVAL_MINUTES === ''
      ? 60 : Math.max(0, Number(env.AUTOMATION_INTERVAL_MINUTES) || 0),
  };
}
