#!/usr/bin/env bash
# Sulduz Cloud — one-command installer for a fresh Ubuntu/Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
#     | sudo bash
#
# v2.1.0 — the plain command above now walks the operator through the install step
# by step: the panel port, the domain, the two certificate paths (optional), the
# owner's username and password, and finally this install's activation key. The
# panel prints its own male key (`SCM-…`) at that last step and the operator types
# the matching female key he was given offline. Nothing is asked that a terminal
# cannot answer, and every step keeps a default you can accept with Enter.
#
# Non-interactive (identical to the old behaviour — the SSH menu's update item uses
# this, and so does `curl | bash` on a machine with no terminal):
#
#   sudo bash install.sh --non-interactive
#
# Options (each one also answers its step, so a pre-seeded run asks nothing):
#   --domain <host>       public host name (default: server IP; change later with `sc`)
#   --port <port>         panel port on 127.0.0.1 (default 3100)
#   --ssl-email <email>   obtain a Let's Encrypt certificate with certbot
#   --ssl-cert <path>     fullchain/public certificate the PANEL serves (absolute)
#   --ssl-key <path>      its private key (both are required, or neither)
#   --username <name>     owner account to create
#   --activation-key <k>  female activation key for this install's male key
#   --no-nginx            skip the nginx site (use your own reverse proxy)
#   --dir <path>          install directory (default /opt/sulduzcloud)
#
# The owner password is never an option: pass it as ADMIN_PASSWORD in the
# environment, or type it at the prompt. Command lines are readable by other
# users through `ps`; the environment of a process you just started is not.
#
# The installer never touches x-ui; connect the panel to x-ui from the admin UI
# after the first login.

set -Eeuo pipefail

REPO_SLUG="${SC_REPO_SLUG:-rezafazli1375/sulduzcloud}"
APP_DIR="/opt/sulduzcloud"
DATA_DIR_="/var/lib/sulduzcloud"
PORT="3100"
PORT_SET="0"
DOMAIN=""
DOMAIN_SET="0"
SSL_EMAIL="${SC_SSL_EMAIL:-}"
SSL_CERT=""
SSL_KEY=""
USE_NGINX="1"
NON_INTERACTIVE="0"
OWNER_USER="${ADMIN_USERNAME:-}"
OWNER_PASSWORD="${ADMIN_PASSWORD:-}"
ACTIVATION_KEY=""
# Where prompts read from. `curl … | sudo bash` puts the SCRIPT on stdin, so a bare
# `read` would eat installer text as answers; /dev/tty is the terminal behind the
# pipe and is the only correct source there. With neither, nothing is asked.
TTY=""

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; DOMAIN_SET="1"; shift 2 ;;
    --port) PORT="${2:-}"; PORT_SET="1"; shift 2 ;;
    --ssl-email) SSL_EMAIL="${2:-}"; shift 2 ;;
    --ssl-cert) SSL_CERT="${2:-}"; shift 2 ;;
    --ssl-key) SSL_KEY="${2:-}"; shift 2 ;;
    --username) OWNER_USER="${2:-}"; shift 2 ;;
    --activation-key) ACTIVATION_KEY="${2:-}"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE="1"; shift ;;
    --no-nginx) USE_NGINX="0"; shift ;;
    --dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print; next } exit }' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "run as root (sudo bash install.sh ...)"

# ------------------------------------------------------------------ the steps
#
# One helper for the whole interview, because every answer has the same three
# rules: a flag that already gave it is never asked for again, Enter takes the
# default, and a machine with no terminal takes all the defaults silently.

ask() { # variable question default
  local __name="$1" __question="$2" __default="$3" __answer=""
  # `${!name:-}` and not `${!name}`: this script runs with `set -u`, and a helper
  # that dies because a variable has never been mentioned yet would take the whole
  # install down with it. An unset answer is simply "nobody answered".
  if [ "$NON_INTERACTIVE" = "1" ] || [ -z "$TTY" ]; then
    [ -n "${!__name:-}" ] || printf -v "$__name" '%s' "$__default"
    return 0
  fi
  if [ -n "${!__name:-}" ]; then
    printf '  %s %s\n' "$__question" "${!__name}"
    return 0
  fi
  printf '  %s%s: ' "$__question" "${__default:+ (Enter = $__default)}" > "$TTY"
  IFS= read -r __answer < "$TTY" || __answer=""
  printf -v "$__name" '%s' "${__answer:-$__default}"
  return 0
}

