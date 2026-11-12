# Sulduz Cloud

پنل مدیریت نمایندگی و کانفیگ VPN — دو زبانه (فارسی/انگلیسی)، تم تیره حرفه‌ای، متصل به ۳x-ui.

A bilingual (Persian/English) reseller & config management panel for 3x-ui, with a premium dark UI, per-reseller limits, wallet, tickets, live node status, backups and a reseller REST API.

Version 1.5.3 · Node.js 20+ · SQLite · React 18 · multi-panel

---

## نصب خودکار (Quick install)

یک فرمان روی سرور تازهٔ Ubuntu/Debian. بدون کلید نصب و بدون رمز فعال‌سازی (از نسخهٔ ۱.۵.۳): هر کسی که به سرور خودش root دارد می‌تواند نصب کند.

```bash
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh | sudo bash
```

همین یک فرمان Node.js 20، nginx، سرویس systemd و بیلد وب‌پنل را نصب می‌کند و فرمان `sulduzcloud` (منوی سرور: رمز مدیر، دامنه، SSL، بکاپ) را آماده می‌گذارد. دامنه و گواهی را بعداً با `sudo sulduzcloud` تنظیم کنید، یا همان اول در دستور بیاورید:

```bash
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
  | sudo bash -s -- --domain panel.example.com --ssl-email you@example.com
```

---

## فارسی

### این پروژه چه می‌کند؟

هر نمایندگی با نام کاربری و رمز خودش وارد پنل شخصی می‌شود و در محدوده‌ای که مدیر تعیین کرده کانفیگ می‌سازد، تمدید می‌کند، حجم/زمان اضافه می‌کند و آمار و کیف پول و تیکت‌هایش را می‌بیند. مدیر روی همه نمایندگان، کانفیگ‌ها، اینباندها، سرورها، آمار، بکاپ، لاگ فعالیت و تنظیمات کنترل کامل دارد. همه عملیات کانفیگ مستقیماً از طریق API پنل ۳x-ui انجام می‌شود؛ پنل دیتابیس ۳x-ui را مستقیم تغییر نمی‌دهد.

### امکانات

**پنل مدیر**

