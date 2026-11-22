#!/usr/bin/env bash
# Sulduz Cloud — server menu.
# Installed by install.sh as /usr/local/bin/sulduzcloud (shortcut: sc).
# Run as root: `sudo sulduzcloud`
#
# The six items the owner asked for, in his order (v2.1.0):
#
#   1) update                     pull the published release and re-run the installer
#   2) change port panel          move the listener — and nginx with it — to a new port
#   3) reset username and password owner — the owner account, from the console
#   4) view panel login details   address, port, accounts, activation key
#   5) automatic ssl              Let's Encrypt: at nginx, or served by the panel
#   6) exit
#
# The rest stayed reachable as subcommands (`sulduzcloud status`, `logs`, `backup`,
# `restart`, `domain <host>`, `net`, `activate`) for scripts and one-off ssh work;
# it just no longer clutters the screen a person looks at.
#
# Read-only where possible: it never touches x-ui, inbounds or clients, and every
# item that restarts something records x-ui's pid before and after so "x-ui was not
# disturbed" is evidence rather than a promise. The only other service this menu
# reloads is nginx, and it copies the site file first.
set -uo pipefail

APP_DIR="${SC_APP_DIR:-/opt/sulduzcloud}"
ENV_FILE="$APP_DIR/server/.env"
NGINX_SITE="/etc/nginx/sites-available/sulduzcloud"
MENU_ENV="${SC_MENU_ENV:-/etc/sulduzcloud/menu.env}"
CRED_FILE="${SC_CRED_FILE:-/etc/sulduzcloud/admin.cred}"
SERVICE="sulduzcloud"
REPO_SLUG="${SC_REPO_SLUG:-rezafazli1375/sulduzcloud}"
CLI="$APP_DIR/server/scripts/admin-cli.js"
# Set by rename_owner() so the "both" branch of the owner page knows which account
# it is now resetting the password of.
RENAME_RESULT=""
# Same reason for the two SSL helpers that would otherwise answer on stdout: a
# command substitution there would also swallow the prompt text.
SSL_EMAIL=""
SSL_PAIR_DIR=""

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

# Every settings write goes through the panel's own code, as the service user: the
# same guards, the same encryption and the same settings row the admin form writes.
# A hand-rolled sqlite UPDATE here would be a second, lazier set of rules that the
# next save from the browser quietly overwrites.
cli() { as_sulduz node "$CLI" "$@"; }

panel_port() { local p; p="$(env_get PORT)"; printf '%s' "${p:-3100}"; }

# The port the panel will use when it next boots: the stored settings number when
# the owner has set one (src/net.js reads general.panelPort BEFORE .env PORT), and
# the .env value otherwise. This is why the port item writes both.
desired_port() {
  local p; p="$(cli port get 2>/dev/null)"
  printf '%s' "${p:-$(panel_port)}"
}

# Which port the running panel process actually holds. systemd's MainPID is the
# answer — a `pgrep src/index.js` would also match a second panel running on the
# same box for testing, and then report the wrong socket.
live_port() {
  local pid port
  pid="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    pid="$(pgrep -f "src/index.js" 2>/dev/null | head -1)"
  fi
  [ -n "$pid" ] || return 1
  port="$(ss -ltnp 2>/dev/null | awk -v p="$pid" '$0 ~ "pid=" p "," { print $4 }' \
    | sed -n 's/.*:\([0-9]*\)$/\1/p' | head -1)"
  [ -n "$port" ] || return 1
  printf '%s' "$port"
}

# Empty is a real answer here, not a success: every caller writes
# `$(public_url || echo 'تنظیم نشده')`, and a zero status with no output would
# print a blank address instead of that label.
public_url() { local u; u="$(env_get PUBLIC_URL)"; [ -n "$u" ] || return 1; printf '%s' "$u"; }

domain_only() { # prints host from PUBLIC_URL
  local url; url="$(public_url)"
  printf '%s' "$url" | sed -e 's#^[a-zA-Z]*://##' -e 's#/.*$##' -e 's#:.*$##'
}

# What the panel answers on one port — http first, then https. A listener that
# was given a certificate (v2.1.0 settings → general.sslCertPath) answers nothing
# to a plain http request, and that is not a dead panel; asking both ways is what
# keeps "پنل پاسخ نمی‌دهد" from being said about a service that is fine.
health_probe() { # port
  local out
  out="$(curl -fsS --max-time 4 "http://127.0.0.1:$1/api/health" 2>/dev/null)" \
    && { printf '%s' "$out"; return 0; }
  out="$(curl -fskS --max-time 4 "https://127.0.0.1:$1/api/health" 2>/dev/null)" \
    && { printf '%s' "$out"; return 0; }
  return 1
}

# Which port to ask: the socket first (that is the truth), then the number the
# panel will take on its next boot, then the number in .env. The three differ
# exactly when something half-finished, and a menu that only reads .env would be
# blind to the case it exists to help with.
health() {
  local p seen=""
  for p in "$(live_port || true)" "$(desired_port)" "$(panel_port)"; do
    [ -n "$p" ] || continue
    case " $seen " in *" $p "*) continue ;; esac
    seen="$seen $p"
    health_probe "$p" && return 0
  done
  return 1
}

health_on() { # port
  health_probe "$1"
}