ask_secret() { # variable question
  local __name="$1" __question="$2" __answer=""
  if [ "$NON_INTERACTIVE" = "1" ] || [ -z "$TTY" ]; then
    return 0
  fi
  if [ -n "${!__name:-}" ]; then
    printf '  %s (از محیط دریافت شد)\n' "$__question"
    return 0
  fi
  printf '  %s: ' "$__question" > "$TTY"
  IFS= read -rs __answer < "$TTY" || __answer=""
  printf '\n' > "$TTY"
  printf -v "$__name" '%s' "$__answer"
  return 0
}

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
valid_domain() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$ ]]; }

# Settings writes during the install go through the panel's own code, as the
# service user — the same guards, the same encryption, the same rows the admin
# form writes. root running node here would leave root-owned files in the data
# directory, which is how a panel stops being able to write its own database.
as_sulduz() {
  if id -u sulduz >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then
    runuser -u sulduz -- "$@"
  else
    "$@"
  fi
}

sc_cli() { as_sulduz node "$APP_DIR/server/scripts/admin-cli.js" "$@"; }

# Every CLI call here is advisory: the files are already installed when these run,
# and a settings write that fails has to be reported, not turned into an installer
# that dies halfway and leaves a half-configured server behind.
sc_cli_soft() {
  local out
  if ! out="$(sc_cli "$@" 2>&1)"; then
    warn "  admin-cli $*: $(printf '%s' "$out" | tr '\n' ' ')"
    return 1
  fi
  [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/    /'
  return 0
}

# The number offered as the default is the number the panel already uses: pressing
# Enter on a re-install must never move a running listener back to 3100.
port_default() {
  local p=""
  if [ -f "$APP_DIR/server/.env" ]; then
    p="$(awk -F= '$1=="PORT" { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/server/.env" 2>/dev/null || true)"
  fi
  valid_port "$p" || p="3100"
  printf '%s' "$p"
}

if [ "$NON_INTERACTIVE" != "1" ]; then
  if [ -t 0 ]; then TTY=/dev/stdin
  elif [ -c /dev/tty ] && : < /dev/tty 2>/dev/null; then TTY=/dev/tty
  else
    warn "No terminal for prompts; installing with defaults (add --non-interactive to say so on purpose)."
    TTY=""
  fi
fi

