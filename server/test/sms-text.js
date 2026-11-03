'use strict';

/**
 * Text-SMS test.
 *
 * Drives notify.testSms / sendSms / alertAdmins against a stubbed fetch, so it
 * checks the exact provider requests (Kavenegar /sms/send and FarazSMS
 * /ws/v1/sms/simple) plus the per-notification SMS switches — without network
 * access, x-ui or the production data directory.
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

const OFFLINE_ALERT = {
  event: 'nodeOffline',
  data: { node: 'dl20', server: 'dash', address: '1.2.3.4', failures: 3 },
  title: 'هشدار: نود dl20 قطع شد',
  body: 'نود dl20 روی dash پاسخ نداد.',
};

async function run() {
  // -------------------------------------------------------------- FarazSMS text
  settings.updateSection('sms', {
    enabled: true,
    provider: 'farazsms',
    apiKey: 'KEY123',
    sender: '50002178584000',
    to: '0912 000 0000; +989351112233',
  });
  calls.length = 0;
  const farazTest = await notify.testSms();
  check(
    'farazsms sends one simple-service request per recipient',
    calls.length === 1
      && calls[0].url.href === 'https://api.iranpayamak.com/ws/v1/sms/simple'
      && calls[0].init.method === 'POST'
      && calls[0].init.headers['Api-Key'] === 'KEY123',
    `calls=${calls.length}`
  );
  const farazBody = bodyOf(calls[0]);
  check(
    'farazsms body carries the raw text, line number and both normalized recipients',
    farazBody.text === 'Sulduz Cloud\nپیام آزمایشی'
      && farazBody.line_number === '50002178584000'
      && farazBody.number_format === 'english'
      && farazBody.recipients.join(',') === '09120000000,09351112233',
    JSON.stringify(farazBody)
  );
  check(
    'the result reports the provider and the text mode',
    farazTest.ok === true && farazTest.provider === 'farazsms' && farazTest.mode === 'text',
    JSON.stringify(farazTest)
  );

  // ---------------------------------------------------------------- Kavenegar
  respond = () => ({
    ok: true,
    status: 200,
    json: async () => ({ return: { status: 200, message: 'تایید شد' } }),
  });
  settings.updateSection('sms', { provider: 'kavenegar' });
  calls.length = 0;
  await notify.sendSms('هشدار: سرور قطع شد\nx-ui پاسخ نداد');
  check(
    'kavenegar sends one request for all recipients through /sms/send.json',
    calls.length === 1 && calls[0].url.pathname === '/v1/KEY123/sms/send.json',
    `calls=${calls.length}`
  );
  const kav = calls[0].url.searchParams;
  check(
    'kavenegar receives the whole message and the comma-separated receptors',
    kav.get('message') === 'هشدار: سرور قطع شد\nx-ui پاسخ نداد'
      && kav.get('receptor') === '09120000000,09351112233'
      && kav.get('sender') === '50002178584000',
    `${kav.get('receptor')} / ${kav.get('sender')}`
  );

  // ------------------------------------------------------------- text length cap
  settings.updateSection('sms', { to: '09120000000' });
  calls.length = 0;
  await notify.sendSms(`عنوان\n${'ب'.repeat(1200)}`);
  const sent = calls[0].url.searchParams.get('message');
  check('the message is cut at the 900-character SMS limit', sent.length === 900 && sent.startsWith('عنوان\n'), `len=${sent.length}`);

  // ------------------------------------------------------------- custom service
  settings.updateSection('sms', {
    provider: 'custom',
    customUrl: 'https://sms.example.com/send',
    customMethod: 'POST',
    customHeaders: '{"X-Token":"abc"}',
    customBody: '{"to":"{to}","text":"{text}"}',
  });
  respond = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  calls.length = 0;
  const custom = await notify.sendSms('سلام\nدنیا');
  check(
    'a custom provider renders {to} and {text} into the configured body',
    custom.provider === 'custom'
      && calls[0].url.href === 'https://sms.example.com/send'
      && calls[0].init.headers['X-Token'] === 'abc'
      && bodyOf(calls[0]).to === '09120000000'
      && bodyOf(calls[0]).text === 'سلام\nدنیا',
    calls[0] ? bodyOf(calls[0]).text : 'no call'
  );

  settings.updateSection('sms', { customMethod: 'GET' });
  calls.length = 0;
  await notify.sendSms('متن');
  check('a custom GET request sends no body', calls[0].init.method === 'GET' && calls[0].init.body === undefined);

  // ---------------------------------------------------------------- provider errors
  respond = () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'error', message: 'line number is invalid' }),
  });
  settings.updateSection('sms', { provider: 'farazsms' });
  let err = null;
  try { await notify.testSms(); } catch (caught) { err = caught; }
  check(
    'a provider error is surfaced to the panel',
    err && err.status === 502 && /line number is invalid/.test(err.message),
    err?.message
  );

  respond = () => ({ ok: false, status: 500, json: async () => ({}) });
  settings.updateSection('sms', { provider: 'custom' });
  err = null;
  try { await notify.sendSms('x'); } catch (caught) { err = caught; }
  check('an HTTP failure from a custom endpoint is reported', err && err.status === 502, err?.message);

  respond = () => ({ ok: true, status: 200, json: async () => ({ return: { status: 200 } }) });

  // ----------------------------------------------------------- per-event switches
  settings.updateSection('sms', { provider: 'kavenegar', to: '09120000000,09351112233' });
  settings.updateSection('monitor', { alertEmail: false, alertSms: true });
  calls.length = 0;
  const alert = await notify.alertAdmins(OFFLINE_ALERT);
  check(
    'an enabled notification sends the alert as its own text',
    alert.sms === true
      && calls.length === 1
      && calls[0].url.searchParams.get('message') === `${OFFLINE_ALERT.title}\n${OFFLINE_ALERT.body}`,
    `calls=${calls.length}`
  );

  const events = settings.getSetting('sms').events;
  settings.updateSection('sms', { events: { ...events, nodeOffline: { enabled: false } } });
  calls.length = 0;
  const muted = await notify.alertAdmins(OFFLINE_ALERT);
  check(
    'a muted notification sends no SMS but the alert keeps flowing',
    muted.sms === false && muted.skipped === 'event_disabled' && calls.length === 0,
    `calls=${calls.length} skipped=${muted.skipped}`
  );

  settings.updateSection('sms', { events: { ...settings.getSetting('sms').events, nodeOffline: { enabled: true } } });
  calls.length = 0;
  const unmuted = await notify.alertAdmins(OFFLINE_ALERT);
  check('turning the notification back on sends it again', unmuted.sms === true && calls.length === 1);

  settings.updateSection('sms', { events: { ...settings.getSetting('sms').events, test: { enabled: false } } });
  calls.length = 0;
  const mutedTest = await notify.testSms();
  check(
    'a muted test event reports skipped instead of sending',
    mutedTest.skipped === 'event_disabled' && calls.length === 0,
    `calls=${calls.length}`
  );
  settings.updateSection('sms', { events: { ...settings.getSetting('sms').events, test: { enabled: true } } });

  // ---------------------------------------------------------------- legacy shapes
  const rawDb = require('../src/db').getDb();
  const readStored = () => JSON.parse(rawDb.prepare('SELECT value FROM settings WHERE key = ?').get('sms').value);
  // A settings row written by an older panel: pattern columns plus per-event
  // pattern configs, with the mute flags the owner had already set. The old
  // shape has no `events` key at all.
  const legacyRow = {
    ...readStored(),
    mode: 'pattern',
    pattern: 'SJ3FgPrE0C',
    patternVar1: '{title}',
    patternVar2: '{body}',
    patternVar3: '',
    patternNames: 'var1,var2',
    patterns: {
      nodeOffline: { enabled: false, code: 'NODE-DOWN', names: '', var1: '', var2: '', var3: '' },
      nodeOnline: { enabled: true, code: '', names: '', var1: '', var2: '', var3: '' },
      test: { enabled: true, code: '', names: '', var1: '', var2: '', var3: '' },
    },
  };
  delete legacyRow.events;
  rawDb.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(legacyRow), 'sms');
  check(
    'the boot migration keeps every mute and drops the pattern columns',
    settings.migrateSmsShape() === true
      && settings.getSetting('sms').events.nodeOffline.enabled === false
      && settings.getSetting('sms').events.nodeOnline.enabled === true
      && settings.getSetting('sms').events.panelOnline.enabled === true,
    JSON.stringify(settings.getSetting('sms').events)
  );

  const stored = readStored();
  const stillPatternish = settings.LEGACY_SMS_KEYS.filter((field) => field in stored);
  check('no pattern-shaped key survives the stored row', stillPatternish.length === 0, stillPatternish.join(','));
  check('the migration is a one-off: nothing to migrate any more', settings.migrateSmsShape() === false);
  check(
    'the API key stays readable after the migration',
    settings.getSetting('sms').apiKey === 'KEY123' && settings.redactSection('sms', settings.getSetting('sms')).hasApiKey === true
  );

  // A partial events patch must not silently mute the other notifications.
  settings.updateSection('sms', { events: { panelOffline: { enabled: false } } });
  const afterPartial = settings.getSetting('sms').events;
  check(
    'an events patch fills the missing events from the defaults',
    afterPartial.panelOffline.enabled === false && afterPartial.nodeOnline.enabled === true && afterPartial.test.enabled === true,
    JSON.stringify(afterPartial)
  );

  // ---------------------------------------------------------------- disabled
  settings.updateSection('sms', { enabled: false });
  err = null;
  try { await notify.sendSms('x\ny'); } catch (caught) { err = caught; }
  check('disabled SMS is still rejected', err && err.status === 400 && err.code === 'sms_disabled');

  settings.updateSection('sms', { enabled: true, to: '' });
  err = null;
  try { await notify.sendSms('x\ny'); } catch (caught) { err = caught; }
  check('an empty recipient list is rejected', err && err.status === 400 && err.code === 'sms_no_recipient');
}

run()
  .catch((err) => {
    fail += 1;
    console.error('  FAIL unexpected error:', err);
  })
  .finally(() => {
    closeDb();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    console.log(`\nsms-text: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
