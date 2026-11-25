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
pause() { printf '\n'; read -rp "Press Enter to go back..." _ || true; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then exec sudo -- "$0" "$@"; fi
    err "This menu must run as root."
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
  if systemctl is-active --quiet "$SERVICE"; then ok "panel (${SERVICE}): active"; else err "panel (${SERVICE}): inactive"; fi
  local active_since
  active_since="$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null)"
  [ -n "$active_since" ] && say "  since: $active_since"
}

xui_pid() { systemctl show -p MainPID --value x-ui 2>/dev/null; }

xui_state() {
  local pid; pid="$(xui_pid)"
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    say "  x-ui: active, pid $pid (this menu never changes it)"
  else
    say "  x-ui: inactive, or not installed on this server (it may run on another one)"
  fi
}

# Printed after every item that restarts services. Same pid in and out is the
# proof; anything else is said out loud instead of hidden.
xui_guard() { # before after label
  if [ "${1:-}" = "${2:-}" ]; then
    say "  x-ui untouched: pid ${2:-0} ($3)"
  else
    warn "  the x-ui pid changed (${1:-0} -> ${2:-0}) — this menu did not change it; please check."
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
  head1 "1) Update panel"
  local now latest
  now="$(version_shown)"
  say "  running version: ${now:-unknown (the panel is not answering)}"
  say "  repository: $REPO_SLUG"
  say "  install path: $APP_DIR"
  printf '\n  reading the latest published version...'
  latest="$(latest_release_tag)"
  if [ -z "$latest" ]; then
    err "  the latest version could not be read from GitHub (network, DNS or rate limit)."
    say "  the manual way is the same one-command install link:"
    say "    curl -fsSL https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh | sudo bash"
    pause; return 1
  fi
  say "  latest published version: $latest"
  if [ -n "$now" ] && [ "v$now" = "$latest" ]; then
    ok "  the panel is up to date (same version)."
    pause; return 0
  fi
  say ""
  say "  Update = reinstall the same published release: the files and the web build change."
  say "  The database, the panel settings and your .env file stay untouched (the installer"
  say "  explicitly keeps .env and deletes no data)."
  printf '\n  Continue? [y/N]: '
  local a; read -r a || true
  [[ "${a:-}" =~ ^[Yy]$ ]] || { say "  Left without changes."; return 0; }

  local bkp; bkp="$(backup_now)"
  if [ -n "$bkp" ]; then ok "  database backup: $bkp"; else warn "  no backup was made; continuing is at your own risk."; fi
  local xui_before; xui_before="$(xui_pid)"

  local dom port flag_domain=""
  dom="$(domain_only)"; port="$(desired_port)"
  valid_domain "$dom" && flag_domain="--domain $dom"

  local script; script="$(mktemp /tmp/sc-install-XXXXXX.sh)"
  if ! curl -fsSL --max-time 40 "https://raw.githubusercontent.com/$REPO_SLUG/main/install.sh" -o "$script"; then
    err "  downloading install.sh failed."; rm -f "$script"; pause; return 1
  fi
  say "  updating (the web build takes a few minutes)..."
  # --non-interactive: the menu already collected what the installer would ask.
  if bash "$script" --non-interactive --dir "$APP_DIR" --port "$port" $flag_domain; then
    ok "  update finished."
  else
    err "  the update ended with an error. Panel status:"
    journalctl -u "$SERVICE" -n 25 --no-pager
  fi
  rm -f "$script"

  sleep 2
  xui_guard "$xui_before" "$(xui_pid)" "after update"
  local h; h="$(health)"
  if [ -n "$h" ]; then
    ok "  the panel is up: $h"
    say "  If the browser still shows the old version: Ctrl+F5 (that is the browser cache, not the server)."
  else
    err "  the panel did not come up: journalctl -u $SERVICE -n 40"
  fi
  pause
}

# ---------------------------------------------------------------- 2) change port