if [ "$NON_INTERACTIVE" != "1" ] && [ -n "$TTY" ]; then
  log "تنظیمات پنل — با Enter همان مقدار پیش‌فرض گرفته می‌شود"
  while :; do
    ask PORT "پورت پنل روی 127.0.0.1:" "$(port_default)"
    valid_port "$PORT" && break
    warn "  پورت باید عددی بین 1024 و 65535 باشد."
    # ask never repeats an answer it already has, so a retry has to clear it
    # first — otherwise the invalid number is printed back forever.
    PORT=""
  done
  PORT_SET="1"
  ask DOMAIN "دامنهٔ پنل (مثلاً panel.example.com؛ خالی = IP همین سرور):" ""
  while [ -n "$DOMAIN" ] && ! valid_domain "$DOMAIN"; do
    warn "  «$DOMAIN» دامنهٔ معتبری نیست."
    DOMAIN=""
    ask DOMAIN "دامنهٔ پنل (Enter = بدون دامنه، با IP همین سرور):" ""
  done
  if [ -n "$DOMAIN" ]; then
    DOMAIN_SET="1"
  fi
  ask SSL_CERT "اگر گواهی HTTPS آماده‌اید: مسیر کلید عمومی (fullchain) — خالی = نگذارم:" ""
  if [ -n "$SSL_CERT" ]; then
    ask SSL_KEY "مسیر کلید خصوصی (privkey):" ""
    if [ ! -f "$SSL_CERT" ] || [ ! -f "$SSL_KEY" ]; then
      warn "  فایلی در آن مسیرها نبود؛ پنل فعلاً HTTP می‌ماند و بعداً از منوی سرور (sc) می‌توانید گواهی بگذارید."
      SSL_CERT=""; SSL_KEY=""
    fi
  fi
  ask OWNER_USER "نام کاربری حساب مالک (پیش‌فرض admin):" "admin"
  tries=0
  while [ -n "$OWNER_USER" ] && [ -z "$OWNER_PASSWORD" ] && [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    ask_secret OWNER_PASSWORD "رمز عبور مالک (حداقل ۸ کاراکتر؛ نمایش داده نمی‌شود)"
    if [ -n "$OWNER_PASSWORD" ] && [ "${#OWNER_PASSWORD}" -lt 8 ]; then
      warn "  کوتاه است؛ دوباره."
      OWNER_PASSWORD=""
    fi
  done
  if [ -z "$OWNER_PASSWORD" ]; then
    warn "  بدون رمز؛ حساب مالک را خودتان در اولین ورود از مرورگر می‌سازید."
    OWNER_USER=""
  fi
fi

# ---------------------------------------------------------------- the port truth
#
# src/net.js binds `general.panelPort` from the stored settings and falls back to
# .env PORT only when that is empty. When nobody answered the port step
# (--non-interactive with no --port — which is how the SSH menu re-installs a
# release) the number already in use is looked up and reused instead of the 3100
# default: otherwise a quiet update could move a panel its owner had deliberately
# parked on another port, and the installer's own health check would then fail
# against the wrong socket.
if [ "$PORT_SET" != "1" ] && [ -f "$APP_DIR/server/.env" ]; then
  ENV_PORT="$(awk -F= '$1=="PORT" { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/server/.env" 2>/dev/null || true)"
  if valid_port "$ENV_PORT"; then
    PORT="$ENV_PORT"
    log "PORT kept from the existing .env: $PORT"
  fi
fi

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends curl ca-certificates git python3 make g++ sqlite3
if [ "$USE_NGINX" = "1" ]; then apt-get install -y nginx; fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ is required (found $(node -v))"

# ------------------------------------------------------------------ sources
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
SRC_DIR=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server/src/index.js" ] && [ -d "$SCRIPT_DIR/web" ]; then
  SRC_DIR="$SCRIPT_DIR"
  log "Installing from local checkout: $SRC_DIR"
else
  TMP="$(mktemp -d)"
  log "Downloading sources from github.com/$REPO_SLUG"
  git clone --depth 1 "https://github.com/$REPO_SLUG.git" "$TMP/sulduzcloud" \
    || die "cannot clone the repository (private repo? use a checkout and run ./install.sh)"
  SRC_DIR="$TMP/sulduzcloud"
fi

mkdir -p "$APP_DIR" "$DATA_DIR_" /etc/sulduzcloud
chmod 750 "$DATA_DIR_" 2>/dev/null || true
if ! id -u sulduz >/dev/null 2>&1; then
  log "Creating the service user"
  useradd --system --home-dir "$DATA_DIR_" --shell /usr/sbin/nologin sulduz
fi
if systemctl list-unit-files | grep -q '^sulduzcloud.service'; then
  log "Stopping the running service"
  systemctl stop sulduzcloud || true
fi

# Re-running the installer on a live panel must not lose its configuration
# (PUBLIC_URL, XUI_URL, PANEL_TZ, ...): keep server/.env across the file copy.
ENV_BACKUP=""
if [ -f "$APP_DIR/server/.env" ]; then
  ENV_BACKUP="$(mktemp)"
  cp -a "$APP_DIR/server/.env" "$ENV_BACKUP"
  log "Keeping the existing $APP_DIR/server/.env"
fi

