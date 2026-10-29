import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Sparkles,
  User,
  Wifi,
  Zap,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { Button, Field, Input, ThemeToggle, cx } from '../../components/ui.jsx';

function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
      className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-300 transition hover:border-cyan-400/30 hover:text-white"
    >
      <Globe2 className="h-3.5 w-3.5" />
      {lang === 'fa' ? 'English' : 'فارسی'}
    </button>
  );
}

function Brand({ name }) {
  return (
    <div className="flex items-center gap-3">
      <span className="relative flex h-11 w-11 items-center justify-center">
        <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-emerald-400 via-cyan-400 to-violet-500 opacity-80 blur-[7px]" />
        <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 shadow-[0_10px_30px_-10px_rgba(16,185,129,.9)]">
          <svg viewBox="0 0 24 24" className="h-5.5 w-5.5 text-[#04120f]" style={{ width: 22, height: 22 }} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 11.2 4 4 0 0 0 7 19h10.5Z" />
          </svg>
        </span>
      </span>
      <div className="min-w-0">
        <p className="truncate text-base font-bold tracking-tight text-white">{name || 'Sulduz Cloud'}</p>
        <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/70">control panel</p>
      </div>
    </div>
  );
}

function Hero({ meta }) {
  const { t } = useI18n();
  const features = [t('auth.feature1'), t('auth.feature2'), t('auth.feature3')];
  return (
    <aside className="relative hidden overflow-hidden lg:flex lg:w-[52%] lg:flex-col lg:justify-between lg:p-12">
      <div className="pointer-events-none absolute -start-24 -top-24 h-[420px] w-[420px] rounded-full bg-emerald-500/20 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-32 end-0 h-[380px] w-[380px] rounded-full bg-cyan-500/15 blur-[120px]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.55]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,.16) 1px, transparent 0)', backgroundSize: '32px 32px', maskImage: 'radial-gradient(ellipse at 30% 40%, black 10%, transparent 70%)' }} />

      <div className="relative">
        <Brand name={meta?.panelName} />
      </div>

      <div className="relative max-w-lg">
        <span className="chip border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
          <Sparkles className="h-3.5 w-3.5" />
          {meta?.tagline || t('app.tagline')}
        </span>
        <h1 className="mt-6 text-4xl font-extrabold leading-[1.25] text-white xl:text-[42px]">
          {t('auth.heroTitle')}
        </h1>
        <p className="mt-4 max-w-md text-[13.5px] leading-7 text-slate-400">{t('auth.heroSubtitle')}</p>

        <ul className="mt-7 space-y-3">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-3 text-[12.5px] text-slate-300">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-500/10 text-emerald-300">
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              {feature}
            </li>
          ))}
        </ul>
      </div>

      <div className="relative mt-10">
        <div className="surface max-w-md rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 text-emerald-300">
                <Wifi className="h-4 w-4" />
              </span>
              <div>
                <p className="text-[11.5px] font-semibold text-slate-200">VLESS · Reality</p>
                <p className="text-[10px] text-slate-500">node-de-03 · :443</p>
              </div>
            </div>
            <span className="badge border border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,.9)]" />
              {t('dash.nodeOnline')}
            </span>
          </div>
          <div className="mt-4 flex items-center justify-between text-[10.5px] text-slate-500">
            <span>42.8 GB / 60 GB</span>
            <span>18 {t('common.days')}</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.07]">
            <div className="h-full w-[71%] rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 shadow-[0_0_14px_rgba(16,185,129,.6)]" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              { icon: Boxes, label: t('dash.kpiConfigs'), value: '1,284' },
              { icon: Zap, label: t('dash.kpiTrafficToday'), value: '96 GB' },
              { icon: ShieldCheck, label: t('dash.nodeOnline'), value: '7 / 7' },
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-2.5 py-2">
                <stat.icon className="h-3.5 w-3.5 text-slate-500" />
                <p className="mt-1.5 text-[12.5px] font-bold text-white">{stat.value}</p>
                <p className="text-[9.5px] text-slate-500">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-4 text-[10px] text-slate-600">
          {meta?.website || 'Sulduz Cloud'} · {t('app.footer')}
        </p>
      </div>
    </aside>
  );
}

