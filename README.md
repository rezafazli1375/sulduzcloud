# Sulduz Cloud

پنل مدیریت نمایندگی و کانفیگ VPN — دو زبانه (فارسی/انگلیسی)، تم تیره حرفه‌ای، متصل به ۳x-ui.

A bilingual (Persian/English) reseller & config management panel for 3x-ui, with a premium dark UI, per-reseller limits, wallet, tickets, live node status, backups and a reseller REST API.

Version 1.3.8 · Node.js 20+ · SQLite · React 18 · multi-panel

---

## نصب خودکار (Quick install)

یک فرمان روی سرور تازهٔ Ubuntu/Debian. کلید نصب خصوصی است و در مخزن نیست؛ آن را از مالک پروژه بگیرید و جای `<کلید نصب>` بگذارید:

```bash
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh | sudo bash -s -- --key "<کلید نصب>"
```

همین یک فرمان Node.js 20، nginx، سرویس systemd و بیلد وب‌پنل را نصب می‌کند و فرمان `sulduzcloud` (منوی سرور: رمز مدیر، دامنه، SSL، بکاپ) را آماده می‌گذارد. دامنه و گواهی را بعداً با `sudo sulduzcloud` تنظیم کنید، یا همان اول در دستور بیاورید:

```bash
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
  | sudo bash -s -- --key "<کلید نصب>" --domain panel.example.com --ssl-email you@example.com
```

---

## فارسی

### این پروژه چه می‌کند؟

هر نمایندگی با نام کاربری و رمز خودش وارد پنل شخصی می‌شود و در محدوده‌ای که مدیر تعیین کرده کانفیگ می‌سازد، تمدید می‌کند، حجم/زمان اضافه می‌کند و آمار و کیف پول و تیکت‌هایش را می‌بیند. مدیر روی همه نمایندگان، کانفیگ‌ها، اینباندها، سرورها، آمار، بکاپ، لاگ فعالیت و تنظیمات کنترل کامل دارد. همه عملیات کانفیگ مستقیماً از طریق API پنل ۳x-ui انجام می‌شود؛ پنل دیتابیس ۳x-ui را مستقیم تغییر نمی‌دهد.

### امکانات

**پنل مدیر**

- نمای کلی: کانفیگ‌ها، نمایندگان، ترافیک امروز/۷ روز، تیکت‌های باز، وضعیت شبکه، توزیع مصرف اینباندها، برترین نمایندگان
- نمایندگان: ساخت/ویرایش/غیرفعال‌سازی، سقف تعداد کانفیگ، سقف حجم هر کانفیگ و حجم کل، محدودیت IP، تاریخ انقضا، دسترسی ماژول‌به‌ماژول، کیف پول، کلید API، ریست رمز
- کانفیگ‌ها: ساخت روی هر اینباندِ هر نود برای هر نماینده، تمدید، افزایش حجم، فعال/غیرفعال، ریست مصرف، لینک اشتراک و URI + QR، خروجی CSV
- اینباندها: همگام‌سازی از ۳x-ui، نمایش/مخفی‌سازی برای نمایندگان، ویرایش مشخصات
- پنل‌های x-ui متعدد: افزودن/ویرایش/حذف چند پنل ۳x-ui هم‌زمان؛ هر اینباند و کانفیگ به سرور خودش وصل است، همگام‌سازی و پایش جدا برای هر پنل، نمایش زندهٔ مصرف پردازنده/رم/دیسک هر سرور. حذف تنها سرورِ باقی‌مانده مجاز است و پنل را به همان حالت خام اول برمی‌گرداند؛ سروری که هنوز کانفیگ فعال دارد حذف نمی‌شود تا کلاینت‌های زنده قطع نشوند
- سرورها و نودها: وضعیت زنده پنل‌ها و نودها، تأخیر، موجودی منابع، بررسی فوری، هشدار قطعی از طریق ایمیل و پیامک
- آمار و گزارش: روند ترافیک، درآمد، وضعیت کانفیگ‌ها، برترین نمایندگان، تراکنش‌ها
- تیکت‌ها، اطلاع‌رسانی گروهی (همه/مدیران/انتخابی)، تاریخچه ارسال
- بکاپ: بکاپ دستی، بکاپ خودکار روزانه، نگهداری N نسخه، دانلود و بازگردانی
- گزارش فعالیت (Audit log) برای عملیات حساس
- تنظیمات: عمومی، اتصال ۳x-ui، پایش و هشدار، ایمیل (SMTP)، پیامک، کیف پول، بکاپ، امنیت

**پنل نمایندگی**

