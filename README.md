# Sulduz Cloud

پنل مدیریت نمایندگی و کانفیگ VPN — دو زبانه (فارسی/انگلیسی)، تم تیره حرفه‌ای، متصل به ۳x-ui.

A bilingual (Persian/English) reseller & config management panel for 3x-ui, with a premium dark UI, per-reseller limits, wallet, tickets, live node status, backups and a reseller REST API.

Version 2.3.0 · Node.js 20+ · SQLite · React 18 · multi-panel

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
- انتقال مشتری از یک نماینده به نماینده دیگر (۱٫۵٫۵): در کشوی هر کانفیگ، فقط برای مدیر، دکمهٔ «انتقال مشتری» هست. پیش از هر جابه‌جایی یک پیش‌نمایش می‌آید — مشتری، مالک فعلی، تعداد ردیف‌ها، حجم کل بسته، روزهای باقی‌مانده و نام تک‌تک کانال‌ها — و دکمهٔ تأیید تا مقصد انتخاب نشود قفل می‌ماند. انتقال مالکیت همهٔ ردیف‌های همان بسته را با هم عوض می‌کند و ردیف‌های `usage_daily` را هم با آن‌ها می‌برد؛ هیچ نوشتنی روی نود انجام نمی‌شود، سهمیه و انقضای مشتری دست‌نخورده می‌ماند و دو طرف (مالک قبلی و مقصد) یک اعلان می‌گیرند. مقصد نباید مدیر باشد، نباید غیرفعال باشد، نباید همین حالا مالک همان مشتری باشد، و باید به همهٔ کانال‌های آن بسته دسترسی داشته باشد؛ سقف تعداد کانفیگ یا حجم مقصد هم کنترل می‌شود و اگر جا نباشد همان‌جا با نام همان سقف رد می‌شود و دکمه قفل می‌ماند. یادداشت اختیاری فرم همراه `config.transfer` در گزارش فعالیت با `fromUserId` و `toUserId` ثبت می‌شود. نماینده این دکمه را ندارد — انتقال مشتری کار مدیر است
- برچسب کانفیگ در `comment` کلاینت x-ui (۱٫۵٫۵): ۳x-ui فیلد «برچسب» جدا ندارد و تنها متن آزاد هر کلاینت `comment` است، پس برچسبی که هنگام ساخت یا ویرایش مشتری می‌نویسید (به‌همراه نام و شماره تماس او) در همان `comment` ذخیره می‌شود و در پنل نود خوانده می‌شود. رشته با « | » ساخته و در ۱۲۰ نویسه بریده می‌شود (سقف خود x-ui)؛ مسیرهای ساخت، ویرایش و ساختِ دوباره هر سه از یک تابع `clientComment()` می‌گذرند تا سه‌جا یک جملهٔ متفاوت ننویسند. اگر نود در دسترس نباشد یا نوشتن روی آن خطا بدهد، ردیف محلی و لینک اشتراک همچنان ذخیره و کار می‌کنند و پاسخ `commentSync = {pushed: false, reason}` را می‌گیرد تا صادقانه «روی نود نوشته نشد» گفته شود، نه اینکه موفقیت جا بزند. جست‌وجوی remark در «جست‌وجوی کانفیگ در x-ui» همین متن را می‌خواند، پس برچسب فارسی هم پیدا می‌شود
- جستجوی کانفینگ (۱٫۵٫۶، نام قبلی: «جستجوی نود»): مدیر با uuid، email یا remark (فارسی هم) روی هر پنل جست‌وجو می‌کند و نتیجه را می‌بیند — این جست‌وجو فقط خواندنی است و چیزی روی نود نمی‌نویسد. سپس می‌تواند همان کلاینت را به لیست کانفیگ‌های یک نماینده اضافه کند (adopt)؛ همهٔ اینباندهای آن کلاینت یک بسته می‌شوند و افزودن دوبارهٔ همان کلاینت کاری نمی‌کند
- جستجوی پیشرفتهٔ کانفینگ (۲٫۰٫۰): همان صفحهٔ جست‌وجو یک پنل فیلتر دارد — فیلد جست‌وجو (همه / ایمیل / uuid / برچسب / subId)، وضعیت کلاینت (فعال / منقضی / حجم تمام‌شده / غیرفعال)، مالکیت در این پنل (ثبت‌شده / بدون مالک)، اینباند مشخص (با نام نودش)، نوع حجم (حجم‌دار / نامحدود) و «انقضا تا چند روز آینده»، به‌علاوهٔ مرتب‌سازی روی ایمیل، انقضا، مصرف، حجم یا نود با جهت صعودی/نزولی. می‌شود بدون هیچ عبارتی و فقط با فیلترها جست‌وجو کرد؛ مرتب‌سازی روی همهٔ نتایج منطبق انجام می‌شود نه فقط صفحهٔ اول، و وقتی نتایج از سقف رد شوند تعداد کل منطبق‌ها جدا نشان داده می‌شود. هر نتیجه بج وضعیت واقعی خودش را دارد (منقضی و بی‌حجم دیگر پشت «فعال» پنهان نمی‌شوند) و دکمهٔ «پاک‌کردن فیلترها» همه را یک‌جا برمی‌گرداند
- حذف زمان‌بندی‌شدهٔ اشتراک‌های تمام‌شده (۲٫۰٫۰): در تنظیمات مدیر یک تب «حذف خودکار» هست که خاموش متولد می‌شود. مدیر روشن می‌کند و می‌گوید اشتراک منقضی، بی‌حجم یا هر دو بعد از چند روز مهلت (پیش‌فرض ۷) پاک شوند، هر چند ساعت یک‌بار sweep بزند و در هر اجرا حداکثر چند بسته حذف شود. بستهٔ منقضی از آخرین تاریخ انقضایش شمرده می‌شود؛ بستهٔ بی‌حجم چون ۳x-ui لحظهٔ «کی پر شد» را نمی‌دهد، اولین sweep که آن را پر ببیند مهر `depleted_at` می‌زند و مهلت از همان‌جا شروع می‌شود — مشتری‌ای که وسط مهلت شارژ کند اشتراکش می‌ماند و مهر پاک می‌شود. حذف همان مسیر دکمهٔ حذف دستی است (`deletePackage`): کلاینت adopted روی پنل مبدأ هرگز پاک نمی‌شود (و با سوییچ «شامل واردشده‌ها» که پیش‌فرض خاموش است اصلاً sweep نمی‌شود)، کلاینتی که از قبل روی نود نیست موفقیت است، و نودی که خطا بدهد بسته را دست‌نخورده نگه می‌دارد. دکمهٔ «پیش‌نمایش» دقیقاً می‌گوید چه چیزی حذف می‌شد بدون آنکه یک ردیف بنویسد (حتی مهر مهلت هم نمی‌زند)، «اجرای الآن» همان sweep را دستی می‌زند، و خلاصهٔ آخرین اجرا (بررسی‌شده / حذف‌شده / در مهلت / ناموفق) با زمانش در همان تب می‌ماند؛ هر حذف خودکار در گزارش فعالیت با `config.auto_delete` ثبت می‌شود و اعلان به نمایندهٔ مالک قابل خاموش‌کردن است
- واگذاری گروهی کانفینگ‌ها به یک نماینده (۱٫۵٫۶): کنار هر نتیجهٔ جست‌وجو یک تیک هست و یک تیک «انتخاب همهٔ نتایج این صفحه» بالای فهرست؛ با دکمهٔ «واگذاری انتخاب‌شده‌ها» همهٔ تیک‌خورده‌ها در یک کلیک به یک نماینده می‌روند — دیگر لازم نیست دانه‌دانه منتقل شوند. پیش از اجرا همان پیش‌نمایش صادق می‌آید: برای هر مشتری یک خط با برچسب «انتقال» (این پنل مالکش است)، «افزودن» (روی نود هست و اینجا مالکی ندارد)، «از قبل دارد» یا «ناموفق» با دلیلش، تعداد کانال‌ها و حجمش. انتخاب ترکیبی مجاز است و یک batch همه‌یا‌هیچ نیست: هر مشتری جدا می‌نشیند یا رد می‌شود، بقیه گروگان نمی‌مانند، و برای ناموفق‌ها دکمهٔ «تلاش دوباره» فقط همان‌ها را دوباره می‌فرستد. سقف تعداد/حجم مقصد به‌صورت تجمعی سنجیده می‌شود (دو بسته‌ای که هرکدام جا دارند ولی با هم نه، همان‌جا در پیش‌نمایش رد می‌شوند)، نماینده‌ای که سوییچ دریافتش خاموش است هشدار می‌گیرد و دکمه قفل می‌ماند. هیچ نوشتنی روی نود انجام نمی‌شود، لینک و سهمیه و انقضا دست‌نخورده می‌مانند، دفتر مصرف روزانه با مشتری می‌رود و برای کل batch یک اعلان تجمیعی به هر طرف می‌رسد — نه یک پیام به‌ازای هر مشتری. یک ردیفِ تنها همان فرم تک‌مشتری قبلی را باز می‌کند (نام، تلفن، برچسب) و اعلان تک‌مشتری می‌فرستد. تیک‌ها به جست‌وجوی خودشان تعلق دارند: جست‌وجوی تازه انتخاب را پاک می‌کند و بعد از واگذاری فقط موفق‌ها از انتخاب خارج می‌شوند
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
- تنظیمات: عمومی، اتصال ۳x-ui، پایش و هشدار، ایمیل (SMTP)، پیامک، کیف پول، پرداخت (فیش واریزی و شماره کارت‌هایش، درگاه زرین‌پال، تایید خودکار فیش)، بکاپ، حذف خودکار اشتراک‌های تمام‌شده، تلگرام (ربات دوطرفه + گزارش شبانه)، امنیت
- نمایش نسخهٔ برنامه و سازنده (تیم سولدوز سرور) در سایدبار، صفحه ورود و تنظیمات
- نام پنل ثابت و غیرقابل تغییر (۱٫۵٫۴): نام برند در `src/brand.js` نوشته می‌شود و در همان لحظه‌ای که تنظیمات خوانده می‌شود روی آن مقدار می‌گیرد، پس نه فرم تنظیمات، نه یک ردیف دستی در دیتابیس و نه نصبی که شخص دیگری انجام داده نمی‌تواند نام را عوض کند. هرچه خودتان در همان فرم بنویسید (تگ‌لاین، توضیح، آدرس) ذخیره و اعمال می‌شود؛ فقط نام برند قفل است. یک `panelName` قدیمی یا دست‌نویس در ردیف `settings` می‌ماند ولی هیچ‌جا خوانده نمی‌شود
- پلن‌های آماده (۱٫۵٫۴): مدیر به‌جای گذاشتن تعرفهٔ خام، یک پلن می‌سازد — نام، توضیح، حجم، مدت، قیمت خودش و یکی دو (یا چند) کانال از یک سرور — و در ویترین می‌گذارد یا با یک کلیک چشمی‌اش را خاموش می‌کند. پلن یک ردیف در جدول `plans` است و کانال‌هایش در همان ردیف (`inbound_ids`)، پس ساختن، پنهان کردن ویرایشِ یک فیلد و برگرداندنش همه با همان PATCH انجام می‌شوند و هیچ‌کدام بقیهٔ عدد پلن را پاک نمی‌کند. حذف پلن نرم است و پلنی که از ویترین رفته حتی با دادن `planId` هم قابل خرید نیست (۴۰۹ `plan_not_available`). کانال‌های پلن باید همه از یک سرور باشند، وگرنه همان‌جا که می‌نویسید رد می‌شود نه وقتی نماینده می‌خرد
- تایید خودکار فیش واریزی (۱٫۵٫۴): مدیر روشن می‌کند، می‌گوید چقدر صبر کند، سقف هر مبلغ چقدر باشد و در روز حداکثر چند request آزاد شود. زمان‌بندی هر دقیقه (شمارهٔ دقیقه‌ها قابل تغییر است) یک sweep می‌زند، و سطرِ تاییدشده در همان دفتر کل با برچسب «تایید خودکار» نوشته می‌شود تا نماینده ماه بعد بتواند بگوید این پول را درگاه داده یا فیش او بدون دستی‌مدیر رد شده. چیزی که هنوز به پایان دورهٔ سکوت نرسیده، بیشتر از سقف است، یا را یک انسان تصمیم گرفته‌اش — هیچ‌کدام لمس نمی‌شوند، و تصمیم یک‌بار و در یک تراکنش نوشته می‌شود. صفحهٔ فیش‌ها دکمهٔ «اجرای الآن» هم دارد تا برای دیدن نتیجهٔ تنظیم تازه لازم نباشد یک دقیقه صبر کنید. از ۱٫۵٫۵ فقط فیش واریزی مشمول این مسیر است؛ ردیف «کارت به کارت» با خودِ آن روش از فرم و از ردیف تنظیمات پاک شد
- دو درگاه، هرکدام با دکمهٔ روشن/خاموش خودش (۱٫۵٫۵): لینک پرداخت بلو بانک و روش «کارت به کارت» با ردیف‌های تنظیماتشان از پنل حذف شدند؛ آنچه در تب پرداخت می‌ماند «فیش واریزی» و «درگاه زرین‌پال» است و هر کدام سوییچ خودش را دارد. کلیدهای قدیمی (`blueEnabled`، `blueLink`، `blueLabel`، `autoApproveCard`) نه در پاسخ API برمی‌گردند و نه در ردیف `settings` می‌مانند — هنگام خواندن و هنگام نوشتن از آن‌ها پاک می‌شود، پس یک نصب ارتقایافته همان ردیف را تمیز تحویل می‌دهد. خاموش‌کردن سوییچ واقعی است: تا ذخیره نشد چیزی عوض نشده، و بعد از ذخیره همان روش از صفحهٔ کیف پول نماینده و از ربات می‌رود؛ اگر هر دو خاموش باشند نماینده یک جملهٔ صادق می‌خواند، نه یک نیمه‌فرم
- شماره کارت‌های فیش واریزی (۱٫۵٫۵، و پاسخِ «کدام شماره کارت؟»): در همان تب یک بخش جدا تا ۱۲ شماره کارت با بانک، به‌نام و توضیح کوتاه نگه می‌دارد. شماره‌ها بدون فاصله و خط تیره ذخیره و تکراری‌ها حذف می‌شوند، یک شمارهٔ بی‌اعتبار پیام می‌گیرد و اگر کل لیست بی‌اعتبار باشد ذخیره ۴۲۲ برمی‌گرداند تا کارت‌های درست پاک نشوند. همان شماره‌ها در صفحهٔ کیف پول نماینده (با دکمهٔ کپی برای هر کارت) و در ربات تلگرام هنگام ارسال فیش نشان داده می‌شوند، و شماره‌ای که نماینده گفته پول را به آن ریخته روی همان ردیف فیش می‌نشیند و در صفحهٔ «فیش‌های واریزی» مدیر خوانده می‌شود. تا کارتی تعریف نشده باشد، فیش واریزی عملاً استفاده‌شدنی نیست و ریل همان تب با «نیمه‌کاره است» و دلیلش (`no_cards`) همین را می‌گوید — پس سوییچِ روشن می‌تواند صادقانه «هنوز آماده نیست» باشد. آیدی مرچنت زرین‌پال مانند بقیهٔ رازها سربسته (aes-256-gcm) در همان ردیف `settings` می‌نشیند، به فرم هیچ‌وقت متن آن برگردانده نمی‌شود، و «خالی گذاشتن» یعنی «همان که هست بماند» — پس ذخیره‌های بعدی همان تب دیگر با «مرچنت را اول ذخیره کنید» رد نمی‌شوند
- پورسانت بین نماینده‌ها (۱٫۵٫۴): هر نمایندگی در فرم خودش یک «معرف» دارد (`users.referrer_id`)؛ وقتی او از کیف پولش خرید می‌کند — بسته، کانال تازه، یا پلن آماده — درصدی از همان مبلغ به موجودی معرف می‌نشیند. درصد پیش‌فرض ناوگان `billing.commissionPercent` است و هر نماینده می‌تواند درصد خودش را داشته باشد (`commission_percent`)، و هیچ‌کدام از `billing.commissionCapPercent` (سقف ۵۰٪) بالاتر نمی‌رود. پورسانت یک تراکنش واقعی از نوع `commission` در دفتر کل معرف است، نه یک عدد نمایشی — و اگر خریدی دو روش داشت، هر دو در همان تراکنش ثبت می‌شوند

