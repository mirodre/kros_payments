/** express-session store v tabuľke `sessions`; dáta šifrované (obsahujú refresh token). */
import session from 'express-session';
import { encrypt, decrypt } from './crypto.js';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class DbSessionStore extends session.Store {
  constructor(db, { key, ttlMs = DEFAULT_TTL_MS }) {
    super();
    this.db = db;
    this.key = key;
    this.ttlMs = ttlMs;
  }

  expiresAt(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
    return exp && !Number.isNaN(exp.getTime()) ? exp : new Date(Date.now() + this.ttlMs);
  }

  get(sid, cb) {
    this.db.query('select data from sessions where sid = $1 and expires_at > now()', [sid])
      .then(({ rows }) => {
        if (!rows[0]) return cb(null, null);
        let sess;
        try {
          sess = JSON.parse(decrypt(rows[0].data, this.key));
        } catch {
          return cb(null, null);
        }
        cb(null, sess);
      }, cb);
  }

  set(sid, sess, cb = () => {}) {
    this.db.query(
      `insert into sessions (sid, data, expires_at) values ($1, $2, $3)
       on conflict (sid) do update set data = excluded.data, expires_at = excluded.expires_at`,
      [sid, encrypt(JSON.stringify(sess), this.key), this.expiresAt(sess)],
    ).then(() => cb(null), cb);
  }

  touch(sid, sess, cb = () => {}) {
    this.db.query('update sessions set expires_at = $2 where sid = $1', [sid, this.expiresAt(sess)])
      .then(() => cb(null), cb);
  }

  destroy(sid, cb = () => {}) {
    this.db.query('delete from sessions where sid = $1', [sid]).then(() => cb(null), cb);
  }

  async pruneExpired() {
    const { rowCount } = await this.db.query('delete from sessions where expires_at <= now()');
    return rowCount;
  }
}
