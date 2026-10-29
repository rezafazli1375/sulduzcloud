import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BadgeCheck,
  Boxes,
  CalendarClock,
  Copy,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Percent,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  UserX,
  Users,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api, downloadFile } from '../../lib/api.js';
import { formatBytes, formatDate, formatMoney, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InfoRow,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
  TableSkeleton,
  Textarea,
  Toolbar,
  cx,
  useDebounced,
} from '../../components/ui.jsx';
import { useConfirm, useToast } from '../../components/feedback.jsx';
import ConfigDetail from '../../components/config/ConfigDetail.jsx';

const PERMISSIONS = ['users', 'configs', 'inbounds', 'servers', 'tickets', 'stats', 'settings', 'backups', 'audit', 'broadcasts'];

const EMPTY_FORM = {
  username: '',
  password: '',
  name: '',
  email: '',
  phone: '',
  role: 'reseller',
  status: 'active',
  permissions: [],
  allowed_inbounds: [],
  max_configs: 0,
  max_total_gb: 0,
  max_gb_per_config: 0,
  max_days_per_config: 0,
  balance: 0,
  note: '',
};

function LimitBadge({ icon: Icon, value, suffix }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">
      <Icon className="h-3 w-3 text-slate-500" />
      {value ? `${value}${suffix || ''}` : '∞'}
    </span>
  );
}

