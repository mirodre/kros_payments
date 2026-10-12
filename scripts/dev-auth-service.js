/**
 * Falošný login.krosdoplnky.sk pre lokálny vývoj (automaticky prihlási testovacieho používateľa).
 * Spustenie: npm run dev:auth   → http://localhost:8100
 * .env: AUTH_SERVICE_URL=http://localhost:8100, AUTH_SERVICE_CLIENT_ID=client-1, AUTH_SERVICE_CLIENT_SECRET=secret-1
 * Iný používateľ: DEV_AUTH_USER=bob npm run dev:auth
 */
import { startFakeAuthService } from '../tests/helpers/fakeAuthService.js';

const user = process.env.DEV_AUTH_USER || 'alice';
const fake = await startFakeAuthService({ port: 8100, host: 'localhost' });
fake.setUser(user);
console.log(`Falošný auth service beží na ${fake.url} (používateľ: ${user})`);
