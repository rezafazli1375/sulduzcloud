#!/usr/bin/env node
'use strict';

// Operator CLI (root or the sulduz user). Used by the SSH menu (`sulduzcloud` /
// `sc`) to show accounts, reset the owner, and change the three things the menu
// owns without opening the web UI: the listener port, the panel address and the
// certificate paths.
//
//   npm run admin -- list
//   npm run admin -- admins
//   npm run admin -- info <username>
//   npm run admin -- reset <username> [--password VALUE]
//   npm run admin -- rename <username> <new-username>
//   npm run admin -- bootstrap <username> <password> [name]   (or ADMIN_USERNAME/ADMIN_PASSWORD)
//   npm run admin -- port show | port get | port set <port>
//   npm run admin -- url show | url get | url set <full-url> | url clear
//   npm run admin -- ssl show | ssl get | ssl set --cert <path> --key <path> | ssl clear
//   npm run admin -- net show
//   npm run admin -- activation show | activation set <female key>
//   npm run admin -- activation male | activation check
//
// `activation check` prints one of activated / required / legacy, and
// `activation male` prints only this install's male id: install.sh and the SSH
// menu read those instead of grepping a Persian sentence. `set` also accepts the
// key in the ACTIVATION_KEY environment, which is how the installer passes it —
// argv of a running process is readable by every other user through `ps`.
//
// Passwords are stored as bcrypt hashes, so the original password can never be
// printed. `reset` generates a fresh one and prints it once; the menu stores that
// value in /etc/sulduzcloud/admin.cred (mode 600, root only) so it can be shown.
//
// v2.1.0 — why the network commands live here at all: src/net.js reads the stored
// `general.panelPort` FIRST and the .env PORT only as a fallback. A menu that
// edited .env alone would be quietly overruled by the stored number on the next
// boot, so the menu writes both and this file prints both side by side. What it
// never prints is the live socket: this process is not the listener, so "what port
// is the panel actually on" is answered from systemd and ss in the menu, not
// guessed here.

const crypto = require('crypto');
const fs = require('fs');
const config = require('../src/config');
const net = require('../src/net');
const settings = require('../src/settings');
const activation = require('../src/activation');
const { getDb, closeDb } = require('../src/db');
const users = require('../src/services/users');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

function generatePassword(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args.flags[key] = next; i += 1; }
      else args.flags[key] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function pad(value, width) {
  return String(value).padEnd(width).slice(0, width);
}

/** A refusal has to be a nonzero exit: the menu chains these and must stop. */
function fail(message) {
  console.error(message);
  process.exitCode = 1;
  return false;
}

function cmdList() {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, username, role, status, name, balance FROM users WHERE deleted_at = 0 ORDER BY role = 'admin' DESC, id")
    .all();
  if (!rows.length) {
    console.log('No accounts yet. Open the panel in a browser to run the first-run setup.');
    return;
  }
  console.log(`${pad('ID', 5)}${pad('USERNAME', 24)}${pad('ROLE', 10)}${pad('STATUS', 9)}NAME`);
  for (const row of rows) {
    console.log(`${pad(row.id, 5)}${pad(row.username, 24)}${pad(row.role, 10)}${pad(row.status, 9)}${row.name || ''}`);
  }
  const owners = rows.filter((row) => row.role === 'admin').length;
  console.log(`\n${rows.length} account(s), ${owners} admin. Database: ${config.dbPath}`);
}

function cmdAdmins() {
  const db = getDb();
  const rows = db
    .prepare("SELECT username, status, created_at FROM users WHERE deleted_at = 0 AND role = 'admin' ORDER BY id")
    .all();
  for (const row of rows) {
    const status = row.status === 'active' ? 'active' : row.status;
    const stamp = Number(row.created_at);
    const when = Number.isFinite(stamp) && stamp > 0
      ? new Date(stamp > 1e12 ? stamp : stamp * 1000).toISOString().slice(0, 10)
      : '';
    console.log(`${row.username}   ${status}   ${when}`);
  }
}

// One line, only the first owner's name — what the menu asks for before it
// touches the right account.
function cmdOwner() {
  const row = getDb()
    .prepare("SELECT username FROM users WHERE deleted_at = 0 AND role = 'admin' ORDER BY id")
    .get();
  console.log(row ? row.username : '');
}

