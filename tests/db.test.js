import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, migrate } from '../src/db.js';

test('migrate vytvorí schému a je idempotentný', async () => {
  const db = await createDb('pglite:memory');
  assert.deepEqual(await migrate(db), ['001_init.sql']);
  assert.deepEqual(await migrate(db), []);
  const { rows } = await db.query(
    "select table_name from information_schema.tables where table_schema='public' order by table_name");
  assert.deepEqual(rows.map((r) => r.table_name), [
    'kros_connections', 'kros_consent_requests', 'kros_payment_callbacks',
    'organizations', 'schema_migrations', 'sessions', 'users',
  ]);
  await db.close();
});

test('query vracia rows a rowCount', async () => {
  const db = await createDb('pglite:memory');
  await migrate(db);
  const ins = await db.query('insert into users(id,email) values ($1,$2),($3,$4)', ['u1', 'a@x', 'u2', 'b@x']);
  assert.equal(ins.rowCount, 2);
  const { rows } = await db.query('select id from users order by id');
  assert.deepEqual(rows.map((r) => r.id), ['u1', 'u2']);
  await db.close();
});