log "Copying files to $APP_DIR"
if [ "$(cd "$SRC_DIR" && pwd)" != "$(cd "$APP_DIR" && pwd)" ]; then
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +
  cp -a "$SRC_DIR/server" "$SRC_DIR/web" "$APP_DIR/"
  [ -f "$SRC_DIR/menu.sh" ] && cp -a "$SRC_DIR/menu.sh" "$APP_DIR/menu.sh"
else
  warn "Installing from $APP_DIR itself; files are left in place"
fi

log "Installing backend dependencies"
cd "$APP_DIR/server"
if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
mkdir -p "$DATA_DIR_/secrets" "$DATA_DIR_/backups"
chown -R sulduz:sulduz "$DATA_DIR_" "$APP_DIR/server/data" 2>/dev/null || true

log "Building the web panel"
cd "$APP_DIR/web"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npx vite build

# ------------------------------------------------------------------ env + unit
if [ -n "$ENV_BACKUP" ]; then
  cp -a "$ENV_BACKUP" "$APP_DIR/server/.env"
  rm -f "$ENV_BACKUP"
fi
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(hostname -I | awk '{print $1}')"
  warn "No --domain given, using $DOMAIN (no HTTPS will be configured)"
fi
# --------------------------------------------------------- the certificate pair
#
# Two things must be true before HTTPS is promised to the operator. The service
# user has to be able to OPEN both files — a Let's Encrypt private key is 0600
# root:root while the panel runs as `sulduz`, and a path the panel cannot read is
# a certificate that silently never gets served — and the two files have to be the
# same key pair, which is the classic modulus comparison. An unreadable pair is
# not refused but copied into the panel's own data directory, the same thing the
# SSH menu's SSL item does, and everything then points at the copy.
if [ -n "$SSL_CERT" ] && [ -n "$SSL_KEY" ]; then
  if ! as_sulduz test -r "$SSL_CERT" -a -r "$SSL_KEY" 2>/dev/null; then
    SSL_DIR="$DATA_DIR_/ssl/$DOMAIN"
    if mkdir -p "$SSL_DIR" \
      && install -m 644 -o sulduz -g sulduz "$SSL_CERT" "$SSL_DIR/fullchain.pem" \
      && install -m 640 -o sulduz -g sulduz "$SSL_KEY" "$SSL_DIR/privkey.pem"; then
      log "Certificate copied where the service user can read it: $SSL_DIR"
      SSL_CERT="$SSL_DIR/fullchain.pem"
      SSL_KEY="$SSL_DIR/privkey.pem"
    else
      warn "  آن جفت فایل را کاربر سرویس نمی‌تواند بخواند و کپی هم نشد؛ پنل HTTP می‌ماند."
      SSL_CERT=""; SSL_KEY=""
    fi
  fi
  if [ -n "$SSL_CERT" ] && command -v openssl >/dev/null 2>&1; then
    CERT_MOD="$(openssl x509 -noout -modulus -in "$SSL_CERT" 2>/dev/null || true)"
    KEY_MOD="$(openssl rsa -noout -modulus -in "$SSL_KEY" 2>/dev/null || true)"
    if [ -n "$CERT_MOD" ] && [ "$CERT_MOD" != "$KEY_MOD" ]; then
      warn "  کلید خصوصی با این گواهی جفت نیست؛ پنل HTTP می‌ماند و از منوی «sc» گزینهٔ ۵ می‌توانید جفت درست بگذارید."
      SSL_CERT=""; SSL_KEY=""
    fi
  fi
fi

# One scheme decision, used by .env, the health check and the summary. A pair of
# certificate paths means the panel itself serves HTTPS, so anything that pokes it
# afterwards has to ask https and must not verify a certificate issued for a
# domain against 127.0.0.1. TLS_FROM_PAIR remembers that this run is the reason:
# if the panel later refuses the pair, only then is it safe to walk the address
# back to http without overwriting somebody else's PUBLIC_URL.
SCHEME="http"
TLS_FROM_PAIR="0"
ENV_CREATED="0"
if [ -n "$SSL_CERT" ] && [ -n "$SSL_KEY" ]; then SCHEME="https"; TLS_FROM_PAIR="1"; fi
if grep -q '^PUBLIC_URL=https://' "$APP_DIR/server/.env" 2>/dev/null; then SCHEME="https"; fi
[ -f "/etc/letsencrypt/live/$DOMAIN/cert.pem" ] && SCHEME="https"
if [ ! -f "$APP_DIR/server/.env" ]; then
  ENV_CREATED="1"
  cat > "$APP_DIR/server/.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR_
