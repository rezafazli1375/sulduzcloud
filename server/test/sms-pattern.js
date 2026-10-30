'use strict';

/**
 * Pattern-SMS test.
 *
 * Drives notify.testSms / sendSms / alertAdmins against a stubbed fetch, so it
 * checks the exact provider requests (Kavenegar verify/lookup and FarazSMS
 * /ws/v1/sms/pattern) without network access, x-ui or the production data
 * directory.
 *
 *   npm run sms-test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sms-'));
process.env.DATA_DIR = DATA_DIR;
process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
process.env.NODE_ENV = 'test';
process.env.TZ = 'Asia/Tehran';

const settings = require('../src/settings');
const notify = require('../src/notify');
const { closeDb } = require('../src/db');

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? '  — ' + note : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? '  — ' + note : ''}`); }
}

const calls = [];
let respond = () => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'success', data: 1, messages: [] }),
});

global.fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(String(input));
  calls.push({ url, init });
  return respond(url, init);
};

const bodyOf = (call) => JSON.parse(call.init.body || '{}');

async function run() {
  // ------------------------------------------------------------ FarazSMS pattern
  settings.updateSection('sms', {
    enabled: true,
    provider: 'farazsms',
    mode: 'pattern',
    apiKey: 'KEY123',
    sender: '50002178584000',
    to: '0912 000 0000; +989351112233',
    pattern: 'SJ3FgPrE0C',
    patternVar1: '{title}',
    patternVar2: '{body}',
    patternVar3: '',
  });
  calls.length = 0;
  const farazTest = await notify.testSms();
  check(
    'farazsms pattern sends one request per recipient to /ws/v1/sms/pattern',
    calls.length === 2
      && calls.every((call) => call.url.href === 'https://api.iranpayamak.com/ws/v1/sms/pattern' && call.init.method === 'POST'),
    `calls=${calls.length}`
  );
  const [first, second] = calls.map(bodyOf);
  check(
    'farazsms pattern body carries code, var1/var2, line and english format',
    first.code === 'SJ3FgPrE0C'
      && first.attributes?.var1 === 'Sulduz Cloud'
      && first.attributes?.var2 === 'پیام آزمایشی'
      && !first.attributes?.var3
      && first.recipient === '09120000000'
      && first.line_number === '50002178584000'
      && first.number_format === 'english',
    JSON.stringify(first)
  );
  check(
    'farazsms pattern normalizes every recipient to the local 09 form',
    second.recipient === '09351112233'
      && calls[0].init.headers['Api-Key'] === 'KEY123',
    second.recipient
  );
  check(
    'test result reports provider, mode, pattern and rendered variables',
    farazTest.mode === 'pattern'
      && farazTest.pattern === 'SJ3FgPrE0C'
      && farazTest.vars?.[0] === 'Sulduz Cloud'
      && farazTest.vars?.[1] === 'پیام آزمایشی'
  );

  // FarazSMS matches attribute keys to the pattern's own variable names.
  settings.updateSection('sms', { patternNames: 'code, msg' });
  calls.length = 0;
  await notify.testSms();
  const renamed = bodyOf(calls[0]);
  check(
    'farazsms attribute names follow the pattern definition',
    renamed.attributes?.code === 'Sulduz Cloud'
      && renamed.attributes?.msg === 'پیام آزمایشی'
      && !renamed.attributes?.var1,
    JSON.stringify(renamed.attributes)
  );
  settings.updateSection('sms', { patternNames: 'var1,var2,var3' });

  // ------------------------------------------------------------ Kavenegar pattern
  respond = () => ({
    ok: true,
    status: 200,
    json: async () => ({ return: { status: 200, message: 'تایید شد' }, entries: [{ messageid: 11 }] }),
  });
  settings.updateSection('sms', { provider: 'kavenegar', pattern: 'sulduz-alert' });
  calls.length = 0;
  await notify.sendSms('هشدار: سرور قطع شد\nx-ui پاسخ نداد');
  const kavQuery = calls[0].url.searchParams;
  check(
    'kavenegar pattern calls verify/lookup once per recipient with template and type',
    calls.length === 2
      && calls.every((call) => call.url.pathname === '/v1/KEY123/verify/lookup.json')
      && calls.map((call) => call.url.searchParams.get('receptor')).join(',') === '09120000000,09351112233'
      && kavQuery.get('template') === 'sulduz-alert'
      && kavQuery.get('type') === 'sms'
  );
  check(
    'kavenegar pattern splits the message into token and token2',
    kavQuery.get('token') === 'هشدار: سرور قطع شد'
      && kavQuery.get('token2') === 'x-ui پاسخ نداد'
      && kavQuery.get('token3') === null
  );

  // ------------------------------------------------- variable mapping + limits
  settings.updateSection('sms', {
    patternVar1: 'sulduz-{date}',
    patternVar2: '{title}',
    patternVar3: '{body}',
  });
  calls.length = 0;
  const longBody = 'ب'.repeat(150);
  await notify.sendSms(`عنوان\n${longBody}`);
  const mapped = calls[0].url.searchParams;
  check(
    'variables accept {date}/{title}/{body} literals and keep 100-char cap',
    /^sulduz-\d{4}-\d{2}-\d{2}$/.test(mapped.get('token'))
      && mapped.get('token2') === 'عنوان'
      && mapped.get('token3') === 'ب'.repeat(100)
  );

  // ---------------------------------------------------------- missing pattern
  settings.updateSection('sms', { pattern: '', patternVar1: '{title}', patternVar2: '{body}', patternVar3: '' });
  let err = null;
  try { await notify.sendSms('a\nb'); } catch (caught) { err = caught; }
  check('missing pattern is rejected with sms_pattern_missing', err && err.status === 400 && err.code === 'sms_pattern_missing');

  // --------------------------------------------------------- provider error
  respond = () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'error', messages: ['code not found'] }),
  });
  settings.updateSection('sms', { provider: 'farazsms', pattern: 'BAD' });
  err = null;
  try { await notify.testSms(); } catch (caught) { err = caught; }
  check(
    'provider error message is surfaced to the panel',
    err && err.status === 502 && /code not found/.test(err.message),
    err?.message
  );

  // -------------------------------------------------- free-text mode fallback
  respond = () => ({ ok: true, status: 200, json: async () => ({ status: 'success', data: 1 }) });
  settings.updateSection('sms', { provider: 'farazsms', mode: 'text' });
  calls.length = 0;
  await notify.sendSms('متن آزاد');
  const farazText = bodyOf(calls[0]);
  check(
    'free-text mode still uses the simple service',
    calls[0].url.href === 'https://api.iranpayamak.com/ws/v1/sms/simple'
      && farazText.text === 'متن آزاد'
      && farazText.recipients.length === 2
  );

  respond = () => ({
    ok: true,
    status: 200,
    json: async () => ({ return: { status: 200, message: 'ok' } }),
  });
  settings.updateSection('sms', { provider: 'kavenegar', mode: 'text' });
  calls.length = 0;
  await notify.sendSms('متن آزاد');
  check(
    'free-text mode still uses /sms/send.json',
    calls[0].url.pathname === '/v1/KEY123/sms/send.json'
      && calls[0].url.searchParams.get('message') === 'متن آزاد'
  );

  // ------------------------------------------------------- admin alert wiring
  settings.updateSection('sms', {
    provider: 'kavenegar',
    mode: 'pattern',
    pattern: 'sulduz-alert',
    patternVar1: '{title}',
    patternVar2: '{body}',
    patternVar3: '',
  });
  settings.updateSection('monitor', { alertEmail: false, alertSms: true });
  calls.length = 0;
  const alert = await notify.alertAdmins({ title: 'هشدار: نود قطع شد', body: 'نود dl20 پاسخ نداد' });
  const alertQuery = calls[0]?.url.searchParams;
  check(
    'admin alerts go through the pattern with title/body split',
    alert.sms === true
      && alertQuery?.get('token') === 'هشدار: نود قطع شد'
      && alertQuery?.get('token2') === 'نود dl20 پاسخ نداد'
  );

  // ---------------------------------------------------------------- disabled
  settings.updateSection('sms', { enabled: false });
  err = null;
  try { await notify.sendSms('x\ny'); } catch (caught) { err = caught; }
  check('disabled SMS is still rejected', err && err.status === 400 && err.code === 'sms_disabled');
}

run()
  .catch((err) => {
    fail += 1;
    console.error('  FAIL unexpected error:', err);
  })
  .finally(() => {
    closeDb();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    console.log(`\nsms-pattern: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
