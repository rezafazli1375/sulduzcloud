#!/usr/bin/env bash
# Sulduz Cloud — one-command installer for a fresh Ubuntu/Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/REPO_SLUG/main/install.sh \
#     | sudo bash -s -- --domain panel.example.com --license /root/license.json
#
# Options:
#   --domain <host>       public host name (default: server IP)
#   --license <file>      signed activation key for this machine (required)
#   --port <port>         panel port on 127.0.0.1 (default 3100)
#   --ssl-email <email>   obtain a Let's Encrypt certificate with certbot
#   --no-nginx            skip the nginx site (use your own reverse proxy)
#   --dir <path>          install directory (default /opt/sulduzcloud)
#
# The installer never touches x-ui; connect the panel to x-ui from the admin UI
# after the first login.

set -Eeuo pipefail

REPO_SLUG="${SC_REPO_SLUG:-REPO_SLUG}"
APP_DIR="/opt/sulduzcloud"
DATA_DIR_="/var/lib/sulduzcloud"
LICENSE_DST="/etc/sulduzcloud/license.json"
PORT="3100"
DOMAIN=""
LICENSE_FILE=""
SSL_EMAIL=""
USE_NGINX="1"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --license) LICENSE_FILE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --ssl-email) SSL_EMAIL="${2:-}"; shift 2 ;;
    --no-nginx) USE_NGINX="0"; shift ;;
    --dir) APP_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "run as root (sudo bash install.sh ...)"
[ -n "$LICENSE_FILE" ] || die "--license is required: send this machine's installation id to the vendor (see docs/INSTALL.md)"
[ -f "$LICENSE_FILE" ] || die "license file not found: $LICENSE_FILE"

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
if ! id -u sulduz >/dev/null 2>&1; then
  log "Creating the service user"
  useradd --system --home-dir "$DATA_DIR_" --shell /usr/sbin/nologin sulduz
fi
if systemctl list-unit-files | grep -q '^sulduzcloud.service'; then
  log "Stopping the running service"
  systemctl stop sulduzcloud || true
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

# ------------------------------------------------------------------ licence
log "Checking the activation key"
node "$APP_DIR/server/scripts/license-cli.js" fingerprint >/tmp/sc-fingerprint.txt
FINGERPRINT="$(cat /tmp/sc-fingerprint.txt)"
if [ -f "$LICENSE_DST" ]; then
  cp -a "$LICENSE_DST" "$LICENSE_DST.bak.$(date +%s)"
fi
cp -a "$LICENSE_FILE" "$LICENSE_DST"
chmod 644 "$LICENSE_DST"
if ! node "$APP_DIR/server/scripts/license-cli.js" status >/tmp/sc-license.txt 2>&1; then
  cat /tmp/sc-license.txt
  die "the activation key does not match this machine (installation id: $FINGERPRINT)"
fi
log "Licence OK for $FINGERPRINT"

# ------------------------------------------------------------------ env + unit
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
LICENSE_PATH=$LICENSE_DST
PUBLIC_URL=http://$DOMAIN
EOF
  chmod 600 "$APP_DIR/server/.env"
else
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=http://$DOMAIN#" "$APP_DIR/server/.env" || true
fi
mkdir -p "$DATA_DIR_/backups"
chown -R sulduz:sulduz "$DATA_DIR_"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

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
  log "Installing the server menu (sc)"
  install -m 755 "$APP_DIR/menu.sh" /usr/local/bin/sc
  ln -sf /usr/local/bin/sc /usr/local/bin/sulduzcloud-menu
fi

# ------------------------------------------------------------------ nginx
if [ "$USE_NGINX" = "1" ]; then
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

  if [ -n "$SSL_EMAIL" ]; then
    log "Requesting a Let's Encrypt certificate"
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" --redirect
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$APP_DIR/server/.env"
    systemctl restart sulduzcloud
  fi
fi

cat <<EOF

$(printf '\033[1;32m')Sulduz Cloud is installed.$(printf '\033[0m')

  Panel:            http://$DOMAIN
  First-run setup:  open the panel and create the owner account
  Server menu:      sc          (status, domain, SSL, accounts, backups)
  Service:          systemctl status sulduzcloud
  Logs:             journalctl -u sulduzcloud -f
  Data:             $DATA_DIR_ (back it up!)
  Activation:       $LICENSE_DST (installation id: $FINGERPRINT)

Next: log in, open Settings → x-UI (or Servers → Add server), paste the panel
address and API token, then sync inbounds and set prices.

EOF