version_shown() {
  health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

service_state() {
  if systemctl is-active --quiet "$SERVICE"; then ok "پنل (${SERVICE}): فعال"; else err "پنل (${SERVICE}): غیرفعال"; fi
  local active_since
  active_since="$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null)"
  [ -n "$active_since" ] && say "  از: $active_since"
}

xui_pid() { systemctl show -p MainPID --value x-ui 2>/dev/null; }

xui_state() {
  local pid; pid="$(xui_pid)"
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    say "  x-ui: فعال، pid $pid (این منو هرگز آن را تغییر نمی‌دهد)"
  else
    say "  x-ui: غیرفعال یا روی این سرور نصب نیست (روی سرور دیگر دیده می‌شود)"
  fi
}

# Printed after every item that restarts services. Same pid in and out is the
# proof; anything else is said out loud instead of hidden.
xui_guard() { # before after label
  if [ "${1:-}" = "${2:-}" ]; then
    say "  x-ui دست‌نخورده: pid ${2:-0} ($3)"
  else
    warn "  pid سرویس x-ui عوض شد (${1:-0} -> ${2:-0}) — این منو آن را تغییر نداد؛ بررسی کنید."
  fi
}

valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }

# The panel's own floor is src/net.js MIN_PORT = 1024: the service runs
# unprivileged, so a port below that can be stored but never bound.
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }

port_free() { # port -> success when nothing holds it
  local n; n="$(ss -ltnH "sport = :$1" 2>/dev/null | wc -l)"
  [ "${n:-0}" -eq 0 ]
}

# Can the SERVICE user read this file? root always can, which is not the question:
# src/net.js refuses a certificate the panel itself cannot open.
readable_by_service() { # path
  [ -f "$1" ] || return 1
  as_sulduz test -r "$1" 2>/dev/null
}

backup_now() { # prints the path it wrote
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
    printf '%s' "$out"
    return 0
  fi
  return 1
}

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

# ---------------------------------------------------------------- 1) update

latest_release_tag() {
  curl -fsSL --max-time 20 "https://api.github.com/repos/$REPO_SLUG/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1
}

page_update() {
  head1 "۱) آپدیت پنل"
  local now latest
  now="$(version_shown)"
  say "  نسخهٔ در حال اجرا: ${now:-نامشخص (پنل پاسخ نمی‌دهد)}"
  say "  مخزن: $REPO_SLUG"
  say "  مسیر نصب: $APP_DIR"
  printf '\n  خواندن آخرین نسخهٔ منتشرشده...'
  latest="$(latest_release_tag)"
  if [ -z "$latest" ]; then
    err "  آخرین نسخه از گیت‌هاب خوانده نشد (اینترنت، DNS یا rate limit)."
    say "  روش دستی همان لینک تک‌دستوری نصب است:"
    say "    curl -fsSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh | sudo bash"
    pause; return 1
  fi
  say "  آخرین نسخهٔ منتشرشده: $latest"
  if [ -n "$now" ] && [ "v$now" = "$latest" ]; then
    ok "  پنل به‌روز است (همان نسخه)."
    pause; return 0
  fi
  say ""
  say "  آپدیت = نصب دوبارهٔ همان نسخهٔ منتشرشده: فایل‌ها و بیلد وب عوض می‌شوند."
  say "  دیتابیس، تنظیمات پنل و فایل .env شما دست‌نخورده می‌مانند (نصب‌کننده"
  say "  صریحاً .env را نگه می‌دارد و هیچ داده‌ای پاک نمی‌کند)."
  printf '\n  ادامه؟ [y/N]: '
  local a; read -r a || true
  [[ "${a:-}" =~ ^[Yy]$ ]] || { say "  بدون تغییر بیرون آمدید."; return 0; }

  local bkp; bkp="$(backup_now)"
  if [ -n "$bkp" ]; then ok "  بکاپ دیتابیس: $bkp"; else warn "  بکاپ ساخته نشد؛ ادامه ریسکش با شماست."; fi
  local xui_before; xui_before="$(xui_pid)"

  local dom port flag_domain=""
  dom="$(domain_only)"; port="$(desired_port)"
  valid_domain "$dom" && flag_domain="--domain $dom"

  local script; script="$(mktemp /tmp/sc-install-XXXXXX.sh)"
  if ! curl -fsSL --max-time 40 "https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh" -o "$script"; then
    err "  دانلود install.sh ناموفق بود."; rm -f "$script"; pause; return 1
  fi
  say "  در حال آپدیت (بیلد وب چند دقیقه طول می‌کشد)..."
  # --non-interactive: the menu already collected what the installer would ask.
  if bash "$script" --non-interactive --dir "$APP_DIR" --port "$port" $flag_domain; then
    ok "  آپدیت انجام شد."
  else
    err "  آپدیت با خطا تمام شد. وضعیت پنل:"
    journalctl -u "$SERVICE" -n 25 --no-pager
  fi
  rm -f "$script"

  sleep 2
  xui_guard "$xui_before" "$(xui_pid)" "پس از آپدیت"
  local h; h="$(health)"
  if [ -n "$h" ]; then
    ok "  پنل بالا آمد: $h"
    say "  اگر مرورگر هنوز نسخهٔ قدیمی را نشان می‌دهد: Ctrl+F5 (حافظهٔ کش مرورگر است، نه سرور)."
  else
    err "  پنل بالا نیامد: journalctl -u $SERVICE -n 40"
  fi
  pause
}

# ---------------------------------------------------------------- 2) change port

