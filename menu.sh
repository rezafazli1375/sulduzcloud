#!/usr/bin/env bash
# Sulduz Cloud — server menu.
# Installed by install.sh as /usr/local/bin/sulduzcloud (shortcut: sc).
# Run as root: `sudo sulduzcloud`
#
# Read-only where possible: it never touches x-ui, inbounds or clients.
set -uo pipefail

APP_DIR="${SC_APP_DIR:-/opt/sulduzcloud}"
ENV_FILE="$APP_DIR/server/.env"
NGINX_SITE="/etc/nginx/sites-available/sulduzcloud"
MENU_ENV="/etc/sulduzcloud/menu.env"
CRED_FILE="/etc/sulduzcloud/admin.cred"
SERVICE="sulduzcloud"

c_r=$'\033[0m'; c_b=$'\033[1m'; c_g=$'\033[32m'; c_y=$'\033[33m'; c_red=$'\033[31m'; c_c=$'\033[36m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s%s%s\n' "$c_g" "$*" "$c_r"; }
warn() { printf '%s%s%s\n' "$c_y" "$*" "$c_r"; }
err()  { printf '%s%s%s\n' "$c_red" "$*" "$c_r" >&2; }
head1() { printf '\n%s%s%s\n' "$c_b" "$*" "$c_r"; }
pause() { printf '\n'; read -rp "Enter را بزنید تا برگردید..." _ || true; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then exec sudo -- "$0" "$@"; fi
    err "این منو باید با کاربر root اجرا شود."
    exit 1
  fi
}

# ---------------------------------------------------------------- helpers

