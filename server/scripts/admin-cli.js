#!/usr/bin/env node
'use strict';

// Operator CLI (root or the sulduz user). Used by the SSH menu (`sulduzcloud` /
// `sc`) to show accounts and to reset a password without opening the web UI.
//
//   npm run admin -- list
//   npm run admin -- admins
//   npm run admin -- info <username>
//   npm run admin -- reset <username> [--password VALUE]
//
// Passwords are stored as bcrypt hashes, so the original password can never be
// printed. `reset` generates a fresh one and prints it once; the menu stores that
// value in /etc/sulduzcloud/admin.cred (mode 600, root only) so it can be shown.

const crypto = require('crypto');
const config = require('../src/config');
const { getDb, closeDb } = require('../src/db');
const users = require('../src/services/users');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

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
    const status = row.status === 'active' ? 'فعال' : row.status;
    console.log(`${row.username}   ${status}   ${String(row.created_at || '').slice(0, 10)}`);
  }
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

function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = _;
  try {
    if (command === 'list') cmdList();
    else if (command === 'admins') cmdAdmins();
    else if (command === 'info' && target) cmdInfo(target);
    else if (command === 'reset' && target) {
      cmdReset(target, typeof flags.password === 'string' ? flags.password : '');
    } else {
      console.log('Usage:');
      console.log('  admin-cli.js list');
      console.log('  admin-cli.js admins');
      console.log('  admin-cli.js info <username>');
      console.log('  admin-cli.js reset <username> [--password VALUE]');
      process.exitCode = command ? 2 : 0;
    }
  } finally {
    try { closeDb(); } catch (_) {}
  }
}

main();
