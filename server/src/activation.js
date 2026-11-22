'use strict';

// Panel v2.1.0 — activation by a male/female key pair («کلید نر و مادگی»).
// v2.3.0 renames what the operator SEES: the male half is «سریال» (serial) and the
// female half is «کلید فعالسازی» (activation key). The identifiers below keep the
// old names on purpose — they are internal, and the shipped ids are already in
// installs that are out there.
//
// The owner's rule, in his own words: the panel a stranger installs must not run
// until he is shown a MALE key and types the FEMALE half that belongs to it.
// So this file carries only the public half of the deal — the male ids and a
// SHA-256 fingerprint of each matching female — and the female strings live in
// one text file in the owner's hands. Nothing here can be turned back into a
// key: verifying a guess is a hash comparison, and there are five real answers
// out of 32^16 shapes.
//
//   male id    printed by the panel (one per install, chosen at first boot)
//   female key what the installer types, once
//
// An install is "activated" the moment a matching pair is accepted; the record
// lives in its own one-row table so a settings restore or a database copy takes
// the activation with it. A panel that already has accounts and no record —
// every install built before v2.1.0 — is NOT asked: it was activated by its
// owner long before this feature existed, and upgrading must never lock a
// running panel out of its own screen.

const crypto = require('crypto');
const { getDb } = require('./db');

// Public ids and the fingerprint of their partner. `digest` is
// sha256("<male>:<female without spaces or dashes, uppercased>").
const KEY_PAIRS = [
  { male: 'SCM-EBRR-LTK2', digest: '7cbffd70d76d19528edf0b20d4b62cffc7cb836a5a664254a44f99aaa651713d' },
  { male: 'SCM-A7LM-LANE', digest: '4a1627f14af091c9ff0d949c85516f3ac1f2c10cef2f628de171a0998d7383a8' },
  { male: 'SCM-UL87-9CJ2', digest: '6c085deb2b5857c65aa8596e3b227c861365f0e3f2963a88e86a6f39558e2327' },
  { male: 'SCM-QN25-PWRW', digest: '83ce95a8d537fc29e29139e21e45b693891f19fad6f5b45a30d3cb459f98beee' },
  { male: 'SCM-FDAX-PVRX', digest: 'd5ebb7e2b5d28da2b34f96aebd3152edb777ad61edaae55aaf7eb17f1bb7972d' },
];

const MALE_IDS = KEY_PAIRS.map((pair) => pair.male);

function digestOf(male, female) {
  const normalized = String(female || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(`${male}:${normalized}`, 'utf8').digest('hex');
}

// Constant-time on purpose: this is the one check a stranger gets to repeat.
function matches(male, female) {
  const pair = KEY_PAIRS.find((item) => item.male === male);
  if (!pair) return false;
  const a = Buffer.from(pair.digest, 'hex');
  const b = Buffer.from(digestOf(male, female), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readRow() {
  try {
    return getDb().prepare('SELECT * FROM activation WHERE id = 1').get() || null;
  } catch (_) {
    // A database file written by an older panel has no such table yet; migrate()
    // creates it on the next real boot, and until then nothing is activated.
    return null;
  }
}

function accountCount() {
  try {
    return Number(getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at = 0').get().c || 0);
  } catch (_) {
    return 0;
  }
}

function isActivated() {
  const row = readRow();
  return Boolean(row && Number(row.activated_at || 0) > 0);
}

/**
 * The one rule every gate in the panel uses. A panel that has accounts but no
 * record is a pre-2.1.0 install: already its owner's, never locked.
 */
function isRequired() {
  return !isActivated() && accountCount() === 0;
}

/**
 * The male key this install answers with. It is written down the first time it
 * is asked for, so the screen a confused installer comes back to shows the same
 * id — a random id per visit would make the offline conversation with the owner
 * impossible.
 */
function challengeMale() {
  const row = readRow();
  if (row && row.male_key && MALE_IDS.includes(row.male_key)) return row.male_key;
  const index = crypto.randomInt(0, MALE_IDS.length);
  const male = MALE_IDS[index];
  getDb().prepare(
    `INSERT INTO activation (id, male_key, fingerprint, activated_at, source) VALUES (1, ?, '', 0, 'challenge')
     ON CONFLICT(id) DO UPDATE SET male_key = excluded.male_key`
  ).run(male);
  return male;
}

function status() {
  const row = readRow();
  const activated = isActivated();
  return {
    activated,
    required: isRequired(),
    maleKey: activated ? String(row.male_key || '') : challengeMale(),
    activatedAt: activated ? Number(row.activated_at) : 0,
    source: activated ? String(row.source || '') : '',
    legacy: !activated && accountCount() > 0,
  };
}

/**
 * Accept a female key for this install's male id. Wrong answers change nothing;
 * the caller decides how loudly to complain and how often to allow a try.
 * `source` records who unlocked it ('web', 'install', 'cli') for the audit trail.
 */
function activate(female, { source = 'web' } = {}) {
  const male = challengeMale();
  if (!matches(male, female)) {
    getDb().prepare(
      'UPDATE activation SET attempts = attempts + 1, last_attempt_at = ? WHERE id = 1'
    ).run(Date.now());
    return { ok: false, male };
  }
  const now = Date.now();
  getDb().prepare(
    `INSERT INTO activation (id, male_key, fingerprint, activated_at, source) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET male_key = excluded.male_key, fingerprint = excluded.fingerprint,
       activated_at = excluded.activated_at, source = excluded.source`
  ).run(male, digestOf(male, female).slice(0, 16), now, String(source).slice(0, 16));
  return { ok: true, male };
}

module.exports = {
  MALE_IDS,
  digestOf,
  matches,
  isActivated,
  isRequired,
  challengeMale,
  status,
  activate,
};