BACKUP_DIR=$DATA_DIR_/backups
PUBLIC_URL=$SCHEME://$DOMAIN
EOF
else
  # An explicit answer (or --domain) wins, but never downgrade an HTTPS panel to
  # plain HTTP, and never let a chosen port evaporate because the file already
  # existed: a re-run of the installer is also how you change the port.
  if [ "$DOMAIN_SET" = "1" ]; then
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=$SCHEME://$DOMAIN#" "$APP_DIR/server/.env" || true
    log "PUBLIC_URL set to $SCHEME://$DOMAIN"
  else
    log "Keeping PUBLIC_URL from the existing .env"
  fi
  if grep -q '^PORT=' "$APP_DIR/server/.env"; then
    if [ "$(awk -F= '$1=="PORT"{print $2; exit}' "$APP_DIR/server/.env")" != "$PORT" ]; then
      sed -i "s#^PORT=.*#PORT=$PORT#" "$APP_DIR/server/.env" || true
      log "PORT set to $PORT"
    fi
  else
    printf 'PORT=%s\n' "$PORT" >> "$APP_DIR/server/.env"
  fi
fi
chmod 600 "$APP_DIR/server/.env" 2>/dev/null || true
mkdir -p "$DATA_DIR_/backups"
chown -R sulduz:sulduz "$DATA_DIR_"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"
# The service runs as `sulduz` and also reads .env itself: keep it out of other
# users' reach but readable by the service (systemd loads it as root anyway).
if [ -f "$APP_DIR/server/.env" ]; then
  chown root:sulduz "$APP_DIR/server/.env"
  chmod 640 "$APP_DIR/server/.env"
fi

# --------------------------------------------------------- the panel's settings
#
# .env is only the boot fallback: src/net.js reads general.panelPort,
# general.publicUrl and the two certificate paths from the stored settings FIRST.
# Writing those rows here is what makes the answers above survive the next
# re-install, and why the SSH menu never has to be told twice. They go through
# admin-cli.js — the panel's own code — for the same reason the menu does: a
# hand-rolled sqlite UPDATE here would be a second, weaker set of rules that the
# next save from the browser quietly overwrites.
PANEL_TLS="0"
if [ -n "$SSL_CERT" ] && [ -n "$SSL_KEY" ]; then
  if sc_cli_soft ssl set --cert "$SSL_CERT" --key "$SSL_KEY"; then PANEL_TLS="1"; fi
fi

if [ "$TLS_FROM_PAIR" = "1" ] && [ "$PANEL_TLS" != "1" ]; then
  # The files were there and readable, yet the panel still refused them. A
  # PUBLIC_URL of https would then quote an address that answers nothing at all,
  # which is worse than plain http: it breaks only after the operator has walked
  # away from the installer. Say so out loud and put the address back.
  warn "  پنل آن جفت گواهی را نپذیرفت؛ آدرس پنل روی http می‌ماند (منوی «sc» گزینهٔ ۵)."
  SCHEME="http"
  if [ "$ENV_CREATED" = "1" ] || [ "$DOMAIN_SET" = "1" ]; then
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=http://$DOMAIN#" "$APP_DIR/server/.env" || true
  fi
fi

if [ "$PORT_SET" = "1" ]; then
  sc_cli_soft port set "$PORT" || true
fi
if [ "$DOMAIN_SET" = "1" ]; then
  sc_cli_soft url set "$SCHEME://$DOMAIN" || true
fi