**پنل نمایندگی**

- ساخت و تمدید کانفیگ با رعایت سقف‌ها، افزودن حجم/زمان؛ ریست مصرف فقط همراه تمدید و با پرداخت تعرفهٔ حجم جدید (ریست رایگان نماینده حذف شده و جایش دکمهٔ «بروزرسانی مصرف» از نود نشسته است)
- افزودن اینباند به مشتریِ فعلی برای نماینده رایگان است: هزینهٔ بسته هنگام ساخت آن پرداخت می‌شود و کانال جدید همان حجم و زمان مشترک را می‌گیرد (حجم و زمان تازه‌ای اضافه نمی‌شود)، پس کیف پول او برای این کار کسر نمی‌شود و حتی با موجودی صفر هم انجام می‌شود. مبلغ تعرفه در همان فهرست فقط برای اطلاع و کم‌رنگ با برچسب «بدون کسر» دیده می‌شود. تنها حالتِ پولیِ این اکشن، تیک «کسر از کیف پول نماینده» توسط مدیر اصلی است
- لینک اشتراک، URI و QR برای هر کانفیگ
- ارسال کانفینگ به تلگرام خود نماینده (۲٫۰٫۰): در کشوی هر کانفیگ، کنار QR یک دکمهٔ «ارسال به تلگرام من» هست. ربات پنل یک پیام شیک و آمادهٔ فوروارد به چت خصوصی خود نماینده می‌فرستد: عکس QR لینک اشتراک، و زیرش نام مشتری، حجم، اعتبار، نود و خود لینک اشتراک در یک بلوک کد که با یک لمس کپی می‌شود — نماینده همان پیام را برای مشتری‌اش فوروارد می‌کند. مقصد فقط آیدی عددی تلگرام ثبت‌شده در حساب خود اوست (نه چت دیگری)، و اگر آیدی نداشته باشد، ربات خاموش باشد، بسته لینک اشتراک نداشته باشد یا لینک برای QR بیش از حد بلند باشد، همان‌جا با پیام روشن رد می‌شود؛ دو ارسال پشت‌سرهم هم مهلت ۱۰ ثانیه‌ای دارد تا ربات اسپم نشود. QR با انکودر داخلی خود پنل ساخته می‌شود (بدون هیچ وابستگیٔ بیرونی) و هر ارسال در گزارش فعالیت ثبت می‌شود
- آمار مصرف، کیف پول و تراکنش‌ها، تیکت، اطلاعیه‌ها، پروفایل و تغییر رمز
- افزایش/کاهش موجودی روی گوشی درست کار می‌کند: فیلد مبلغ دیگر کیبورد فقط‌عددی باز نمی‌کند (که علامت + و − نداشت)؛ کیبورد کامل با دکمهٔ «افزایش»/«کاهش» و میان‌برهای مبلغ باز می‌شود و نوشتن عدد منفی خودش حالت را به «کاهش» می‌برد. مبلغ بیشتر از موجودی در حالت کاهش، دکمه را غیرفعال می‌کند و درخواستی فرستاده نمی‌شود
- فیش واریزی از ربات تلگرام: نماینده عکس فیش را برای ربات می‌فرستد، مبلغ را می‌گوید، و وضعیت همان فیش (در انتظار / تأیید / رد) با یادداشت مدیر در کیف پول خودش دیده می‌شود — فقط فیش‌های خودش، بدون هیچ اطلاعات داخلی تلگرام
- افزایش موجودی از ربات، داخل پنل (۱٫۵٫۳): صفحهٔ کیف پول نماینده یک کادر دارد که با یک دکمه او را مستقیم وارد گفت‌وگوی ارسال فیش در ربات می‌کند: `t.me/<bot>?start=topup`. نام کاربری ربات از `getMe` گرفته و یک‌بار در `bot_state` کش می‌شود؛ تا آن لحظه که ربات خودش را به پنل معرفی نکرده، کادر به‌جای نشاندن یک لینک شکسته، صادقانه همان را می‌گوید
- موجودی زنده بالای صفحه (۱٫۵٫۳): نماینده موجودی کیف پولش را در هدرِ همهٔ صفحه‌ها می‌بیند؛ عدد هر ۲۰ ثانیه از `/reseller/balance` دوباره خوانده می‌شود، وقتی تب به پیش‌زمینه برمی‌گردد و هر بار که بین صفحه‌ها جابه‌جا می‌شوید هم تازه می‌شود، و با هر شارژ سبز و هر کسر قرمز چشمک می‌زند. فیشی که مدیر یا ربات تأیید کند بدون تازه‌کردن صفحه در همین هدر دیده می‌شود. برای مدیر این کادر نمایش داده نمی‌شود چون کیف پول جداگانه‌ای ندارد
- آمار ترافیک روزانه از دفتر روزانهٔ خود پنل خوانده می‌شود: ۳x-ui فقط یک شمارندهٔ تجمعی می‌دهد، پس اختلاف آن روی روزهایی که مصرف واقعاً در آن‌ها افتاده تقسیم می‌شود (زمان‌بندی بر پایهٔ منطقهٔ زمانی پنل، حداکثر ۷ روز) — سکوت چندروزهٔ پنل دیگر به‌شکل یک روز پرحجم در آمار نمی‌آید
- کلید API و مستندات REST برای اتصال فروشگاه/ربات
- دکمهٔ «افزایش موجودی» کنار خودِ موجودی (۱٫۵٫۴): در هدرِ پنل نماینده، کنار همان چیپ موجودی یک لینک «افزایش موجودی» نشسته که مستقیم به `/wallet?topup=1` می‌رود و همان‌جا که وارد می‌شوید صفحه روی کادر روش‌های پرداخت اسکرول می‌کند. این کنار همان دکمهٔ قدیمی «افزایش موجودی از طریق ربات» است — یکی پول را از ربات می‌گیرد، یکی از درگاه یا کارت — و هیچ‌کدام جای دیگری را باز نمی‌کند. روی گوشی (۳۹۰px) همان دکمه با برچسب تا‌شده به آیکون همچنان یک هدف لمسی واقعی است و `title` خودش را نگه می‌دارد
- دو راه برای شارژ کیف پول (۱٫۵٫۵): صفحهٔ کیف پول فقط روش‌هایی را نشان می‌دهد که مدیر واقعاً روشن کرده — فیش واریزی (کنار شماره کارت‌هایی که مدیر تعریف کرده، با دکمهٔ کپی برای هر کارت) و درگاه زرین‌پال. «کارت به کارت» و لینک آمادهٔ بلو بانک از این صفحه رفتند، و اگر هر دو سوییچ خاموش باشد نماینده به‌جای یک نیمه‌فرم یک جمله می‌خواند که هیچ روشی فعال نیست. درخواست زرین‌پال از سمت پنل ساخته می‌شود، بازگشت درگاه (`/api/payments/zarinpal/callback`) مبلغ و AUTHORITY را با همان ردیف می‌سنجد و فقط اگر verify جواب داد کیف پول شارژ می‌شود؛ یک‌بار و با کد رهگیری کنار AUTHORITY، تا ماه بعد هم بتوان همان سفارش را در هر دو صفحهٔ زرین‌پال پیدا کرد. فرم «واریز کردم» هیچ‌وقت مستقیم به درگاه نمی‌نویسد
- خرید و تمدید از پلن آماده (۱٫۵٫۴): نماینده در صفحهٔ «پلن‌ها» فقط پلن‌های دیده‌شدنی خودش را می‌بیند. برای مشتری تازه، یک پلن را انتخاب می‌کند و همان حجم، همان مدت و همان کانال‌ها با قیمت خودِ پلن ساخته می‌شود؛ برای تمدید، پلن را روی مشتری فعلی اعمال می‌کند — و همان‌جا پنل با یک تأیید جدا می‌گوید «کل مصرف و زمان این مشتری ریست می‌شود و این پلن از نو برایش اعمال می‌شود». عددی که مرورگر می‌فرستد (قیمت، حجم، مدت، لیست کانال‌ها) خوانده نمی‌شود: از ردیف پلن در دیتابیس گرفته می‌شود، و اگر موجودی کیف پول برسد همین‌جا کسر می‌شود — یک بار برای کل بسته، نه برای هر کانال
- شمارندهٔ قرمز پیام‌های مدیر جلوی اعلان‌ها (۱٫۵٫۴): هر پیامی که مدیر برای نماینده‌ها می‌فرستد (`broadcast`) تا خوانده نشده، یک عدد قرمز روی همان آیتم منو و روی زنگوله نگه می‌دارد. این عدد فقط پیام‌های مدیر است — نه هر سطر خوانده‌نشدهٔ دیگری که پنل برای خودش می‌سازد — و بالای ۹۹ به `99+` تبدیل می‌شود. «همه را خوانده‌ام» همان‌جا در منوی زنگوله و در صفحهٔ اعلان‌ها هست، و خوانده‌شدن واقعاً در دیتابیس نوشته می‌شود تا دفعهٔ بعد همان عدد دوباره برنگردد