page_port() {
  head1 "۲) تغییر پورت پنل"
  local live want envp
  live="$(live_port || true)"; want="$(desired_port)"; envp="$(panel_port)"
  say "  پورتی که پنل همین حالا گوش می‌دهد: ${live:-نامشخص (سرویس بالا نیست؟)}"
  say "  پورت ذخیره‌شده در تنظیمات پنل:    ${want:-(خالی)}"
  say "  پورت در فایل .env:                ${envp}"
  say ""
  say "  این کار هر سه را یکجا عوض می‌کند؛ اگر فقط یکی عوض شود، src/net.js عدد"
  say "  ذخیره‌شده در تنظیمات را بر .env مقدم می‌داند و شمارهٔ قدیمی برمی‌گردد."
  say ""
  say "  نکته: اگر پنل را با دامنه و nginx باز می‌کنید، آدرس مرورگر شما پورت ندارد;"
  say "  اینجا پورت داخلی جابه‌جا می‌شود و nginx هم با همان گزینه وصل می‌شود."
  printf '\n  پورت تازه (۱۰۲۴ تا ۶۵۵۳۵، خالی = انصراف): '
  local p; read -r p || true
  p="${p//[^0-9]/}"
  [ -z "$p" ] && return 0
  if ! valid_port "$p"; then err "  پورت معتبر نیست (بین ۱۰۲۴ و ۶۵۵۳۵)."; pause; return 1; fi
  if [ "$p" = "${live:-$envp}" ]; then
    warn "  پنل همین حالا روی $p است؛ چیزی تغییر نکرد."; pause; return 0
  fi
  if ! port_free "$p"; then
    err "  پورت $p روی این سرور آزاد نیست:"
    ss -ltnp "sport = :$p" 2>/dev/null | sed -n '2,5p' | sed 's/^/    /'
    say "  آن سرویس را آزاد کنید و دوباره بیایید — پنل جابه‌جا نشد."
    pause; return 1
  fi
  if [ "$p" -ge 2000 ] && [ "$p" -le 2100 ]; then
    warn "  این شماره در بازهٔ پورت‌های معمول x-ui است؛ بعداً ممکن است برخورد کند."
  fi

  local xui_before; xui_before="$(xui_pid)"
  local bkp; bkp="$(backup_now)"
  [ -n "$bkp" ] && say "  بکاپ دیتابیس: $bkp"

  # 1) the stored setting — the number src/net.js reads first.
  if ! cli port set "$p"; then
    err "  ذخیرهٔ پورت در تنظیمات پنل ناموفق بود؛ پنل جابه‌جا نشد."
    pause; return 1
  fi
  # 2) .env — what systemd hands the service, and what the installer reads later.
  env_set PORT "$p"
  say "  PORT=$p در $ENV_FILE نوشته شد."

  # 3) nginx — the site that proxies to the OLD port has to follow.
  local site old; site="$(nginx_site)"; old="$envp"
  if [ -n "$site" ] && [ -f "$site" ]; then
    cp -a "$site" "$site.bak.$(date +%s)"
    sed -i -E "s#127\.0\.0\.1:${old}([^0-9]|$)#127.0.0.1:${p}\1#g" "$site"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && ok "  nginx به پورت $p وصل شد ($site)."
    else
      err "  nginx بعد از تغییر پورت معتبر نیست؛ نسخهٔ قبلی برگردانده شد:"
      local prev; prev="$(ls -1t "$site.bak."* 2>/dev/null | head -1)"
      [ -n "$prev" ] && cp -a "$prev" "$site" && nginx -t >/dev/null 2>&1 && systemctl reload nginx
      warn "  پنل روی $p است ولی nginx هنوز به $old اشاره می‌کند؛ دستی بررسی کنید."
    fi
  else
    warn "  سایت nginx‌ای که به پورت $old اشاره کند پیدا نشد؛ فقط تنظیمات پنل و .env عوض شد."
  fi

  systemctl restart "$SERVICE"
  sleep 3
  if [ -n "$(health_on "$p")" ]; then
    ok "  پنل روی پورت $p بالا آمد."
  else
    err "  پنل روی $p پاسخ نداد؛ بازگردانی به $old:"
    cli port set "$old" >/dev/null; env_set PORT "$old"
    [ -n "$site" ] && sed -i -E "s#127\.0\.0\.1:${p}([^0-9]|$)#127.0.0.1:${old}\1#g" "$site"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    systemctl restart "$SERVICE"; sleep 2
    if [ -n "$(health_on "$old")" ]; then
      ok "  پنل به $old برگشت و کار می‌کند."
      warn "  اگر فایل سایت را دستی عوض کرده باشید ممکن است nginx روی $old نمانده باشد."
    else
      err "  پنل حتی روی $old هم بالا نیامد: journalctl -u $SERVICE -n 40"
    fi
  fi
  xui_guard "$xui_before" "$(xui_pid)" "پس از تغییر پورت"
  pause
}

# ---------------------------------------------------------------- pages

page_status() {
  head1 "وضعیت پنل"
  service_state
  local h; h="$(health)"
  if [ -n "$h" ]; then ok "  health: $h"; else err "  health: پاسخ نداد"; fi
  say "  آدرس عمومی: $(public_url || true)"
  say "  پورت زنده:   $(live_port || echo نامشخص)    (مورد نظر: $(desired_port) | در .env: $(panel_port))"
  say "  دیتابیس: $(env_get DATA_DIR || echo /var/lib/sulduzcloud)/panel.db"
  local xui; xui="$(as_sulduz node -e '
    try {
      const s = require(process.argv[1] + "/server/src/settings");
      const x = s.getSetting ? s.getSetting("xui") : null;
      // Never print the panel path or the API token; host:port is enough here.
      if (x && x.url) process.stdout.write(String(x.url).replace(/^(https?:\/\/[^/]+).*$/, "$1") + "/…");
    } catch (_) {}
  ' "$APP_DIR" 2>/dev/null)"
  [ -n "$xui" ] && say "  x-ui متصل: $xui"
  xui_state
  say "  فعال‌سازی:"
  cli activation show 2>/dev/null | sed 's/^/    /'
}

admin_list() { cli admins 2>/dev/null; }

owner_name() { cli owner 2>/dev/null; }

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

# ---------------------------------------------------------------- 4) login details