# What the socket itself speaks — not the same question as PUBLIC_URL. A panel
# behind nginx with a Let's Encrypt certificate is https to the browser and plain
# http on 127.0.0.1, and a health check built from the wrong one of the two
# reports a dead panel that is perfectly alive.
LISTEN_SCHEME="http"
[ "$PANEL_TLS" = "1" ] && LISTEN_SCHEME="https"

log "Writing the systemd unit"
cat > /etc/systemd/system/sulduzcloud.service <<EOF
[Unit]
Description=Sulduz Cloud reseller panel
After=network.target

[Service]
Type=simple
User=sulduz
Group=sulduz
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$APP_DIR/server/.env
ExecStart=$(command -v node) src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA_DIR_
LimitNOFILE=65535
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sulduzcloud >/dev/null

# Say it out loud before the service tries to bind: a port already held by
# something else (x-ui lives in 2000-2100) is the one failure this script cannot
# fix by itself, and the operator should see why before reading a stack of logs.
if command -v ss >/dev/null 2>&1 && [ "$(ss -ltnH "sport = :$PORT" 2>/dev/null | wc -l)" -gt 0 ]; then
  warn "پورت $PORT همین حالا روی این سرور گرفته شده است:"
  ss -ltnp "sport = :$PORT" 2>/dev/null | sed -n '2,4p' | sed 's/^/    /'
  warn "  اگر پنل بالا نیامد، پس از آزاد کردن پورت با «sc» گزینهٔ ۲ آن را عوض کنید."
fi

systemctl restart sulduzcloud

# An HTTPS listener answers /api/health over TLS; the same request sent as plain
# http is a parse error, not a dead panel. -k because a certificate issued for a
# domain is not validated against 127.0.0.1. Ten tries because the first boot of
# a fresh install runs the database migrations and systemd restarts it under
# RestartSec=3 if that takes too long.
HEALTH=""
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  HEALTH="$(curl -fsSk --max-time 3 "$LISTEN_SCHEME://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 1
done
[ -n "$HEALTH" ] || die "the service did not answer on $LISTEN_SCHEME://127.0.0.1:$PORT; check: journalctl -u sulduzcloud -n 50"
log "Panel service is running on $LISTEN_SCHEME://127.0.0.1:$PORT"

# ------------------------------------------------------------------ server menu
if [ -f "$APP_DIR/menu.sh" ]; then
  log "Installing the server menu (sulduzcloud / sc)"
  install -m 755 "$APP_DIR/menu.sh" /usr/local/bin/sulduzcloud
  ln -sf /usr/local/bin/sulduzcloud /usr/local/bin/sc
  ln -sf /usr/local/bin/sulduzcloud /usr/local/bin/sulduzcloud-menu
fi

