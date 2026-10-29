#!/usr/bin/env node
'use strict';

/**
 * Vendor-side signing tool. The Ed25519 private key never ships with the
 * repository; point SC_LICENSE_KEY at it before running.
 *
 *   SC_LICENSE_KEY=~/.sulduz/license-key.pem \
 *   node scripts/sign-license.js --fingerprint ABCD-... --customer "Name" \
 *        [--expires 2027-12-31|never] [--out license.json]
 */

const fs = require('fs');
const crypto = require('crypto');

const args = process.argv.slice(2);
function argValue(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const keyFile = process.env.SC_LICENSE_KEY || '';
const fingerprint = argValue('fingerprint').toUpperCase().trim();
const customer = argValue('customer', 'Sulduz Cloud');
const expires = argValue('expires', 'never');
const out = argValue('out', 'license.json');

if (!keyFile) {
  console.error('Set SC_LICENSE_KEY to the path of the Ed25519 private key (PEM).');
  process.exit(1);
}
if (!fingerprint) {
  console.error('--fingerprint is required (see: license-cli.js fingerprint)');
  process.exit(1);
}
if (expires !== 'never' && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error('--expires must be YYYY-MM-DD or "never"');
  process.exit(1);
}

const doc = {
  v: 1,
  id: `SC-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
  fingerprint,
  customer,
  issued: new Date().toISOString().slice(0, 10),
  expires,
};

const canonical = ['SC1', doc.id, doc.fingerprint, doc.customer, doc.issued, doc.expires].join('|');
const key = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), key);
doc.sig = sig.toString('base64');

fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
console.log(`license written to ${out}`);
console.log(`  id:          ${doc.id}`);
console.log(`  fingerprint: ${doc.fingerprint}`);
console.log(`  expires:     ${doc.expires}`);