env_get() { # KEY
  [ -f "$ENV_FILE" ] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

env_set() { # KEY VALUE
  local key="$1" value="$2" tmp
  [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" -F= '
    BEGIN { done = 0 }
    $1 == k { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

as_sulduz() {
  if id -u sulduz >/dev/null 2>&1; then
    runuser -u sulduz -- "$@"
  else
    "$@"
  fi
}

panel_port() { local p; p="$(env_get PORT)"; printf '%s' "${p:-3100}"; }

public_url() { env_get PUBLIC_URL; }

domain_only() { # prints host from PUBLIC_URL
  local url; url="$(public_url)"
  printf '%s' "$url" | sed -e 's#^[a-zA-Z]*://##' -e 's#/.*$##' -e 's#:.*$##'
}

health() {
  curl -fsS --max-time 4 "http://127.0.0.1:$(panel_port)/api/health" 2>/dev/null
}

service_state() {
  if systemctl is-active --quiet "$SERVICE"; then ok "پنل (${SERVICE}): فعال"; else err "پنل (${SERVICE}): غیرفعال"; fi
  local active_since
  active_since="$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null)"
  [ -n "$active_since" ] && say "  از: $active_since"
}

xui_state() {
  if systemctl is-active --quiet x-ui 2>/dev/null; then
    say "  ۳x-ui: فعال (این منو هرگز آن را تغییر نمی‌دهد)"
  else
    say "  ۳x-ui: غیرفعال یا روی این سرور نصب نیست (روی سرور دیگر دیده می‌شود)"
  fi
}

valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }

# The nginx file that proxies to this panel. install.sh writes $NGINX_SITE, but
# an existing server may keep it under another name; find it by the proxy target.
nginx_site() {
  local port f
  port="$(panel_port)"
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -e "$f" ] || continue
    if grep -q "127.0.0.1:${port}\b" "$f" 2>/dev/null; then
      readlink -f "$f"
      return
    fi
  done
  [ -f "$NGINX_SITE" ] && printf '%s' "$NGINX_SITE"
}

# Certificate path used by the panel site (Let's Encrypt or a hand-managed cert).
cert_file_for() {
  local site="${1:-}"
  [ -n "$site" ] && [ -f "$site" ] || return 0
  awk '/ssl_certificate[[:space:]]+[^;]+;/ { for (i = 1; i <= NF; i++) if ($i ~ /^\//) { gsub(/;/, "", $i); print $i; exit } }' "$site"
}

cert_expiry() { # path -> "end-date|days-left"
  local path="$1" end
  [ -f "$path" ] || return 0
  end="$(openssl x509 -in "$path" -noout -enddate 2>/dev/null | cut -d= -f2)"
  [ -n "$end" ] || return 0
  printf '%s|%s' "$end" "$(( ( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))"
}

# ---------------------------------------------------------------- pages

page_status() {
  head1 "وضعیت پنل"
  service_state
  local h; h="$(health)"
  if [ -n "$h" ]; then ok "  health: $h"; else err "  health: پاسخ نداد"; fi
  say "  آدرس عمومی: $(public_url || true)"
  say "  پورت داخلی: $(panel_port)"
  say "  دیتابیس: $(env_get DATA_DIR || echo /var/lib/sulduzcloud)/panel.db"
  local xui; xui="$(as_sulduz node -e '
    try {
      const s = require(process.argv[1] + "/server/src/settings");
      const x = s.getSetting ? s.getSetting("xui") : null;
      // Never print the panel path or the API token; host:port is enough here.
      if (x && x.url) process.stdout.write(String(x.url).replace(/^(https?:\/\/[^/]+).*$/, "$1") + "/…");
    } catch (_) {}
  ' "$APP_DIR" 2>/dev/null)"
  [ -n "$xui" ] && say "  ۳x-ui متصل: $xui"
  xui_state
}

admin_list() { as_sulduz node "$APP_DIR/server/scripts/admin-cli.js" admins 2>/dev/null; }

cred_get() { # KEY -> value
  [ -f "$CRED_FILE" ] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$CRED_FILE"
}

cred_save() { # username password
  mkdir -p "$(dirname "$CRED_FILE")"
  ( umask 077
    printf 'ADMIN_USER=%s\nADMIN_PASS=%s\nADMIN_SET=%s\n' "$1" "$2" "$(date '+%Y-%m-%d %H:%M')" > "$CRED_FILE"
  )
  chmod 600 "$CRED_FILE"
}

show_credentials() {
  head1 "نام کاربری و رمز عبور مدیر"
  local admins; admins="$(admin_list)"
  if [ -z "$admins" ]; then
    warn "هنوز هیچ حساب ادمینی ساخته نشده است."
    say "  پنل را در مرورگر باز کنید و در صفحهٔ اول حساب مالک را بسازید."
    return
  fi
  say "  نام کاربری مدیر:"
  printf '%s\n' "$admins" | while IFS= read -r line; do [ -n "$line" ] && say "    $line"; done
  if [ -f "$CRED_FILE" ]; then
    local u p t
    u="$(cred_get ADMIN_USER)"; p="$(cred_get ADMIN_PASS)"; t="$(cred_get ADMIN_SET)"
    say ""
    ok "  رمز عبور: $p"
    say "  کاربر: $u    |    آخرین تنظیم از همین منو: $t"
    warn "  اگر رمز را از داخل پنل وب عوض کرده‌اید این مقدار قدیمی است؛ گزینهٔ ۲ را بزنید."
  else
    say ""
    warn "  رمز عبور: قابل نمایش نیست."
    say "  رمزها به‌صورت هش ذخیره می‌شوند و بازیابی ندارند. با گزینهٔ ۲ یک رمز تازه بسازید"
    say "  (همان لحظه نمایش داده و در همین سرور ذخیره می‌شود)."
  fi
}

set_admin_password() { # username [password]
  local u="$1" pw="${2:-}" out
  if [ -n "$pw" ]; then
    as_sulduz node "$APP_DIR/server/scripts/admin-cli.js" reset "$u" --password "$pw" >/dev/null \
      || { err "تغییر رمز ناموفق بود."; return 1; }
  else
    out="$(as_sulduz node "$APP_DIR/server/scripts/admin-cli.js" reset "$u")" \
      || { err "تغییر رمز ناموفق بود."; return 1; }
    pw="$(printf '%s\n' "$out" | sed -n 's/^  New password: //p')"
  fi
  [ -n "$pw" ] || { err "رمز تازه ساخته نشد."; return 1; }
  cred_save "$u" "$pw"
  say ""
  ok "  کاربر: $u"
  ok "  رمز جدید: $pw"
  warn "  این رمز در $CRED_FILE ذخیره شد (فقط root می‌تواند بخواند) و از این منو نمایش‌دادنی است."
}

change_admin_password() {
  local first target pw auto
  first="$(admin_list | awk 'NF { print $1; exit }')"
  [ -n "$first" ] || { err "حساب ادمینی وجود ندارد؛ اول در پنل وب حساب مالک را بسازید."; return 1; }
  printf 'نام کاربری (خالی = %s): ' "$first"
  read -r target || true
  target="${target:-$first}"
  printf 'رمز به‌صورت خودکار ساخته شود؟ [Y/n]: '
  read -r auto || true
  if [[ "${auto:-Y}" =~ ^[Nn]$ ]]; then
    printf 'رمز جدید (حداقل ۸ کاراکتر): '
    read -rs pw || true; printf '\n'
    [ ${#pw} -ge 8 ] || { err "کوتاه است."; return 1; }
    set_admin_password "$target" "$pw"
  else
    set_admin_password "$target"
  fi
}

page_accounts() {
  show_credentials
  say ""
  say "  1) نمایش دوباره"
  say "  2) تغییر رمز عبور مدیر"
  say "  0) بازگشت"
  printf 'انتخاب: '
  local ch; read -r ch || true
  case "${ch:-}" in
    1) show_credentials ;;
    2) change_admin_password; pause ;;
    *) : ;;
  esac
}

page_domain() {
  head1 "تنظیم دامنه"
  say "دامنهٔ فعلی: $(public_url || true)"
  say "قبل از این کار رکورد A دامنه را به IP همین سرور وصل کنید."
  printf '\nدامنهٔ جدید (مثلاً panel.example.com، خالی = انصراف): '
  local d; read -r d || true
  [ -z "${d:-}" ] && return
  if ! valid_domain "$d"; then err "دامنه معتبر نیست."; pause; return; fi
  set_domain "$d"
  pause
}

set_domain() { # host [scheme]
  local d="$1" scheme="${2:-}"
  [ -n "$scheme" ] || { if [ -f "/etc/letsencrypt/live/$d/cert.pem" ]; then scheme="https"; else scheme="http"; fi; }
  env_set PUBLIC_URL "$scheme://$d"
  ok "PUBLIC_URL روی $scheme://$d تنظیم شد."
  local site; site="$(nginx_site)"
  if [ -n "$site" ] && [ -f "$site" ]; then
    cp -a "$site" "$site.bak.$(date +%s)"
    sed -i -E "s/server_name[[:space:]]+[^;]+;/server_name $d;/g" "$site"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && ok "nginx به‌روزرسانی شد ($site)."
    else
      err "خطای nginx -t؛ reload انجام نشد (نسخهٔ قبلی: $site.bak.*)."
      nginx -t || true
      return 1
    fi
  else
    warn "فایل سایت nginx پیدا نشد (نصب با --no-nginx) — فقط .env تغییر کرد."
  fi
  systemctl restart "$SERVICE"
  sleep 2
  if [ -n "$(health)" ]; then ok "پنل با دامنهٔ جدید بالا آمد."; else err "پنل بالا نیامد: journalctl -u $SERVICE -n 50"; fi
}

page_ssl() {
  head1 "گواهی SSL"
  local d; d="$(domain_only)"
  [ -n "$d" ] || { err "اول دامنه را تنظیم کنید (گزینهٔ ۳)."; pause; return; }
  say "دامنه: $d"
  local site cert info end days
  site="$(nginx_site)"
  cert="$(cert_file_for "$site")"
  [ -n "$cert" ] || cert="/etc/letsencrypt/live/$d/fullchain.pem"
  info="$(cert_expiry "$cert")"
  if [ -n "$info" ]; then
    end="${info%%|*}"; days="${info##*|}"
    ok "  گواهی: $cert"
    ok "  معتبر تا ${end} — ${days} روز مانده"
    [ "$days" -lt 0 ] && err "  گواهی منقضی شده است!"
    [ "$days" -ge 0 ] && [ "$days" -lt 14 ] && warn "  کمتر از ۱۴ روز؛ تمدید کنید."
    case "$cert" in
      */letsencrypt/*) : ;;
      *) warn "  این گواهی خارج از certbot مدیریت می‌شود؛ تمدید آن با روش خودتان (یا گزینهٔ ۱) انجام شود." ;;
    esac
  else
    warn "  گواهی SSL روی این سایت پیدا نشد (HTTP)."
  fi
  say ""
  say "  1) صدور/تمدید خودکار گواهی Let's Encrypt"
  say "  2) نمایش مسیر فایل‌های گواهی"
  say "  0) بازگشت"
  printf 'انتخاب: '
  local ch; read -r ch || true
  case "${ch:-}" in
    1) issue_cert "$d" ;;
    2) say "  /etc/letsencrypt/live/$d/fullchain.pem"; say "  /etc/letsencrypt/live/$d/privkey.pem" ;;
    *) return ;;
  esac
  pause
}

issue_cert() { # host
  local d="$1" email
  if ! command -v certbot >/dev/null 2>&1; then
    warn "certbot نصب نیست؛ نصب می‌شود..."
    apt-get update -qq && apt-get install -y certbot python3-certbot-nginx || { err "نصب certbot ناموفق."; return 1; }
  fi
  email="$(awk -F= '$1=="SC_SSL_EMAIL"{print $2}' "$MENU_ENV" 2>/dev/null)"
  if [ -z "$email" ]; then
    printf "ایمیل برای Let's Encrypt: "
    read -r email || true
    [ -n "$email" ] || { err "ایمیل لازم است."; return 1; }
    mkdir -p "$(dirname "$MENU_ENV")"
    printf 'SC_SSL_EMAIL=%s\n' "$email" > "$MENU_ENV"
    chmod 600 "$MENU_ENV"
  fi
  if [ -z "$(nginx_site)" ]; then
    err "سایت nginx نیست؛ گواهی با certbot --nginx ممکن نیست."
    return 1
  fi
  if certbot --nginx -d "$d" --redirect --non-interactive --agree-tos -m "$email"; then
    env_set PUBLIC_URL "https://$d"
    systemctl restart "$SERVICE"
    ok "گواهی صادر شد و پنل روی https://$d بالا آمد."
  else
    err "صدور گواهی ناموفق بود. DNS دامنه و پورت ۸۰ را بررسی کنید."
  fi
}

page_backup() {
  head1 "بکاپ فوری"
  local data_dir backup_dir stamp out
  data_dir="$(env_get DATA_DIR)"; data_dir="${data_dir:-/var/lib/sulduzcloud}"
  backup_dir="$(env_get BACKUP_DIR)"; backup_dir="${backup_dir:-$data_dir/backups}"
  mkdir -p "$backup_dir"
  chown sulduz:sulduz "$backup_dir" 2>/dev/null || true
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="$backup_dir/manual-$stamp.db"
  if as_sulduz node -e '
    const Database = require(process.argv[1] + "/server/node_modules/better-sqlite3");
    const db = new Database(process.argv[2], { readonly: true });
    db.backup(process.argv[3]).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
  ' "$APP_DIR" "$data_dir/panel.db" "$out"; then
    ok "بکاپ ساخته شد: $out ($(du -h "$out" | cut -f1))"
  else
    err "بکاپ ناموفق بود."
  fi
  pause
}

page_restart() {
  head1 "ری‌استارت پنل"
  say "فقط سرویس $SERVICE ری‌استارت می‌شود؛ ۳x-ui و کاربران دست نمی‌خورند."
  if [ -t 0 ]; then
    printf 'ادامه؟ [y/N]: '
    local a; read -r a || true
    [[ "${a:-}" =~ ^[Yy]$ ]] || return
  fi
  systemctl restart "$SERVICE"
  sleep 2
  if [ -n "$(health)" ]; then ok "پنل سالم بالا آمد: $(health)"; else err "پنل بالا نیامد:"; journalctl -u "$SERVICE" -n 30 --no-pager; fi
  pause
}

page_logs() {
  head1 "۳۰ خط آخر لاگ"
  journalctl -u "$SERVICE" -n 30 --no-pager
  pause
}

# ---------------------------------------------------------------- menu

draw_menu() {
  clear 2>/dev/null || true
  printf '%s' "$c_b"
  say "  Sulduz Cloud — منوی سرور"
  printf '%s' "$c_r"
  say "  پنل: $(public_url || echo 'تنظیم نشده')   |   نسخهٔ health: $(health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  say "  ------------------------------------------------------------"
  say "  1) وضعیت سرویس و اتصال ۳x-ui"
  say "  2) نام کاربری و رمز مدیر (نمایش / تغییر)"
  say "  3) تنظیم دامنه پنل"
  say "  4) گواهی SSL (صدور/تمدید)"
  say "  5) بکاپ فوری دیتابیس"
  say "  6) ری‌استارت پنل"
  say "  7) لاگ سرویس"
  say "  0) خروج"
  printf '  انتخاب: '
}

main_menu() {
  while true; do
    draw_menu
    local choice; read -r choice || exit 0
    case "${choice:-}" in
      1) page_status; pause ;;
      2) page_accounts ;;
      3) page_domain ;;
      4) page_ssl ;;
      5) page_backup ;;
      6) page_restart ;;
      7) page_logs ;;
      0|q|Q) exit 0 ;;
      *) ;;
    esac
  done
}

main() {
  need_root "$@"
  if [ ! -d "$APP_DIR/server" ]; then
    err "نصب در $APP_DIR پیدا نشد. با SC_APP_DIR مسیر را بدهید."
    exit 1
  fi
  case "${1:-}" in
    status) page_status ;;
    accounts) page_accounts ;;
    domain)
      if [ -n "${2:-}" ]; then
        if valid_domain "$2"; then set_domain "$2"; else err "دامنه معتبر نیست."; fi
      else
        page_domain
      fi
      ;;
    ssl) if [ -n "${2:-}" ]; then issue_cert "$2"; else page_ssl; fi ;;
    backup) page_backup ;;
    restart) page_restart ;;
    logs) page_logs ;;
    ""|-m|menu) main_menu ;;
    *) say "استفاده: sulduzcloud [status|accounts|domain <host>|ssl <host>|backup|restart|logs]" ;;
  esac
}

main "$@"