# ------------------------------------------------------------------ nginx
if [ "$USE_NGINX" = "1" ]; then
  # A live panel may already be served by a customized site (HTTPS, hand-managed
  # certificate, static root): only write a site when nothing proxies to the port.
  EXISTING_SITE=""
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -e "$f" ] || continue
    if grep -q "127.0.0.1:${PORT}\b" "$f" 2>/dev/null; then EXISTING_SITE="$f"; break; fi
  done

  if [ -n "$EXISTING_SITE" ]; then
    log "nginx already serves the panel from $EXISTING_SITE; leaving it untouched"
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
  else
    log "Configuring nginx for $DOMAIN"
    # Two separate questions, and mixing them up is how an install gets a site that
    # 502s: what the BROWSER speaks (https on 443, only when this run holds a
    # usable pair for a real domain) and what the PANEL's socket speaks (TLS too,
    # when it was given the certificate itself — then nginx must speak https to
    # 127.0.0.1 and must not verify it, because a certificate issued for a domain
    # is never valid for 127.0.0.1).
    NGX_PROXY_TLS=""
    [ "$LISTEN_SCHEME" = "https" ] && NGX_PROXY_TLS="        proxy_ssl_verify off;"
    NGX_TLS=""
    if [ -n "$SSL_CERT" ] && [ -n "$SSL_KEY" ] && valid_domain "$DOMAIN"; then
      NGX_TLS="$(printf '    listen 443 ssl;\n    listen [::]:443 ssl;\n    ssl_certificate %s;\n    ssl_certificate_key %s;' "$SSL_CERT" "$SSL_KEY")"
    fi

    write_nginx_site() {
      cat > /etc/nginx/sites-available/sulduzcloud <<EOF
server {
    listen 80;
    listen [::]:80;
$NGX_TLS
    server_name $DOMAIN;
    client_max_body_size 32m;

    location / {
        proxy_pass $LISTEN_SCHEME://127.0.0.1:$PORT;
$NGX_PROXY_TLS
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
    }

    write_nginx_site
    ln -sf /etc/nginx/sites-available/sulduzcloud /etc/nginx/sites-enabled/sulduzcloud
    rm -f /etc/nginx/sites-enabled/default
    if ! nginx -t >/dev/null 2>&1 && [ -n "$NGX_TLS" ]; then
      warn "  سایت TLS با nginx -t قبول نشد؛ همان سایت بدون گواهی نوشته می‌شود."
      NGX_TLS=""
      write_nginx_site
    fi
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
    else
      # A site file nginx cannot parse would kill the whole web server on its next
      # restart, so it does not stay behind: the panel works on its own port and
      # the operator is told the reverse proxy was not configured.
      rm -f /etc/nginx/sites-enabled/sulduzcloud
      warn "  nginx این سایت را قبول نکرد و لینک آن حذف شد؛ پنل روی پورت $PORT کار می‌کند."
      nginx -t || true
    fi
  fi

  if [ -n "$SSL_EMAIL" ]; then
    log "Requesting a Let's Encrypt certificate"
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$APP_DIR/server/.env"
    # general.publicUrl outranks PUBLIC_URL for every link the panel quotes to a
    # customer, so the new https address has to be stored, not only written to .env.
    sc_cli_soft url set "https://$DOMAIN" || true
    systemctl restart sulduzcloud
  fi
fi

# ------------------------------------------------------- activation + owner
#
# The owner's condition for letting anybody else run this panel: the install
# shows one MALE key and stays locked until the matching FEMALE half is typed.
# The order below matters more than it looks — activation.isRequired() is only
# true while the panel has NO accounts, so an installer that created the owner
# first would have unlocked the panel without ever asking for a key. The female
# strings are in none of these files: the repository carries the male ids and
# the sha256 fingerprint of each partner, nothing else.
ACT_STATE="$(sc_cli activation check 2>/dev/null || echo unknown)"
MALE_KEY="$(sc_cli activation male 2>/dev/null || true)"
log "Activation: ${ACT_STATE}   serial of this install: ${MALE_KEY:-unknown}"

if [ "$ACT_STATE" = "required" ]; then
  warn "  کلید فعالسازیِ همین سریال را از مالک پروژه بگیرید (سریال: $MALE_KEY)."
  warn "  با Enter رد شوید؛ همان سؤال در اولین باز کردن پنل در مرورگر هم پرسیده می‌شود."
  KEY_TRIES=0
  TRY_KEY=""
  while [ "$ACT_STATE" = "required" ] && [ "$KEY_TRIES" -lt 3 ]; do
    if [ -n "$ACTIVATION_KEY" ]; then
      TRY_KEY="$ACTIVATION_KEY"; ACTIVATION_KEY=""
    else
      ask TRY_KEY "کلید فعالسازی (Enter = بعداً):" ""
    fi
    [ -z "$TRY_KEY" ] && break
    KEY_TRIES=$((KEY_TRIES + 1))
    if KEY_OUT="$( ( export ACTIVATION_KEY="$TRY_KEY"; sc_cli activation set ) 2>&1 )"; then
      printf '%s\n' "$KEY_OUT" | sed 's/^/    /'
      ACT_STATE="activated"
    else
      warn "  $(printf '%s' "$KEY_OUT" | tr '\n' ' ')"
    fi
    TRY_KEY=""
  done
fi

# The owner account, created through the panel's own createUser() — the same
# bcrypt cost, the same validations, the same audit shape as the browser form.
# It happens after the key step on purpose (see above), and the password is
# handed over in the environment because argv is readable by every user through
# `ps`.
OWNER_LINE=""
if [ -n "$OWNER_USER" ] && [ -n "$OWNER_PASSWORD" ]; then
  if [ "$ACT_STATE" = "required" ]; then
    warn "  تا این نصب فعال نشده، حساب مالک ساخته نمی‌شود؛ کلید را که گرفتید از مرورگر وارد کنید."
    OWNER_LINE="  Owner account:    after the activation key, the first page will ask for it"
  else
    if OWNER_OUT="$( ( export ADMIN_USERNAME="$OWNER_USER" ADMIN_PASSWORD="$OWNER_PASSWORD"; sc_cli bootstrap ) 2>&1 )"; then
      printf '%s\n' "$OWNER_OUT" | sed 's/^/    /'
      mkdir -p /etc/sulduzcloud
      ( umask 077
        printf 'ADMIN_USER=%s\nADMIN_PASS=%s\nADMIN_SET=%s\n' "$OWNER_USER" "$OWNER_PASSWORD" "$(date '+%Y-%m-%d %H:%M')" > /etc/sulduzcloud/admin.cred
      )
      chmod 600 /etc/sulduzcloud/admin.cred
      log "Same credentials saved in /etc/sulduzcloud/admin.cred (root only; menu item 4 shows them)"
      OWNER_LINE="  Sign in:          $OWNER_USER — the password you typed, also in /etc/sulduzcloud/admin.cred"
    else
      warn "  حساب مالک ساخته نشد: $(printf '%s' "$OWNER_OUT" | tr '\n' ' ')"
    fi
  fi
  OWNER_PASSWORD=""
fi

if [ -z "$OWNER_LINE" ]; then
  ADMIN_COUNT="$( { sc_cli admins 2>/dev/null || true; } | grep -c . || true)"
  if [ "${ADMIN_COUNT:-0}" -gt 0 ]; then
    OWNER_LINE="  Sign in:          the owner account already on this install ($ADMIN_COUNT admin)"
  else
    OWNER_LINE="  First-run setup:  open the panel and create the owner account"
  fi
fi

case "$ACT_STATE" in
  activated) ACT_LINE="  Activation:       activated (serial $MALE_KEY)" ;;
  legacy)    ACT_LINE="  Activation:       an older install with accounts — no key is asked" ;;
  required)  ACT_LINE="  Activation:       NOT activated: the panel asks for the activation key of serial $MALE_KEY" ;;
  *)         ACT_LINE="  Activation:       unknown — check with the server menu: sc -> 4" ;;
