import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomToken, pkceChallenge, encrypt, decrypt, safeEqual } from '../src/crypto.js';

const key = Buffer.alloc(32, 9);

test('pkceChallenge zodpovedá RFC 7636 príkladu', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomToken je base64url a unikátny', () => {
  const a = randomToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomToken());
});

test('encrypt/decrypt round-trip, rôzny ciphertext', () => {
  const a = encrypt('tajný token', key);
  const b = encrypt('tajný token', key);
  assert.notEqual(a, b);
  assert.equal(decrypt(a, key), 'tajný token');
});

test('decrypt odmietne poškodený ciphertext a iný kľúč', () => {
  const enc = encrypt('x', key);
  const parts = enc.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => decrypt(parts.join('.'), key));
  assert.throws(() => decrypt(enc, Buffer.alloc(32, 1)));
  assert.throws(() => decrypt('garbage', key));
});

test('safeEqual', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), false);
});