page_port() {
  head1 "2) Change panel port"
  local live want envp
  live="$(live_port || true)"; want="$(desired_port)"; envp="$(panel_port)"
  say "  port the panel is listening on right now: ${live:-unknown (is the service up?)}"
  say "  port stored in the panel settings:    ${want:-(empty)}"
  say "  port in the .env file:                ${envp}"
  say ""
  say "  This changes all three at once; if only one of them changes, src/net.js prefers"
  say "  the number stored in the settings and the old port comes back."
  say ""
  say "  Note: if you open the panel through a domain and nginx, your browser address has no port;"
  say "  this moves the internal port and nginx is repointed to the same number."
  printf '\n  new port (1024 to 65535, empty = cancel): '
  local p; read -r p || true
  p="${p//[^0-9]/}"
  [ -z "$p" ] && return 0
  if ! valid_port "$p"; then err "  invalid port (between 1024 and 65535)."; pause; return 1; fi
  if [ "$p" = "${live:-$envp}" ]; then
    warn "  the panel is already on $p; nothing changed."; pause; return 0
  fi
  if ! port_free "$p"; then
    err "  port $p is not free on this server:"
    ss -ltnp "sport = :$p" 2>/dev/null | sed -n '2,5p' | sed 's/^/    /'
    say "  free that service and come back — the panel was not moved."
    pause; return 1
  fi
  if [ "$p" -ge 2000 ] && [ "$p" -le 2100 ]; then
    warn "  this number is inside the usual x-ui port range; it may collide later."
  fi

  local xui_before; xui_before="$(xui_pid)"
  local bkp; bkp="$(backup_now)"
  [ -n "$bkp" ] && say "  database backup: $bkp"

  # 1) the stored setting — the number src/net.js reads first.
  if ! cli port set "$p"; then
    err "  saving the port in the panel settings failed; the panel was not moved."
    pause; return 1
  fi
  # 2) .env — what systemd hands the service, and what the installer reads later.
  env_set PORT "$p"
  say "  PORT=$p was written to $ENV_FILE."

  # 3) nginx — the site that proxies to the OLD port has to follow.
  local site old; site="$(nginx_site)"; old="$envp"
  if [ -n "$site" ] && [ -f "$site" ]; then
    cp -a "$site" "$site.bak.$(date +%s)"
    sed -i -E "s#127\.0\.0\.1:${old}([^0-9]|$)#127.0.0.1:${p}\1#g" "$site"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && ok "  nginx repointed to port $p ($site)."
    else
      err "  nginx is not valid after the port change; the previous version was restored:"
      local prev; prev="$(ls -1t "$site.bak."* 2>/dev/null | head -1)"
      [ -n "$prev" ] && cp -a "$prev" "$site" && nginx -t >/dev/null 2>&1 && systemctl reload nginx
      warn "  the panel is on $p but nginx still points at $old; please check it by hand."
    fi
  else
    warn "  no nginx site referencing port $old was found; only the panel settings and .env changed."
  fi

  systemctl restart "$SERVICE"
  sleep 3
  if [ -n "$(health_on "$p")" ]; then
    ok "  the panel came up on port $p."
  else
    err "  the panel did not answer on $p; rolling back to $old:"
    cli port set "$old" >/dev/null; env_set PORT "$old"
    [ -n "$site" ] && sed -i -E "s#127\.0\.0\.1:${p}([^0-9]|$)#127.0.0.1:${old}\1#g" "$site"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    systemctl restart "$SERVICE"; sleep 2
    if [ -n "$(health_on "$old")" ]; then
      ok "  the panel is back on $old and working."
      warn "  if you edited the site file by hand, nginx may not have stayed on $old."
    else
      err "  the panel did not come up even on $old: journalctl -u $SERVICE -n 40"
    fi
  fi
  xui_guard "$xui_before" "$(xui_pid)" "after the port change"
  pause
}

# ---------------------------------------------------------------- pages