esac

# What the panel will quote to a customer as its own address: the stored setting
# wins, .env is only the fallback (src/net.js applies it that way).
ENV_URL="$(awk -F= '$1=="PUBLIC_URL" { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/server/.env" 2>/dev/null)"
STORED_URL="$(sc_cli url get 2>/dev/null || true)"
PUBLIC_URL_SHOWN="${STORED_URL:-$ENV_URL}"
[ -n "$PUBLIC_URL_SHOWN" ] || PUBLIC_URL_SHOWN="http://$DOMAIN"

cat <<EOF

$(printf '\033[1;32m')Sulduz Cloud is installed.$(printf '\033[0m')

  Panel:            $PUBLIC_URL_SHOWN
$OWNER_LINE
$ACT_LINE
  Panel port:       $LISTEN_SCHEME://127.0.0.1:$PORT
  Server menu:      sulduzcloud   (or: sc)   1 update | 2 port | 3 owner | 4 login details | 5 SSL | 6 exit
  Service:          systemctl status sulduzcloud
  Logs:             journalctl -u sulduzcloud -f
  Data:             $DATA_DIR_ (back it up!)

Next: log in, open Settings → x-UI (or Servers → Add server), paste the panel
address and API token, then sync inbounds and set prices. The installer never
touches x-ui.

EOF