- نمای کلی: کانفیگ‌ها، نمایندگان، ترافیک امروز/۷ روز، تیکت‌های باز، وضعیت شبکه، توزیع مصرف اینباندها، برترین نمایندگان
- نمایندگان: ساخت/ویرایش/غیرفعال‌سازی، سقف تعداد کانفیگ، سقف حجم هر کانفیگ و حجم کل، محدودیت IP، تاریخ انقضا، دسترسی ماژول‌به‌ماژول، کیف پول، کلید API، ریست رمز
- کانفیگ‌ها: فهرست گروه‌شده (هر مشتری بستهٔ چند‌اینباندی یک ردیف نمایش داده می‌شود، نه چند ردیف جدا)، ساخت روی هر اینباندِ هر نود برای هر نماینده، ساخت بستهٔ چند‌اینباندی به‌شکل یک کلاینت x-ui که به همهٔ اینباندهایش وصل است — پس لینک سابسکرایب مشتری همان آدرس اشتراک سرور نود می‌ماند و همهٔ کانال‌هایش را یکجا نشان می‌دهد؛ فقط بسته‌ای که واقعاً بین چند کلاینت تقسیم شده باشد (۳x-ui اجازهٔ subId تکراری بین کلاینت‌ها را نمی‌دهد) را پنل با یک لینک تجمیعی سرو می‌کند و یکپارچه‌سازی آن با پیش‌نمایش و تأیید در فرم نماینده هست)، تمدید، افزایش حجم، فعال/غیرفعال، لینک اشتراک و URI + QR، خروجی CSV
- حذف اشتراک با یک دکمه: در کشوی هر کانفیگ فقط یک «حذف» هست که کل بستهٔ مشتری را هم از پنل نمایندگی و هم از x-ui پاک می‌کند (دکمهٔ جداگانهٔ «حذف کل اشتراک» برداشته شد). بسته‌ای که کلاینتش روی نود نیست هم حذف می‌شود — پنل پاسخ «record not found» را یعنی «از قبل آنجا نیست» می‌فهمد و ردیف‌های محلی را پاک می‌کند، بدون آنکه چیزی روی نود بنویسد. اگر نود در دسترس نباشد یا خطای دیگری بدهد، حذف انجام نمی‌شود و هیچ ردیفی پاک نمی‌شود تا مشتری قطع نشود. بستهٔ دریافت‌شده از پنل (adopted) فقط فراموش می‌شود و کلاینت پنل مبدأ دست‌نخورده می‌ماند
- فیش‌های واریزی نماینده‌ها: هر فیشی که نماینده از ربات تلگرام می‌فرستد اینجا با تصویر، مبلغ، نام نمایندگی و زمان می‌آید. مدیر می‌تواند مبلغ را اصلاح کند، تأیید کند (فقط همان یک بار کیف پول شارژ می‌شود) یا با یادداشت رد کند؛ رد کردن هیچ پولی جابه‌جا نمی‌کند. فیش تصمیم‌گرفته‌شده فقط خواندنی است و نام تصمیم‌گیرنده، زمان و یادداشتش ثبت می‌شود. همین صفحه وضعیت ربات (روشن/خاموش، در حال اجرا، تداخل ۴۰۹) و دکمهٔ راه‌اندازی دوباره را هم نشان می‌دهد
- جست‌وجوی کانفیگ در x-ui: مدیر با uuid، email یا remark (فارسی هم) روی هر پنل جست‌وجو می‌کند و نتیجه را می‌بیند — این جست‌وجو فقط خواندنی است و چیزی روی نود نمی‌نویسد. سپس می‌تواند همان کلاینت را به لیست کانفیگ‌های یک نماینده اضافه کند (adopt)؛ همهٔ اینباندهای آن کلاینت یک بسته می‌شوند و افزودن دوبارهٔ همان کلاینت کاری نمی‌کند
- ربات دوطرفهٔ تلگرام: با همان توکن ربات پنل، هر نماینده‌ای که آیدی عددی تلگرامش در حسابش ثبت شده می‌تواند موجودی (`/balance`)، آمار (`/stats`) و فیش واریزی (`/topup`) را از ربات ببیند/بفرستد. فیش دو مرحله‌ای است (عکس، بعد مبلغ) و برای مدیر با دکمهٔ «تأیید»/«رد» می‌رود؛ تا مدیر تأیید نکرده هیچ پولی به کیف پول اضافه نمی‌شود. سوییچ ربات در تنظیمات است و اگر خاموش باشد یا توکنی ذخیره نشده باشد، ربات بی‌حرکت می‌ماند و هیچ درخواستی به تلگرام نمی‌فرستد
- کیبورد دکمه‌ای ربات (۱٫۵٫۳): نماینده دیگر لازم نیست دستور حفظ کند؛ `/start` یک کیبورد ماندگار سه‌ردیفه می‌دهد — «💰 موجودی · 💳 افزایش موجودی · 📦 آمار اشتراک‌ها»، «🧾 فیش‌های من · 📊 آمار مصرف · 📖 راهنما» و «❌ لغو». هر دکمه دقیقاً همان کد دستور معادلش را صدا می‌زند، پس متن `/balance` و دکمهٔ موجودی یکی است. مدیر کیبورد جدا دارد: «👥 آمار نمایندگان · 💰 شارژ/کسر نماینده · 🧾 فیش‌های در انتظار · 📖 راهنمای مدیر». منوی دستور بومی تلگرام هم جدا ثبت می‌شود: دستورات کیف پول در چت خصوصی و دستورات ناوگان فقط در چت مدیر
- شارژ و کسر موجودی نماینده از ربات (۱٫۵٫۳): مدیر آیدی عددی تلگرام یا نام کاربری نماینده را می‌فرستد، بعد مبلغ، بعد جهت (افزایش/کسر) و در آخر یک تأییدیه که پیش از جابه‌جایی پول همه‌چیز را دوباره می‌خواند. دکمه‌های جهت «-»، `-1` و `-500` را می‌فهمند و علامت از متن خوانده می‌شود نه از `Number()`. مسیر پول همان `usersService.adjustBalance` پنل است، پس یک ردیف `transactions` و یک `user.balance` در لاگ فعالیت نوشته می‌شود و کسری که موجودی را منفی کند رد می‌شود؛ فشردن دکمهٔ کهنه، جعل مبلغ در payload، یا فیش‌اکتاری دکمهٔ مدیر توسط شخص دیگر همه رد می‌شود. «آمار نمایندگان» هم موجودی، تعداد بسته و مصرف را هشت ردیف در هر صفحه نشان می‌دهد
- آمار اشتراک‌ها داخل ربات (۱٫۵٫۳): «📦 آمار اشتراک‌ها» همان بسته‌های گروه‌شدهٔ پنل را می‌خواند — کل، فعال، تمام‌شده، بی‌حجم، غیرفعال، و آن‌که تا سه روز دیگر تمام می‌شود یا به آخر سهمیهٔ مشترک رسیده — با روزهای باقی‌مانده، گیگابایت مانده و درصد مصرف، و فقط در محدوده‌ای که به آن نماینده اجازهٔ دیدن داده شده. «🧾 فیش‌های من» هشت فیش آخر خودش را با وضعیت و یادداشت مدیر نشان می‌دهد
- اینباند ثابت هر نماینده: در مودال ویرایش نمایندگی یک کادر جدا اینباند پایه را مشخص می‌کند. آن اینباند هنگام ساخت کانفیگ خودکار انتخاب می‌شود و تا بسته عضو دیگری دارد از بسته برداشته نمی‌شود؛ اگر کانفیگ قدیمی (دریافت‌شده از پنل ۳x-ui) آن را نداشته باشد، پنل پس از نمایش تعداد بسته‌های نیازمند و تأیید صریح مدیر، همان اینباند را به‌صورت رایگان (بدون کسر از کیف پول و بدون حجم اضافه) روی بسته‌ها اعمال می‌کند
- اینباندها: همگام‌سازی از ۳x-ui، نمایش/مخفی‌سازی برای نمایندگان، ویرایش مشخصات. «مخفی» درِ فهرست پیش‌فرض است، نه وتوی دسترسی: کانالی که مدیر در فرم نمایندگی دستی برای یک نماینده تیک زده، برای همان نماینده قابل استفاده است حتی اگر پرچم مخفی روشن بماند — پرچم `visible` تغییر نمی‌کند و بقیهٔ نماینده‌ها آن کانال را نمی‌بینند. هر کانال تازه‌ای که همگام‌سازی پیدا می‌کند `visible = 0` متولد می‌شود و تا مدیر چشمش را روشن نکند، فقط با همین تیکِ اسمی قابل فروش است
- پنل‌های x-ui متعدد: افزودن/ویرایش/حذف چند پنل ۳x-ui هم‌زمان؛ هر اینباند و کانفیگ به سرور خودش وصل است، همگام‌سازی و پایش جدا برای هر پنل، نمایش زندهٔ مصرف پردازنده/رم/دیسک هر سرور. حذف تنها سرورِ باقی‌مانده مجاز است و پنل را به همان حالت خام اول برمی‌گرداند؛ سروری که هنوز کانفیگ فعال دارد حذف نمی‌شود تا کلاینت‌های زنده قطع نشوند
- سرورها و نودها: وضعیت زنده پنل‌ها و نودها، تأخیر، موجودی منابع، بررسی فوری، هشدار قطعی از طریق ایمیل و پیامک (کاوه‌نگار، فراز اس‌ام‌اس یا سرویس سفارشی)
- آمار و گزارش: روند ترافیک، درآمد، وضعیت کانفیگ‌ها، برترین نمایندگان، تراکنش‌ها
- گزارش شبانهٔ تلگرام برای نماینده‌ها (سوییچش خاموش است مگر مدیر خودش روشن کند): هر شب در ساعت و دقیقهٔ انتخابی — به وقت پنل — برای هر نماینده که آیدی عددی تلگرامش در تنظیمات همان نماینده ثبت شده سه بخش فرستاده می‌شود: خرید امروز و موجودی باقی‌ماندهٔ کیف پول، اشتراک‌هایی که امروز تمام یا غیرفعال شدند، و اشتراک‌هایی که نزدیک اتمام‌اند (تاریخ یا حجم). یک خلاصهٔ کل نماینده‌ها هم برای مدیر می‌رود. هر ارسال در جدول `daily_reports` ثبت می‌شود تا ریستارت سرویس نتواند همان گزارش را دوباره بفرستد، و در تنظیمات پیش‌نمایش هر نماینده، ارسال دستی و تاریخچهٔ ارسال هست
- تیکت‌ها، اطلاع‌رسانی گروهی (همه/مدیران/انتخابی)، تاریخچه ارسال
- بکاپ: بکاپ دستی، بکاپ خودکار روزانه، نگهداری N نسخه، دانلود و بازگردانی
- گزارش فعالیت (Audit log) برای عملیات حساس
- تنظیمات: عمومی، اتصال ۳x-ui، پایش و هشدار، ایمیل (SMTP)، پیامک، کیف پول، بکاپ، تلگرام (ربات دوطرفه + گزارش شبانه)، امنیت
- نمایش نسخهٔ برنامه و سازنده (تیم سولدوز سرور) در سایدبار، صفحه ورود و تنظیمات