# Everything a person needs to get INTO the panel, on one screen: the address to
# type, the port behind it, the accounts, where the password file is, and the
# activation key this install answers with.
page_details() {
  head1 "۴) اطلاعات ورود پنل"
  local live want
  live="$(live_port || true)"; want="$(desired_port)"
  say "  آدرس برای مرورگر : $(public_url || echo 'تنظیم نشده — با گزینهٔ دامنه یا ssl تنظیمش کنید')"
  say "  پورت زنده        : ${live:-نامشخص (سرویس بالا نیست؟)}"
  say "  پورت مورد نظر    : ${want:-نامشخص}    (در .env: $(panel_port))"
  say "  سرویس            : $SERVICE  —  $(systemctl is-active "$SERVICE" 2>/dev/null || echo '?')"
  say "  نسخهٔ پنل        : $(version_shown || echo نامشخص)"
  say ""
  local admins; admins="$(admin_list)"
  if [ -z "$admins" ]; then
    warn "  هنوز هیچ حساب مدیری ساخته نشده است."
    say "  پنل را در مرورگر باز کنید؛ اولین صفحه حساب مالک را می‌سازد."
    say "  اگر صفحه باز نشد: sulduzcloud net   و   sulduzcloud logs"
  else
    say "  حساب‌های مدیر (نمایش / وضعیت / تاریخ ساخت):"
    printf '%s\n' "$admins" | while IFS= read -r line; do [ -n "$line" ] && say "    $line"; done
  fi
  say ""
  if [ -f "$CRED_FILE" ]; then
    local u p t
    u="$(cred_get ADMIN_USER)"; p="$(cred_get ADMIN_PASS)"; t="$(cred_get ADMIN_SET)"
    say "  نام کاربری ذخیره‌شده در این منو : $u"
    say "  رمز عبور                      : $p"
    say "  آخرین تنظیم از همین منو        : $t"
    warn "  اگر رمز را از داخل پنل وب عوض کرده‌اید این مقدار قدیمی است؛ گزینهٔ ۳."
  else
    say "  رمز عبور: قابل نمایش نیست — رمزها هش می‌شوند و بازیابی ندارند."
    say "  با گزینهٔ ۳ می‌توانید رمز تازه بسازید (همان لحظه نمایش داده و در همین"
    say "  سرور در $CRED_FILE ذخیره می‌شود)."
  fi
  say ""
  say "  فعال‌سازی:"
  cli activation show 2>/dev/null | sed 's/^/    /'
  say ""
  say "  شبکه:"
  cli net show 2>/dev/null | sed 's/^/    /'
  say ""
  say "  دیتابیس: $(env_get DATA_DIR || echo /var/lib/sulduzcloud)/panel.db"
  say "  فایل رمز: $CRED_FILE (فقط root)"
}

# ---------------------------------------------------------------- 3) owner account

set_admin_password() { # username [password]
  local u="$1" pw="${2:-}" out
  if [ -n "$pw" ]; then
    cli reset "$u" --password "$pw" >/dev/null \
      || { err "  تغییر رمز ناموفق بود."; return 1; }
  else
    out="$(cli reset "$u")" || { err "  تغییر رمز ناموفق بود."; return 1; }
    pw="$(printf '%s\n' "$out" | sed -n 's/^  New password: //p')"
  fi
  [ -n "$pw" ] || { err "  رمز تازه ساخته نشد."; return 1; }
  cred_save "$u" "$pw"
  say ""
  say "  کاربر      : $u"
  ok "  رمز جدید   : $pw"
  warn "  این رمز در $CRED_FILE (mode 600، فقط root) ذخیره شد تا از همین منو قابل نمایش باشد."
  say "  نشست‌های بازِ مرورگر با رمز قدیمی از کار می‌افتند؛ این درستِ کار است."
  return 0
}

rename_owner() { # current-name
  local cur="$1" next
  RENAME_RESULT=""
  printf '\n  نام کاربری جدید (۳ تا ۳۲ نویسهٔ انگلیسی، رقم، . _ -، خالی = انصراف): '
  read -r next || true
  next="${next//[^A-Za-z0-9._-]/}"
  [ -n "$next" ] || { say "  بدون تغییر."; return 0; }
  local out
  if ! out="$(cli rename "$cur" "$next" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/  /'
    warn "  نام کاربری تغییر نکرد."
    return 1
  fi
  printf '%s\n' "$out" | sed 's/^/  /'
  RENAME_RESULT="$next"
  # The credential file is keyed by the name the owner types in the login box, so
  # it follows the account; an old name left in it would show a password that no
  # longer logs anybody in.
  if [ -f "$CRED_FILE" ]; then
    local p; p="$(cred_get ADMIN_PASS)"
    if [ -n "$p" ]; then cred_save "$next" "$p"; say "  $CRED_FILE هم به نام تازه به‌روز شد."
    else say "  (رمزی در فایل نبود؛ چیزی برای به‌روزرسانی نبود.)"; fi
  fi
  return 0
}