export default function Login() {
  const { t, lang } = useI18n();
  const { login, setup, meta, setupRequired, user } = useAuth();
  const navigate = useNavigate();
  const isSetup = Boolean(setupRequired);

  const [form, setForm] = useState({ username: '', password: '', name: '', confirm: '', panelName: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const update = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (isSetup) {
      if (form.password !== form.confirm) {
        setError(t('auth.mismatch'));
        return;
      }
      if (form.password.length < 8) {
        setError(t('profile.password') + ': 8+');
        return;
      }
    }
    setBusy(true);
    try {
      if (isSetup) {
        await setup({
          username: form.username.trim(),
          password: form.password,
          name: form.name.trim() || 'Owner',
          panelName: form.panelName.trim() || undefined,
        });
      } else {
        await login(form.username.trim(), form.password);
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const title = isSetup ? t('auth.setupTitle') : t('auth.loginTitle');
  const subtitle = isSetup ? t('auth.setupSubtitle') : t('auth.loginSubtitle');

  return (
    <div className="relative flex min-h-screen items-stretch">
      <Hero meta={meta} />

      <main className="relative flex w-full flex-col justify-center px-5 py-10 sm:px-10 lg:w-[48%] lg:px-14">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-emerald-500/[0.06] to-transparent lg:hidden" />

        <div className="mb-8 flex items-center justify-between lg:hidden">
          <Brand name={meta?.panelName} />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
        <div className="absolute end-6 top-6 hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          <LangToggle />
        </div>

        <div className="mx-auto w-full max-w-[400px] animate-fadeUp">
          <div className="mb-7">
            <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-emerald-400/25 bg-emerald-500/10 text-emerald-300">
              {isSetup ? <ShieldCheck className="h-5 w-5" /> : <KeyRound className="h-5 w-5" />}
            </span>
            <h2 className="text-2xl font-bold tracking-tight text-white">{title}</h2>
            <p className="mt-1.5 text-[12.5px] leading-6 text-slate-400">{subtitle}</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {isSetup ? (
              <Field label={t('auth.panelName')}>
                <Input
                  value={form.panelName}
                  onChange={update('panelName')}
                  placeholder={meta?.panelName || 'Sulduz Cloud'}
                  maxLength={60}
                  autoComplete="organization"
                />
              </Field>
            ) : null}

            <Field label={isSetup ? t('resellers.form.username') : t('auth.username')} required>
              <Input
                value={form.username}
                onChange={update('username')}
                placeholder="admin"
                autoComplete="username"
                autoFocus
                dir="ltr"
                required
                minLength={3}
                icon={User}
              />
            </Field>

            {isSetup ? (
              <Field label={t('auth.name')}>
                <Input value={form.name} onChange={update('name')} placeholder="—" autoComplete="name" />
              </Field>
            ) : null}

            <Field label={t('auth.password')} required>
              <span className="relative block">
                <Lock className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" style={{ insetInlineStart: '0.85rem' }} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={update('password')}
                  placeholder="••••••••"
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  className="input"
                  style={{ paddingInlineStart: '2.4rem', paddingInlineEnd: '2.6rem' }}
                  required
                  minLength={isSetup ? 8 : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition hover:text-slate-300"
                  style={{ insetInlineEnd: '0.55rem' }}
                  aria-label="toggle password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </span>
            </Field>

            {isSetup ? (
              <Field label={t('auth.confirmPassword')} required>
                <Input
                  type="password"
                  value={form.confirm}
                  onChange={update('confirm')}
                  placeholder="••••••••"
                  autoComplete="new-password"
                  icon={Lock}
                  required
                />
              </Field>
            ) : null}

            {error ? (
              <div className="flex items-start gap-2 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2.5 text-[12px] text-rose-200">
                <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400" />
                {error}
              </div>
            ) : null}

            <Button type="submit" loading={busy} className="w-full" size="lg">
              {busy ? (isSetup ? t('common.loading') : t('auth.submitting')) : isSetup ? t('auth.createOwner') : t('auth.submit')}
            </Button>
          </form>

          <div className="mt-6 flex items-center justify-center gap-1.5 text-[11px] text-slate-600">
            <ShieldCheck className="h-3.5 w-3.5" />
            {lang === 'fa' ? 'اتصال امن با TLS · نشست رمزنگاری‌شده' : 'Secured with TLS · encrypted session'}
          </div>

          <p className="mt-8 text-center text-[10.5px] text-slate-600">
            {t('app.footer')} · v{meta?.version || '1.0.0'}
          </p>
        </div>
      </main>
    </div>
  );
}