function UserForm({ open, onClose, editing }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);

  const inboundsQuery = useQuery({
    queryKey: ['inbounds', 'form'],
    queryFn: () => api.get('/admin/inbounds'),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        ...EMPTY_FORM,
        username: editing.username || '',
        name: editing.name || '',
        email: editing.email || '',
        phone: editing.phone || '',
        role: editing.role || 'reseller',
        status: editing.status || 'active',
        permissions: editing.permissions || [],
        allowed_inbounds: editing.allowedInbounds || [],
        max_configs: editing.limits?.maxConfigs || 0,
        max_total_gb: editing.limits?.maxTotalGb || 0,
        max_gb_per_config: editing.limits?.maxGbPerConfig || 0,
        max_days_per_config: editing.limits?.maxDaysPerConfig || 0,
        balance: editing.balance || 0,
        note: editing.note || '',
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setShowPassword(false);
  }, [open, editing]);

  const save = useMutation({
    mutationFn: (payload) => (editing ? api.patch(`/admin/users/${editing.id}`, payload) : api.post('/admin/users', payload)),
    onSuccess: () => {
      toast.success(editing ? t('common.updated') : t('common.created'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const submit = (event) => {
    event.preventDefault();
    const payload = {
      username: form.username.trim(),
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      role: form.role,
      status: form.status,
      note: form.note.trim(),
      max_configs: Number(form.max_configs || 0),
      max_total_gb: Number(form.max_total_gb || 0),
      max_gb_per_config: Number(form.max_gb_per_config || 0),
      max_days_per_config: Number(form.max_days_per_config || 0),
      allowed_inbounds: form.allowed_inbounds,
    };
    if (form.password) payload.password = form.password;
    if (form.role === 'admin') payload.permissions = form.permissions;
    if (!editing) payload.balance = Number(form.balance || 0);
    save.mutate(payload);
  };

  const inbounds = (inboundsQuery.data?.rows || []).filter((row) => row.enabled);

  const toggleArray = (key, id) => {
    setForm((prev) => ({
      ...prev,
      [key]: prev[key].includes(id) ? prev[key].filter((value) => value !== id) : [...prev[key], id],
    }));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('resellers.form.editTitle') : t('resellers.form.createTitle')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={save.isPending} onClick={submit} icon={ShieldCheck}>{t('common.save')}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('resellers.form.username')} required>
            <Input value={form.username} onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))} dir="ltr" required minLength={3} autoComplete="off" />
          </Field>
          <Field label={editing ? t('resellers.detail.newPassword') : t('resellers.form.password')} hint={form.password ? '' : t('resellers.form.passwordHint')}>
            <span className="relative block">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                placeholder={editing ? '••••••••' : ''}
                autoComplete="new-password"
                style={{ paddingInlineEnd: '2.6rem' }}
              />
              <button
                type="button"
                className="absolute top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 hover:text-slate-300"
                style={{ insetInlineEnd: '0.55rem' }}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </span>
          </Field>
          <Field label={t('resellers.form.name')}>
            <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          </Field>
          <Field label={t('resellers.form.phone')}>
            <Input value={form.phone} onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))} dir="ltr" placeholder="09..." />
          </Field>
          <Field label={t('resellers.form.email')}>
            <Input type="email" value={form.email} onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))} dir="ltr" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('resellers.form.role')}>
              <Select value={form.role} onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value }))}>
                <option value="reseller">{t('common.reseller')}</option>
                <option value="admin">{t('common.admin')}</option>
              </Select>
            </Field>
            <Field label={t('resellers.form.status')}>
              <Select value={form.status} onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value }))}>
                <option value="active">{t('common.active')}</option>
                <option value="disabled">{t('common.disabled')}</option>
              </Select>
            </Field>
          </div>
        </div>

        {form.role === 'admin' ? (
          <div>
            <span className="label">{t('resellers.form.permissions')}</span>
            <div className="flex flex-wrap gap-2">
              {PERMISSIONS.map((perm) => (
                <Checkbox
                  key={perm}
                  checked={form.permissions.includes(perm)}
                  onChange={() => toggleArray('permissions', perm)}
                  label={t(`nav.${perm === 'users' ? 'resellers' : perm}`) || perm}
                  className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5"
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('resellers.form.maxConfigs')} hint={t('resellers.form.zeroHint')}>
            <Input type="number" min={0} value={form.max_configs} onChange={(e) => setForm((prev) => ({ ...prev, max_configs: e.target.value }))} />
          </Field>
          <Field label={t('resellers.form.maxTotalGb')} hint={t('resellers.form.zeroHint')}>
            <Input type="number" min={0} value={form.max_total_gb} onChange={(e) => setForm((prev) => ({ ...prev, max_total_gb: e.target.value }))} />
          </Field>
          <Field label={t('resellers.form.maxGbPerConfig')} hint={t('resellers.form.zeroHint')}>
            <Input type="number" min={0} value={form.max_gb_per_config} onChange={(e) => setForm((prev) => ({ ...prev, max_gb_per_config: e.target.value }))} />
          </Field>
          <Field label={t('resellers.form.maxDaysPerConfig')} hint={t('resellers.form.zeroHint')}>
            <Input type="number" min={0} value={form.max_days_per_config} onChange={(e) => setForm((prev) => ({ ...prev, max_days_per_config: e.target.value }))} />
          </Field>
        </div>

        <div>
          <span className="label">{t('resellers.form.allowedInbounds')}</span>
          <div className="max-h-[180px] overflow-y-auto rounded-xl border border-white/[0.07] bg-white/[0.015] p-2.5">
            {inbounds.length ? (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {inbounds.map((row) => (
                  <Checkbox
                    key={row.id}
                    checked={form.allowed_inbounds.includes(row.id)}
                    onChange={() => toggleArray('allowed_inbounds', row.id)}
                    label={`${row.remark || `#${row.id}`} (${row.protocol})`}
                    className="rounded-md px-1.5 py-1 hover:bg-white/[0.03]"
                  />
                ))}
              </div>
            ) : (
              <p className="py-2 text-center text-[11px] text-slate-500">{t('inbounds.empty')}</p>
            )}
          </div>
          <p className="mt-1.5 text-[10.5px] text-slate-500">{t('resellers.form.allowedInboundsHint')}</p>
        </div>

        {!editing ? (
          <Field label={t('resellers.form.balance')} hint={t('resellers.form.zeroHint')}>
            <Input type="number" min={0} value={form.balance} onChange={(e) => setForm((prev) => ({ ...prev, balance: e.target.value }))} />
          </Field>
        ) : null}

        <Field label={t('resellers.form.note')}>
          <Textarea rows={2} value={form.note} onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))} />
        </Field>
      </form>
    </Modal>
  );
}