page_owner() {
  head1 "۳) بازنشانی نام کاربری و رمز مالک"
  local first; first="$(owner_name)"
  if [ -z "$first" ]; then
    warn "  حساب مدیری در این پنل نیست."
    say "  اگر تازه نصب کرده‌اید، پنل را در مرورگر باز کنید تا صفحهٔ نخستین ورود ظاهر شود."
    say "  اگر مطمئن هستید پنل بالا است: sulduzcloud status"
    pause; return 1
  fi
  say "  حساب مالک فعلی: $first"
  local admins; admins="$(admin_list)"
  if [ -n "$admins" ] && [ "$(printf '%s\n' "$admins" | awk 'NF' | wc -l)" -gt 1 ]; then
    warn "  چند حساب مدیر وجود دارد؛ این منو روی $first کار می‌کند."
    printf '%s\n' "$admins" | sed 's/^/    /'
  fi
  say ""
  say "  1) تغییر رمز عبور"
  say "  2) تغییر نام کاربری"
  say "  3) هر دو (وقتی دسترسی کامل را باخته‌اید)"
  say "  0) بازگشت"
  printf '  انتخاب: '
  local ch; read -r ch || true
  case "${ch:-}" in
    1)
      printf '  رمز به‌صورت خودکار ساخته شود؟ [Y/n]: '
      local auto; read -r auto || true
      if [[ "${auto:-Y}" =~ ^[Nn]$ ]]; then
        local pw; printf '  رمز جدید (حداقل ۸ کاراکتر): '; read -rs pw || true; printf '\n'
        [ ${#pw} -ge 8 ] || { err "  کوتاه است."; pause; return 1; }
        set_admin_password "$first" "$pw"
      else
        set_admin_password "$first"
      fi
      ;;
    2) rename_owner "$first" ;;
    3)
      if rename_owner "$first"; then
        local who="${RENAME_RESULT:-$first}"
        printf '\n  حالا رمز حساب %s:\n' "$who"
        set_admin_password "$who"
      fi
      ;;
    *) return 0 ;;
  esac
  pause
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
  # .env is the boot-time fallback; the stored setting is what src/net.js and every
  # subscribe link actually read, so a domain change that skips it is a no-op the
  # next time the browser asks for a link.
  if cli url set "$scheme://$d" >/dev/null 2>&1; then
    ok "آدرس عمومی در تنظیمات پنل هم روی $scheme://$d رفت."
  else
    warn "آدرس عمومی در تنظیمات پنل نوشته نشد (خطا در CLI)؛ از داخل پنل وب چک کنید."
  fi
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
  head1 "۵) گواهی SSL خودکار"
  local d; d="$(domain_only)"
  if [ -z "$d" ]; then
    say "  هنوز دامنه‌ای تنظیم نشده است و بدون دامنه گواهی Let's Encrypt معنا ندارد."
    printf '  دامنه (مثلاً panel.example.com، خالی = انصراف): '
    read -r d || true
    d="${d//[^A-Za-z0-9.-]/}"
    [ -n "$d" ] || return 0
    valid_domain "$d" || { err "  دامنه معتبر نیست."; pause; return 1; }
    say "  رکورد A دامنه باید به IP همین سرور اشاره کند."
    set_domain "$d" https
    pause; return 0
  fi
  say "  دامنه: $d"
  ssl_status_show
  say ""
  say "  1) صدور/تمدید خودکار Let's Encrypt — TLS در nginx تمام شود (توصیهٔ نصب پیش‌فرض)"
  say "  2) صدور خودکار — خودِ پنل HTTPS سرو کند (سریال و کلید فعالسازی و مسیر سرتیفکت در پنل)"
  say "  3) تمدید گواهی‌های موجود + نصب قلاب تمدید خودکار"
  say "  4) خودم مسیر دو فایل گواهی را می‌دهم"
  say "  5) گواهی پنل را بردار (برگشت به HTTP پشت nginx)"
  say "  0) بازگشت"
  printf '  انتخاب: '
  local ch; read -r ch || true
  case "${ch:-}" in
    1) ssl_via_nginx "$d" ;;
    2) ssl_on_panel "$d" ;;
    3) install_cert_hook "$d"; renew_ssl ;;
    4) ssl_take_paths ;;
    5) ssl_remove "$d" ;;
    *) return 0 ;;
  esac
  pause
}

ssl_status_show() {
  local site cert info end days pair
  site="$(nginx_site)"
  cert="$(cert_file_for "$site")"
  [ -n "$cert" ] || cert="/etc/letsencrypt/live/$(domain_only)/fullchain.pem"
  info="$(cert_expiry "$cert")"
  if [ -n "$info" ]; then
    end="${info%%|*}"; days="${info##*|}"
    say "  گواهی فعال   : $cert"
    say "  معتبر تا     : ${end} — ${days} روز مانده"
    [ "$days" -lt 0 ] 2>/dev/null && err "    گواهی منقضی شده است!"
    [ "$days" -ge 0 ] 2>/dev/null && [ "$days" -lt 14 ] 2>/dev/null && warn "    کمتر از ۱۴ روز؛ گزینهٔ ۳."
  else
    say "  گواهی فعال   : هیچ (سرویس روی HTTP است)"
  fi
  pair="$(cli ssl get 2>/dev/null)"
  if [ -n "$pair" ]; then
    say "  پنل خودش HTTPS سرو می‌کند:"
    printf '%s\n' "$pair" | sed 's/^/    /'
  else
    say "  پنل: مسیر گواهی ندارد — اگر nginx گواهی دارد، TLS همان‌جا تمام می‌شود (حالت عادی)."
  fi
  if [ -x /usr/bin/certbot ] || command -v certbot >/dev/null 2>&1; then
    say "  certbot      : نصب است"
  else
    say "  certbot      : نصب نیست (در اولین صدور خودکار نصب می‌شود)"
  fi
}

ssl_email_ask() {
  SSL_EMAIL="$(awk -F= '$1=="SC_SSL_EMAIL"{print $2}' "$MENU_ENV" 2>/dev/null)"
  if [ -z "$SSL_EMAIL" ]; then
    printf "  ایمیل برای Let's Encrypt: "
    read -r SSL_EMAIL || true
    SSL_EMAIL="${SSL_EMAIL//[[:space:]]/}"
    [ -n "$SSL_EMAIL" ] || { err "    ایمیل لازم است."; return 1; }
    mkdir -p "$(dirname "$MENU_ENV")"
    printf 'SC_SSL_EMAIL=%s\n' "$SSL_EMAIL" > "$MENU_ENV"
    chmod 600 "$MENU_ENV"
  fi
  return 0
}

