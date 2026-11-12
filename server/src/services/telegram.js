'use strict';

const fs = require('fs');
const path = require('path');
const { getSetting } = require('../settings');
const { ApiError } = require('../utils');

const API_BASE = 'https://api.telegram.org';

function config() {
  const cfg = getSetting('telegram');
  return {
    enabled: Boolean(cfg.enabled),
    botToken: String(cfg.botToken || '').trim(),
    chatId: String(cfg.chatId || '').trim(),
    sendOnAuto: Boolean(cfg.sendOnAuto),
  };
}

function ready(cfg = config()) {
  return Boolean(cfg.botToken && cfg.chatId);
}

/**
 * v1.5.2: the two-way bot. `adminChatId` is where a reseller's payment receipt is
 * posted for a decision; empty falls back to the panel chat, which is the owner's
 * own chat. The bot needs a token but NOT a panel chat to serve resellers.
 */
function botConfig() {
  const cfg = getSetting('telegram');
  const botToken = String(cfg.botToken || '').trim();
  return {
    enabled: Boolean(cfg.botEnabled) && Boolean(botToken),
    botToken,
    adminChatId: String(cfg.botAdminChatId || '').trim() || String(cfg.chatId || '').trim(),
  };
}

async function call(method, payload, opts = {}) {
  const cfg = config();
  if (!cfg.botToken) throw new ApiError(422, 'telegram_not_configured', 'توکن ربات تلگرام تنظیم نشده است');
  // v1.5.2: the bot's getUpdates long poll holds the connection open for up to
  // `timeout` seconds, so its own deadline has to be longer than that answer.
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 20000);
  const res = await fetch(`${API_BASE}/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: opts.signal || AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  if (!res.ok || !body?.ok) {
    const detail = body?.description || `HTTP ${res.status}`;
    throw new ApiError(502, 'telegram_error', `Telegram: ${detail}`);
  }
  return body.result;
}

async function sendMessage(text) {
  const cfg = config();
  if (!cfg.chatId) throw new ApiError(422, 'telegram_not_configured', 'Chat ID تنظیم نشده است');
  return call('sendMessage', {
    chat_id: cfg.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * Send to one specific chat — a reseller's own numeric Telegram id, taken from
 * his settings row and NOT from the panel chat. `chatId` is always caller-supplied
 * and never read back out of the token, and a chat that was never started shows up
 * here as Telegram's own error ("bot can't initiate conversation with a user"),
 * which is exactly what the caller needs to tell the owner why nothing arrived.
 */
async function sendMessageTo(chatId, text) {
  const target = String(chatId || '').trim();
  if (!/^-?\d+$/.test(target)) throw new ApiError(422, 'telegram_chat_id', 'آیدی عددی تلگرام معتبر نیست');
  return call('sendMessage', {
    chat_id: target,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendDocument(filePath, caption) {
  const cfg = config();
  if (!cfg.botToken) throw new ApiError(422, 'telegram_not_configured', 'توکن ربات تلگرام تنظیم نشده است');
  if (!cfg.chatId) throw new ApiError(422, 'telegram_not_configured', 'Chat ID تنظیم نشده است');
  const stat = fs.statSync(filePath);
  if (stat.size > 49 * 1024 * 1024) {
    throw new ApiError(422, 'file_too_large', 'حجم فایل برای ارسال در تلگرام بیش از ۵۰ مگابایت است');
  }
  const form = new FormData();
  form.append('chat_id', cfg.chatId);
  if (caption) {
    form.append('caption', String(caption).slice(0, 1000));
    form.append('parse_mode', 'HTML');
  }
  form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetch(`${API_BASE}/bot${cfg.botToken}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    body = null;
  }
  if (!res.ok || !body?.ok) {
    const detail = body?.description || `HTTP ${res.status}`;
    throw new ApiError(502, 'telegram_error', `Telegram: ${detail}`);
  }
  return body.result;
}

/**
 * v1.5.2: fetch a receipt the bot was sent, so the admin can look at it inside
 * the panel too and not only in Telegram. The bot token never leaves this
 * function — the caller gets bytes and a mime type, and the file_id is always
 * the one stored on the request row, never a value from the browser.
 */
const FILE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

async function fetchFile(fileId) {
  const cfg = config();
  if (!cfg.botToken) throw new ApiError(422, 'telegram_not_configured', 'توکن ربات تلگرام تنظیم نشده است');
  const id = String(fileId || '').trim();
  if (!id) throw new ApiError(422, 'file_required', 'No receipt file on this request');
  const info = await call('getFile', { file_id: id }, { timeoutMs: 30000 });
  const filePath = String(info?.file_path || '');
  if (!filePath) throw new ApiError(502, 'telegram_error', 'Telegram returned no file path');
  const res = await fetch(`${API_BASE}/file/bot${cfg.botToken}/${filePath}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new ApiError(502, 'telegram_error', `Telegram file: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) {
    throw new ApiError(413, 'file_too_large', 'Receipt file is larger than 20 MB');
  }
  const ext = path.extname(filePath).toLowerCase();
  return {
    buffer,
    mime: FILE_MIME[ext] || res.headers.get('content-type') || 'application/octet-stream',
    name: path.basename(filePath),
  };
}

async function test() {
  const cfg = config();
  if (!cfg.botToken) throw new ApiError(422, 'telegram_not_configured', 'توکن ربات تلگرام تنظیم نشده است');
  if (!cfg.chatId) throw new ApiError(422, 'telegram_not_configured', 'Chat ID تنظیم نشده است');
  const me = await call('getMe', {});
  await sendMessage(
    `✅ <b>Sulduz Cloud</b>\nاتصال ربات تلگرام با موفقیت برقرار شد.\n@${me?.username || 'bot'}`
  );
  return { ok: true, bot: me?.username || '', chatId: cfg.chatId };
}

async function sendBackup(filePath, name, reason = 'auto') {
  const cfg = config();
  if (!cfg.enabled && reason !== 'manual') {
    return { sent: false, reason: 'disabled' };
  }
  if (!ready(cfg)) {
    if (reason === 'manual') {
      throw new ApiError(422, 'telegram_not_configured', 'ابتدا توکن ربات و Chat ID را در تنظیمات تلگرام وارد کنید');
    }
    return { sent: false, reason: 'not_configured' };
  }
  const size = fs.statSync(filePath).size;
  const caption = `🗄 <b>Sulduz Cloud</b>\nنسخه پشتیبان ${reason === 'auto' ? 'خودکار' : 'دستی'}\n<code>${name}</code>\n${(size / 1024).toFixed(1)} KB`;
  await sendDocument(filePath, caption);
  return { sent: true, name };
}

module.exports = { config, botConfig, ready, call, sendMessage, sendMessageTo, sendDocument, fetchFile, test, sendBackup };