**پنل نمایندگی**

- ساخت و تمدید کانفیگ با رعایت سقف‌ها، افزودن حجم/زمان؛ ریست مصرف فقط همراه تمدید و با پرداخت تعرفهٔ حجم جدید (ریست رایگان نماینده حذف شده و جایش دکمهٔ «بروزرسانی مصرف» از نود نشسته است)
- افزودن اینباند به مشتریِ فعلی برای نماینده رایگان است: هزینهٔ بسته هنگام ساخت آن پرداخت می‌شود و کانال جدید همان حجم و زمان مشترک را می‌گیرد (حجم و زمان تازه‌ای اضافه نمی‌شود)، پس کیف پول او برای این کار کسر نمی‌شود و حتی با موجودی صفر هم انجام می‌شود. مبلغ تعرفه در همان فهرست فقط برای اطلاع و کم‌رنگ با برچسب «بدون کسر» دیده می‌شود. تنها حالتِ پولیِ این اکشن، تیک «کسر از کیف پول نماینده» توسط مدیر اصلی است
- لینک اشتراک، URI و QR برای هر کانفیگ
- آمار مصرف، کیف پول و تراکنش‌ها، تیکت، اطلاعیه‌ها، پروفایل و تغییر رمز
- افزایش/کاهش موجودی روی گوشی درست کار می‌کند: فیلد مبلغ دیگر کیبورد فقط‌عددی باز نمی‌کند (که علامت + و − نداشت)؛ کیبورد کامل با دکمهٔ «افزایش»/«کاهش» و میان‌برهای مبلغ باز می‌شود و نوشتن عدد منفی خودش حالت را به «کاهش» می‌برد. مبلغ بیشتر از موجودی در حالت کاهش، دکمه را غیرفعال می‌کند و درخواستی فرستاده نمی‌شود
- فیش واریزی از ربات تلگرام: نماینده عکس فیش را برای ربات می‌فرستد، مبلغ را می‌گوید، و وضعیت همان فیش (در انتظار / تأیید / رد) با یادداشت مدیر در کیف پول خودش دیده می‌شود — فقط فیش‌های خودش، بدون هیچ اطلاعات داخلی تلگرام
- افزایش موجودی از ربات، داخل پنل (۱٫۵٫۳): صفحهٔ کیف پول نماینده یک کادر دارد که با یک دکمه او را مستقیم وارد گفت‌وگوی ارسال فیش در ربات می‌کند: `t.me/<bot>?start=topup`. نام کاربری ربات از `getMe` گرفته و یک‌بار در `bot_state` کش می‌شود؛ تا آن لحظه که ربات خودش را به پنل معرفی نکرده، کادر به‌جای نشاندن یک لینک شکسته، صادقانه همان را می‌گوید
- موجودی زنده بالای صفحه (۱٫۵٫۳): نماینده موجودی کیف پولش را در هدرِ همهٔ صفحه‌ها می‌بیند؛ عدد هر ۲۰ ثانیه از `/reseller/balance` دوباره خوانده می‌شود، وقتی تب به پیش‌زمینه برمی‌گردد و هر بار که بین صفحه‌ها جابه‌جا می‌شوید هم تازه می‌شود، و با هر شارژ سبز و هر کسر قرمز چشمک می‌زند. فیشی که مدیر یا ربات تأیید کند بدون تازه‌کردن صفحه در همین هدر دیده می‌شود. برای مدیر این کادر نمایش داده نمی‌شود چون کیف پول جداگانه‌ای ندارد
- آمار ترافیک روزانه از دفتر روزانهٔ خود پنل خوانده می‌شود: ۳x-ui فقط یک شمارندهٔ تجمعی می‌دهد، پس اختلاف آن روی روزهایی که مصرف واقعاً در آن‌ها افتاده تقسیم می‌شود (زمان‌بندی بر پایهٔ منطقهٔ زمانی پنل، حداکثر ۷ روز) — سکوت چندروزهٔ پنل دیگر به‌شکل یک روز پرحجم در آمار نمی‌آید
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
- بدون کلید نصب و بدون رمز فعال‌سازی — از نسخهٔ ۱.۵.۳ اسکریپت هر سروری را که root روی آن دارد نصب می‌کند