ensure_certbot() {
  command -v certbot >/dev/null 2>&1 && return 0
  warn "  certbot نصب نیست؛ از مخزن توزیع نصب می‌شود..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y --no-install-recommends certbot python3-certbot-nginx >/dev/null \
      || { err "    نصب certbot ناموفق بود."; return 1; }
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot python3-certbot-nginx >/dev/null || { err "    نصب certbot ناموفق بود."; return 1; }
  else
    err "    مدیر بسته‌ای نشناختم؛ certbot را خودتان نصب کنید."
    return 1
  fi
  command -v certbot >/dev/null 2>&1 || { err "    certbot نصب شد اما در PATH نیست."; return 1; }
  ok "    certbot نصب شد."
}

ssl_data_dir() { local d; d="$(env_get DATA_DIR)"; printf '%s' "${d:-/var/lib/sulduzcloud}"; }

# The unprivileged service user can never read /etc/letsencrypt/live/*/privkey.pem
# (root 600 by design), so a certificate the panel serves itself has to be copied
# somewhere the panel owns. 640 + group sulduz is the smallest door that works.
ssl_install_pair() { # domain
  local d="$1" dir live out
  SSL_PAIR_DIR=""
  dir="$(ssl_data_dir)/ssl/$d"; live="/etc/letsencrypt/live/$d"
  [ -f "$live/fullchain.pem" ] && [ -f "$live/privkey.pem" ] || { err "    گواهی $live پیدا نشد؛ اول آن را صادر کنید."; return 1; }
  mkdir -p "$dir"
  cp -f "$live/fullchain.pem" "$dir/fullchain.pem"
  cp -f "$live/privkey.pem" "$dir/privkey.pem"
  if id -u sulduz >/dev/null 2>&1; then chown -R sulduz:sulduz "$dir" 2>/dev/null || true; fi
  chmod 750 "$dir" 2>/dev/null || true
  chmod 644 "$dir/fullchain.pem" 2>/dev/null || true
  chmod 640 "$dir/privkey.pem" 2>/dev/null || true
  if ! out="$(cli ssl set --cert "$dir/fullchain.pem" --key "$dir/privkey.pem" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    err "    پنل این جفت گواهی را نپذیرفت."
    return 1
  fi
  printf '%s\n' "$out" | sed 's/^/    /'
  SSL_PAIR_DIR="$dir"
  return 0
}

# certbot runs its deploy hooks for EVERY renewed certificate. The guard on
# RENEWED_LINEAGE keeps a second domain on this box from restarting our panel.
install_cert_hook() { # domain
  local d="$1" hook dir
  hook="/etc/letsencrypt/renewal-hooks/deploy/sulduzcloud.sh"
  dir="$(ssl_data_dir)/ssl/$d"
  [ -n "$d" ] || { err "  دامنه‌ای تنظیم نیست؛ قلاب تمدید لازم نیست."; return 1; }
  mkdir -p "$(dirname "$hook")"
  cat > "$hook" <<HOOK_EOF
#!/usr/bin/env bash
# Installed by the Sulduz Cloud server menu (item 5). Runs as root after certbot
# renews a certificate. It only acts when THAT certificate is the one this panel
# was told to serve, so a second domain on this box never restarts anything.
# If the panel has no certificate paths, TLS ends at nginx and there is nothing
# for the panel to take.
set -u
DOMAIN="$d"
APP_DIR="$APP_DIR"
DIR="$dir"
LIVE="/etc/letsencrypt/live/\$DOMAIN"
[ -n "\${RENEWED_LINEAGE:-}" ] && [ "\$RENEWED_LINEAGE" != "\$LIVE" ] && exit 0
[ -f "\$LIVE/fullchain.pem" ] || exit 0
CLI="\$APP_DIR/server/scripts/admin-cli.js"
PAIR=""
if [ -f "\$CLI" ]; then
  if id -u sulduz >/dev/null 2>&1; then
    PAIR="\$(runuser -u sulduz -- node "\$CLI" ssl get 2>/dev/null || true)"
  else
    PAIR="\$(node "\$CLI" ssl get 2>/dev/null || true)"
  fi
fi
[ -n "\$PAIR" ] || exit 0
mkdir -p "\$DIR"
cp -f "\$LIVE/fullchain.pem" "\$DIR/fullchain.pem"
cp -f "\$LIVE/privkey.pem" "\$DIR/privkey.pem"
if id -u sulduz >/dev/null 2>&1; then chown -R sulduz:sulduz "\$DIR" 2>/dev/null || true; fi
chmod 644 "\$DIR/fullchain.pem" 2>/dev/null || true
chmod 640 "\$DIR/privkey.pem" 2>/dev/null || true
systemctl restart "$SERVICE" 2>/dev/null || true
echo "[sulduzcloud] renewal hook: certificate copied into \$DIR and the panel restarted"
HOOK_EOF
  chmod 755 "$hook"
  ok "  قلاب تمدید نصب شد: $hook"
  say "  هر تمدید خودکار certbot، گواهی تازه را به پنل می‌دهد و فقط سرویس $SERVICE را ری‌استارت می‌کند."
}

renew_ssl() {
  ensure_certbot || return 1
  say "  در حال تمدید (اگر زمانش نرسیده باشد certbot کاری نمی‌کند)..."
  certbot renew --quiet --non-interactive 2>&1 | sed 's/^/    /'
  ssl_status_show
}