page_status() {
  head1 "Panel status"
  service_state
  local h; h="$(health)"
  if [ -n "$h" ]; then ok "  health: $h"; else err "  health: no answer"; fi
  say "  public address: $(public_url || true)"
  say "  live port:   $(live_port || echo unknown)    (wanted: $(desired_port) | in .env: $(panel_port))"
  say "  database: $(env_get DATA_DIR || echo /var/lib/sulduzcloud)/panel.db"
  local xui; xui="$(as_sulduz node -e '
    try {
      const s = require(process.argv[1] + "/server/src/settings");
      const x = s.getSetting ? s.getSetting("xui") : null;
      // Never print the panel path or the API token; host:port is enough here.
      if (x && x.url) process.stdout.write(String(x.url).replace(/^(https?:\/\/[^/]+).*$/, "$1") + "/…");
    } catch (_) {}
  ' "$APP_DIR" 2>/dev/null)"
  [ -n "$xui" ] && say "  x-ui connected: $xui"
  xui_state
  say "  activation:"
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
  head1 "4) Panel login details"
  local live want
  live="$(live_port || true)"; want="$(desired_port)"
  say "  browser address : $(public_url || echo 'not set — set it with the domain or ssl option')"
  say "  live port       : ${live:-unknown (is the service up?)}"
  say "  wanted port     : ${want:-unknown}    (in .env: $(panel_port))"
  say "  service         : $SERVICE  —  $(systemctl is-active "$SERVICE" 2>/dev/null || echo '?')"
  say "  panel version   : $(version_shown || echo unknown)"
  say ""
  local admins; admins="$(admin_list)"
  if [ -z "$admins" ]; then
    warn "  no admin account exists yet."
    say "  Open the panel in a browser; the first page creates the owner account."
    say "  If that page did not open: sulduzcloud net   and   sulduzcloud logs"
  else
    say "  admin accounts (username / status / created):"
    printf '%s\n' "$admins" | while IFS= read -r line; do [ -n "$line" ] && say "    $line"; done
  fi
  say ""
  if [ -f "$CRED_FILE" ]; then
    local u p t
    u="$(cred_get ADMIN_USER)"; p="$(cred_get ADMIN_PASS)"; t="$(cred_get ADMIN_SET)"
    say "  username stored in this menu : $u"
    say "  password                     : $p"
    say "  last set from this menu      : $t"
    warn "  if you changed the password inside the web panel, this value is old; use option 3."
  else
    say "  password: not showable — passwords are hashed and cannot be recovered."
    say "  Option 3 can create a new password (it is shown once and stored on this"
    say "  server in $CRED_FILE)."
  fi
  say ""
  say "  activation:"
  cli activation show 2>/dev/null | sed 's/^/    /'
  say ""
  say "  network:"
  cli net show 2>/dev/null | sed 's/^/    /'
  say ""
  say "  database: $(env_get DATA_DIR || echo /var/lib/sulduzcloud)/panel.db"
  say "  password file: $CRED_FILE (root only)"
}

# ---------------------------------------------------------------- 3) owner account

set_admin_password() { # username [password]
  local u="$1" pw="${2:-}" out
  if [ -n "$pw" ]; then
    cli reset "$u" --password "$pw" >/dev/null \
      || { err "  changing the password failed."; return 1; }
  else
    out="$(cli reset "$u")" || { err "  changing the password failed."; return 1; }
    pw="$(printf '%s\n' "$out" | sed -n 's/^  New password: //p')"
  fi
  [ -n "$pw" ] || { err "  no new password was created."; return 1; }
  cred_save "$u" "$pw"
  say ""
  say "  username   : $u"
  ok "  new password : $pw"
  warn "  this password was stored in $CRED_FILE (mode 600, root only) so this menu can show it again."
  say "  Open browser sessions stop working with the old password; that is the correct behaviour."
  return 0
}

