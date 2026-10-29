import React, { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AtSign,
  CalendarDays,
  Check,
  Languages,
  Lock,
  Save,
  ShieldCheck,
  Smartphone,
  UserRound,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n, translateError } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatDate, formatMoney } from '../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  Field,
  InfoRow,
  Input,
  PageHeader,
  SectionCard,
  cx,
} from '../components/ui.jsx';
import { useToast } from '../components/feedback.jsx';

export default function Profile() {
  const { t, lang, setLang } = useI18n();
  const { user, meta, patchUser, refresh } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' });

  useEffect(() => {
    setForm({
      name: user?.name || '',
      email: user?.email || '',
      phone: user?.phone || '',
    });
  }, [user?.id, user?.name, user?.email, user?.phone]);

  const saveProfile = useMutation({
    mutationFn: () => api.patch('/auth/profile', form),
    onSuccess: (result) => {
      const next = result?.user || { ...form };
      patchUser(next);
      refresh?.();
      toast.success(t('profile.updated'));
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const saveLang = useMutation({
    mutationFn: (next) => api.patch('/auth/profile', { lang: next }),
    onSuccess: (_result, next) => {
      setLang(next);
      patchUser({ lang: next });
      toast.success(t('profile.updated'));
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post('/auth/password', { currentPassword: pwd.current, newPassword: pwd.next }),
    onSuccess: () => {
      setPwd({ current: '', next: '', confirm: '' });
      toast.success(t('profile.changed'));
    },
    onError: (err) => toast.error(err?.code === 'wrong_password' ? err.message : translateError(err, t)),
  });

  const passwordMismatch = pwd.next || pwd.confirm ? pwd.next !== pwd.confirm : false;
  const passwordValid = pwd.current.length > 0 && pwd.next.length >= 8 && pwd.next === pwd.confirm;
  const currency = meta?.billing?.currency || (lang === 'fa' ? 'تومان' : 'Toman');

  const roleLabel = user?.role === 'admin'
    ? (user?.isOwner ? t('common.owner') : t('common.admin'))
    : t('common.reseller');

  return (
    <>
      <PageHeader title={t('profile.title')} subtitle={t('profile.subtitle')} />

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-4">
          <SectionCard icon={UserRound} title={t('profile.info')}>
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
                <Avatar name={user?.name || user?.username} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{user?.name || user?.username}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">@{user?.username}</p>
                </div>
                <Badge tone={user?.isOwner ? 'violet' : user?.role === 'admin' ? 'cyan' : 'emerald'} className="ms-auto">
                  {roleLabel}
                </Badge>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('common.name')}>
                  <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} placeholder={t('common.name')} />
                </Field>
                <Field label={t('common.phone')}>
                  <Input dir="ltr" value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} placeholder="09xxxxxxxxx" />
                </Field>
              </div>
              <Field label={t('common.email')}>
                <Input dir="ltr" type="email" value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} placeholder="name@example.com" />
              </Field>

              <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
                <p className="text-[10.5px] text-slate-500">{t('profile.updated')}</p>
                <Button icon={Save} loading={saveProfile.isPending} onClick={() => saveProfile.mutate()}>
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </SectionCard>

          <SectionCard icon={Lock} title={t('profile.password')}>
            <div className="space-y-4">
              <Field label={t('profile.currentPassword')} required>
                <Input
                  type="password"
                  autoComplete="current-password"
                  value={pwd.current}
                  onChange={(e) => setPwd((prev) => ({ ...prev, current: e.target.value }))}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('profile.newPassword')} hint={t('resellers.form.passwordHint')} required>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={pwd.next}
                    onChange={(e) => setPwd((prev) => ({ ...prev, next: e.target.value }))}
                  />
                </Field>
                <Field label={t('profile.confirm')} error={passwordMismatch ? t('auth.mismatch') : ''}>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={pwd.confirm}
                    onChange={(e) => setPwd((prev) => ({ ...prev, confirm: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
                <p className="text-[10.5px] text-slate-500">{t('profile.changed')}</p>
                <Button
                  variant="secondary"
                  icon={ShieldCheck}
                  loading={changePassword.isPending}
                  disabled={!passwordValid}
                  onClick={() => changePassword.mutate()}
                >
                  {t('profile.password')}
                </Button>
              </div>
            </div>
          </SectionCard>
        </div>

        <div className="space-y-4">
          <SectionCard icon={Languages} title={t('profile.language')}>
            <div className="grid grid-cols-2 gap-2">
              {[['fa', 'فارسی', 'RTL'], ['en', 'English', 'LTR']].map(([code, label, hint]) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => lang !== code && saveLang.mutate(code)}
                  className={cx(
                    'flex items-center gap-2.5 rounded-xl border px-3 py-3 text-start transition',
                    lang === code
                      ? 'border-emerald-400/35 bg-emerald-500/[0.09]'
                      : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]'
                  )}
                >
                  <span className={cx(
                    'flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-bold',
                    lang === code ? 'bg-emerald-500/20 text-emerald-200' : 'bg-white/[0.05] text-slate-400'
                  )}>
                    {code.toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold text-slate-100">{label}</span>
                    <span className="mt-0.5 block text-[10px] text-slate-500">{hint}</span>
                  </span>
                  {lang === code ? <Check className="ms-auto h-4 w-4 text-emerald-300" /> : null}
                </button>
              ))}
            </div>
          </SectionCard>

          <SectionCard icon={AtSign} title={t('profile.info')} bodyClass="p-4">
            <div className="divide-y divide-white/[0.05]">
              <InfoRow label={t('common.username')} value={<span className="font-mono">@{user?.username}</span>} />
              <InfoRow label={t('common.role')} value={roleLabel} />
              {user?.role === 'reseller' ? (
                <InfoRow label={t('common.balance')} value={formatMoney(user?.balance || 0, lang, currency)} />
              ) : null}
              <InfoRow label={t('common.createdAt')} value={formatDate(user?.createdAt, lang)} />
              <InfoRow label={t('resellers.table.lastLogin')} value={user?.lastLoginAt ? formatDate(user.lastLoginAt, lang, true) : '—'} />
              <InfoRow label={t('common.phone')} value={user?.phone || '—'} mono />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="chip border-white/10 bg-white/[0.03] text-slate-400">
                <CalendarDays className="h-3 w-3" />
                {formatDate(user?.createdAt, lang)}
              </span>
              <span className="chip border-white/10 bg-white/[0.03] text-slate-400">
                <Smartphone className="h-3 w-3" dir="ltr" />
                {user?.phone || '—'}
              </span>
            </div>
          </SectionCard>
        </div>
      </div>
    </>
  );
}
