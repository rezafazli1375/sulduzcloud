'use strict';

/**
 * The brand of this panel is fixed in the code (v1.5.4).
 *
 * The owner's reason is simple: the software is published, anybody can install
 * it, and the name on the header, in the bot's footer and in every message must
 * still be HIS brand. So the name is no longer a setting — it is a constant, and
 * a stored `general.panelName` row (an old install, a hand-edited database) is
 * ignored on read.
 *
 * Everything else in `general` (tagline, support url, language, timezone) stays
 * editable; only the name is pinned. The settings layer, the public meta and the
 * bot/report/notification texts all take the name from here, so there is exactly
 * one place that decides what the panel is called.
 */

const PANEL_NAME = 'Sulduz Cloud';
const PANEL_TAGLINE_FA = 'پنل مدیریت نمایندگی‌های سرویس';
const PANEL_TAGLINE_EN = 'Reseller management panel';
const DEVELOPER = 'Sulduz Cloud';

function panelName() {
  return PANEL_NAME;
}

module.exports = {
  PANEL_NAME,
  PANEL_TAGLINE_FA,
  PANEL_TAGLINE_EN,
  DEVELOPER,
  panelName,
};