rename_owner() { # current-name
  local cur="$1" next
  RENAME_RESULT=""
  printf '\n  new username (3 to 32 english letters, digits, . _ -, empty = cancel): '
  read -r next || true
  next="${next//[^A-Za-z0-9._-]/}"
  [ -n "$next" ] || { say "  No change."; return 0; }
  local out
  if ! out="$(cli rename "$cur" "$next" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/  /'
    warn "  the username did not change."
    return 1
  fi
  printf '%s\n' "$out" | sed 's/^/  /'
  RENAME_RESULT="$next"
  # The credential file is keyed by the name the owner types in the login box, so
  # it follows the account; an old name left in it would show a password that no
  # longer logs anybody in.
  if [ -f "$CRED_FILE" ]; then
    local p; p="$(cred_get ADMIN_PASS)"
    if [ -n "$p" ]; then cred_save "$next" "$p"; say "  $CRED_FILE was updated to the new name too."
    else say "  (there was no password in the file; nothing to update.)"; fi
  fi
  return 0
}

page_owner() {
  head1 "3) Reset owner username and password"
  local first; first="$(owner_name)"
  if [ -z "$first" ]; then
    warn "  this panel has no admin account."
    say "  If you have just installed it, open the panel in a browser so the first-run page appears."
    say "  If you are sure the panel is running: sulduzcloud status"
    pause; return 1
  fi
  say "  current owner account: $first"
  local admins; admins="$(admin_list)"
  if [ -n "$admins" ] && [ "$(printf '%s\n' "$admins" | awk 'NF' | wc -l)" -gt 1 ]; then
    warn "  there are several admin accounts; this menu works on $first."
    printf '%s\n' "$admins" | sed 's/^/    /'
  fi
  say ""
  say "  1) Change the password"
  say "  2) Change the username"
  say "  3) Both (when you have lost full access)"
  say "  0) Back"
  printf '  choice: '
  local ch; read -r ch || true
  case "${ch:-}" in
    1)
      printf '  generate the password automatically? [Y/n]: '
      local auto; read -r auto || true
      if [[ "${auto:-Y}" =~ ^[Nn]$ ]]; then
        local pw; printf '  new password (at least 8 characters): '; read -rs pw || true; printf '\n'
        [ ${#pw} -ge 8 ] || { err "  too short."; pause; return 1; }
        set_admin_password "$first" "$pw"
      else
        set_admin_password "$first"
      fi
      ;;
    2) rename_owner "$first" ;;
    3)
      if rename_owner "$first"; then
        local who="${RENAME_RESULT:-$first}"
        printf '\n  now the password of account %s:\n' "$who"
        set_admin_password "$who"
      fi
      ;;
    *) return 0 ;;
  esac
  pause
}

page_domain() {
  head1 "Set domain"
  say "Current address: $(public_url || true)"
  say "Before this, point the domain A record to this server IP."
  printf '\nnew domain (for example panel.example.com, empty = cancel): '
  local d; read -r d || true
  [ -z "${d:-}" ] && return
  if ! valid_domain "$d"; then err "invalid domain."; pause; return; fi
  set_domain "$d"
  pause
}

set_domain() { # host [scheme]
  local d="$1" scheme="${2:-}"
  [ -n "$scheme" ] || { if [ -f "/etc/letsencrypt/live/$d/cert.pem" ]; then scheme="https"; else scheme="http"; fi; }
  env_set PUBLIC_URL "$scheme://$d"
  ok "PUBLIC_URL was set to $scheme://$d."
  # .env is the boot-time fallback; the stored setting is what src/net.js and every
  # subscribe link actually read, so a domain change that skips it is a no-op the
  # next time the browser asks for a link.
  if cli url set "$scheme://$d" >/dev/null 2>&1; then
    ok "the public address was written to the panel settings too: $scheme://$d."
  else
    warn "the public address could not be written to the panel settings (CLI error); check it in the web panel."
  fi
  local site; site="$(nginx_site)"
  if [ -n "$site" ] && [ -f "$site" ]; then
    cp -a "$site" "$site.bak.$(date +%s)"
    sed -i -E "s/server_name[[:space:]]+[^;]+;/server_name $d;/g" "$site"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && ok "nginx was updated ($site)."
    else
      err "nginx -t failed; no reload happened (previous version: $site.bak.*)."
      nginx -t || true
      return 1
    fi
  else
    warn "no nginx site file was found (installed with --no-nginx) — only .env changed."
  fi
  systemctl restart "$SERVICE"
  sleep 2
  if [ -n "$(health)" ]; then ok "the panel came up with the new domain."; else err "the panel did not come up: journalctl -u $SERVICE -n 50"; fi
}

