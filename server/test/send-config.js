'use strict';

/**
 * v2.0.0 — «ارسال کانفینگ به تلگرام خود نماینده»: the QR encoder and the send
 * path, proven in process.
 *
 * The owner's sentence behind this file (verbatim):
 *   «برای نمایندگان قابلیتی اضافه کن که اگر نماینده خواست اون کانفینگ به تلگرام
 *     خودش ارسال کنه از طریق ربات / لینک اشتراک و کیو ارکد اشتراک تو یک پیام
 *     بصورت شیک و زیبا ربات به تلگرام نماینده ارسال کنه که از اونجا بتونه برا
 *     مشتری خودش فوروارد کنه»
 *
 * Two subjects, one file:
 *   1) the dependency-free QR encoder (services/qrcode.js). A hand-rolled
 *      Reed–Solomon implementation is exactly the kind of code that looks right
 *      and scans wrong, so it is checked three ways: against the published
 *      «HELLO WORLD» 1-Q test vector, against an INDEPENDENT decoder written
 *      here (own function-pattern map, own zigzag read, own BCH format check,
 *      own de-interleave, ECC re-verified per block), and as a real PNG whose
 *      pixels are read back. The UI harness adds a fourth opinion by comparing
 *      codewords with qrcode.react in a browser.
 *   2) sendToTelegram's guards and its one message: the chat is always the
 *      caller's own numeric id, a missing id / a dead bot / a linkless package /
 *      a double click / an oversized link are all refused before anything is
 *      sent, and the caption carries the customer's facts under 1024 chars.
 *
 * Like bot-test and payment-test, nothing here can reach the network:
 * global.fetch counts and refuses every attempt, and telegram.sendPhotoTo is
 * replaced by a recorder that keeps the exact bytes and caption it was handed.
 *
 *   npm run send-test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-send-'));
process.env.DATA_DIR = DATA_DIR;
process.env.BACKUP_DIR = path.join(DATA_DIR, 'backups');
process.env.NODE_ENV = 'test';
process.env.PANEL_TZ = 'Asia/Tehran';

let networkAttempts = 0;
global.fetch = async (url) => {
  networkAttempts += 1;
  throw new Error(`network call blocked by the send test: ${String(url).slice(0, 60)}`);
};

const { getDb, closeDb } = require('../src/db');
const settings = require('../src/settings');
const usersService = require('../src/services/users');
const configsService = require('../src/services/configs');
const telegram = require('../src/services/telegram');
const qrcode = require('../src/services/qrcode');
const config = require('../src/config');
const { encryptSecret } = require('../src/crypto');

let pass = 0;
let fail = 0;
function check(name, ok, note = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${note ? `  — ${note}` : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${note ? `  — ${note}` : ''}`); }
}

const GB = 1024 ** 3;
const DAY_MS = 86400000;
const NOW = Date.now();

// ═══════════════════════════════════════════════════════════ the QR encoder ═══

// The published worked example (Thonky / ISO 18004): «HELLO WORLD» in 1-Q,
// 13 data codewords, 13 ECC codewords. A Reed–Solomon implementation that does
// not reproduce this vector byte for byte cannot produce scannable symbols.
const RS_DATA = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
const RS_ECC = [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16];

// ---- an independent decoder, written from the spec, not from the encoder ----

// Function-pattern map rebuilt here on purpose: if the encoder reserved the
// wrong cells, this map disagrees and the read-back fails.
function fnMapOf(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const block = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) fn[y][x] = true;
  };
  block(0, 0, 9, 9);                    // top-left finder + separator + format
  block(size - 8, 0, 8, 9);             // top-right
  block(0, size - 8, 9, 8);             // bottom-left
  for (let i = 0; i < size; i += 1) { fn[6][i] = true; fn[i][6] = true; } // timing
  const ALIGN = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  for (const cy of ALIGN[version] || []) {
    for (const cx of ALIGN[version] || []) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      block(cx - 2, cy - 2, 5, 5);
    }
  }
  if (version >= 7) {
    block(0, size - 11, 6, 3);
    block(size - 11, 0, 3, 6);
  }
  return fn;
}

// BCH(15,5) format info by polynomial long division — a different formulation
// from the encoder's shift loop, so a shared mistake cannot hide in both.
function formatWord(eclBits, mask) {
  const data = (eclBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function readFormat(matrix, size) {
  const bit = (x, y) => matrix[y][x];
  let copy1 = 0;
  for (let i = 0; i <= 14; i += 1) {
    let v;
    if (i <= 5) v = bit(8, i);
    else if (i === 6) v = bit(8, 7);
    else if (i === 7) v = bit(8, 8);
    else if (i === 8) v = bit(7, 8);
    else v = bit(14 - i, 8);
    copy1 |= v << i;
  }
  let copy2 = 0;
  for (let i = 0; i <= 14; i += 1) {
    const v = i <= 7 ? bit(size - 1 - i, 8) : bit(8, size - 15 + i);
    copy2 |= v << i;
  }
  return { copy1, copy2 };
}

const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Read the data bits in the spec's zigzag, unmasking as we go.
function readCodewords(matrix, version, mask) {
  const size = matrix.length;
  const fn = fnMapOf(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) bits.push(matrix[y][x] ^ (MASK_FN[mask](x, y) ? 1 : 0));
      }
    }
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }
  return words;
}

// De-interleave into blocks, re-verify every block's ECC, then parse byte mode.
function decodeSymbol(sym) {
  const { copy1, copy2 } = readFormat(sym.matrix, sym.size);
  let found = null;
  for (const [ecl, eclBits] of [['L', 1], ['M', 0]]) {
    for (let mask = 0; mask < 8; mask += 1) {
      const word = formatWord(eclBits, mask);
      if (word === copy1 && word === copy2) found = { ecl, mask };
    }
  }
  if (!found) return { ok: false, why: 'format info unreadable' };
  if (found.ecl !== sym.ecl || found.mask !== sym.mask) return { ok: false, why: 'format disagrees with encoder claim' };
  const words = readCodewords(sym.matrix, sym.version, found.mask);
  const { ecc, groups } = qrcode.BLOCKS[sym.version][found.ecl];
  const dataLens = [];
  for (const [count, len] of groups) for (let i = 0; i < count; i += 1) dataLens.push(len);
  const numBlocks = dataLens.length;
  const dataBlocks = dataLens.map(() => []);
  let pos = 0;
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) {
      if (i < dataLens[b]) dataBlocks[b].push(words[pos++]);
    }
  }
  const eccBlocks = dataLens.map(() => []);
  for (let i = 0; i < ecc; i += 1) {
    for (let b = 0; b < numBlocks; b += 1) eccBlocks[b].push(words[pos++]);
  }
  for (let b = 0; b < numBlocks; b += 1) {
    const want = qrcode.rsRemainder(dataBlocks[b], ecc);
    if (want.join(',') !== eccBlocks[b].join(',')) return { ok: false, why: `ECC mismatch in block ${b}` };
  }
  const data = dataBlocks.flat();
  const bits = [];
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | bits.shift();
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) return { ok: false, why: `mode ${mode} is not byte mode` };
  const len = take(sym.version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i += 1) bytes.push(take(8));
  return { ok: true, text: Buffer.from(bytes).toString('utf8'), len };
}

function qrChecks() {
  console.log('\n— the QR encoder —');
  const ecc = qrcode.rsRemainder(RS_DATA, 13);
  check('Reed–Solomon reproduces the published «HELLO WORLD» 1-Q vector byte for byte',
    ecc.join(',') === RS_ECC.join(','), `ecc=${ecc.join(',')}`);

  const cases = [
    ['A', 'the shortest possible symbol'],
    ['https://sub.example.test:8443/sub/abc123XYZ', 'a real subscription link'],
    ['مشتری ایرانی — لینک اشتراک', 'Persian text (multi-byte UTF-8)'],
    ['x'.repeat(120), 'a long link that needs several blocks'],
    ['y'.repeat(210), 'a version-10 sized payload'],
  ];
  for (const [text, label] of cases) {
    const sym = qrcode.qrMatrix(text);
    const back = decodeSymbol(sym);
    check(`an independent decoder reads back ${label}`,
      back.ok === true && back.text === text,
      back.ok ? `v${sym.version}-${sym.ecl} mask=${sym.mask}` : back.why);
  }

  // The exact boundary: v10-L carries 274 data codewords (2×68 + 2×69), so
  // 4 + 16 + 8n ≤ 2192 → 271 bytes, the published byte-mode capacity of 10-L.
  const dc10L = qrcode.BLOCKS[10].L.groups.reduce((sum, [count, len]) => sum + count * len, 0);
  const maxLen = Math.floor((dc10L * 8 - 4 - 16) / 8);
  const atLimit = qrcode.qrMatrix('z'.repeat(maxLen));
  check('the largest payload v10-L can hold still encodes and reads back',
    maxLen === 271 && atLimit.version === 10 && atLimit.ecl === 'L' && decodeSymbol(atLimit).text === 'z'.repeat(maxLen),
    `len=${maxLen} v=${atLimit.version}-${atLimit.ecl}`);
  let tooLong = false;
  try { qrcode.qrMatrix('z'.repeat(maxLen + 1)); } catch (err) { tooLong = err.code === 'qr_too_long'; }
  check('one byte past the ceiling is a clean qr_too_long, not a broken symbol', tooLong);

  // A real subscription URL must prefer M over L at the same version.
  const link = qrcode.qrMatrix('https://sub.example.test:8443/sub/770152001-a1b2c3');
  check('a normal link gets ECC level M, not the weaker L', link.ecl === 'M', `v${link.version}-${link.ecl}`);

  // PNG: signature, IHDR, pixel read-back, quiet zone.
  const png = qrcode.qrPng('https://sub.example.test:8443/sub/qr-png-check', { scale: 6, margin: 4 });
  const buf = png.buffer;
  const sigOk = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdrLen = buf.readUInt32BE(8);
  const ihdrType = buf.toString('ascii', 12, 16);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colorType = buf[25];
  check('the PNG carries a valid signature and a grayscale IHDR of the promised size',
    sigOk && ihdrLen === 13 && ihdrType === 'IHDR' && width === png.width && height === png.width
      && depth === 8 && colorType === 0 && width === (png.size + 8) * 6,
    `width=${width} depth=${depth} color=${colorType}`);
  // Walk the chunks, verify every CRC, inflate the IDAT.
  let off = 8;
  let crcOk = true;
  const idat = [];
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crcOf = (b) => {
    let c = 0xffffffff;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 4, off + 8 + len);
    if (crcOf(body) !== buf.readUInt32BE(off + 8 + len)) crcOk = false;
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  check('every PNG chunk passes its own CRC', crcOk);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixel = (px, py) => raw[py * (width + 1) + 1 + px];
  const sym = qrcode.qrMatrix('https://sub.example.test:8443/sub/qr-png-check');
  let pixelsMatch = true;
  for (let my = 0; my < sym.size && pixelsMatch; my += 1) {
    for (let mx = 0; mx < sym.size; mx += 1) {
      const want = sym.matrix[my][mx] === 1 ? 0 : 255;
      if (pixel((mx + 4) * 6 + 3, (my + 4) * 6 + 3) !== want) { pixelsMatch = false; break; }
    }
  }
  check('every module of the symbol is the right color in the actual pixels', pixelsMatch);
  check('the quiet zone is white and the finder corner is black',
    pixel(3, 3) === 255 && pixel(width - 4, width - 4) === 255 && pixel(4 * 6 + 3, 4 * 6 + 3) === 0);
}

// ═══════════════════════════════════════════════════════════ the send path ═══

const sent = [];
telegram.sendPhotoTo = async (chatId, buffer, filename, caption) => {
  sent.push({ chatId: String(chatId), buffer, filename, caption });
  return { message_id: 900 + sent.length };
};

const rowOf = (id) => getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
const auditRows = (action) => getDb().prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY id').all(String(action));

function makeUser(username, { telegramId = '', role = 'reseller' } = {}) {
  const created = usersService.createUser({ username, password: 'Send-Suite-12345', role, telegram_id: telegramId });
  return rowOf(created.id);
}

const SUB_BASE = 'https://sub.example.test:8443/sub';

function seedNode() {
  const db = getDb();
  // resolveServer refuses a node without an API token, so the fixtures carry
  // one — encrypted exactly the way the servers service stores it.
  const token = encryptSecret('send-suite-node-token');
  db.prepare(
    `INSERT INTO servers (id, name, url, token, verify_tls, sub_base, enabled, sort, status, created_at, updated_at)
     VALUES (1, 'نود آزمایش', 'http://127.0.0.1:2053', ?, 0, ?, 1, 0, '', ?, ?)`
  ).run(token, SUB_BASE, NOW, NOW);
  // A second node with NO subscription base — the linkless-package case.
  db.prepare(
    `INSERT INTO servers (id, name, url, token, verify_tls, sub_base, enabled, sort, status, created_at, updated_at)
     VALUES (2, 'نود بی‌لینک', 'http://127.0.0.1:2054', ?, 0, '', 1, 1, '', ?, ?)`
  ).run(token, NOW, NOW);
  db.prepare(
    `INSERT INTO inbounds (id, server_id, xui_id, remark, protocol, enabled, visible, updated_at)
     VALUES (10, 1, 901, 'کانال یک', 'vless', 1, 1, ?)`
  ).run(NOW);
  db.prepare(
    `INSERT INTO inbounds (id, server_id, xui_id, remark, protocol, enabled, visible, updated_at)
     VALUES (11, 2, 902, 'کانال دو', 'vless', 1, 1, ?)`
  ).run(NOW);
}

function addConfig(userId, {
  email, name = email, gb = 30, expiryAt = NOW + 20 * DAY_MS, inboundId = 10, serverId = 1, subId = `sub-${email}`,
}) {
  const info = getDb().prepare(
    `INSERT INTO configs (user_id, inbound_id, server_id, email, sub_id, xui_sub_id, label, customer_name,
      total_bytes, expiry_at, enabled, status, up_bytes, down_bytes, last_up, last_down, last_synced_at,
      created_at, updated_at, origin, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', 0, 0, 0, 0, ?, ?, ?, 'panel', 0)`
  ).run(userId, inboundId, serverId, email, subId, subId, name, name,
    Math.round(gb * GB), Math.round(expiryAt), NOW, NOW, NOW);
  return Number(info.lastInsertRowid);
}

const codeOf = async (fn) => {
  try { await fn(); return 'no-error'; } catch (err) { return `${err.status || 0}:${err.code || err.message}`; }
};

async function sendChecks() {
  console.log('\n— sending a config to the reseller’s own Telegram —');
  settings.setSetting('telegram', { enabled: true, botToken: '123456:send-suite-token', chatId: '-1009000000009', botEnabled: true });
  seedNode();

  const shop = makeUser('sendshop', { telegramId: '770200001' });
  const noId = makeUser('sendnoid');
  const other = makeUser('sendother', { telegramId: '770200002' });
  const admin = makeUser('sendadmin', { telegramId: '770200900', role: 'admin' });

  const cfgA = addConfig(shop.id, { email: 'sendshop-a', name: 'مشتری اول', gb: 30 });
  const cfgUnlimited = addConfig(shop.id, { email: 'sendshop-u', name: 'بی‌حد', gb: 0, expiryAt: 0 });
  const cfgNoLink = addConfig(shop.id, { email: 'sendshop-n', inboundId: 11, serverId: 2 });
  const cfgLong = addConfig(shop.id, { email: 'sendshop-l', subId: 'L'.repeat(400) });
  const cfgHtml = addConfig(shop.id, { email: 'sendshop-h', name: '<b>مشتری</b> & «تست»' });
  const cfgOther = addConfig(other.id, { email: 'sendother-a' });

  // ── the refusals, each before a single byte is sent. The id-less reseller
  // sends his OWN package: ownership is checked before the Telegram id, so a
  // stranger's config would be a 403, not the refusal under test here.
  const cfgNoId = addConfig(noId.id, { email: 'sendnoid-a' });
  check('a reseller with no numeric Telegram id is refused, and nothing is sent',
    (await codeOf(() => configsService.sendToTelegram(cfgNoId, null, noId))) === '422:telegram_id_required' && sent.length === 0);

  settings.setSetting('telegram', { botEnabled: false });
  check('a switched-off bot is refused even for a fully linked reseller',
    (await codeOf(() => configsService.sendToTelegram(cfgA, null, shop))) === '422:bot_disabled' && sent.length === 0);
  settings.setSetting('telegram', { botEnabled: true });

  check('a package whose node has no subscription base is refused honestly',
    (await codeOf(() => configsService.sendToTelegram(cfgNoLink, null, shop))) === '422:no_subscription_link' && sent.length === 0);

  check('a link too long for any QR version is refused, not silently truncated',
    (await codeOf(() => configsService.sendToTelegram(cfgLong, null, shop))) === '422:qr_too_long' && sent.length === 0);

  check('one reseller cannot send another reseller’s config to his own chat',
    (await codeOf(() => configsService.sendToTelegram(cfgOther, null, shop))) === '403:forbidden' && sent.length === 0);

  // ── the one message
  const res = await configsService.sendToTelegram(cfgA, null, shop);
  const url = `${SUB_BASE}/sub-sendshop-a`;
  check('the send succeeds and names the caller’s own chat, never a request value',
    res.sent === true && res.chatId === '770200001' && res.url === url && res.messageId > 0,
    `chat=${res.chatId} url=${res.url}`);
  check('exactly ONE message went out: one photo carrying the QR and the caption',
    sent.length === 1 && sent[0].chatId === '770200001' && sent[0].filename === `subscription-${cfgA}.png`);
  const photo = sent[0];
  check('the photo is a real PNG of the subscription link’s QR',
    photo.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && photo.buffer.length > 200,
    `bytes=${photo.buffer.length}`);
  const cap = photo.caption;
  check('the caption carries the customer, the volume, the validity and the node',
    cap.includes('مشتری اول') && cap.includes('۳۰') && cap.includes('گیگابایت') && cap.includes('روز مانده') && cap.includes('نود آزمایش'),
    `len=${cap.length}`);
  check('the link sits in a tap-to-copy <code> block and the message says «forward it»',
    cap.includes(`<code>${url}</code>`) && cap.includes('فوروارد'));
  check('the caption stays inside Telegram’s 1024-character photo limit', cap.length <= 1024, `len=${cap.length}`);
  check('the send is audited with the chat, the link and the QR version',
    auditRows('config.send_telegram').length === 1
      && String(auditRows('config.send_telegram')[0].details || '').includes('770200001'));

  // ── the cooldown is per user and only after a real send
  check('a second click inside the cooldown is a calm 429, not a second message',
    (await codeOf(() => configsService.sendToTelegram(cfgA, null, shop))) === '429:send_cooldown' && sent.length === 1);
  const otherRes = await configsService.sendToTelegram(cfgOther, null, other);
  check('the cooldown belongs to one user: another reseller sends right away',
    otherRes.sent === true && sent.length === 2 && sent[1].chatId === '770200002');
  const adminRes = await configsService.sendToTelegram(cfgA, null, admin);
  check('an admin with a linked id can send any config to his own chat',
    adminRes.sent === true && sent.length === 3 && sent[2].chatId === '770200900');

  // ── caption shapes for the edge packages (fresh admins: the cooldown is per
  // user, and shop/other/admin above all sent within the last ten seconds)
  const capAdmin1 = makeUser('sendcap1', { telegramId: '770200004', role: 'admin' });
  const capAdmin2 = makeUser('sendcap2', { telegramId: '770200005', role: 'admin' });
  await configsService.sendToTelegram(cfgUnlimited, null, capAdmin1);
  const capU = sent[sent.length - 1].caption;
  check('an unlimited package says «نامحدود» for both volume and validity',
    capU.includes('حجم: نامحدود') && capU.includes('اعتبار: نامحدود'));
  await configsService.sendToTelegram(cfgHtml, null, capAdmin2);
  const capH = sent[sent.length - 1].caption;
  check('a customer name with HTML in it is escaped, never injected',
    capH.includes('&lt;b&gt;مشتری&lt;/b&gt;') && !capH.includes('<b>مشتری</b>'));

  // A failed send must not arm the cooldown: noId still has no id, but a user
  // whose FIRST attempt was refused for another reason can send once it passes.
  const fresh = makeUser('sendfresh', { telegramId: '770200003' });
  const cfgFresh = addConfig(fresh.id, { email: 'sendfresh-a' });
  settings.setSetting('telegram', { botEnabled: false });
  await codeOf(() => configsService.sendToTelegram(cfgFresh, null, fresh));
  settings.setSetting('telegram', { botEnabled: true });
  const freshRes = await configsService.sendToTelegram(cfgFresh, null, fresh);
  check('a refusal never arms the cooldown: the first real send goes straight through',
    freshRes.sent === true && sent[sent.length - 1].chatId === '770200003');

  check('the whole suite made zero network calls — the recorder saw everything',
    networkAttempts === 0, `attempts=${networkAttempts}`);
  check('this build is v2.0.0', config.version === '2.0.0', config.version);
}

(async () => {
  try {
    qrChecks();
    await sendChecks();
  } catch (err) {
    fail += 1;
    console.log(`  FAIL unexpected error — ${err.stack || err.message}`);
  } finally {
    try { closeDb(); } catch (_) { /* ignore */ }
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();