### نصب با یک فرمان

```bash
sudo bash install.sh
# یا از روی مخزن:
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
  | sudo bash
```

اسکریپت خودش Node.js 20، nginx، سرویس systemd و بیلد وب را انجام می‌دهد. گزینه‌ها:

| گزینه | توضیح |
| --- | --- |
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
npm run selftest        # راه‌اندازی، ورود/خروج، CSRF، بسته‌های چند‌اینباندی، تمدید، کیف پول، تیکت، بکاپ، لاگ فعالیت، کلید API
npm run telegram-test   # دریافت اشتراک‌های موجود پنل‌ها بر اساس آیدی تلگرام
npm run sms-test        # متن و پترن پیامک‌ها
npm run report-test     # گزارش شبانهٔ تلگرام: ساخت متن، گیرنده‌ها، ارسال، دفتر روزانه
npm run bot-test        # ربات دوطرفه: شناسایی نماینده، فیش دو مرحله‌ای، دکمه‌های مدیر، شارژ یک‌باره
```

هر پنج تست روی دیتابیس موقت اجرا می‌شوند و تعداد موارد خودشان را در پایان چاپ می‌کنند. تست‌های `report-test` و `bot-test` فرستادن به تلگرام را با یک ضبط‌کنندهٔ محلی جایگزین می‌کنند و دسترسی شبکه را هم می‌بندند، پس در هیچ اجرا از این پنج تست یک پیام واقعی به هیچ چتی فرستاده نمی‌شود.

### ساختار پروژه

```
server/
  src/
    index.js          نقطه ورود، static، بکاپ خودکار
    config.js         خواندن .env و اسرار زمان اجرا
    db.js             SQLite + مایگریشن
    auth.js           JWT، CSRF، نشست‌ها
    settings.js       تنظیمات پیش‌فرض
    services/         users, configs, inbounds, servers, pricing, stats, monitor,
                      tickets, telegram, reports (گزارش شبانه), bot (ربات دوطرفه),
                      topups (فیش واریزی), backup
    routes/           public, admin, reseller, apiV1
    xui.js notify.js restore.js audit.js crypto.js utils.js
  test/               selftest.js, telegram-import.js, sms-text.js, daily-report.js,
                      bot-topup.js
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

