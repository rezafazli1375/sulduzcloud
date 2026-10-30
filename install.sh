#!/usr/bin/env bash
# Sulduz Cloud — one-command installer for a fresh Ubuntu/Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
#     | sudo bash -s -- --key "<installation key>"
#
# The installation key is private. This file only stores its SHA-256 hash, so the
# key cannot be read from the repository: without the exact key nothing installs.
# Get the key from the project owner.
#
# Options:
#   --key <key>           installation key (required)
#   --domain <host>       public host name (default: server IP; change later with `sc`)
#   --port <port>         panel port on 127.0.0.1 (default 3100)
#   --ssl-email <email>   obtain a Let's Encrypt certificate with certbot
#   --no-nginx            skip the nginx site (use your own reverse proxy)
#   --dir <path>          install directory (default /opt/sulduzcloud)
#
# The installer never touches x-ui; connect the panel to x-ui from the admin UI
# after the first login.

set -Eeuo pipefail

REPO_SLUG="${SC_REPO_SLUG:-rezafazli1375/sulduzcloud}"
APP_DIR="/opt/sulduzcloud"
DATA_DIR_="/var/lib/sulduzcloud"
PORT="3100"
DOMAIN=""
DOMAIN_SET="0"
SSL_EMAIL=""
USE_NGINX="1"

# SHA-256 of the private installation key. The key itself is NOT stored here (and
# must never be committed): the owner hands it out together with the install
# command, so a leaked or rotated key is simply a new hash below.
INSTALL_KEY_SHA256="7eb7decb0a915f8f81b016ac0f068759eeacf393e31df838034b4ede0eaca375"
PROVIDED_KEY=""

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; DOMAIN_SET="1"; shift 2 ;;
    --key) PROVIDED_KEY="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --ssl-email) SSL_EMAIL="${2:-}"; shift 2 ;;
    --no-nginx) USE_NGINX="0"; shift ;;
    --dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "run as root (sudo bash install.sh ...)"

[ -n "$PROVIDED_KEY" ] || die "installation key required: pass --key <key>"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum not found (coreutils missing)"
PROVIDED_KEY_HASH="$(printf '%s' "$PROVIDED_KEY" | sha256sum | awk '{print $1}')"
[ "$PROVIDED_KEY_HASH" = "$INSTALL_KEY_SHA256" ] || die "wrong installation key"

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
  [ -d "$SRC_DIR/scripts" ] && cp -a "$SRC_DIR/scripts" "$APP_DIR/scripts"
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
if [ ! -f "$APP_DIR/server/.env" ]; then
  cat > "$APP_DIR/server/.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$DATA_DIR_
BACKUP_DIR=$DATA_DIR_/backups
PUBLIC_URL=http://$DOMAIN
EOF
elif [ "$DOMAIN_SET" = "1" ]; then
  # An explicit --domain wins, but never downgrade an HTTPS panel to plain HTTP:
  # keep https when the current URL uses it or a certificate already exists.
  scheme="http"
  if grep -q '^PUBLIC_URL=https://' "$APP_DIR/server/.env" 2>/dev/null; then scheme="https"; fi
  [ -f "/etc/letsencrypt/live/$DOMAIN/cert.pem" ] && scheme="https"
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=$scheme://$DOMAIN#" "$APP_DIR/server/.env" || true
  log "PUBLIC_URL set to $scheme://$DOMAIN"
else
  log "Keeping PUBLIC_URL from the existing .env"
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
systemctl restart sulduzcloud
sleep 2
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || die "the service did not start; check: journalctl -u sulduzcloud -n 50"
log "Panel service is running on 127.0.0.1:$PORT"

# ------------------------------------------------------------------ server menu
if [ -f "$APP_DIR/menu.sh" ]; then
  log "Installing the server menu (sulduzcloud / sc)"
  install -m 755 "$APP_DIR/menu.sh" /usr/local/bin/sulduzcloud
  ln -sf /usr/local/bin/sulduzcloud /usr/local/bin/sc
  ln -sf /usr/local/bin/sulduzcloud /usr/local/bin/sulduzcloud-menu
fi

# --------------------------------------------------------------- in-panel updater
if [ -f "$APP_DIR/scripts/sulduzcloud-update" ]; then
  log "Installing the in-panel updater (Settings -> Update)"
  install -m 755 "$APP_DIR/scripts/sulduzcloud-update" /usr/local/bin/sulduzcloud-update
  if [ -f "$APP_DIR/scripts/sulduzcloud-update.sudoers" ] && command -v visudo >/dev/null 2>&1; then
    install -m 440 "$APP_DIR/scripts/sulduzcloud-update.sudoers" /etc/sudoers.d/sulduzcloud-update
    if ! visudo -cf /etc/sudoers.d/sulduzcloud-update >/dev/null 2>&1; then
      warn "sudoers entry rejected; the in-panel updater stays disabled"
      rm -f /etc/sudoers.d/sulduzcloud-update
    fi
  fi
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
    cat > /etc/nginx/sites-available/sulduzcloud <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/sulduzcloud /etc/nginx/sites-enabled/sulduzcloud
    rm -f /etc/nginx/sites-enabled/default
    nginx -t && systemctl reload nginx
  fi

  if [ -n "$SSL_EMAIL" ]; then
    log "Requesting a Let's Encrypt certificate"
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$APP_DIR/server/.env"
    systemctl restart sulduzcloud
  fi
fi

PUBLIC_URL_SHOWN="$(awk -F= '$1=="PUBLIC_URL" { sub(/^[^=]*=/, ""); print; exit }' "$APP_DIR/server/.env" 2>/dev/null)"
[ -n "$PUBLIC_URL_SHOWN" ] || PUBLIC_URL_SHOWN="http://$DOMAIN"
SETUP_STATE="$(curl -fsS --max-time 4 "http://127.0.0.1:$PORT/api/setup/status" 2>/dev/null | sed -n 's/.*"setupRequired":\(true\|false\).*/\1/p')"
if [ "$SETUP_STATE" = "true" ]; then
  SETUP_LINE="  First-run setup:  open the panel and create the owner account"
else
  SETUP_LINE="  Sign in:          use the owner account you already created"
fi

cat <<EOF

$(printf '\033[1;32m')Sulduz Cloud is installed.$(printf '\033[0m')

  Panel:            $PUBLIC_URL_SHOWN
$SETUP_LINE
  Server menu:      sulduzcloud      (or: sc)  -> accounts, domain, SSL, backups
  Service:          systemctl status sulduzcloud
  Logs:             journalctl -u sulduzcloud -f
  Data:             $DATA_DIR_ (back it up!)

Next: log in, open Settings → x-UI (or Servers → Add server), paste the panel
address and API token, then sync inbounds and set prices.

EOF