// The installer's last step: create the owner from the console so a fresh server
// never has to open a browser before it is usable. It mirrors POST /api/setup
// exactly (admin, '*', lang fa) and refuses to run twice — the first account on
// this panel was created by whoever got there first, and overwriting it is not
// what re-running an installer should mean.
function cmdBootstrap(username, password, name) {
  // v2.1.0 — the same gate the running panel applies (src/index.js answers 423 on
  // every route but /meta, /health and /activation while this is true). Creating
  // the owner here would take the account count off zero, and because
  // activation.isRequired() only locks a panel with NO accounts, a CLI that
  // ignored it would hand a stranger a way past the female key: the panel would
  // look activated to itself without ever having been given one.
  if (activation.isRequired()) {
    return fail(`This install is not activated yet. Enter the activation key with "activation set <key>" or from the activation page in the browser; serial: ${activation.challengeMale()}`);
  }
  const existing = getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE deleted_at = 0').get().c;
  if (Number(existing) > 0) {
    console.log(`The owner account already exists (${existing} active accounts) — nothing was created.`);
    return true;
  }
  const user = String(username || '').trim();
  const pw = String(password || '');
  if (!USERNAME_RE.test(user)) return fail('The username must be 3 to 32 characters: english letters, digits, dot, dash or underscore.');
  if (pw.length < 8) return fail('The password must be at least 8 characters.');
  let created;
  try {
    created = users.createUser(
      { username: user, password: pw, name: String(name || '').trim() || 'Owner', role: 'admin', status: 'active', permissions: ['*'], lang: 'fa' },
      null
    );
  } catch (err) {
    return fail(err && err.message ? err.message : 'the owner account was not created.');
  }
  console.log(`Owner account created: ${created.username} (id ${created.id}, role admin).`);
  return true;
}

function cmdInfo(username) {
  const user = users.getUserByUsername(username);
  if (!user) {
    console.error(`No user named "${username}".`);
    process.exitCode = 1;
    return;
  }
  const fields = ['id', 'username', 'name', 'role', 'status', 'email', 'phone', 'balance', 'max_configs', 'created_at'];
  for (const key of fields) console.log(`${pad(key, 14)}${user[key] ?? ''}`);
}

function cmdReset(username, explicit) {
  const user = users.getUserByUsername(username);
  if (!user) {
    console.error(`No user named "${username}".`);
    process.exitCode = 1;
    return;
  }
  const password = explicit || generatePassword();
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }
  users.updateUser(user.id, { password }, null);
  console.log(`Password updated for ${user.username} (${user.role}).`);
  if (!explicit) {
    console.log(`\n  New password: ${password}\n`);
    console.log('Store it now; it cannot be shown again. Change it after logging in.');
  }
}

// Renaming the owner is the other half of «reset username and password owner».
// Everything a username is attached to in this database is an id, not a string
// (configs.user_id, transactions.user_id, audit_logs.user_id), so moving the
// login name never touches a single package — which is why this is allowed at all.
function cmdRename(username, nextName) {
  const user = users.getUserByUsername(username);
  if (!user) return fail(`no account named "${username}".`);
  const next = String(nextName || '').trim();
  if (!USERNAME_RE.test(next)) {
    return fail('The new username must be 3 to 32 characters: english letters, digits, dot, dash or underscore.');
  }
  if (next.toLowerCase() === String(user.username).toLowerCase()) return fail('the new name is the same as the current one.');
  try {
    users.updateUser(user.id, { username: next }, null);
  } catch (err) {
    return fail(err && err.message ? err.message : 'the username was not changed.');
  }
  console.log(`Username "${user.username}" changed to "${next}" (role ${user.role}).`);
  console.log('From now on log in with this name; old sessions of the previous name do nothing.');
  return true;
}

