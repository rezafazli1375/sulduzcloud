#!/usr/bin/env node
'use strict';

/**
 * Licence helper for the machine that runs the panel.
 *
 *   node scripts/license-cli.js fingerprint   # show the installation id
 *   node scripts/license-cli.js status        # is the installed key valid?
 *   node scripts/license-cli.js activate FILE # install a signed key (needs root)
 */

const fs = require('fs');
const path = require('path');
const license = require('../src/license');

const [, , command, arg] = process.argv;

function fail(message) {
  console.error(message);
  process.exit(1);
}

switch (command) {
  case 'fingerprint': {
    console.log(license.fingerprint());
    break;
  }
  case 'status': {
    const state = license.status({ fresh: true });
    console.log(`path:        ${state.path}`);
    console.log(`fingerprint: ${state.fingerprint}`);
    console.log(`valid:       ${state.valid}`);
    if (state.license) {
      console.log(`id:          ${state.license.id}`);
      console.log(`customer:    ${state.license.customer}`);
      console.log(`issued:      ${state.license.issued}`);
      console.log(`expires:     ${state.license.expires}`);
    }
    if (!state.valid) console.log(`reason:      ${state.reason}`);
    process.exit(state.valid ? 0 : 1);
    break;
  }
  case 'activate': {
    if (!arg) fail('usage: license-cli.js activate /path/to/license.json');
    let raw = '';
    try {
      raw = fs.readFileSync(path.resolve(arg), 'utf8');
    } catch (err) {
      fail(`cannot read ${arg}: ${err.message}`);
    }
    const result = license.activate(raw);
    if (!result.ok) fail(`activation rejected: ${result.reason}`);
    console.log(`activated: ${license.LICENSE_PATH}`);
    console.log(`fingerprint: ${result.state.fingerprint}`);
    console.log(`customer: ${result.state.license.customer || '-'}`);
    console.log('restart the service to apply: systemctl restart sulduzcloud');
    break;
  }
  default:
    fail('usage: license-cli.js fingerprint | status | activate FILE');
}