function BalanceModal({ open, onClose, user }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => { if (open) { setAmount(''); setDescription(''); } }, [open]);

  const adjust = useMutation({
    mutationFn: (payload) => api.post(`/admin/users/${user.id}/balance`, payload),
    onSuccess: () => {
      toast.success(t('common.saved'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user', user.id] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('resellers.detail.adjustBalance')}
      subtitle={`${user?.username} · ${formatMoney(user?.balance || 0, lang)}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={adjust.isPending} onClick={() => adjust.mutate({ amount: Number(amount), description })} icon={Wallet}>{t('common.apply')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('resellers.detail.amount')} hint={lang === 'fa' ? 'برای افزایش عدد مثبت و برای کاهش عدد منفی وارد کنید' : 'Positive to add, negative to deduct'}>
          <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="+500000" dir="ltr" />
        </Field>
        <Field label={t('common.description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function DiscountsModal({ open, onClose, user }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({});

  const inboundsQuery = useQuery({
    queryKey: ['inbounds', 'discounts', user?.id || 0],
    queryFn: () => api.get(`/admin/inbounds?userId=${user.id}`),
    enabled: open && Boolean(user?.id),
  });

  const discountsQuery = useQuery({
    queryKey: ['admin', 'user', user?.id, 'discounts'],
    queryFn: () => api.get(`/admin/users/${user.id}/discounts`),
    enabled: open && Boolean(user?.id),
  });

  useEffect(() => {
    if (!open) return;
    const map = {};
    for (const item of discountsQuery.data?.discounts || []) map[item.inboundId] = String(item.percent);
    setValues(map);
  }, [open, discountsQuery.data]);

  const save = useMutation({
    mutationFn: (entries) => api.put(`/admin/users/${user.id}/discounts`, { discounts: entries }),
    onSuccess: () => {
      toast.success(t('resellers.discounts.saved'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'user', user.id, 'discounts'] });
      queryClient.invalidateQueries({ queryKey: ['inbounds'] });
      queryClient.invalidateQueries({ queryKey: ['quote'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const rows = (inboundsQuery.data?.rows || []).filter((row) => row.enabled);
  const activeCount = Object.values(values).filter((value) => Number(value) > 0).length;
  const loading = inboundsQuery.isLoading || discountsQuery.isLoading;

  const submit = () => {
    const entries = Object.entries(values)
      .map(([inboundId, percent]) => ({ inboundId: Number(inboundId), percent: Math.round(Number(percent) || 0) }))
      .filter((entry) => entry.percent > 0);
    save.mutate(entries);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('resellers.discounts.title')}
      subtitle={user?.username ? `@${user.username} · ${t('resellers.discounts.subtitle')}` : t('resellers.discounts.subtitle')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="ghost" onClick={() => setValues({})} disabled={!activeCount || save.isPending}>
            {t('resellers.discounts.clear')}
          </Button>
          <Button icon={Percent} loading={save.isPending} onClick={submit}>{t('common.save')}</Button>
        </>
      }
    >
      {loading ? (
        <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
      ) : rows.length ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] leading-5 text-slate-500">{t('resellers.discounts.hint')}</p>
            <Badge tone={activeCount ? 'emerald' : 'slate'}>
              {formatNumber(activeCount, lang)} {t('resellers.detail.discountCount')}
            </Badge>
          </div>
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto pe-1">
            {rows.map((row) => {
              const value = values[row.id] ?? '';
              const hasDiscount = Number(value) > 0;
              return (
                <div
                  key={row.id}
                  className={cx(
                    'flex items-center gap-3 rounded-xl border px-3 py-2 transition',
                    hasDiscount ? 'border-emerald-400/30 bg-emerald-500/[0.06]' : 'border-white/[0.06] bg-white/[0.02]'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-slate-200">{row.remark || `#${row.id}`}</p>
                    <p className="truncate text-[10px] text-slate-500" dir="ltr">
                      {row.protocol}{row.network ? ` · ${row.network}` : ''} · :{row.port}
                    </p>
                  </div>
                  <div className="hidden shrink-0 text-end sm:block">
                    <p className="text-[9.5px] text-slate-500">{t('resellers.discounts.basePrice')}</p>
                    <p className="text-[10.5px] text-slate-300">{formatNumber(row.priceFixed, lang)}</p>
                    {Number(row.pricePerGb) || Number(row.pricePerDay) ? (
                      <p className="text-[9px] text-slate-500" dir="ltr">
                        +{formatNumber(row.pricePerGb, lang)}/GB · +{formatNumber(row.pricePerDay, lang)}/d
                      </p>
                    ) : null}
                  </div>
                  <div className="relative w-24 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      dir="ltr"
                      value={value}
                      placeholder="0"
                      className="text-center"
                      style={{ paddingInlineEnd: '1.7rem' }}
                      onChange={(e) => {
                        const next = e.target.value;
                        setValues((prev) => ({ ...prev, [row.id]: next }));
                      }}
                    />
                    <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-[10px] text-slate-500">%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState icon={Percent} title={t('resellers.discounts.empty')} className="py-8" />
      )}
    </Modal>
  );
}

function UserDetail({ userId, onClose, onEdit }) {
  const { t, lang } = useI18n();
  const confirm = useConfirm();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [configId, setConfigId] = useState(null);
  const [discountsOpen, setDiscountsOpen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => api.get(`/admin/users/${userId}`),
    enabled: Boolean(userId),
  });

  const discountsQuery = useQuery({
    queryKey: ['admin', 'user', userId, 'discounts'],
    queryFn: () => api.get(`/admin/users/${userId}/discounts`),
    enabled: Boolean(userId),
  });
  const discountList = discountsQuery.data?.discounts || [];

  const user = data?.user;
  const stats = data?.stats || {};
  const configs = data?.configs?.rows || [];
  const transactions = data?.transactions || [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'user', userId] });
  };

  const setStatus = useMutation({
    mutationFn: (status) => api.post(`/admin/users/${userId}/status`, { status }),
    onSuccess: () => { toast.success(t('common.updated')); invalidate(); },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const changePassword = useMutation({
    mutationFn: () => api.post(`/admin/users/${userId}/password`, { password }),
    onSuccess: () => { toast.success(t('profile.changed')); setPasswordOpen(false); setPassword(''); },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const regenerate = useMutation({
    mutationFn: () => api.post(`/admin/users/${userId}/api-key`),
    onSuccess: () => { toast.success(t('common.saved')); invalidate(); },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const remove = useMutation({
    mutationFn: (purge) => api.del(`/admin/users/${userId}?purge=${purge ? 1 : 0}`),
    onSuccess: () => { toast.success(t('common.deleted')); invalidate(); onClose?.(); },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askStatus = async () => {
    const ok = await confirm({
      title: user?.status === 'active' ? t('resellers.disableConfirm') : t('resellers.enableConfirm'),
      danger: user?.status === 'active',
    });
    if (ok) setStatus.mutate(user?.status === 'active' ? 'disabled' : 'active');
  };

  const askDelete = async () => {
    const ok = await confirm({
      title: t('resellers.detail.deleteConfirm'),
      body: t('common.irreversible'),
      danger: true,
    });
    if (ok) remove.mutate(false);
  };

  return (
    <>
      <Drawer
        open={Boolean(userId)}
        onClose={onClose}
        title={user ? user.name || `@${user.username}` : t('resellers.detail.title')}
        subtitle={user ? `@${user.username} · ${user.role === 'admin' ? t('common.admin') : t('common.reseller')}` : ''}
        width="max-w-2xl"
        footer={
          user ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <Button variant="danger" size="sm" icon={Trash2} onClick={askDelete}>{t('resellers.detail.deleteUser')}</Button>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" icon={user.status === 'active' ? UserX : ShieldCheck} onClick={askStatus} loading={setStatus.isPending}>
                  {user.status === 'active' ? t('common.disabled') : t('common.active')}
                </Button>
                <Button size="sm" icon={Pencil} onClick={() => onEdit?.(user)}>{t('common.edit')}</Button>
              </div>
            </div>
          ) : null
        }
      >
        {isLoading ? (
          <div className="space-y-3"><div className="skeleton h-24 w-full" /><div className="skeleton h-20 w-full" /><div className="skeleton h-40 w-full" /></div>
        ) : isError ? (
          <ErrorState message={error?.message} onRetry={refetch} />
        ) : user ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3.5 rounded-2xl border border-white/[0.07] bg-gradient-to-br from-emerald-500/[0.07] to-cyan-500/[0.03] p-4">
              <Avatar name={user.name || user.username} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">{user.name || `@${user.username}`}</p>
                <p className="truncate text-[11px] text-slate-400">@{user.username}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={user.status} />
                  <Badge tone={user.role === 'admin' ? 'violet' : 'cyan'}>{user.role === 'admin' ? t('common.admin') : t('common.reseller')}</Badge>
                  {user.isOwner ? <Badge tone="amber">{t('common.owner')}</Badge> : null}
                </div>
              </div>
              <div className="text-end">
                <p className="text-[10px] text-slate-500">{t('common.balance')}</p>
                <p className="text-base font-bold text-emerald-300">{formatNumber(user.balance, lang)}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { label: t('common.configs'), value: formatNumber(stats.configs, lang), icon: Boxes },
                { label: t('common.active'), value: formatNumber(stats.active, lang), icon: Activity },
                { label: t('common.quota'), value: formatBytes(stats.quotaBytes, lang), icon: Download },
                { label: t('common.used'), value: formatBytes(stats.usedBytes, lang), icon: CalendarClock },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
                  <item.icon className="h-3.5 w-3.5 text-slate-500" />
                  <p className="mt-1 text-[13px] font-bold text-white">{item.value}</p>
                  <p className="text-[9.5px] text-slate-500">{item.label}</p>
                </div>
              ))}
            </div>

            <SectionCard
              title={t('resellers.detail.limits')}
              bodyClass="p-4"
              actions={discountList.length ? (
                <Badge tone="emerald">{formatNumber(discountList.length, lang)} {t('resellers.detail.discountCount')}</Badge>
              ) : null}
            >
              <div className="grid gap-x-6 sm:grid-cols-2">
                <InfoRow label={t('resellers.form.maxConfigs')} value={user.limits.maxConfigs ? formatNumber(user.limits.maxConfigs, lang) : '∞'} />
                <InfoRow label={t('resellers.form.maxTotalGb')} value={user.limits.maxTotalGb ? `${formatNumber(user.limits.maxTotalGb, lang)} GB` : '∞'} />
                <InfoRow label={t('resellers.form.maxGbPerConfig')} value={user.limits.maxGbPerConfig ? `${formatNumber(user.limits.maxGbPerConfig, lang)} GB` : '∞'} />
                <InfoRow label={t('resellers.form.maxDaysPerConfig')} value={user.limits.maxDaysPerConfig ? `${formatNumber(user.limits.maxDaysPerConfig, lang)}` : '∞'} />
                <InfoRow label={t('common.email')} value={user.email || '—'} />
                <InfoRow label={t('common.phone')} value={user.phone || '—'} />
                <InfoRow label={t('resellers.table.lastLogin')} value={user.lastLoginAt ? relativeTime(user.lastLoginAt, lang) : '—'} />
                <InfoRow label={t('common.createdAt')} value={formatDate(user.createdAt, lang)} />
              </div>
              {user.allowedInbounds?.length ? (
                <div className="mt-2 flex flex-wrap gap-1 border-t border-white/[0.06] pt-3">
                  {user.allowedInbounds.map((id) => <Badge key={id} tone="cyan">#{id}</Badge>)}
                </div>
              ) : null}
              {user.note ? <p className="mt-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-[11px] text-slate-400">{user.note}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
                <Button size="xs" variant="soft" icon={Wallet} onClick={() => setBalanceOpen(true)}>{t('resellers.detail.adjustBalance')}</Button>
                <Button size="xs" variant="soft" icon={Percent} onClick={() => setDiscountsOpen(true)}>{t('resellers.detail.discounts')}</Button>
                <Button size="xs" variant="ghost" icon={KeyRound} onClick={() => setPasswordOpen(true)}>{t('resellers.detail.resetPassword')}</Button>
                {user.role === 'reseller' ? (
                  <Button size="xs" variant="ghost" icon={RefreshCw} onClick={() => regenerate.mutate()} loading={regenerate.isPending}>{t('resellers.detail.regenerate')}</Button>
                ) : null}
              </div>
              {user.apiKey ? (
                <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
                  <p className="mb-1 text-[10px] text-slate-500">{t('resellers.detail.apiKey')}</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-300" dir="ltr">{user.apiKey}</code>
                    <CopyButton value={user.apiKey} iconOnly />
                  </div>
                </div>
              ) : null}
            </SectionCard>

            <SectionCard
              title={t('resellers.detail.configs')}
              bodyClass="p-0"
              actions={configs.length ? <Badge tone="slate">{formatNumber(data?.configs?.total || configs.length, lang)}</Badge> : null}
            >
              {configs.length ? (
                <div className="divide-y divide-white/[0.04]">
                  {configs.map((row) => (
                    <button key={row.id} type="button" onClick={() => setConfigId(row.id)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-start transition hover:bg-white/[0.03]">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300"><Boxes className="h-3.5 w-3.5" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11.5px] text-slate-200">{row.label || row.email}</p>
                        <p className="truncate text-[9.5px] text-slate-500">{row.inbound?.remark} · {formatBytes(row.used, lang)}</p>
                      </div>
                      <StatusBadge status={row.status} />
                    </button>
                  ))}
                </div>
              ) : <EmptyState icon={Boxes} title={t('configs.empty')} className="py-8" />}
            </SectionCard>

            <SectionCard title={t('resellers.detail.transactions')} bodyClass="p-0">
              {transactions.length ? (
                <div className="divide-y divide-white/[0.04]">
                  {transactions.map((tx) => (
                    <div key={tx.id} className="flex items-center justify-between gap-2 px-4 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] text-slate-300">{tx.description || tx.type}</p>
                        <p className="text-[9px] text-slate-500">{formatDate(tx.createdAt, lang, true)}</p>
                      </div>
                      <span className={cx('text-[11px] font-semibold', tx.amount < 0 ? 'text-rose-300' : 'text-emerald-300')}>
                        {tx.amount > 0 ? '+' : ''}{formatNumber(tx.amount, lang)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : <EmptyState icon={CreditCard} title={t('wallet.empty')} className="py-8" />}
            </SectionCard>
          </div>
        ) : null}
      </Drawer>

      <BalanceModal open={balanceOpen} onClose={() => setBalanceOpen(false)} user={user || {}} />
      <DiscountsModal open={discountsOpen} onClose={() => setDiscountsOpen(false)} user={user || {}} />
      <Modal
        open={passwordOpen}
        onClose={() => setPasswordOpen(false)}
        title={t('resellers.detail.resetPassword')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasswordOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={changePassword.isPending} onClick={() => changePassword.mutate()}>{t('common.save')}</Button>
          </>
        }
      >
        <Field label={t('resellers.detail.newPassword')} hint={t('resellers.form.passwordHint')}>
          <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" autoComplete="new-password" />
        </Field>
      </Modal>
      <ConfigDetail open={Boolean(configId)} configId={configId} onClose={() => setConfigId(null)} onChanged={invalidate} />
    </>
  );
}

export default function Resellers() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 350);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [discountUser, setDiscountUser] = useState(null);

  useEffect(() => { setPage(1); }, [debounced, status, role]);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (debounced) params.set('search', debounced);
    if (status) params.set('status', status);
    if (role) params.set('role', role);
    params.set('page', String(page));
    params.set('pageSize', '20');
    return params.toString();
  }, [debounced, status, role, page]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'users', query],
    queryFn: () => api.get(`/admin/users?${query}`),
    placeholderData: (prev) => prev,
  });

  const rows = data?.rows || [];

  const toggleStatus = async (row) => {
    const ok = await confirm({
      title: row.status === 'active' ? t('resellers.disableConfirm') : t('resellers.enableConfirm'),
      danger: row.status === 'active',
    });
    if (!ok) return;
    try {
      await api.post(`/admin/users/${row.id}/status`, { status: row.status === 'active' ? 'disabled' : 'active' });
      toast.success(t('common.updated'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (err) {
      toast.error(translateError(err, t));
    }
  };

  return (
    <>
      <PageHeader
        title={t('resellers.title')}
        subtitle={t('resellers.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={Download} onClick={() => downloadFile('/admin/users/export.csv', 'resellers.csv')}>{t('common.export')}</Button>
            <Button icon={Plus} onClick={() => { setEditing(null); setFormOpen(true); }}>{t('resellers.new')}</Button>
          </>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder={t('resellers.searchPlaceholder')} className="w-full max-w-xs" />
        <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-auto min-w-[128px]">
          <option value="">{t('common.all')}</option>
          <option value="reseller">{t('common.reseller')}</option>
          <option value="admin">{t('common.admin')}</option>
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-[128px]">
          <option value="">{t('common.allStatuses')}</option>
          <option value="active">{t('common.active')}</option>
          <option value="disabled">{t('common.disabled')}</option>
        </Select>
        <div className="ms-auto">
          <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={() => refetch()} className={cx(isFetching && '[&>svg]:animate-spin')} />
        </div>
      </Toolbar>

      {isLoading ? (
        <div className="table-wrap"><TableSkeleton rows={7} cols={6} /></div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : rows.length ? (
        <>
          <div className="table-wrap hidden md:block">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('resellers.table.user')}</th>
                    <th>{t('resellers.table.limits')}</th>
                    <th>{t('resellers.table.usage')}</th>
                    <th>{t('resellers.table.balance')}</th>
                    <th>{t('resellers.table.lastLogin')}</th>
                    <th>{t('common.status')}</th>
                    <th className="text-end">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="cursor-pointer" onClick={() => setDetailId(row.id)}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={row.name || row.username} />
                          <div className="min-w-0">
                            <p className="max-w-[180px] truncate text-[12.5px] font-medium text-slate-200">{row.name || `@${row.username}`}</p>
                            <p className="max-w-[180px] truncate text-[10px] text-slate-500">@{row.username} · {row.role === 'admin' ? t('common.admin') : t('common.reseller')}</p>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="flex max-w-[170px] flex-wrap gap-1">
                          <LimitBadge icon={Boxes} value={row.limits.maxConfigs} />
                          <LimitBadge icon={Download} value={row.limits.maxTotalGb} suffix="G" />
                          <LimitBadge icon={CalendarClock} value={row.limits.maxDaysPerConfig} suffix="d" />
                        </div>
                      </td>
                      <td>
                        <p className="text-[11.5px] text-slate-300">{formatNumber(row.stats?.configs, lang)} {t('common.configs')}</p>
                        <p className="text-[10px] text-slate-500">{formatBytes(row.stats?.usedBytes, lang)}</p>
                      </td>
                      <td>
                        <span className={cx('text-[12px] font-semibold', Number(row.balance) > 0 ? 'text-emerald-300' : 'text-slate-400')}>
                          {formatNumber(row.balance, lang)}
                        </span>
                      </td>
                      <td><span className="text-[11px] text-slate-400">{row.lastLoginAt ? relativeTime(row.lastLoginAt, lang) : '—'}</span></td>
                      <td><StatusBadge status={row.status} /></td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                          {row.role === 'reseller' ? (
                            <IconButton icon={Percent} label={t('resellers.detail.discounts')} onClick={() => setDiscountUser(row)} />
                          ) : null}
                          <IconButton icon={Pencil} label={t('common.edit')} onClick={() => { setEditing(row); setFormOpen(true); }} />
                          <IconButton icon={row.status === 'active' ? UserX : BadgeCheck} label={t('common.status')} onClick={() => toggleStatus(row)} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2.5 md:hidden">
            {rows.map((row) => (
              <div key={row.id} role="button" tabIndex={0} onClick={() => setDetailId(row.id)} className="card w-full p-3.5 text-start">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={row.name || row.username} size="sm" />
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-slate-100">{row.name || `@${row.username}`}</p>
                      <p className="truncate text-[9.5px] text-slate-500">{formatNumber(row.stats?.configs, lang)} {t('common.configs')}</p>
                    </div>
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <div className="mt-2.5 flex items-center justify-between text-[10.5px]">
                  <span className="text-slate-500">{t('common.balance')}</span>
                  <span className="font-semibold text-emerald-300">{formatNumber(row.balance, lang)}</span>
                </div>
                {row.role === 'reseller' ? (
                  <div className="mt-2.5 border-t border-white/[0.06] pt-2">
                    <Button
                      size="xs"
                      variant="soft"
                      icon={Percent}
                      onClick={(event) => { event.stopPropagation(); setDiscountUser(row); }}
                    >
                      {t('resellers.detail.discounts')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
        </>
      ) : (
        <div className="card">
          <EmptyState
            icon={Users}
            title={t('resellers.empty')}
            action={<Button size="sm" icon={Plus} onClick={() => { setEditing(null); setFormOpen(true); }}>{t('resellers.new')}</Button>}
          />
        </div>
      )}

      <UserForm open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
      <UserDetail
        userId={detailId}
        onClose={() => setDetailId(null)}
        onEdit={(user) => { setEditing(user); setFormOpen(true); }}
      />
      <DiscountsModal open={Boolean(discountUser)} onClose={() => setDiscountUser(null)} user={discountUser || {}} />
    </>
  );
}