// ── network: port, address, certificates ──────────────────────────────────
// Every write here goes through settings.updateSection('general'), the same door
// the web form uses, so the menu can never grow a weaker set of rules than the
// panel itself. updateSection drops unknown and locked fields, which is exactly
// the validation we want repeated.
function patchGeneral(patch) {
  try {
    return settings.updateSection('general', patch);
  } catch (err) {
    fail(`saving the general settings failed: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function showOr(value) {
  const text = String(value == null ? '' : value).trim();
  return text || '—';
}

// Both halves of the port decision, side by side, because `net.desired()` picks
// the stored number over the .env one. An operator who sees only one of them
// cannot tell why a restart did not move the panel.
function networkReadout() {
  const general = settings.getSetting('general') || {};
  const want = net.desired();
  console.log(`port stored in the settings (general.panelPort) : ${showOr(general.panelPort)}`);
  console.log(`port in the .env file (PORT)                      : ${showOr(process.env.PORT)}`);
  console.log(`port the panel takes on its next boot             : ${want.port}`);
  console.log(`listen address (HOST)                             : ${want.host}`);
  console.log(`public address in the settings (publicUrl)        : ${showOr(general.publicUrl)}`);
  console.log(`public address in .env (PUBLIC_URL)               : ${showOr(process.env.PUBLIC_URL)}`);
  console.log(`public key path (sslCertPath)                     : ${showOr(want.certPath)}`);
  console.log(`private key path (sslKeyPath)                     : ${showOr(want.keyPath)}`);
  if (want.certPath || want.keyPath) {
    for (const [label, file] of [['public key', want.certPath], ['private key', want.keyPath]]) {
      if (!file) { console.log(`  ${label}: not set — the panel stays on HTTP until both paths are filled.`); continue; }
      console.log(`  ${label}: ${fs.existsSync(file) ? 'present' : 'NOT FOUND!'} ${file}`);
    }
  } else {
    console.log('  certificate: not set — the panel is served on HTTP (nginx can end TLS itself).');
  }
}

function cmdPort(action, value) {
  const general = settings.getSetting('general') || {};
  if (action === 'get') { console.log(net.desired().port); return true; }
  if (action === 'show' || !action) { networkReadout(); return true; }
  if (action !== 'set') return fail('port commands: port set <number> | port get | port show');
  const port = net.clampPort(value);
  if (!port) return fail(`invalid port: "${showOr(value)}". A number between ${net.MIN_PORT} and ${net.MAX_PORT}.`);
  if (!patchGeneral({ panelPort: port })) return false;
  console.log(`the panel port was saved as ${port} (before: ${showOr(general.panelPort)}).`);
  console.log('Reminder: this menu updates the .env file and the nginx config too; the panel does not move until a restart.');
  return true;
}

// The same two shapes routes/admin.js accepts: a host with a dot, or a bare IPv4
// with an optional port. Anything else would be stored and then quoted into a
// customer's subscribe link broken.
function validPublicUrl(raw) {
  const url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/i.test(url)) return url;
  if (/^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?$/i.test(url)) return url;
  return null;
}

function cmdUrl(action, value) {
  const general = settings.getSetting('general') || {};
  if (action === 'get') { console.log(net.desired().publicUrl); return true; }
  if (action === 'show' || !action) {
    console.log(`publicUrl (settings) : ${showOr(general.publicUrl)}`);
    console.log(`PUBLIC_URL (.env)   : ${showOr(process.env.PUBLIC_URL)}`);
    return true;
  }
  if (action === 'clear') {
    if (!patchGeneral({ publicUrl: '' })) return false;
    console.log('the public address was cleared; the panel uses the address the browser requested.');
    return true;
  }
  if (action !== 'set') return fail('url commands: url set <full address> | url get | url show | url clear');
  if (!String(value || '').trim()) return fail('the address is empty. To clear it: url clear');
  const url = validPublicUrl(value);
  if (url === null) return fail(`invalid address: "${showOr(value)}". It must be http:// or https:// with a full host.`);
  if (!patchGeneral({ publicUrl: url })) return false;
  console.log(`panel address saved: ${url} — subscription links and cookies use it from now on.`);
  return true;
}

// A half key pair is the case that silently kills HTTPS, so the two paths are
// only ever written together — same rule the web form enforces.
function cmdSsl(action, flags) {
  const want = net.desired();
  if (action === 'get') { console.log(want.certPath && want.keyPath ? `${want.certPath}\n${want.keyPath}` : ''); return true; }
  if (action === 'show' || !action) { networkReadout(); return true; }
  if (action === 'clear') {
    if (!patchGeneral({ sslCertPath: '', sslKeyPath: '' })) return false;
    console.log('certificate paths cleared. If nginx ends HTTPS itself, this is correct.');
    return true;
  }
  if (action !== 'set') return fail('certificate: use ssl set --cert <path> --key <path> | ssl show | ssl clear');
  const cert = String(flags.cert || '').trim();
  const key = String(flags.key || '').trim();
  if (!cert || !key) return fail('both paths are required for HTTPS: --cert and --key.');
  for (const [label, file] of [['public key', cert], ['private key', key]]) {
    if (!file.startsWith('/')) return fail(`${label}: the path must be absolute (it must start with /).`);
    if (!fs.existsSync(file)) return fail(`${label}: no file exists at ${file}.`);
  }
  const { error } = net.readKeyPair(cert, key);
  if (error) return fail(`the certificate pair is not usable: ${error}`);
  if (!patchGeneral({ sslCertPath: cert.slice(0, 300), sslKeyPath: key.slice(0, 300) })) return false;
  console.log('Certificate paths saved. After a restart the panel is served directly on HTTPS.');
  return true;
}

function cmdActivation(action, value) {
  // The two machine-readable answers install.sh and the SSH menu need, printed
  // alone so nobody has to grep a Persian sentence for a value.
  if (action === 'male') {
    console.log(activation.challengeMale());
    return true;
  }
  if (action === 'check') {
    if (activation.isActivated()) console.log('activated');
    else console.log(activation.isRequired() ? 'required' : 'legacy');
    return true;
  }
  if (action === 'set') {
    // The key may arrive as `activation set <key>` or in the environment: the
    // installer passes it through the environment so it never appears in `ps`.
    const result = activation.activate(String(value || process.env.ACTIVATION_KEY || ''), { source: 'cli' });
    if (!result.ok) return fail(`this activation key is not valid for this install (serial: ${result.male}).`);
    console.log(`The panel is activated. Serial ${result.male} is now paired with this install.`);
    return true;
  }
  const status = activation.status();
  if (status.activated) {
    const when = status.activatedAt ? new Date(status.activatedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    console.log(`status: active ✓   serial: ${status.maleKey || '—'}   time: ${when || '—'}   by: ${status.source || '—'}`);
    return true;
  }
  console.log('status: not activated ✗');
  console.log(`serial of this install: ${status.maleKey}`);
  console.log('to activate: get the activation key of this serial from the owner and run  sulduzcloud activate');
  if (status.legacy) console.log('note: this install was upgraded from an earlier version; the accounts exist and the panel works.');
  return true;
}

function usage() {
  console.log('Usage:');
  console.log('  admin-cli.js list | admins | info <username>');
  console.log('  admin-cli.js owner');
  console.log('  admin-cli.js reset <username> [--password VALUE]');
  console.log('  admin-cli.js rename <username> <new-username>');
  console.log('  admin-cli.js bootstrap <username> <password> [name]   ADMIN_USERNAME/ADMIN_PASSWORD also work');
  console.log('  admin-cli.js port show | port get | port set <port>');
  console.log('  admin-cli.js url show | url get | url set <full-url> | url clear');
  console.log('  admin-cli.js ssl show | ssl set --cert <path> --key <path> | ssl clear');
  console.log('  admin-cli.js net show');
  console.log('  admin-cli.js activation show | activation set <female-key>');
  console.log('  admin-cli.js activation male      (prints only this install\'s male key)');
  console.log('  admin-cli.js activation check     (activated | required | legacy)');
}

function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const [command, second, third] = _;
  try {
    if (command === 'list') cmdList();
    else if (command === 'admins') cmdAdmins();
    else if (command === 'owner') cmdOwner();
    else if (command === 'bootstrap') {
      // The installer passes the password in the environment, not on the command
      // line: argv is readable by anyone who runs `ps` on the same machine.
      const who = second || process.env.ADMIN_USERNAME || '';
      const secret = third || process.env.ADMIN_PASSWORD || '';
      if (!who || !secret) {
        fail('bootstrap <username> <password> [name] — or set ADMIN_USERNAME and ADMIN_PASSWORD.');
        process.exitCode = 2;
      } else if (!cmdBootstrap(who, secret, _[3] || '')) {
        process.exitCode = 1;
      }
    }
    else if (command === 'info' && second) cmdInfo(second);
    else if (command === 'reset' && second) {
      cmdReset(second, typeof flags.password === 'string' ? flags.password : '');
    } else if (command === 'rename' && second && third) {
      if (!cmdRename(second, third)) process.exitCode = 1;
    } else if (command === 'port') {
      if (!cmdPort(second, third)) process.exitCode = 1;
    } else if (command === 'url') {
      if (!cmdUrl(second, third)) process.exitCode = 1;
    } else if (command === 'ssl') {
      if (!cmdSsl(second, flags)) process.exitCode = 1;
    } else if (command === 'net') {
      networkReadout();
    } else if (command === 'activation') {
      if (!cmdActivation(second, third)) process.exitCode = 1;
    } else {
      usage();
      process.exitCode = command ? 2 : 0;
    }
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  } finally {
    try { closeDb(); } catch (_) {}
  }
}

main();