page_ssl() {
  head1 "5) Automatic SSL certificate"
  local d; d="$(domain_only)"
  if [ -z "$d" ]; then
    say "  no domain is set yet, and a Let's Encrypt certificate makes no sense without one."
    printf '  domain (for example panel.example.com, empty = cancel): '
    read -r d || true
    d="${d//[^A-Za-z0-9.-]/}"
    [ -n "$d" ] || return 0
    valid_domain "$d" || { err "  invalid domain."; pause; return 1; }
    say "  the domain A record must point to this server IP."
    set_domain "$d" https
    pause; return 0
  fi
  say "  domain: $d"
  ssl_status_show
  say ""
  say "  1) Automatic Let's Encrypt issue/renew — TLS ends at nginx (recommended, default install)"
  say "  2) Automatic issue — the panel itself serves HTTPS (serial, activation key and cert paths in the panel)"
  say "  3) Renew existing certificates + install the automatic renewal hook"
  say "  4) I will give the paths of the two certificate files myself"
  say "  5) Remove the panel certificate (back to HTTP behind nginx)"
  say "  0) Back"
  printf '  choice: '
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
    say "  active certificate : $cert"
    say "  valid until        : ${end} — ${days} days left"
    [ "$days" -lt 0 ] 2>/dev/null && err "    the certificate has expired!"
    [ "$days" -ge 0 ] 2>/dev/null && [ "$days" -lt 14 ] 2>/dev/null && warn "    fewer than 14 days left; use option 3."
  else
    say "  active certificate : none (the service is on HTTP)"
  fi
  pair="$(cli ssl get 2>/dev/null)"
  if [ -n "$pair" ]; then
    say "  the panel serves HTTPS itself:"
    printf '%s\n' "$pair" | sed 's/^/    /'
  else
    say "  panel: no certificate path — if nginx has a certificate, TLS ends there (the normal case)."
  fi
  if [ -x /usr/bin/certbot ] || command -v certbot >/dev/null 2>&1; then
    say "  certbot      : installed"
  else
    say "  certbot      : not installed (it is installed on the first automatic issue)"
  fi
}

ssl_email_ask() {
  SSL_EMAIL="$(awk -F= '$1=="SC_SSL_EMAIL"{print $2}' "$MENU_ENV" 2>/dev/null)"
  if [ -z "$SSL_EMAIL" ]; then
    printf "  email for Let's Encrypt: "
    read -r SSL_EMAIL || true
    SSL_EMAIL="${SSL_EMAIL//[[:space:]]/}"
    [ -n "$SSL_EMAIL" ] || { err "    an email is required."; return 1; }
    mkdir -p "$(dirname "$MENU_ENV")"
    printf 'SC_SSL_EMAIL=%s\n' "$SSL_EMAIL" > "$MENU_ENV"
    chmod 600 "$MENU_ENV"
  fi
  return 0
}

ensure_certbot() {
  command -v certbot >/dev/null 2>&1 && return 0
  warn "  certbot is not installed; installing it from the distribution repository..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y --no-install-recommends certbot python3-certbot-nginx >/dev/null \
      || { err "    installing certbot failed."; return 1; }
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot python3-certbot-nginx >/dev/null || { err "    installing certbot failed."; return 1; }
  else
    err "    I did not recognise a package manager; install certbot yourself."
    return 1
  fi
  command -v certbot >/dev/null 2>&1 || { err "    certbot was installed but is not in PATH."; return 1; }
  ok "    certbot installed."
}

ssl_data_dir() { local d; d="$(env_get DATA_DIR)"; printf '%s' "${d:-/var/lib/sulduzcloud}"; }