- ساخت و تمدید کانفیگ با رعایت سقف‌ها، افزودن حجم/زمان، ریست مصرف
- لینک اشتراک، URI و QR برای هر کانفیگ
- آمار مصرف، کیف پول و تراکنش‌ها، تیکت، اطلاعیه‌ها، پروفایل و تغییر رمز
- کلید API و مستندات REST برای اتصال فروشگاه/ربات

**امنیت**

- JWT در کوکی HttpOnly + محافظت CSRF با double-submit
- هش رمز با bcrypt، ابطال نشست‌ها پس از خروج/تغییر رمز
- محدودیت تلاش ورود، Helmet، اعتبارسنجی ورودی با zod، لاگ فعالیت
- کلید API مخصوص نمایندگی با محدودیت نرخ ۱۲۰ درخواست در دقیقه

**رابط کاربری**

- دو زبانه کامل fa/en با RTL/LTR، فونت Vazirmatn به‌صورت لوکال (بدون وابستگی به Google Fonts)
- تم تیره، نمودارها، اسکلت بارگذاری، اعلان‌ها، ریسپانسیو موبایل

### پیش‌نیازها

- Ubuntu/Debian تازه (یا هر لینوکسی با Node.js 20+ و ابزار ساخت بسته‌های native: `python3`, `make`, `g++`)
- یک پنل ۳x-ui فعال با API Token
- کلید نصب خصوصی (از مالک پروژه بگیرید؛ در مخزن نیست)

### نصب با یک فرمان

```bash
sudo bash install.sh --key "<کلید نصب>"
# یا از روی مخزن:
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
  | sudo bash -s -- --key "<کلید نصب>"
```

اسکریپت خودش Node.js 20، nginx، سرویس systemd و بیلد وب را انجام می‌دهد. گزینه‌ها:

| گزینه | توضیح |
| --- | --- |
| `--key <key>` | کلید نصب خصوصی (الزامی؛ فقط SHA-256 آن در مخزن است) |
| `--domain <host>` | نام دامنه عمومی (پیش‌فرض: IP سرور؛ بعداً هم با `sulduzcloud` قابل تغییر است) |
| `--ssl-email <email>` | دریافت خودکار گواهی Let's Encrypt با certbot |
| `--port <port>` | پورت داخلی پنل (پیش‌فرض ۳۱۰۰) |
| `--no-nginx` | بدون ساخت سایت nginx (پروکسی معکوس خودتان) |
| `--dir <path>` | مسیر نصب (پیش‌فرض `/opt/sulduzcloud`) |

اجرای مجدد همین فرمان روی یک نصب موجود، امن است: فایل `server/.env` (شامل `PUBLIC_URL`، `XUI_URL`، `PANEL_TZ`)، دیتابیس و سایت nginx فعلی حفظ می‌شوند و فقط کد و بیلد وب به‌روز می‌شوند.

پس از نصب، پنل را باز کنید؛ بار اول حساب مدیر ساخته می‌شود. سپس از **تنظیمات → اتصال ۳x-ui** یا صفحه **سرورها → افزودن سرور** آدرس و توکن پنل ۳x-ui را وارد کنید، اینباندها را همگام کنید و تعرفه بگذارید.

### منوی سرور (SSH)

اسکریپت نصب فرمان `sulduzcloud` را در `/usr/local/bin/sulduzcloud` می‌گذارد (میان‌بر: `sc`). با root اجرا کنید:

```bash
sudo sulduzcloud          # منوی تعاملی
sudo sulduzcloud status   # وضعیت سرویس، مسیر دیتابیس، اتصال ۳x-ui
sudo sulduzcloud accounts # نام کاربری و رمز مدیر + تغییر رمز
sudo sulduzcloud domain panel.example.com
sudo sulduzcloud ssl      # وضعیت گواهی و صدور/تمدید با certbot
sudo sulduzcloud backup   # بکاپ فوری دیتابیس
sudo sulduzcloud restart  # فقط ری‌استارت سرویس پنل
```

رمزها هش می‌شوند و بازیابی‌شدنی نیستند؛ گزینهٔ «حساب‌ها» یک رمز تازه می‌سازد و همان لحظه نشان می‌دهد. این منو هیچ‌وقت ۳x-ui، اینباندها یا کلاینت‌ها را تغییر نمی‌دهد. اگر سایت nginx یا گواهی در مسیر غیرمعمول باشد، منو آن را از روی پیکربندی nginx خودکار پیدا می‌کند.

### متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
| --- | --- | --- |
| `NODE_ENV` | `production` | حالت اجرا |
| `HOST` / `PORT` | `127.0.0.1` / `3100` | آدرس شنود بک‌اند (پشت nginx) |
| `PUBLIC_URL` | خالی | آدرس عمومی پنل؛ برای کوکی امن و لینک‌ها (اسکریپت نصب پر می‌کند) |
| `PANEL_TZ` | `Asia/Tehran` | منطقه زمانی گزارش‌ها و بکاپ خودکار |
| `DATA_DIR` | `server/data` | دیتابیس و فایل‌های زمان اجرا |
| `BACKUP_DIR` | `server/backups` | محل بکاپ‌ها |
| `DB_PATH` | `$DATA_DIR/panel.db` | مسیر دیتابیس SQLite |
| `WEB_DIST` | `../web/dist` | مسیر فایل‌های build شده فرانت |
| `JWT_SECRET` / `ENCRYPTION_KEY` | خودکار | اگر خالی بماند یک‌بار در `runtime-secrets.json` ساخته می‌شود |
| `XUI_URL` | — | آدرس کامل API پنل ۳x-ui شامل مسیر مخفی پنل |
| `XUI_TOKEN_FILE` | `$DATA_DIR/secrets/xui-token` | فایل توکن API |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | فقط برای ساخت اولیه مدیر |

### سرویس systemd

```ini
[Unit]
Description=Sulduz Cloud reseller panel
After=network.target

[Service]
Type=simple
User=sulduz
Group=sulduz
WorkingDirectory=/opt/sulduzcloud/server
EnvironmentFile=/opt/sulduzcloud/server/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/sulduzcloud

[Install]
WantedBy=multi-user.target
```

### nginx (نمونه)

```nginx
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    root /opt/sulduzcloud/web/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        client_max_body_size 512m;   # برای بازگردانی بکاپ
    }

    location /assets/ {
        try_files $uri =404;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files $uri /index.html;
    }
}
```

### آماده‌سازی ۳x-ui

1. در پنل ۳x-ui یک API Token بسازید و در `XUI_TOKEN_FILE` ذخیره کنید (دسترسی 600).
2. اینباندهایی که می‌خواهید نمایندگان روی آن‌ها کانفیگ بسازند باید در پنل ۳x-ui وجود داشته باشند؛ سپس در پنل، صفحه «اینباندها» → «همگام‌سازی».
3. نودها/سرورها بر اساس اینباندهای همان پنل شناسایی می‌شوند؛ برای دیده‌شدن وضعیت هر نود، پایش را در تنظیمات فعال کنید.
4. پنل هیچ‌وقت UUID کلاینت‌های موجود را تغییر نمی‌دهد و اینباندها/کلاینت‌های ۳x-ui را بازنویسی نمی‌کند؛ فقط از API برای ساخت/حذف/ویرایش همان کانفیگ‌هایی استفاده می‌کند که خودش ساخته است.
5. قبل از هر بازگردانی بکاپ، از دیتابیس ۳x-ui نسخه پشتیبان بگیرید (بکاپ پنل فقط دیتابیس پنل است، نه ۳x-ui).

### بکاپ

- بکاپ خودکار روزانه در ساعت تنظیم‌شده (پیش‌فرض 03:30) و نگهداری ۱۴ نسخه
- بکاپ دستی از صفحه «پشتیبان‌گیری»
- بازگردانی از همان صفحه؛ سرور پس از ثبت درخواست، دیتابیس را جایگزین و سرویس را ری‌استارت می‌کند
- بکاپ‌ها شامل دیتابیس پنل هستند (کاربران، کانفیگ‌ها، تراکنش‌ها، تنظیمات، لاگ‌ها)

### API نمایندگی

```bash
curl -H "X-API-Key: sc_xxx" https://panel.example.com/api/v1/me
```

| متد | مسیر | کار |
| --- | --- | --- |
| GET | `/api/v1/me` | پروفایل و آمار |
| GET | `/api/v1/inbounds` | اینباندهای مجاز |
| GET | `/api/v1/configs` | فهرست کانفیگ‌ها |
| POST | `/api/v1/configs` | ساخت کانفیگ |
| GET | `/api/v1/configs/:id` | جزئیات |
| POST | `/api/v1/configs/:id/extend` | تمدید/افزایش حجم |
| POST | `/api/v1/configs/:id/toggle` | فعال/غیرفعال |
| DELETE | `/api/v1/configs/:id` | حذف |
| GET | `/api/v1/usage` | سری مصرف N روز اخیر |

کلید API فقط برای حساب‌های نمایندگی است و در پروفایل/صفحه «API» قابل ساخت و ابطال است.

### تست

```bash
cd /opt/sulduzcloud/server
npm run selftest
```

تست خودکار ۴۲ مورد را پوشش می‌دهد: راه‌اندازی اولیه، ورود/خروج، ابطال نشست، CSRF، ساخت/تمدید/حذف کانفیگ، محدودیت‌ها، کیف پول، تیکت، بکاپ، لاگ فعالیت و کلید API. تست‌ها روی دیتابیس موقت اجرا می‌شوند.

