import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { createDb, migrate } from '../src/db.js';
import { DbSessionStore } from '../src/sessionStore.js';

const key = Buffer.alloc(32, 3);

test('set/get/destroy a šifrované dáta v DB', async () => {
  const db = await createDb('pglite:memory');
  await migrate(db);
  const store = new DbSessionStore(db, { key });
  const set = promisify(store.set.bind(store));
  const get = promisify(store.get.bind(store));
  const destroy = promisify(store.destroy.bind(store));

  const sess = { cookie: { expires: new Date(Date.now() + 60_000).toISOString() }, auth: { tokens: { refreshToken: 'RT-secret' } } };
  await set('sid1', sess);
  assert.deepEqual(await get('sid1'), sess);
  const raw = (await db.query('select data from sessions where sid = $1', ['sid1'])).rows[0].data;
  assert.equal(raw.includes('RT-secret'), false);

  await destroy('sid1');
  assert.equal(await get('sid1'), null);
  assert.equal(await get('missing'), null);
  await db.close();
});

test('expirovaná alebo nedešifrovateľná session sa ignoruje, prune maže', async () => {
  const db = await createDb('pglite:memory');
  await migrate(db);
  const store = new DbSessionStore(db, { key });
  const get = promisify(store.get.bind(store));
  await promisify(store.set.bind(store))('old', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(await get('old'), null);
  await db.query("insert into sessions(sid, data, expires_at) values ('bad', 'v1.x.y.z', now() + interval '1 hour')");
  assert.equal(await get('bad'), null);
  assert.equal(await store.pruneExpired(), 1);
  await db.close();
});