# The unprivileged service user can never read /etc/letsencrypt/live/*/privkey.pem
# (root 600 by design), so a certificate the panel serves itself has to be copied
# somewhere the panel owns. 640 + group sulduz is the smallest door that works.
ssl_install_pair() { # domain
  local d="$1" dir live out
  SSL_PAIR_DIR=""
  dir="$(ssl_data_dir)/ssl/$d"; live="/etc/letsencrypt/live/$d"
  [ -f "$live/fullchain.pem" ] && [ -f "$live/privkey.pem" ] || { err "    certificate $live not found; issue it first."; return 1; }
  mkdir -p "$dir"
  cp -f "$live/fullchain.pem" "$dir/fullchain.pem"
  cp -f "$live/privkey.pem" "$dir/privkey.pem"
  if id -u sulduz >/dev/null 2>&1; then chown -R sulduz:sulduz "$dir" 2>/dev/null || true; fi
  chmod 750 "$dir" 2>/dev/null || true
  chmod 644 "$dir/fullchain.pem" 2>/dev/null || true
  chmod 640 "$dir/privkey.pem" 2>/dev/null || true
  if ! out="$(cli ssl set --cert "$dir/fullchain.pem" --key "$dir/privkey.pem" 2>&1)"; then
    printf '%s\n' "$out" | sed 's/^/    /' >&2
    err "    the panel did not accept this certificate pair."
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
  [ -n "$d" ] || { err "  no domain is set; the renewal hook is not needed."; return 1; }
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
  ok "  renewal hook installed: $hook"
  say "  every automatic certbot renewal now hands the new certificate to the panel and restarts only $SERVICE."
}

renew_ssl() {
  ensure_certbot || return 1
  say "  renewing (certbot does nothing if the certificate is not due yet)..."
  certbot renew --quiet --non-interactive 2>&1 | sed 's/^/    /'
  ssl_status_show
}