- **Admin**: dashboard KPIs, resellers with per-module permissions and quotas (configs, GB per config, total GB, IP limit, expiry, balance, API key, numeric Telegram id), configs on any inbound for any reseller (packages are listed as one customer row), multi-inbound packages built as ONE 3x-ui client attached to every inbound the customer bought — so his subscription link stays the node's own subscription address and lists all of his channels there; only a package that genuinely spans several clients (3x-ui rejects a subId shared by two clients) is served through one aggregated link on this panel, and a preview-then-confirm merge puts split packages back onto the customer's own client, renew/extend/toggle, a node-side usage refresh that changes nothing, subscription link + URI + QR, CSV export, client names shaped `<telegramId>-<random>` with automatic adoption of subscriptions that already live on the panels under that id, a per-reseller on/off switch plus a load/refresh button for that adoption (turning it off only hides the adopted rows; nothing is deleted from x-ui), legacy x-ui subscriptions kept separate from panel customers with their own "old" badge and source filter, inbound sync/visibility, multiple x-ui servers (add/edit/delete; deleting the last server returns the panel to its blank first-run state, while a server that still owns configs is protected so live clients are never cut), live per-panel server status with latency plus CPU/RAM/disk usage, and node status, email/SMS outage alarms (Kavenegar, FarazSMS or a custom endpoint), traffic & revenue reports, tickets, broadcast, manual/auto backups with retention and restore, audit log, settings (general, x-ui, monitoring, email, SMS, wallet, backups, telegram — the two-way bot and the nightly report — security), and the app version + author (Sulduz Server Team) shown in the sidebar, login page and settings.
- **Reseller**: self-service configs within limits, renew & add traffic, usage stats, wallet & transactions, tickets, notifications, profile/password, API keys with REST docs. Adding an inbound to a customer he already has is free: he paid for the package when he built it and the new channel joins the same shared quota and expiry (no extra bytes, no extra days), so his wallet is not touched and the add works even at balance zero — the tariff is shown greyed out with a "no charge" mark, for information only. The only paid case left for that action is the main admin ticking "charge the reseller's wallet". Daily traffic comes from the panel's own day ledger: 3x-ui only exposes a cumulative counter, so the delta of a sync window is spread over the days it actually covers (panel-timezone midnights, seven days at most) instead of landing in one heap on the day the panel woke up.
- **Nightly Telegram report (ships switched off)**: at the hour and minute the owner picks, in the panel timezone, every reseller whose numeric Telegram id is saved in his settings receives three sections — what he bought today and what is left in his wallet, the subscriptions that ended or ran out today, and the ones about to end by date or by shared volume — plus a fleet digest for the owner. Each attempt is remembered per recipient per day, so a restart cannot send the same report twice; the settings page has the schedule, both role switches, a preview of every message, a manual send and the delivery history.
- **One delete button (v1.5.2)**: the config drawer has a single Delete that removes the customer's whole package from the reseller panel AND from x-ui; the separate "delete the whole subscription" button is gone. A package whose client is no longer on the node can be deleted too — the panel reads 3x-ui's "record not found" as "already gone", clears the local rows and writes nothing to the node. A node that is unreachable or answers with any other error refuses the delete and keeps every row, so a customer is never cut by accident. An adopted package is only forgotten locally; the client on the panel it came from stays alive.
- **Payment receipts (v1.5.2)**: every receipt a reseller sends through the Telegram bot lands in an admin inbox with the image, the amount, the reseller and the time. The admin can correct the amount, approve (the wallet is credited exactly once) or reject with a note; a rejection moves no money. A decided receipt is read-only and keeps who decided, when, and the note. The same page shows the bot's state (enabled, running, 409 conflict) and a restart button that reports honestly whether the bot is actually polling or just idle.
- **Find a client on x-ui (v1.5.2)**: the admin searches any panel by uuid, email or remark (Persian included) and reads the result — the search is read-only and writes nothing to the node. He can then adopt that client into a reseller's config list; every inbound the client is on becomes one package, and adopting the same client again is a no-op.
- **Two-way reseller bot (v1.5.2)**: on the panel's own bot token, any reseller whose numeric Telegram id is saved on his account can read his balance (`/balance`) and his numbers (`/stats`), and send a payment receipt (`/topup`) as a two-step conversation (photo, then amount). The receipt goes to the admin with Approve / Reject buttons, and no money moves until he approves. `/start`, `/help`, `/cancel` and an admin `/pending` list are there too. The switch lives in settings; with the switch off or no token saved the bot stays idle and makes no Telegram call at all. A restart never replays old updates (the offset is stored in the database) and a bot that already has a webhook is left to that webhook.
- **Reseller wallet on a phone (v1.5.2)**: the amount field no longer opens a digits-only keyboard with no way to type a sign. It opens the full keyboard with Increase / Decrease chips and amount shortcuts, typing a negative number switches the mode to Decrease by itself, and a decrease larger than the balance disables the button without sending a request. The reseller also sees his own receipts (pending / approved / rejected) with the admin's note in his wallet — only his own, with no Telegram internals in the payload.
- **Button keyboards in the bot (v1.5.3)**: the reseller's `/start` is no longer a list of commands he has to remember. A persistent three-row keypad — موجودی · افزایش موجودی · آمار اشتراک‌ها on the first row, فیش‌های من · آمار مصرف · راهنما on the second, لغو on its own — answers every menu and every step, and each button is wired to the same code as its command, so `/balance` and 💰 موجودی produce the identical message. The admin gets his own keypad: آمار نمایندگان · شارژ/کسر نماینده · فیش‌های در انتظار · راهنمای مدیر. `getUpdates` never touches a webhook, the native command menu is registered per scope (wallet commands in private chats, the fleet commands only in the decision chat) and the bot's own username is cached from `getMe` once, so a link can be promised without a second call.
- **Subscription stats inside the bot (v1.5.3)**: 📦 آمار اشتراک‌ها reads the same grouped packages the panel lists — total, active, ended, out of volume, disabled, and the ones expiring inside three days or almost out of their shared quota — each with days left, gigabytes left and the percentage consumed, scoped to what that reseller is allowed to see. 🧾 فیش‌های من gives him his own last eight receipts with their state and the admin's note.
- **Charging a reseller from the bot (v1.5.3)**: the admin's 💰 شارژ/کسر نماینده asks for a numeric Telegram id or a username, resolves it to a live reseller account (never an admin, never the owner's own wallet), then amount, then direction, then a confirmation that re-reads everything before it moves. The buttons accept «-», `-1` and `-500` as "decrease" and the sign is read from the text, not from `Number()`. A charge or a deduction calls the same `usersService.adjustBalance` as the panel does, so it writes one `transactions` row and one `user.balance` audit entry, and a deduction that would go below zero is refused. Tapping a stale button, forging the amount in the callback payload, or a stranger replaying the admin's callback id all get refused. 👥 آمار نمایندگان lists id, balance, package count and consumption eight rows per page with page buttons.
- **Top up from the panel, in the bot (v1.5.3)**: the reseller wallet page has a card that opens the bot straight into the receipt conversation through `t.me/<bot>?start=topup` — the bot's own username comes from `getMe`, is cached in `bot_state`, and is only ever shown when it is actually known; before that the card says so instead of printing a broken link. The deep link opens the top-up step with the chat already primed; `/start menu` shows the keypad and an unknown payload is answered with the keypad and no section at all.
- **Live balance in the header (v1.5.3)**: the reseller sees his wallet balance at the top of every page, re-read from `/reseller/balance` every twenty seconds, when the tab comes back to the foreground and whenever he navigates, and the chip flashes green on a credit or red on a debit. An approved receipt in the panel or in the bot changes that number without a reload; admins get no chip because they have no wallet of their own.