**امنیت**

- JWT در کوکی HttpOnly + محافظت CSRF با double-submit
- هش رمز با bcrypt، ابطال نشست‌ها پس از خروج/تغییر رمز
- محدودیت تلاش ورود، Helmet، اعتبارسنجی ورودی با zod، لاگ فعالیت
- کلید API مخصوص نمایندگی با محدودیت نرخ ۱۲۰ درخواست در دقیقه

**رابط کاربری**

- دو زبانه کامل fa/en با RTL/LTR، فونت Vazirmatn به‌صورت لوکال (بدون وابستگی به Google Fonts)
- تم تیره، نمودارها، اسکلت بارگذاری، اعلان‌ها، ریسپانسیو موبایل
- منوی کناری روی گوشی (۱٫۵٫۵): ستون منو دیگر با `translate` جابه‌جا نمی‌شود؛ روی صفحهٔ کوچک با `hidden`/`flex` باز و بسته می‌شود. دلیلش یک کلاس بود: `max-lg:` تنها واریانت باز در کل برنامه بود و مرورگرهای قدیمی‌تر آن قاعده را نمی‌فهمیدند، پس «حالت بسته» هیچ قاعده‌ای نداشت و منو روی صفحه می‌ماند و دکمهٔ همبرگری مرده به‌نظر می‌رسید — همان «درست باز نمیشه و ناپدید میشه». حالا باز‌شدن واقعی است: پس‌زمینهٔ تار می‌آید، با `Escape` یا زدن روی همان پس‌زمینه بسته می‌شود، اسکرولِ پشتِ منو قفل می‌شود تا صفحه زیرش نلغزد، و کلید تم و زبان که در هدرِ گوشی جا نمی‌شدند داخل خودِ منو نشسته‌اند (از ۶۴۰px به بالا هدرشان را برمی‌دارد). کلید منو هم `aria-expanded` را درست نگه می‌دارد

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
npm run payment-test    # پول: شماره کارت‌های فیش، ساخت سفارش و بازگشت و verify زرین‌پال، سوییچ هر درگاه، تایید خودکار، برند ثابت، پورسانت، شمارندهٔ اعلان
```

هر شش تست روی دیتابیس موقت خودشان اجرا می‌شوند و تعداد موارد خودشان را در پایان چاپ می‌کنند. تست‌های `report-test` و `bot-test` فرستادن به تلگرام را با یک ضبط‌کنندهٔ محلی جایگزین می‌کنند و دسترسی شبکه را هم می‌بندند، پس در هیچ اجرا از این شش تست یک پیام واقعی به هیچ چتی فرستاده نمی‌شود. `payment-test` هم هیچ میزبانی جز دو هاست زرین‌پال نمی‌پذیرد و اگر درخواستی به جای دیگر برود، همان اجرا را می‌شکند — یعنی مکالمهٔ بانک فقط با پاسخ‌های ساختگیِ خودش اثبات می‌شود، نه با اینترنت.

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

- **Admin**: dashboard KPIs, resellers with per-module permissions and quotas (configs, GB per config, total GB, IP limit, expiry, balance, API key, numeric Telegram id), configs on any inbound for any reseller (packages are listed as one customer row), multi-inbound packages built as ONE 3x-ui client attached to every inbound the customer bought — so his subscription link stays the node's own subscription address and lists all of his channels there; only a package that genuinely spans several clients (3x-ui rejects a subId shared by two clients) is served through one aggregated link on this panel, and a preview-then-confirm merge puts split packages back onto the customer's own client, renew/extend/toggle, a node-side usage refresh that changes nothing, subscription link + URI + QR, CSV export, client names shaped `<telegramId>-<random>` with automatic adoption of subscriptions that already live on the panels under that id, a per-reseller on/off switch plus a load/refresh button for that adoption (turning it off only hides the adopted rows; nothing is deleted from x-ui), legacy x-ui subscriptions kept separate from panel customers with their own "old" badge and source filter, inbound sync/visibility, multiple x-ui servers (add/edit/delete; deleting the last server returns the panel to its blank first-run state, while a server that still owns configs is protected so live clients are never cut), live per-panel server status with latency plus CPU/RAM/disk usage, and node status, email/SMS outage alarms (Kavenegar, FarazSMS or a custom endpoint), traffic & revenue reports, tickets, broadcast, manual/auto backups with retention and restore, audit log, settings (general, x-ui, monitoring, email, SMS, wallet, payment — the receipt method with its own card list and the ZarinPal gateway, each with its own switch — backups, telegram — the two-way bot and the nightly report — security), and the app version + author (Sulduz Server Team) shown in the sidebar, login page and settings.
- **Reseller**: self-service configs within limits, renew & add traffic, usage stats, wallet & transactions, tickets, notifications, profile/password, API keys with REST docs. Adding an inbound to a customer he already has is free: he paid for the package when he built it and the new channel joins the same shared quota and expiry (no extra bytes, no extra days), so his wallet is not touched and the add works even at balance zero — the tariff is shown greyed out with a "no charge" mark, for information only. The only paid case left for that action is the main admin ticking "charge the reseller's wallet". Daily traffic comes from the panel's own day ledger: 3x-ui only exposes a cumulative counter, so the delta of a sync window is spread over the days it actually covers (panel-timezone midnights, seven days at most) instead of landing in one heap on the day the panel woke up.
- **Nightly Telegram report (ships switched off)**: at the hour and minute the owner picks, in the panel timezone, every reseller whose numeric Telegram id is saved in his settings receives three sections — what he bought today and what is left in his wallet, the subscriptions that ended or ran out today, and the ones about to end by date or by shared volume — plus a fleet digest for the owner. Each attempt is remembered per recipient per day, so a restart cannot send the same report twice; the settings page has the schedule, both role switches, a preview of every message, a manual send and the delivery history.
- **One delete button (v1.5.2)**: the config drawer has a single Delete that removes the customer's whole package from the reseller panel AND from x-ui; the separate "delete the whole subscription" button is gone. A package whose client is no longer on the node can be deleted too — the panel reads 3x-ui's "record not found" as "already gone", clears the local rows and writes nothing to the node. A node that is unreachable or answers with any other error refuses the delete and keeps every row, so a customer is never cut by accident. An adopted package is only forgotten locally; the client on the panel it came from stays alive.
- **Payment receipts (v1.5.2)**: every receipt a reseller sends through the Telegram bot lands in an admin inbox with the image, the amount, the reseller and the time. The admin can correct the amount, approve (the wallet is credited exactly once) or reject with a note; a rejection moves no money. A decided receipt is read-only and keeps who decided, when, and the note. The same page shows the bot's state (enabled, running, 409 conflict) and a restart button that reports honestly whether the bot is actually polling or just idle.
- **Find a client on x-ui (v1.5.2, renamed "Config search" in v1.5.6)**: the admin searches any panel by uuid, email or remark (Persian included) and reads the result — the search is read-only and writes nothing to the node. He can then adopt that client into a reseller's config list; every inbound the client is on becomes one package, and adopting the same client again is a no-op. Since v1.5.8 the search returns the WHOLE match, not a first page: the page asks for up to 5000 hits per panel (the service default is 1000), so a node with 210 clients sharing one prefix hands back all 210, and a result that really did hit the ceiling says `truncated: true` instead of pretending it is complete. The bulk hand-over ceiling rose with it, from 100 to 1000 customers per click.
- **"Not registered on the node" filter (v1.5.8)**: the configs page's status filter has a new option that lists exactly the customers whose x-ui client is gone from the node panel (`sync_status = 'missing'`, the same fact the rose badge shows). It works on both list shapes — a single-channel row matches directly, and a multi-channel package matches when ANY of its channels is missing — for the admin and for the reseller, and the CSV export follows the same filter.
- **Three shelves of ready-made plans (v1.5.8)**: the plans menu splits into Test / Public / Exclusive, each a real route (`/plans/test`, `/plans/public`, `/plans/exclusive`) with its own tab on the page, for the admin and the reseller alike; plans written before this release land on the Public shelf. Every plan carries a per-reseller take limit (0 = unlimited): a new customer AND a renewal each count as one take in a `plan_purchases` ledger, the reseller's card shows how many takes he has left, and an exhausted plan stays visible with a locked buy button while the API answers 409 `plan_limit_reached` before any wallet movement. An exclusive plan is activated for a named list of resellers — only they see it in their shop window, and the quote, the purchase and the renewal all refuse anybody else (403 `plan_not_for_you`); saving one without a reseller, or naming an admin or a deleted account, is refused while the owner is still typing. The activation list and the sold counter are admin-only; a reseller never reads who his competitors are.
- **Scheduled deletion of finished subscriptions (v2.0.0)**: a new "Auto-delete" settings tab, born switched off. The owner turns it on and says whether expired packages, quota-depleted packages or both should go, how many grace days they get first (default 7), how often the sweep runs (hours) and how many packages one run may delete at most. An expired package counts its grace from its last expiry; a depleted one has no "became full at" moment in x-ui, so the first sweep that sees it full stamps `configs.depleted_at` and the window starts there — a customer who tops up inside the window keeps his subscription and the stamp is cleared. Deletion is the exact code path the manual delete button takes (`deletePackage`): an adopted client is never deleted on the other operator's panel (and with "include imported" off — the default — adopted packages are not swept at all), a client already off the node is a success, and a node that refuses leaves the package untouched. A Preview button answers with exactly what WOULD happen while writing nothing (not even the grace stamp), "Run now" fires the same sweep by hand, the last run's summary and time stay on the tab, every automatic deletion is audited as `config.auto_delete`, and the owner can switch the reseller notification off.
- **Advanced config search (v2.0.0)**: the config-search page grows a filter panel — search field (all / email / uuid / remark / subId), client status (active / expired / depleted / disabled), ownership in this panel (held / unowned), a specific inbound (labelled with its node), quota kind (limited / unlimited) and "expiring within N days", plus sorting by email, expiry, usage, volume or node in either direction. A search can run with no term at all, on filters alone; sorting happens over ALL matches, not just the shown page, and when the ceiling truncates the result the total match count is shown separately. Every hit carries its real status badge (expired and depleted no longer hide behind "active") and one reset button clears every filter at once.
- **Send a config to the reseller's own Telegram (v2.0.0)**: next to the QR in every config drawer sits a "Send to my Telegram" button. The panel's bot delivers ONE stylish, forward-ready message to the reseller's own private chat: a QR image of the subscription link with a Persian caption underneath — customer name, volume, validity, node, and the link itself in a tap-to-copy code block — so he can forward that single message straight to his customer. The destination is only the numeric Telegram id saved on his own account (never another chat), and a missing id, a switched-off bot, a package without a subscription link or a link too long for a QR is refused on the spot with a clear message; back-to-back sends wait out a 10-second cooldown so the bot is never spammed. The QR is produced by the panel's own encoder (a dependency-free byte-mode QR with Reed–Solomon ECC, rendered to PNG in-process) and every send lands in the audit log.
- **Hand several configs to one reseller in a single click (v1.5.6)**: every search hit carries its own tick and a select-all tick takes the whole page; "Hand over selected" moves every ticked customer to one reseller at once instead of one by one. The same honest preview comes first — one line per customer labelled Move (this panel already owns him), Adopt (he lives on the node and nobody here owns him), Already-owned, or Failed with its reason, his channel count and his volume. A mixed selection is fine and a batch is not all-or-nothing: each customer lands or is refused on his own, the rest are never held hostage, and a Retry button re-posts only the failed ones. The target's count/volume ceilings are projected cumulatively (two packages that each fit but together do not are refused in the preview, by name), and a reseller whose import switch is off gets a warning and a locked button. Nothing is written to the node, links, quotas and expiry stay untouched, the daily usage ledger follows the customers, and each side gets ONE aggregated notification for the whole batch — not one message per customer. A single ticked row still opens the v1.5.5 single-customer form (label, name, phone) with its per-customer notification. Ticks belong to their own search: a new search clears the selection, and after a hand-over only the ones that landed leave it.
- **Two-way reseller bot (v1.5.2)**: on the panel's own bot token, any reseller whose numeric Telegram id is saved on his account can read his balance (`/balance`) and his numbers (`/stats`), and send a payment receipt (`/topup`) as a two-step conversation (photo, then amount). The receipt goes to the admin with Approve / Reject buttons, and no money moves until he approves. `/start`, `/help`, `/cancel` and an admin `/pending` list are there too. The switch lives in settings; with the switch off or no token saved the bot stays idle and makes no Telegram call at all. A restart never replays old updates (the offset is stored in the database) and a bot that already has a webhook is left to that webhook.
- **Reseller wallet on a phone (v1.5.2)**: the amount field no longer opens a digits-only keyboard with no way to type a sign. It opens the full keyboard with Increase / Decrease chips and amount shortcuts, typing a negative number switches the mode to Decrease by itself, and a decrease larger than the balance disables the button without sending a request. The reseller also sees his own receipts (pending / approved / rejected) with the admin's note in his wallet — only his own, with no Telegram internals in the payload.
- **Button keyboards in the bot (v1.5.3)**: the reseller's `/start` is no longer a list of commands he has to remember. A persistent three-row keypad — موجودی · افزایش موجودی · آمار اشتراک‌ها on the first row, فیش‌های من · آمار مصرف · راهنما on the second, لغو on its own — answers every menu and every step, and each button is wired to the same code as its command, so `/balance` and 💰 موجودی produce the identical message. The admin gets his own keypad: آمار نمایندگان · شارژ/کسر نماینده · فیش‌های در انتظار · راهنمای مدیر. `getUpdates` never touches a webhook, the native command menu is registered per scope (wallet commands in private chats, the fleet commands only in the decision chat) and the bot's own username is cached from `getMe` once, so a link can be promised without a second call.
- **Subscription stats inside the bot (v1.5.3)**: 📦 آمار اشتراک‌ها reads the same grouped packages the panel lists — total, active, ended, out of volume, disabled, and the ones expiring inside three days or almost out of their shared quota — each with days left, gigabytes left and the percentage consumed, scoped to what that reseller is allowed to see. 🧾 فیش‌های من gives him his own last eight receipts with their state and the admin's note.
- **Charging a reseller from the bot (v1.5.3)**: the admin's 💰 شارژ/کسر نماینده asks for a numeric Telegram id or a username, resolves it to a live reseller account (never an admin, never the owner's own wallet), then amount, then direction, then a confirmation that re-reads everything before it moves. The buttons accept «-», `-1` and `-500` as "decrease" and the sign is read from the text, not from `Number()`. A charge or a deduction calls the same `usersService.adjustBalance` as the panel does, so it writes one `transactions` row and one `user.balance` audit entry, and a deduction that would go below zero is refused. Tapping a stale button, forging the amount in the callback payload, or a stranger replaying the admin's callback id all get refused. 👥 آمار نمایندگان lists id, balance, package count and consumption eight rows per page with page buttons.
- **Top up from the panel, in the bot (v1.5.3)**: the reseller wallet page has a card that opens the bot straight into the receipt conversation through `t.me/<bot>?start=topup` — the bot's own username comes from `getMe`, is cached in `bot_state`, and is only ever shown when it is actually known; before that the card says so instead of printing a broken link. The deep link opens the top-up step with the chat already primed; `/start menu` shows the keypad and an unknown payload is answered with the keypad and no section at all.
- **Live balance in the header (v1.5.3)**: the reseller sees his wallet balance at the top of every page, re-read from `/reseller/balance` every twenty seconds, when the tab comes back to the foreground and whenever he navigates, and the chip flashes green on a credit or red on a debit. An approved receipt in the panel or in the bot changes that number without a reload; admins get no chip because they have no wallet of their own.
- **A top-up button beside the balance (v1.5.4)**: the reseller header now carries a real link next to the balance chip — same row, same band, side by side — that lands on `/wallet?topup=1`, and the wallet page scrolls to the payment card on arrival. It sits beside the v1.5.3 "top up through the bot" link rather than replacing it: one takes the money from Telegram, the other from a gateway or a card. On a 390 px screen the label folds to an icon, the tap target stays a real target and the `title` still says what the button is.
- **Two ways to fund the wallet (v1.5.5)**: the wallet page offers only what the owner actually switched on — a payment receipt, next to the card numbers he registered (each with a copy button), and the ZarinPal gateway. Card-to-card and the ready Blue Bank link are gone from the page, and with both switches off the reseller reads one honest sentence instead of a half-form. A gateway order is built by the panel, and `/api/payments/zarinpal/callback` measures the bank's answer against that row and verifies before it credits — once, with the AUTHORITY and the ref_id kept side by side so one order can be traced through both ZarinPal screens a month later. A "I paid" form never writes to the gateway directly.
- **Every gate has its own on/off switch (v1.5.5)**: the payment tab now carries a switch for the receipt method and one for ZarinPal, and nothing else. The retired keys (`blueEnabled`, `blueLink`, `blueLabel`, `autoApproveCard`) are pruned both on read and on write, so they neither come back in the API answer nor stay in the stored `settings` row — an upgraded install hands back a clean row. Turning a switch off is real: nothing changes until the save lands, and after it the method disappears from the reseller wallet and from the bot.
- **Receipt card numbers (v1.5.5)**: a separate section in the same tab keeps up to twelve card numbers with bank, account holder and a short note. Numbers are stored without spaces or dashes, duplicates dropped, a malformed one gets a message, and a list that is entirely invalid is refused with 422 so the good numbers are never erased. The same numbers reach the reseller's wallet page and the Telegram bot when he is about to send a receipt, and the number he says he paid into is written onto that receipt row and read back in the admin's inbox. Until at least one card exists the receipt method is not really usable, and the tab's rail says so with `ready: false` and `no_cards` — so an "on" switch can answer honestly "not ready yet".
- **Moving a customer to another reseller (v1.5.5)**: the config drawer carries a Move-customer button for the admin only. It previews before it touches anything — the customer, his current owner, the row count, the package volume, the days left and every channel by name — and the confirm button stays locked until a destination is chosen. The move changes the owner of every row of that package at once and takes the `usage_daily` rows with them; nothing is written to the node, the customer's quota and expiry are untouched, and both the old and the new owner get one notification. A destination cannot be an admin, an inactive reseller, the owner he already has, or somebody lacking access to one of the package's channels, and the target's own config-count and volume ceilings are checked — a refusal names the ceiling it hit and keeps the button locked. An optional note lands in the `config.transfer` audit entry beside `fromUserId` and `toUserId`. A reseller is never offered the button: moving a customer is the owner's job.
- **The config label lands on the node (v1.5.5)**: 3x-ui has no label field of its own — a client's only free text is `comment`, the column the node panel shows as the customer's description — so the label typed when a customer is created or edited (with his name and phone) is written there. One `clientComment()` builds it for the create, rebuild and edit paths, joined with " | " and cut at 120 characters, which is x-ui's own limit. When the node is unreachable or the write fails, the local row and the subscription link are still saved and work, and the answer carries `commentSync = {pushed: false, reason}` so the screen says the node was not told rather than pretending it was. The remark search in "Find a client on x-ui" reads this text, so a Persian label is searchable on the node too.
- **The side menu on a phone (v1.5.5)**: the drawer is shown and hidden with `hidden`/`flex` instead of a transform. The old rule used `max-lg:rtl:translate-x-full` — the only range variant in the whole app — and browsers that do not understand `@media (width <= 1023px)` dropped it, so the closed state had no rule at all: the menu sat over the page and the hamburger looked dead. Opening it is now real: a dimmed backdrop, Escape and a tap on it close the menu, the page behind stops scrolling, the button carries `aria-expanded`, and the theme and language switches that have no room in a phone header sit inside the drawer (from 640px the header carries them again).
- **Scheduled auto-approval of receipts (v1.5.4)**: the owner switches it on, says how long a request must have sat untouched, what the ceiling per amount is, how many approvals a reseller may get in a day, and how often the sweep runs. An auto-approved row is labelled «تایید خودکار» in the ledger line itself, so a reseller reading his book months later can tell a gateway payment from a receipt he sent in Telegram. A request younger than the quiet period, larger than the ceiling, or already decided by a human is not touched; the decision and the credit happen in one transaction, exactly once. The receipt page has a "run now" button so a fresh setting does not have to be waited for. From v1.5.5 receipts are the only method this path can release — the card-to-card row left the form with the method itself.
- **Ready-made plans (v1.5.4)**: the owner builds a plan once — name, description, volume, duration, his own price and one or several inbounds, all from a single server or the write is refused while he is still typing — and puts it in the shop window or turns its eye off. A plan is one row in `plans` with its channel list in that same row, so hiding it, showing it again or editing one field is a partial save that leaves every other number of the plan alone. A reseller buys a new customer from a plan, or applies a plan to a customer he already has, and the panel says so plainly in a separate confirmation: all of that customer's usage and time are reset and the plan is rebuilt for him. The price, volume, duration and channel list the browser posts are never read — they come from the plan's row — the wallet is charged the plan price once per package, and a plan that is off the shelf cannot be bought even by naming its id (409 `plan_not_available`).
- **Commission between resellers (v1.5.4)**: every reseller form has a referrer (`users.referrer_id`), and when that reseller buys with his wallet — a package, a new channel, or a ready plan — a share of what he paid lands in the referrer's balance. `billing.commissionPercent` is the fleet default, a reseller can carry his own agreed rate, and nothing, however typed, gets past `billing.commissionCapPercent` (capped at 50). A commission is a real `transactions` row of type `commission` in the referrer's book, not a display number: 0 means off, a purchase of nothing pays nothing, a disabled referrer simply stops earning while the sale still happens, the share is rounded to a whole unit of the currency, and a commission credit never earns a commission of its own.
- **A red counter for the owner's messages (v1.5.4)**: next to Notifications in the reseller menu, and on the bell, an unread count of the owner's broadcasts sits in red until he has seen them. It counts only the messages the owner sent — not every unread row the panel happens to create for itself — caps at 99+, arrives with the same request the dropdown already makes, and drops by one when he opens a message. "Mark all as read" clears it for real, in the database, so the number does not come back on the next load.
- **The panel's name is code, not data (v1.5.4)**: the brand name lives in `src/brand.js` and is pinned over the settings row at read time, so the settings form, a PATCH that claims to rename the panel, a hand-edited row or an installation by somebody else all still answer with the same name — and every consumer (public meta, login page, sidebar, bot footer, reports, SMS) agrees because they all read it through that one place. Everything else in that section — tagline, description, address — stays editable; only the brand is locked.

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

`selftest` covers setup, auth, session revocation, CSRF and multi-panel management; one-client packages (create, add a channel, take one off, rotate the subscription id, merge a package that was split over two clients — the client that holds only the reseller's fixed inbound is the copy that goes, the customer's own client survives and receives that channel — and refuse to delete a duplicate when the node refused the attach); quota pooling; renewal and the subscription address (a customer is always handed the node's own link for his x-ui client, and the panel only falls back to its aggregated `/api/sub/<token>` address when the server has no subscription base); rebuilding a customer whose x-ui client was deleted on the node; the renewal-charging policy and the replacement reset that a reseller can no longer get for free; adding a channel to a customer the reseller already has is free even on an empty wallet (and stays free when his own session posts `charge: true`), while an admin who ticks the charge switch is still refused there; the inbound-visibility rule — a channel the admin ticked by name in the reseller form is sellable for that reseller even while the panel still flags it hidden, while the default offer of an empty allow list and every other reseller stay exactly as they were, and the flag itself is never rewritten; wallet charges, quotas, tickets, backups, the audit log and API keys. It runs against a mock 3x-ui that enforces the real subId uniqueness rule and the real attachment rule (a channel only moves with `clients/bulkAttach` / `clients/<email>/detach`; `clients/update` rewrites the client where it already lives and ignores a channel it is not in yet, and a client that is not on the panel answers "record not found"). v1.5.2 adds the single delete (a package whose client is gone is cleared locally with zero node writes, an unreachable node refuses the delete and keeps every row, an adopted package is only forgotten), the read-only x-ui client search by uuid/email/remark and its adoption into a reseller's list as one package, and the receipt inbox: approving credits exactly once, a corrected amount is what gets credited, rejecting moves no money and keeps the note, a decided row is read-only, and a reseller can only ever read his own receipts while the admin inbox, the approve route, the node search and the adopt route all stay closed to him. v1.5.3 adds the two panel routes behind the new UI — `/reseller/balance` answers the money, the currency and the number of receipts still waiting (and an admin on the same route reads his own wallet, never the shop's), and `/reseller/bot` plus `/admin/bot` hand out the `t.me/<bot>?start=…` link built from the cached `getMe` answer, degrading to an empty link and `commands: false` rather than a broken URL or a 500 when the bot has no username yet. `bot-test` covers the keypads themselves (row order and labels, button text identical to the command text), the subscription-stats and own-receipts sections, the four deep links (`?start=topup|balance|packages|receipts`), an unknown payload that is refused with the keypad and no section at all, `getMe` being called exactly once and cached, the per-scope command registration, the admin paging over a ten-reseller fleet, and the whole charge/deduct conversation including the refusals: stale step, forged amount, second tap, stranger tap, self-target and a deduction the balance cannot cover — with the resulting `transactions` and `audit_logs` rows read back from the database. v1.5.4 adds the six new areas: the pinned brand (the name comes from the code at read time, so a saved hostile `panelName` never reaches the API, the sidebar or the login page), ready-made plans (one-server rule, multi-inbound packages, renewal replacing volume and expiry, and the separate reset switch that clears usage before the new period starts), the auto-approval schedule (a receipt is credited once, exactly, only after its own waiting window, and a row a human already decided is never touched again), the payment gateways (ZarinPal order/verify/callback, keeping its credential sealed with the merge rule "an empty or all-bullets box means keep what is stored"), commission (a percentage of a reseller's purchase routed to his referrer, per-reseller rate beating the fleet default, and the ceiling never being crossed), and the unread counter (the sidebar badge counts only broadcasts, never every notification row). v1.5.5 adds the five areas of that release: the retired gates (the Blue and card-to-card keys answer to nothing — they are pruned from the API response and from the stored row on both read and write, each surviving method keeps its own switch, and a switch that is really turned off takes the method out of the reseller wallet and the bot), the receipt card list (up to twelve numbers with bank, holder and note, normalized and deduplicated, an all-invalid list refused with 422 so the good numbers survive, the receipt method reported `ready: false / no_cards` until one exists, and the number a receipt was paid into kept on that row and shown to the admin), the customer transfer (only the whole package moves, only for an admin, only after the target's permissions and quotas are checked, with zero node writes and the daily ledger following the customer), the label reaching the node (`clientComment()` on the create, rebuild and edit paths, with `commentSync` admitting when the node was not told), and the phone sidebar (`hidden`/`flex` instead of a `max-lg:` transform that older engines dropped, body scroll locked, Escape and the backdrop closing it). v1.5.6 adds the bulk hand-over: one `POST /admin/configs/bulk-assign` classifies a mixed selection in a `dryRun` preview (transfer / adopt / already / failed, each with its channel count) without writing a row, an owner, a ledger line, a notification, an audit entry or a node call; the real batch lands each customer independently under the target's cumulatively-projected ceilings, moves every member row of a package with the daily ledger, keeps the v1.5.5 single-customer form and notifications for a one-item selection, sends one aggregated note per side for a batch, audits the click once (`config.bulk_assign`, never the previews), and re-handing a customer to the reseller who already holds him is a calm "already", not an error. v1.5.8 adds its three areas: the un-capped config search (a 210-client prefix match comes back whole, the 5000 ceiling is enforced and flagged), the missing-client status filter on both list shapes and in the CSV export, and the plan shelves (category validation, the exclusive whitelist enforced on list/quote/new/renew, the per-reseller take ledger counting purchases and renewals alike, and the 409 that lands before any money moves). v2.0.0 adds its three areas: the cleanup schedule (a dry-run preview writes nothing — not even the grace stamp; a depleted package is stamped on first sighting and only deleted after its own grace window; a top-up inside the window clears the stamp and keeps the customer; expired packages count from their last expiry; adopted packages are skipped by default and never deleted on the other panel; a refusing node keeps its package; the per-run cap holds; and the settings guards refuse an "on" switch with both kinds selected off), the advanced search filters (every field/status/ownership/quota enum, the inbound and expiring-soon filters, filter-only search with no term, sorting over the whole match set with an honest `matched`/`truncated` pair), and sending a config to the reseller's own Telegram (the QR encoder verified against a published Reed–Solomon test vector and a round-trip decode, the caption's shape and length, and every refusal: no Telegram id, bot off, no link, cooldown, oversized link).

```bash
cd server
npm run telegram-test   # adopting the subscriptions that already live on the panels, by Telegram id
npm run sms-test        # SMS text and pattern rendering
npm run report-test     # the nightly report: its three sections, its recipients, its delivery ledger
npm run bot-test        # the two-way bot: identity, the two-step receipt, the admin's buttons, the single credit
npm run payment-test    # money: the receipt card numbers, ZarinPal order/verify/callback, each gateway's own switch, auto-approval, the pinned brand, commission, the unread counter
npm run send-test       # sending a config to the reseller's own Telegram: the QR encoder, the caption, the guards
```

Every suite runs on a temporary database and reports its own check count when it finishes. `report-test` and `bot-test` replace the Telegram transport with an in-process recorder and refuse every network call, so no test run can ever put a real message into a real chat. `bot-test` drives the conversation in process (the HTTP half of the feature is covered by `selftest`), so it can prove which chat received what, with which keyboard, and that approving twice still credits once. `payment-test` — the money suite — accepts no host but the two ZarinPal ones and breaks the run the moment a request would go anywhere else: the bank conversation is proven only against its own fake answers, never the internet. The v1.5.4 areas (pinned brand, ready-made plans, the auto-approval schedule, commission, the unread counter) are checked in `selftest` and `payment-test`, the five v1.5.5 areas (the retired gates and their switches, the receipt card list, the customer transfer, the label written to the node, the phone sidebar) are checked there and again through the real interface by the UI harness, and the v1.5.6 bulk hand-over is checked in `selftest` (preview classification, zero-write previews, cumulative ceilings, partial batches, the ledger and notification accounting) and once more in a real browser by the UI harness — ticks, select-all, the mixed one-click hand-over, the retry loop and the phone viewport included. The v2.0.0 areas are checked in `selftest` (the cleanup sweep and the advanced search filters), in `send-test` (the QR encoder against a published Reed–Solomon vector and a round-trip decode, the send guards and the caption — with the Telegram transport replaced by a recorder and every network call refused), and again through the real interface by the UI harness, which points the bot at a local mock Telegram so the send button is proven end to end without a real chat ever being touched.

### License

Commercial/proprietary. See [LICENSE](LICENSE). Redistribution or resale of the source is not permitted.