# Where TLS ends decides everything else, so both paths say it out loud.
ssl_via_nginx() { # domain
  local d="$1"
  ensure_certbot || return 1
  ssl_email_ask || return 1
  [ -n "$(nginx_site)" ] || { err "  no nginx site was found; a certificate with --nginx is not possible. Use option 2 or install nginx."; return 1; }
  local xui_before; xui_before="$(xui_pid)"
  say "  certbot --nginx: gets the certificate, turns port 80 into 443 and reloads nginx."
  certbot --nginx -d "$d" --redirect --non-interactive --agree-tos -m "$SSL_EMAIL" 2>&1 | sed 's/^/    /'
  if [ ! -f "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
    err "  no certificate was created; the panel settings stayed untouched. Check the domain DNS and that port 80 is open."
    return 1
  fi
  # nginx holds TLS now: the panel must not be holding half a pair.
  cli ssl clear >/dev/null 2>&1
  set_domain "$d" https
  xui_guard "$xui_before" "$(xui_pid)" "after issuing the certificate"
  ok "  https://$d is ready (TLS ends at nginx)."
}

ssl_on_panel() { # domain
  local d="$1" email site
  ensure_certbot || return 1
  ssl_email_ask || return 1
  email="$SSL_EMAIL"
  if [ -f "/etc/letsencrypt/live/$d/fullchain.pem" ]; then
    say "  the certificate of $d is already on the server; the same one is copied."
  else
    [ -n "$(nginx_site)" ] || { err "  there is neither a certificate nor nginx; certbot has no way to issue one."; return 1; }
    say "  certbot only gets the certificate (certonly) and does not touch nginx."
    certbot certonly --nginx -d "$d" --non-interactive --agree-tos -m "$email" 2>&1 | sed 's/^/    /' || true
  fi
  ssl_install_pair "$d" || return 1
  install_cert_hook "$d"
  # The panel now speaks TLS on its own port, so nginx has to stop talking plain
  # HTTP to it — otherwise the domain goes dark exactly when this succeeds.
  site="$(nginx_site)"
  if [ -n "$site" ] && [ -f "$site" ]; then
    warn "  nginx in this install proxy_passes to the panel; switching it to https."
    nginx_upstream_tls https || warn "  nginx did not change; if the domain address stops working: option 5."
  fi
  local xui_before; xui_before="$(xui_pid)"
  systemctl restart "$SERVICE"
  sleep 3
  local p; p="$(desired_port)"
  if curl -fsSk --max-time 5 "https://127.0.0.1:$p/api/health" >/dev/null 2>&1; then
    ok "  the panel itself serves HTTPS on port $p."
  else
    err "  the panel did not answer on https; rolling back to HTTP:"
    cli ssl clear >/dev/null 2>&1
    [ -n "$site" ] && nginx_upstream_tls http
    systemctl restart "$SERVICE"; sleep 2
    if [ -n "$(health)" ]; then ok "  the panel came up on HTTP."; else err "  the panel did not come up: journalctl -u $SERVICE -n 40"; fi
  fi
  xui_guard "$xui_before" "$(xui_pid)" "after moving the certificate to the panel"
  [ -n "$SSL_PAIR_DIR" ] && say "  paths: $SSL_PAIR_DIR/fullchain.pem and $SSL_PAIR_DIR/privkey.pem"
}

ssl_take_paths() {
  local c k
  printf '  public key path (fullchain, must start with /, empty = cancel): '; read -r c || true
  [ -n "${c:-}" ] || return 0
  printf '  private key path (privkey): '; read -r k || true
  [ -n "${k:-}" ] || { err "  both paths are required."; return 1; }
  cli ssl set --cert "$c" --key "$k" || { err "  the panel did not accept this pair."; return 1; }
  local site; site="$(nginx_site)"
  [ -n "$site" ] && [ -f "$site" ] && nginx_upstream_tls https
  systemctl restart "$SERVICE"; sleep 3
  local p; p="$(desired_port)"
  if curl -fsSk --max-time 5 "https://127.0.0.1:$p/api/health" >/dev/null 2>&1; then
    ok "  the panel is served over HTTPS on port $p with this certificate."
  else
    err "  the panel did not answer on https; the paths were cleared so the service stays alive."
    cli ssl clear >/dev/null 2>&1
    [ -n "$site" ] && nginx_upstream_tls http
    systemctl restart "$SERVICE"
  fi
}

ssl_remove() { # domain
  local d="${1:-}"
  printf '  remove the panel certificate and go back behind nginx? [y/N]: '
  local a; read -r a || true
  [[ "${a:-}" =~ ^[Yy]$ ]] || { say "  No change."; return 0; }
  cli ssl clear
  local site; site="$(nginx_site)"
  [ -n "$site" ] && [ -f "$site" ] && nginx_upstream_tls http
  local xui_before; xui_before="$(xui_pid)"
  systemctl restart "$SERVICE"; sleep 2
  if [ -n "$(health)" ]; then ok "  the panel is on HTTP."; else err "  the panel did not come up: journalctl -u $SERVICE -n 40"; fi
  [ -n "$d" ] && set_domain "$d" "$( [ -f "/etc/letsencrypt/live/$d/fullchain.pem" ] && echo https || echo http )"
  xui_guard "$xui_before" "$(xui_pid)" "after removing the certificate"
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
    systemctl reload nginx && ok "  nginx: proxy_pass on $want."
    return 0
  fi
  err "  nginx was not valid after the change; the previous version was restored."
  local prev; prev="$(ls -1t "$site.bak."* 2>/dev/null | head -1)"
  if [ -n "$prev" ]; then
    cp -a "$prev" "$site"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
  fi
  return 1
}

page_backup() {
  head1 "Backup now"
  local out; out="$(backup_now)"
  if [ -n "$out" ]; then
    ok "backup created: $out ($(du -h "$out" | cut -f1))"
    say "  the same function runs before an update and before a port change."
  else
    err "backup failed — check the better-sqlite3 files and the database path."
  fi
  pause
}

page_net() {
  head1 "Panel network"
  cli net show
  say ""
  say "  live port: $(live_port || echo unknown)"
  say "  to move the port: option 2 (or sulduzcloud port)"
  say "  for HTTPS: option 5"
  pause
}

# ---------------------------------------------------------------- activate

page_activate() {
  head1 "Panel activation"
  local st; st="$(cli activation show 2>/dev/null)"
  printf '%s\n' "$st"
  say ""
  if printf '%s' "$st" | grep -q 'status: active'; then
    say "  nothing is needed; this install is activated and its serial is not shown again."
    pause; return 0
  fi
  say "  The serial above belongs to this install only. Send it to the owner and get the"
  say "  activation key of that serial; activation keys are stored neither on this server nor in the repository."
  printf '\n  activation key (empty = cancel): '
  local k; read -r k || true
  [ -n "${k:-}" ] || { say "  No change."; pause; return 0; }
  if cli activation set "$k"; then
    ok "  the panel is activated; you can now create the owner account."
  else
    err "  this key was not valid for this install (the attempt count is recorded in the database)."
  fi
  pause
}

page_restart() {
  head1 "Restart panel"
  say "Only the $SERVICE service is restarted; x-ui and the customers are not touched."
  if [ -t 0 ]; then
    printf 'Continue? [y/N]: '
    local a; read -r a || true
    [[ "${a:-}" =~ ^[Yy]$ ]] || return
  fi
  systemctl restart "$SERVICE"
  sleep 2
  if [ -n "$(health)" ]; then ok "the panel came up healthy: $(health)"; else err "the panel did not come up:"; journalctl -u "$SERVICE" -n 30 --no-pager; fi
  pause
}

page_logs() {
  head1 "Last 30 log lines"
  journalctl -u "$SERVICE" -n 30 --no-pager
  pause
}

# ---------------------------------------------------------------- menu

draw_menu() {
  clear 2>/dev/null || true
  printf '%s' "$c_b"
  say "  Sulduz Cloud — server menu"
  printf '%s' "$c_r"
  say "  $(public_url || echo 'no address set')   |   port $(live_port || echo '?')   |   version $(version_shown || echo '?')"
  say "  ------------------------------------------------------------"
  say "  1) update                      update to the latest published version"
  say "  2) change port panel           change the panel port"
  say "  3) reset username/password     reset the owner username and password"
  say "  4) view panel login details    show the panel login details"
  say "  5) automatic ssl               SSL certificate (nginx or the panel itself)"
  say "  6) exit                        exit"
  say "  ------------------------------------------------------------"
  say "  more:  sulduzcloud status | domain <host> | net | activate | backup | restart | logs"
  printf '  choice: '
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
    err "no install found in $APP_DIR. Give the path with SC_APP_DIR."
    exit 1
  fi
  case "${1:-}" in
    status) page_status ;;
    details) page_details ;;
    owner|accounts) page_owner ;;
    port)
      if [ -n "${2:-}" ]; then
        if valid_port "$2"; then cli port set "$2" && env_set PORT "$2" && say "then run sulduzcloud restart"; else err "invalid port."; fi
      else
        page_port
      fi ;;
    update) page_update ;;
    ssl) if [ -n "${2:-}" ]; then ssl_via_nginx "$2"; else page_ssl; fi ;;
    activate) page_activate ;;
    net) page_net ;;
    domain)
      if [ -n "${2:-}" ]; then
        if valid_domain "$2"; then set_domain "$2"; else err "invalid domain."; fi
      else
        page_domain
      fi
      ;;
    backup) page_backup ;;
    restart) page_restart ;;
    logs) page_logs ;;
    ""|-m|menu) main_menu ;;
    *)
      say "usage:"
      say "  sulduzcloud                 the 6-item menu"
      say "  sulduzcloud update | port <n> | owner | details | ssl [domain]"
      say "  sulduzcloud status | net | activate | domain <host> | backup | restart | logs"
      ;;
  esac
}

main "$@"