### ساختار پروژه

```
server/
  src/
    index.js          نقطه ورود، static، بکاپ خودکار
    config.js         خواندن .env و اسرار زمان اجرا
    db.js             SQLite + مایگریشن
    auth.js           JWT، CSRF، نشست‌ها
    settings.js       تنظیمات پیش‌فرض
    services/         users, configs, inbounds, xui, stats, monitor, backup, mail, sms
    routes/           public, admin, reseller, apiV1
  test/selftest.js
web/
  src/
    pages/            admin/, reseller/, auth/
    components/       Shell, ui, charts, config form & drawer
    lib/              api, auth, i18n, format, nodes
  public/fonts/       Vazirmatn.woff2
```

### لایسنس

نرم‌افزار تجاری است. فایل [LICENSE](LICENSE) را بخوانید. خریدار اجازه انتشار مجدد کد را ندارد.

---

## English

### What it does

Each reseller signs in with their own username/password and, within the limits the admin sets, creates and renews configs, adds traffic/time, and tracks usage, wallet, tickets and notifications. The admin manages resellers, configs on any inbound/node, inbound visibility, servers and nodes with email/SMS outage alerts, statistics, backups, audit log, staff permissions and settings. All config operations go through the 3x-ui HTTP API; the panel never rewrites the 3x-ui database.

### Feature highlights

- **Admin**: dashboard KPIs, resellers with per-module permissions and quotas (configs, GB per config, total GB, IP limit, expiry, balance, API key), configs on any inbound for any reseller, renew/extend/toggle/reset, subscription link + URI + QR, CSV export, inbound sync/visibility, multiple x-ui servers (add/edit/delete; deleting the last server returns the panel to its blank first-run state, while a server that still owns configs is protected so live clients are never cut), live per-panel server status with latency plus CPU/RAM/disk usage, and node status, email/SMS outage alarms, traffic & revenue reports, tickets, broadcast, manual/auto backups with retention and restore, audit log, settings (general, x-ui, monitoring, email, SMS, wallet, backups, security).
- **Reseller**: self-service configs within limits, renew & add traffic, usage stats, wallet & transactions, tickets, notifications, profile/password, API keys with REST docs.
- **Security**: JWT in HttpOnly cookie, CSRF double-submit, bcrypt, session revocation, login rate limit, Helmet, zod validation, audit log, per-key API rate limit.
- **UI**: full fa/en with RTL/LTR, locally bundled Vazirmatn, premium dark theme, charts, skeletons, toasts, responsive mobile layout.

### Requirements

A fresh Ubuntu/Debian box (or any Linux with Node.js 20+, `python3`, `make`, `g++`), a reachable 3x-ui panel with an API token, and the private installation key (the repository only stores its SHA-256).

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh | sudo bash -s -- --key "<installation key>"

# with a domain and a Let's Encrypt certificate up front:
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
  | sudo bash -s -- --key "<installation key>" --domain panel.example.com --ssl-email you@example.com
```

The installer provisions Node.js 20, nginx and the systemd unit, and builds the web panel. Open the panel afterwards, create the owner account on first run, then connect 3x-ui from **Settings → 3x-ui** or **Servers → Add server**, sync inbounds and set prices.

### Server menu

The installer drops `sulduzcloud` in `/usr/local/bin` (shortcut: `sc`). Run it as root: `sudo sulduzcloud` for the interactive menu, or directly `sulduzcloud status`, `sulduzcloud accounts`, `sulduzcloud domain <host>`, `sulduzcloud ssl`, `sulduzcloud backup`, `sulduzcloud restart`. Passwords are stored as bcrypt hashes and cannot be recovered, so `accounts` shows the admin user name, shows the password if it was set from the menu (kept in `/etc/sulduzcloud/admin.cred`, mode 600, root only) and issues a new one on request. The menu never touches 3x-ui, inbounds or clients.

Environment variables, the systemd unit and the nginx sample are documented in the Persian section above (same names and values).

### Reseller API

`GET /api/v1/me`, `/inbounds`, `/configs`, `/configs/:id`, `/usage`; `POST /configs`, `/configs/:id/extend`, `/configs/:id/toggle`; `DELETE /configs/:id`. Authenticate with `X-API-Key: sc_...` (or `Authorization: Bearer sc_...`).

### Tests

```bash
cd server && npm run selftest
```

83 automated checks covering setup, auth, session revocation, CSRF, multi-panel management, config creation and renewal against a mock 3x-ui, wallet charges, quotas, tickets, backups, audit log and API keys, on a temporary database.

### License

Commercial/proprietary. See [LICENSE](LICENSE). Redistribution or resale of the source is not permitted.
