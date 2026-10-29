const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function formatNumber(value, lang = 'fa', digits = 0) {
  const num = Number(value || 0);
  return new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(num);
}

export function formatBytes(bytes, lang = 'fa', opts = {}) {
  const n = Number(bytes || 0);
  if (!n) return `0 ${lang === 'fa' ? 'بایت' : 'B'}`;
  const units = lang === 'fa'
    ? ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت', 'ترابایت']
    : ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = opts.digits !== undefined ? opts.digits : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${formatNumber(value, lang, digits)} ${units[unit]}`;
}

export function formatGb(bytes, lang = 'fa') {
  return `${formatNumber(Number(bytes || 0) / GB, lang, Number(bytes || 0) % GB === 0 ? 0 : 2)} ${lang === 'fa' ? 'گیگ' : 'GB'}`;
}

export function formatMoney(amount, lang = 'fa', currency = 'تومان') {
  return `${formatNumber(amount, lang)} ${currency}`;
}

export function formatDate(ts, lang = 'fa', withTime = false) {
  if (!ts) return '—';
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-GB', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

export function formatDateTime(ts, lang = 'fa') {
  return formatDate(ts, lang, true);
}

export function dayLabel(day, lang = 'fa') {
  if (!day) return '';
  const date = new Date(`${day}T12:00:00`);
  try {
    return new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-GB', { month: 'short', day: '2-digit' }).format(date);
  } catch (_) {
    return day.slice(5);
  }
}

export function daysLeft(ts, lang = 'fa') {
  if (!ts) return null;
  const diff = Number(ts) - Date.now();
  const days = Math.ceil(diff / 86400000);
  return days;
}

export function relativeTime(ts, lang = 'fa') {
  if (!ts) return '—';
  const diff = Number(ts) - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang === 'fa' ? 'fa-IR' : 'en', { numeric: 'auto' });
  const units = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return '';
}

export function pct(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (!t) return null;
  return Math.min(100, Math.round((p / t) * 1000) / 10);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } finally { area.remove(); }
  return Promise.resolve();
}
