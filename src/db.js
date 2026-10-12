/**
 * Spoločné DB rozhranie nad `pg` (produkcia) a PGlite (testy, lokálny vývoj).
 * DATABASE_URL: postgres://…  |  pglite:memory  |  pglite:<cesta k adresáru>
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_LOCK_ID = 727001;

export async function createDb(databaseUrl) {
  if (databaseUrl.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const location = databaseUrl.slice('pglite:'.length);
    const inMemory = !location || location === 'memory';
    if (!inMemory) await fs.mkdir(location, { recursive: true });
    const pg = new PGlite(inMemory ? undefined : location);
    await pg.waitReady;
    const db = {
      async query(text, params = []) {
        const r = await pg.query(text, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
      async exec(sql) {
        await pg.exec(sql);
      },
      withClient: (fn) => fn(db),
      close: () => pg.close(),
    };
    return db;
  }

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (err) => console.error('[db] pool error:', err.message));
  const wrap = (c) => ({
    query: (text, params = []) => c.query(text, params),
    exec: async (sql) => { await c.query(sql); },
  });
  return {
    ...wrap(pool),
    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(wrap(client));
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Aplikuje nové migrations/*.sql v abecednom poradí; chránené advisory lockom. */
export async function migrate(db, dir = MIGRATIONS_DIR) {
  return db.withClient(async (c) => {
    await c.exec(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    await c.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const done = new Set((await c.query('select name from schema_migrations')).rows.map((r) => r.name));
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      const applied = [];
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = await fs.readFile(path.join(dir, file), 'utf8');
        await c.exec('begin');
        try {
          await c.exec(sql);
          await c.query('insert into schema_migrations(name) values ($1)', [file]);
          await c.exec('commit');
        } catch (err) {
          await c.exec('rollback').catch(() => {});
          throw new Error(`Migrácia ${file} zlyhala: ${err.message}`);
        }
        applied.push(file);
      }
      return applied;
    } finally {
      await c.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  });
}
