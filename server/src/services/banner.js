'use strict';

// Panel v2.1.0 — the owner's banner («نوار اطلاع‌رسانی»).
//
// The ask: «در شرایط بحرانی و قطعی سرورها و اینترنت یک پیام بصورت نوار سبز رنگ
// یا قرمز رنگ برای نمایندگانی که انتخاب کردیم یا برای همه نمایندگان اون پیام
// نشان داده بشه» — and the example he gave was not an outage at all but an offer
// («تخفیف ویژه برای حساب کاربری شما اعمال شد»). So this is not an outage widget:
// it is one line of the owner's own words, pinned above every page of the
// reseller panel, in the colour that matches what it says.
//
// It lives in settings.banner (one row, no new table) and is written only by the
// admin PATCH, which runs it through `normalize()` here so the shape stored is
// always the shape `forUser()` reads. Two rules make it safe to hand to an owner
// in a hurry:
//
//   · an empty message is never shown, even with the switch on — a half-saved
//     banner must not paint an empty bar across every reseller's screen;
//   · the window is optional and checked against the panel clock, so a warning
//     about a maintenance slot switches itself on and off around it.
//
// `targets` is 'all' or 'selected'. 'selected' with nobody picked shows nothing
// to nobody, which is the honest reading of «برای نمایندگانی که انتخاب کردیم» —
// guessing "all" would broadcast a message the owner aimed at three people.

const { getDb } = require('../db');

const MAX_TEXT = 300;
// Exactly the two colours he asked for («نوار سبز رنگ یا قرمز رنگ») — a longer
// palette is a decision nobody asked this panel to make.
const TONES = ['green', 'red'];

function normalize(raw = {}) {
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const tone = TONES.includes(String(raw.tone)) ? String(raw.tone) : 'green';
  const targets = String(raw.targets) === 'selected' ? 'selected' : 'all';
  const startsAt = Number.isFinite(Number(raw.startsAt)) && Number(raw.startsAt) > 0 ? Math.round(Number(raw.startsAt)) : 0;
  const endsAt = Number.isFinite(Number(raw.endsAt)) && Number(raw.endsAt) > 0 ? Math.round(Number(raw.endsAt)) : 0;
  const userIds = [...new Set((Array.isArray(raw.userIds) ? raw.userIds : [])
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0))].slice(0, 500);
  return {
    enabled: Boolean(raw.enabled),
    text,
    tone,
    targets,
    userIds,
    startsAt,
    endsAt,
  };
}

/** Switched on, carrying words, and inside its own window right now. */
function active(cfg = {}) {
  if (!cfg.enabled || !String(cfg.text || '').trim()) return false;
  const now = Date.now();
  if (Number(cfg.startsAt || 0) > now) return false;
  if (Number(cfg.endsAt || 0) > 0 && Number(cfg.endsAt) <= now) return false;
  return true;
}

function inWindow(cfg = {}) {
  const now = Date.now();
  if (Number(cfg.startsAt || 0) > now) return 'waiting';
  if (Number(cfg.endsAt || 0) > 0 && Number(cfg.endsAt) <= now) return 'over';
  return 'now';
}

/**
 * What one account should see, or null.
 *
 * Admins are excluded on purpose: the owner does not need his own notice, and the
 * settings tab previews it instead. A 'selected' banner reaches exactly the ids
 * stored — an id that has since been deleted simply stops matching.
 */
function forUser(user, cfg) {
  if (!user || String(user.role || '') === 'admin') return null;
  if (!active(cfg)) return null;
  if (cfg.targets === 'selected' && !(cfg.userIds || []).includes(Number(user.id))) return null;
  return { text: String(cfg.text), tone: String(cfg.tone || 'green') };
}

/**
 * Names behind the picked ids, for the settings tab.
 *
 * A list of numbers is not reviewable — the owner picks resellers by name — and
 * an id whose account has gone is reported as such instead of vanishing, so he
 * never wonders whether his banner still covers the person he meant.
 */
function audience(cfg) {
  const ids = (Array.isArray(cfg.userIds) ? cfg.userIds : []).map(Number).filter((n) => n > 0);
  if (cfg.targets !== 'selected') return { count: 0, rows: [], all: true };
  if (!ids.length) return { count: 0, rows: [], all: false };
  const db = getDb();
  const place = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, username, name, deleted_at FROM users WHERE id IN (${place})`
  ).all(...ids);
  const found = new Map(rows.map((row) => [Number(row.id), row]));
  const list = ids.map((id) => {
    const row = found.get(id);
    return {
      id,
      username: row ? String(row.username || '') : '',
      name: row ? String(row.name || '') : '',
      gone: !row || Number(row.deleted_at || 0) > 0,
    };
  });
  return { count: list.filter((item) => !item.gone).length, rows: list, all: false };
}

module.exports = { MAX_TEXT, TONES, normalize, active, inWindow, forUser, audience };