- **Security**: JWT in HttpOnly cookie, CSRF double-submit, bcrypt, session revocation, login rate limit, Helmet, zod validation, audit log, per-key API rate limit.
- **UI**: full fa/en with RTL/LTR, locally bundled Vazirmatn, premium dark theme, charts, skeletons, toasts, responsive mobile layout.

### Requirements

A fresh Ubuntu/Debian box (or any Linux with Node.js 20+, `python3`, `make`, `g++`) and a reachable 3x-ui panel with an API token. No installation key and no activation code: since v1.5.3 the installer runs on any server you have root on.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh | sudo bash

# with a domain and a Let's Encrypt certificate up front:
curl -fsSL https://raw.githubusercontent.com/rezafazli1375/sulduzcloud/main/install.sh \
  | sudo bash -s -- --domain panel.example.com --ssl-email you@example.com
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

`selftest` covers setup, auth, session revocation, CSRF and multi-panel management; one-client packages (create, add a channel, take one off, rotate the subscription id, merge a package that was split over two clients — the client that holds only the reseller's fixed inbound is the copy that goes, the customer's own client survives and receives that channel — and refuse to delete a duplicate when the node refused the attach); quota pooling; renewal and the subscription address (a customer is always handed the node's own link for his x-ui client, and the panel only falls back to its aggregated `/api/sub/<token>` address when the server has no subscription base); rebuilding a customer whose x-ui client was deleted on the node; the renewal-charging policy and the replacement reset that a reseller can no longer get for free; adding a channel to a customer the reseller already has is free even on an empty wallet (and stays free when his own session posts `charge: true`), while an admin who ticks the charge switch is still refused there; the inbound-visibility rule — a channel the admin ticked by name in the reseller form is sellable for that reseller even while the panel still flags it hidden, while the default offer of an empty allow list and every other reseller stay exactly as they were, and the flag itself is never rewritten; wallet charges, quotas, tickets, backups, the audit log and API keys. It runs against a mock 3x-ui that enforces the real subId uniqueness rule and the real attachment rule (a channel only moves with `clients/bulkAttach` / `clients/<email>/detach`; `clients/update` rewrites the client where it already lives and ignores a channel it is not in yet, and a client that is not on the panel answers "record not found"). v1.5.2 adds the single delete (a package whose client is gone is cleared locally with zero node writes, an unreachable node refuses the delete and keeps every row, an adopted package is only forgotten), the read-only x-ui client search by uuid/email/remark and its adoption into a reseller's list as one package, and the receipt inbox: approving credits exactly once, a corrected amount is what gets credited, rejecting moves no money and keeps the note, a decided row is read-only, and a reseller can only ever read his own receipts while the admin inbox, the approve route, the node search and the adopt route all stay closed to him. v1.5.3 adds the two panel routes behind the new UI — `/reseller/balance` answers the money, the currency and the number of receipts still waiting (and an admin on the same route reads his own wallet, never the shop's), and `/reseller/bot` plus `/admin/bot` hand out the `t.me/<bot>?start=…` link built from the cached `getMe` answer, degrading to an empty link and `commands: false` rather than a broken URL or a 500 when the bot has no username yet. `bot-test` covers the keypads themselves (row order and labels, button text identical to the command text), the subscription-stats and own-receipts sections, the four deep links (`?start=topup|balance|packages|receipts`), an unknown payload that is refused with the keypad and no section at all, `getMe` being called exactly once and cached, the per-scope command registration, the admin paging over a ten-reseller fleet, and the whole charge/deduct conversation including the refusals: stale step, forged amount, second tap, stranger tap, self-target and a deduction the balance cannot cover — with the resulting `transactions` and `audit_logs` rows read back from the database.

```bash
cd server
npm run telegram-test   # adopting the subscriptions that already live on the panels, by Telegram id
npm run sms-test        # SMS text and pattern rendering
npm run report-test     # the nightly report: its three sections, its recipients, its delivery ledger
npm run bot-test        # the two-way bot: identity, the two-step receipt, the admin's buttons, the single credit
```

Every suite runs on a temporary database and reports its own check count when it finishes. `report-test` and `bot-test` replace the Telegram transport with an in-process recorder and refuse every network call, so no test run can ever put a real message into a real chat. `bot-test` drives the conversation in process (the HTTP half of the feature is covered by `selftest`), so it can prove which chat received what, with which keyboard, and that approving twice still credits once.

### License

Commercial/proprietary. See [LICENSE](LICENSE). Redistribution or resale of the source is not permitted.
