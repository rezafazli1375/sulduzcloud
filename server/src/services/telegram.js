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

async function call(method, payload) {
  const cfg = config();
  if (!cfg.botToken) throw new ApiError(422, 'telegram_not_configured', 'توکن ربات تلگرام تنظیم نشده است');
  const res = await fetch(`${API_BASE}/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(20000),
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

module.exports = { config, ready, call, sendMessage, sendDocument, test, sendBackup };