# Where TLS ends decides everything else, so both paths say it out loud.
ssl_via_nginx() { # domain
  local d="$1"
  ensure_certbot || return 1
  ssl_email_ask || return 1
  [ -n "$(nginx_site)" ] || { err "  سایت nginx پیدا نشد؛ گواهی با --nginx ممکن نیست. از گزینهٔ ۲ یا نصب nginx استفاده کنید."; return 1; }
  local xui_before; xui_before="$(xui_pid)"
  say "  certbot --nginx: گواهی می‌گیرد، پورت ۸۰ را به ۴۴۳ تبدیل می‌کند و nginx را بازمی‌خواند."
  certbot --nginx -d "$d" --redirect --non-interactive --agree-tos -m "$SSL_EMAIL" 2>&1 | sed 's/^/    /'
  if [ ! -f "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
    err "  گواهی ساخته نشد؛ تنظیمات پنل دست‌نخورده ماند. DNS دامنه و باز بودن پورت ۸۰ را بررسی کنید."
    return 1
  fi
  # nginx holds TLS now: the panel must not be holding half a pair.
  cli ssl clear >/dev/null 2>&1
  set_domain "$d" https
  xui_guard "$xui_before" "$(xui_pid)" "پس از صدور گواهی"
  ok "  https://$d آماده است (TLS در nginx)."
}

ssl_on_panel() { # domain
  local d="$1" email site
  ensure_certbot || return 1
  ssl_email_ask || return 1
  email="$SSL_EMAIL"
  if [ -f "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
    say "  گواهی $d از قبل روی سرور هست؛ همان کپی می‌شود."
  else
    [ -n "$(nginx_site)" ] || { err "  نه گواهی هست نه nginx؛ certbot راهی برای صدور ندارد."; return 1; }
    say "  certbot فقط گواهی می‌گیرد (certonly) و به nginx دست نمی‌زند."
    certbot certonly --nginx -d "$d" --non-interactive --agree-tos -m "$email" 2>&1 | sed 's/^/    /' || true
  fi
  ssl_install_pair "$d" || return 1
  install_cert_hook "$d"
  # The panel now speaks TLS on its own port, so nginx has to stop talking plain
  # HTTP to it — otherwise the domain goes dark exactly when this succeeds.
  site="$(nginx_site)"
  if [ -n "$site" ] && [ -f "$site" ]; then
    warn "  nginx در این نصب به پنل proxy_pass می‌کند؛ آن را به https سوییچ می‌کنم."
    nginx_upstream_tls https || warn "  nginx تغییر نکرد؛ اگر آدرس دامنه از کار افتاد: گزینهٔ ۵."
  fi
  local xui_before; xui_before="$(xui_pid)"
  systemctl restart "$SERVICE"
  sleep 3
  local p; p="$(desired_port)"
  if curl -fsSk --max-time 5 "https://127.0.0.1:$p/api/health" >/dev/null 2>&1; then
    ok "  پنل خودش روی پورت $p HTTPS سرو می‌کند."
  else
    err "  پنل روی https پاسخ نداد؛ بازگردانی به HTTP:"
    cli ssl clear >/dev/null 2>&1
    [ -n "$site" ] && nginx_upstream_tls http
    systemctl restart "$SERVICE"; sleep 2
    if [ -n "$(health)" ]; then ok "  پنل روی HTTP بالا آمد."; else err "  پنل بالا نیامد: journalctl -u $SERVICE -n 40"; fi
  fi
  xui_guard "$xui_before" "$(xui_pid)" "پس از گواهی روی پنل"
  [ -n "$SSL_PAIR_DIR" ] && say "  مسیرها: $SSL_PAIR_DIR/fullchain.pem و $SSL_PAIR_DIR/privkey.pem"
}

ssl_take_paths() {
  local c k
  printf '  مسیر کلید عمومی (fullchain، با / شروع شود، خالی = انصراف): '; read -r c || true
  [ -n "${c:-}" ] || return 0
  printf '  مسیر کلید خصوصی (privkey): '; read -r k || true
  [ -n "${k:-}" ] || { err "  هر دو مسیر لازم است."; return 1; }
  cli ssl set --cert "$c" --key "$k" || { err "  پنل این جفت را نپذیرفت."; return 1; }
  local site; site="$(nginx_site)"
  [ -n "$site" ] && [ -f "$site" ] && nginx_upstream_tls https
  systemctl restart "$SERVICE"; sleep 3
  local p; p="$(desired_port)"
  if curl -fsSk --max-time 5 "https://127.0.0.1:$p/api/health" >/dev/null 2>&1; then
    ok "  پنل روی پورت $p با این گواهی HTTPS سرو می‌شود."
  else
    err "  پنل روی https پاسخ نداد؛ مسیرها پاک شد تا سرویس زنده بماند."
    cli ssl clear >/dev/null 2>&1
    [ -n "$site" ] && nginx_upstream_tls http
    systemctl restart "$SERVICE"
  fi
}

ssl_remove() { # domain
  local d="${1:-}"
  printf '  گواهی پنل برداشته شود و برگردد پشت nginx؟ [y/N]: '
  local a; read -r a || true
  [[ "${a:-}" =~ ^[Yy]$ ]] || { say "  بدون تغییر."; return 0; }
  cli ssl clear
  local site; site="$(nginx_site)"
  [ -n "$site" ] && [ -f "$site" ] && nginx_upstream_tls http
  local xui_before; xui_before="$(xui_pid)"
  systemctl restart "$SERVICE"; sleep 2
  if [ -n "$(health)" ]; then ok "  پنل روی HTTP است."; else err "  پنل بالا نیامد: journalctl -u $SERVICE -n 40"; fi
  [ -n "$d" ] && set_domain "$d" "$( [ -f "/etc/letsencrypt/live/$d/fullchain.pem" ] && echo https || echo http )"
  xui_guard "$xui_before" "$(xui_pid)" "پس از برداشتن گواهی"
}

# proxy_pass is the one line that decides whether nginx can reach a TLS panel.
# An unverified https upstream needs proxy_ssl_verify off; — the certificate is
# for the domain, not for 127.0.0.1, so verifying it here could only ever fail.
nginx_upstream_tls() { # https|http
  local want="$1" site port; site="$(nginx_site)"; port="$(panel_port)"
  [ -n "$site" ] && [ -f "$site" ] || return 1
  cp -a "$site" "$site.bak.$(date +%s)"
  if [ "$want" = "https" ]; then
    sed -i -E "s#(proxy_pass[[:space:]]+)http://(127\.0\.0\.1:${port}[;/])#\1https://\2#g" "$site"
    if grep -q "proxy_pass[[:space:]]*https://127" "$site" && ! grep -q "proxy_ssl_verify" "$site"; then
      sed -i -E "/proxy_pass[[:space:]]+https:\/\/127\.0\.0\.1/a\\    proxy_ssl_verify off;" "$site"
    fi
  else
    sed -i -E "s#(proxy_pass[[:space:]]+)https://(127\.0\.0\.1:${port}[;/])#\1http://\2#g" "$site"
  fi
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx && ok "  nginx: proxy_pass روی $want."
    return 0
  fi
  err "  nginx بعد از تغییر معتبر نبود؛ نسخهٔ قبلی برگشت."
  local prev; prev="$(ls -1t "$site.bak."* 2>/dev/null | head -1)"
  if [ -n "$prev" ]; then
    cp -a "$prev" "$site"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
  fi
  return 1
}

page_backup() {
  head1 "بکاپ فوری"
  local out; out="$(backup_now)"
  if [ -n "$out" ]; then
    ok "بکاپ ساخته شد: $out ($(du -h "$out" | cut -f1))"
    say "  همین تابع قبل از آپدیت و قبل از تغییر پورت هم اجرا می‌شود."
  else
    err "بکاپ ناموفق بود — فایل‌های better-sqlite3 و مسیر دیتابیس را بررسی کنید."
  fi
  pause
}

page_net() {
  head1 "شبکهٔ پنل"
  cli net show
  say ""
  say "  پورت زنده: $(live_port || echo نامشخص)"
  say "  برای جابه‌جایی پورت: گزینهٔ ۲ (یا sulduzcloud port)"
  say "  برای HTTPS: گزینهٔ ۵"
  pause
}

# ---------------------------------------------------------------- activate

page_activate() {
  head1 "فعال‌سازی پنل"
  local st; st="$(cli activation show 2>/dev/null)"
  printf '%s\n' "$st"
  say ""
  if printf '%s' "$st" | grep -q 'وضعیت: فعال'; then
    say "  چیزی لازم نیست؛ این نصب فعال است و سریالش دیگر نمایش داده نمی‌شود."
    pause; return 0
  fi
  say "  سریال بالا فقط برای همین نصب است. آن را برای مالک بفرستید و کلید فعالسازیِ"
  say "  همان سریال را بگیرید؛ کلیدهای فعالسازی نه در این سرور و نه در مخزن نگه‌داشته می‌شوند."
  printf '\n  کلید فعالسازی (خالی = انصراف): '
  local k; read -r k || true
  [ -n "${k:-}" ] || { say "  بدون تغییر."; pause; return 0; }
  if cli activation set "$k"; then
    ok "  پنل فعال شد؛ حالا می‌توانید حساب مالک را بسازید."
  else
    err "  این کلید برای این نصب معتبر نبود (شمارش تلاش‌ها در دیتابیس ثبت شد)."
  fi
  pause
}

page_restart() {
  head1 "ری‌استارت پنل"
  say "فقط سرویس $SERVICE ری‌استارت می‌شود؛ x-ui و کاربران دست نمی‌خورند."
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
  say "  $(public_url || echo 'آدرس تنظیم نشده')   |   پورت $(live_port || echo '?')   |   نسخه $(version_shown || echo '?')"
  say "  ------------------------------------------------------------"
  say "  1) update                      آپدیت به آخرین نسخهٔ منتشرشده"
  say "  2) change port panel           تغییر پورت پنل"
  say "  3) reset username/password     بازنشانی نام کاربری و رمز مالک"
  say "  4) view panel login details    نمایش اطلاعات ورود پنل"
  say "  5) automatic ssl               گواهی SSL خودکار (nginx یا خود پنل)"
  say "  6) exit                        خروج"
  say "  ------------------------------------------------------------"
  say "  بیشتر:  sulduzcloud status | domain <host> | net | activate | backup | restart | logs"
  printf '  انتخاب: '
}

main_menu() {
  while true; do
    draw_menu
    local choice; read -r choice || exit 0
    case "${choice:-}" in
      1) page_update ;;
      2) page_port ;;
      3) page_owner ;;
      4) page_details; pause ;;
      5) page_ssl ;;
      6|0|q|Q) exit 0 ;;
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
    details) page_details ;;
    owner|accounts) page_owner ;;
    port)
      if [ -n "${2:-}" ]; then
        if valid_port "$2"; then cli port set "$2" && env_set PORT "$2" && say "بعد از آن sulduzcloud restart"; else err "پورت معتبر نیست."; fi
      else
        page_port
      fi ;;
    update) page_update ;;
    ssl) if [ -n "${2:-}" ]; then ssl_via_nginx "$2"; else page_ssl; fi ;;
    activate) page_activate ;;
    net) page_net ;;
    domain)
      if [ -n "${2:-}" ]; then
        if valid_domain "$2"; then set_domain "$2"; else err "دامنه معتبر نیست."; fi
      else
        page_domain
      fi
      ;;
    backup) page_backup ;;
    restart) page_restart ;;
    logs) page_logs ;;
    ""|-m|menu) main_menu ;;
    *)
      say "استفاده:"
      say "  sulduzcloud                 منوی ۶ گزینه‌ای"
      say "  sulduzcloud update | port <n> | owner | details | ssl [domain]"
      say "  sulduzcloud status | net | activate | domain <host> | backup | restart | logs"
      ;;
  esac
}

main "$@"
