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
  DownloadCloud,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Minus,
  Pencil,
  Percent,
  Pin,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  UserX,
  Users,
  Wallet,
  WifiOff,
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
  Switch,
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
  telegramId: '',
  importConfigs: true,
  role: 'reseller',
  status: 'active',
  permissions: [],
  allowed_inbounds: [],
  fixed_inbound: 0,
  max_configs: 0,
  max_total_gb: 0,
  max_gb_per_config: 0,
  max_days_per_config: 0,
  balance: 0,
  note: '',
};

// A single sentence describing what a Telegram adoption pass did.
function importMessage(result, t) {
  if (result?.enabled === false) return t('resellers.import.disabled');
  const added = Number(result?.imported || 0) + Number(result?.restored || 0);
  const refreshed = Number(result?.refreshed || 0);
  if (added) return refreshed ? t('resellers.import.doneRefreshed', { n: added, m: refreshed }) : t('resellers.import.done', { n: added });
  if (refreshed) return t('resellers.import.refreshed', { n: refreshed });
  if (Number(result?.conflicts || 0)) return t('resellers.import.conflicts', { n: result.conflicts });
  if (Number(result?.failed || 0)) return t('resellers.import.failed', { n: result.failed });
  return t('resellers.import.none');
}

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
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [savingFixed, setSavingFixed] = useState(false);
  const [merging, setMerging] = useState(false);
  const [recreating, setRecreating] = useState(false);

  const inboundsQuery = useQuery({
    queryKey: ['inbounds', 'form'],
    queryFn: () => api.get('/admin/inbounds'),
    enabled: open,
  });

  const inboundRemark = (id) => {
    const row = (inboundsQuery.data?.rows || []).find((item) => Number(item.id) === Number(id));
    return row?.remark || `#${id}`;
  };

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        ...EMPTY_FORM,
        username: editing.username || '',
        name: editing.name || '',
        email: editing.email || '',
        phone: editing.phone || '',
        telegramId: editing.telegramId || '',
        importConfigs: editing.importConfigs !== false,
        role: editing.role || 'reseller',
        status: editing.status || 'active',
        permissions: editing.permissions || [],
        allowed_inbounds: editing.allowedInbounds || [],
        fixed_inbound: Number(editing.fixedInbound || 0),
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

  // Panel v1.4.16: older packages — especially the subscriptions adopted from
  // another panel — usually do not carry the fixed inbound yet. Count them
  // first (the endpoint is read-only with dryRun) and only write after the
  // admin sees how many customer packages change: the pass attaches the channel
  // to the x-ui clients that already stand behind them, on another seller's panel.
  const applyFixedInbound = async (userId, preview = null) => {
    let summary = preview;
    if (!summary) {
      try {
        summary = await api.post(`/admin/users/${userId}/fixed-inbound/apply`, { dryRun: true });
      } catch (err) {
        toast.error(translateError(err, t));
        return;
      }
    }
    const need = Number(summary?.needFix || 0);
    if (!need) {
      toast.success(t('resellers.form.fixedInboundNothing', { inbound: inboundRemark(summary?.fixedInbound || form.fixed_inbound) }));
      return;
    }
    const go = await confirm({
      title: t('resellers.form.fixedInboundApplyTitle'),
      body: t('resellers.form.fixedInboundApplyBody', { n: need, inbound: inboundRemark(summary.fixedInbound || form.fixed_inbound) }),
    });
    if (!go) return;
    try {
      const result = await api.post(`/admin/users/${userId}/fixed-inbound/apply`, { dryRun: false });
      const healed = Number(result?.healed || 0);
      const skipped = Number(result?.skipped || 0);
      if (healed) toast.success(t('resellers.form.fixedInboundDone', { n: healed, m: skipped }));
      else toast.error(t('resellers.form.fixedInboundFailed', { reason: (result?.errors || [])[0] || '' }));
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user', userId] });
    } catch (err) {
      toast.error(translateError(err, t));
    }
  };

  // Panel v1.4.18: a customer package spread over more than one x-ui client has
  // channels that his own client's node link does not cover, so the drawer has to
  // offer a second address beside it. The owner wants every customer holding the
  // node's link, so merging moves the extra channels onto the client the customer
  // already subscribes to — one client, one node link, whole package. Count first
  // (dryRun is read-only) because the real pass deletes the duplicate client
  // this panel created on the x-ui panel.
  const mergePackages = async (userId) => {
    let preview = null;
    try {
      preview = await api.post(`/admin/users/${userId}/consolidate`, { dryRun: true });
    } catch (err) {
      toast.error(translateError(err, t));
      return;
    }
    const split = Number(preview?.split || 0);
    if (!split) {
      toast.success(t('resellers.form.mergeNothing', { n: Number(preview?.packages || 0) }));
      return;
    }
    const go = await confirm({
      title: t('resellers.form.mergeTitle'),
      body: t('resellers.form.mergeBody', { n: split }),
    });
    if (!go) return;
    try {
      const result = await api.post(`/admin/users/${userId}/consolidate`, { dryRun: false });
      const merged = Number(result?.merged || 0);
      const skipped = Number(result?.skipped || 0);
      if (merged) toast.success(t('resellers.form.mergeDone', { n: merged, m: skipped }));
      else toast.error(t('resellers.form.mergeFailed', { reason: (result?.errors || [])[0] || '' }));
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
      queryClient.invalidateQueries({ queryKey: ['configs'] });
    } catch (err) {
      toast.error(translateError(err, t));
    }
  };

  // Panel v1.4.21: the other direction of the same repair — customers whose
  // x-ui client is gone from the node panel. Those packages serve nothing: every
  // link errors out and no channel can be added. Count first (dryRun is
  // read-only), then build ONE client back per package with the same email,
  // UUID and subscription id, so the customer's old link works again.
  const recreateMissing = async (userId) => {
    let preview = null;
    try {
      preview = await api.post(`/admin/users/${userId}/recreate-missing`, { dryRun: true });
    } catch (err) {
      toast.error(translateError(err, t));
      return;
    }
    const missing = Number(preview?.missing || 0);
    if (!missing) {
      toast.success(t('resellers.form.recreateNothing', { n: Number(preview?.packages || 0) }));
      return;
    }
    const go = await confirm({
      title: t('resellers.form.recreateTitle'),
      body: t('resellers.form.recreateBody', { n: missing }),
    });
    if (!go) return;
    try {
      const result = await api.post(`/admin/users/${userId}/recreate-missing`, { dryRun: false });
      const restored = Number(result?.restored || 0);
      const skipped = Number(result?.skipped || 0);
      if (restored) toast.success(t('resellers.form.recreateDone', { n: restored, m: skipped }));
      else toast.error(t('resellers.form.recreateFailed', { reason: (result?.errors || [])[0] || '' }));
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
      queryClient.invalidateQueries({ queryKey: ['configs'] });
    } catch (err) {
      toast.error(translateError(err, t));
    }
  };

  const save = useMutation({
    mutationFn: (payload) => (editing ? api.patch(`/admin/users/${editing.id}`, payload) : api.post('/admin/users', payload)),
    onSuccess: async (result) => {
      // Reusing the name of a deleted reseller brings that account back, so the
      // panel says so instead of pretending it is a brand new one.
      if (result?.revived) toast.success(t('resellers.form.revived'));
      else toast.success(editing ? t('common.updated') : t('common.created'));
      // Creating/saving a reseller with a Telegram id adopts the subscriptions
      // that already exist under that id on the panels.
      if (result?.import) {
        const added = Number(result.import.imported || 0) + Number(result.import.restored || 0);
        const refreshed = Number(result.import.refreshed || 0);
        if (added || refreshed) {
          toast.success(importMessage(result.import, t));
          queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
        } else if (Number(result.import.conflicts || 0) || Number(result.import.failed || 0)) {
          toast.warning(importMessage(result.import, t));
        }
      }
      const pending = Number(result?.fixedInboundPreview?.needFix || 0);
      if (pending > 0) {
        await applyFixedInbound(result.user.id, result.fixedInboundPreview);
      }
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'user'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  // Deletion is a soft delete: the account is disabled and hidden and its
  // configs disappear from the panel, but x-ui itself is never touched.
  const remove = useMutation({
    mutationFn: () => api.del(`/admin/users/${editing.id}`),
    onSuccess: () => {
      toast.success(t('common.deleted'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askDelete = async () => {
    const ok = await confirm({
      title: t('resellers.detail.deleteConfirm'),
      body: `@${editing?.username || ''} · ${t('resellers.detail.deleteNote')}`,
      danger: true,
    });
    if (ok) remove.mutate();
  };

  const submit = (event) => {
    event.preventDefault();
    const payload = {
      username: form.username.trim(),
      name: form.name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      telegram_id: form.telegramId.trim(),
      import_configs: Boolean(form.importConfigs),
      role: form.role,
      status: form.status,
      note: form.note.trim(),
      max_configs: Number(form.max_configs || 0),
      max_total_gb: Number(form.max_total_gb || 0),
      max_gb_per_config: Number(form.max_gb_per_config || 0),
      max_days_per_config: Number(form.max_days_per_config || 0),
      allowed_inbounds: form.allowed_inbounds,
      fixed_inbound: Number(form.fixed_inbound || 0),
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
        editing ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button variant="danger" size="sm" icon={Trash2} loading={remove.isPending} onClick={askDelete}>
              {t('resellers.detail.deleteUser')}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
              <Button loading={save.isPending} onClick={submit} icon={ShieldCheck}>{t('common.save')}</Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button loading={save.isPending} onClick={submit} icon={ShieldCheck}>{t('common.save')}</Button>
          </>
        )
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
          <Field label={t('resellers.form.telegramId')} hint={t('resellers.form.telegramHint')}>
            <Input
              value={form.telegramId}
              onChange={(e) => setForm((prev) => ({ ...prev, telegramId: e.target.value.replace(/[^\d]/g, '') }))}
              dir="ltr"
              inputMode="numeric"
              maxLength={20}
              placeholder="123456789"
              autoComplete="off"
            />
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

        <div className={cx(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-3 transition',
          form.importConfigs ? 'border-emerald-400/25 bg-emerald-500/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'
        )}>
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-slate-200">{t('resellers.form.importConfigs')}</p>
            <p className="mt-0.5 text-[10.5px] leading-5 text-slate-500">{t('resellers.form.importHint')}</p>
          </div>
          <Switch checked={Boolean(form.importConfigs)} onChange={(value) => setForm((prev) => ({ ...prev, importConfigs: value }))} />
        </div>

        {form.role === 'reseller' ? (
          <div className={cx(
            'rounded-xl border px-3.5 py-3 transition',
            Number(form.fixed_inbound) > 0 ? 'border-sky-400/25 bg-sky-500/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'
          )}>
            <div className="flex items-center gap-2">
              <Pin className="h-3.5 w-3.5 text-sky-300" />
              <p className="text-[12.5px] font-medium text-slate-200">{t('resellers.form.fixedInbound')}</p>
            </div>
            <div className="mt-2.5 flex flex-wrap items-end gap-2">
              <Select
                className="min-w-[220px] flex-1"
                disabled={inboundsQuery.isLoading}
                value={String(Number(form.fixed_inbound) || 0)}
                onChange={(e) => setForm((prev) => ({ ...prev, fixed_inbound: Number(e.target.value) }))}
              >
                {/* While the inbound list is still loading the saved base has no
                    matching option yet, so the box would read «بدون اینباند ثابت»
                    and look as if the base had been cleared. Say what is really
                    happening instead, and block a pick until the list is there. */}
                <option value="0">
                  {inboundsQuery.isLoading && Number(form.fixed_inbound) > 0
                    ? t('common.loading')
                    : t('resellers.form.fixedInboundNone')}
                </option>
                {inbounds.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`${row.remark || `#${row.id}`} (${row.protocol})${row.serverName ? ` · ${row.serverName}` : ''}${row.visible === false ? ` · ${t('common.hidden')}` : ''}`}
                  </option>
                ))}
              </Select>
              {editing && Number(form.fixed_inbound) > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={savingFixed}
                  icon={RefreshCw}
                  onClick={() => {
                    setSavingFixed(true);
                    Promise.resolve(applyFixedInbound(editing.id)).finally(() => setSavingFixed(false));
                  }}
                >
                  {t('resellers.form.fixedInboundApply')}
                </Button>
              ) : null}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-5 text-slate-500">{t('resellers.form.fixedInboundHint')}</p>
          </div>
        ) : null}

        {/* Panel v1.4.18: the subscription link of a customer lives on the node
            (sub_base) as long as his package is ONE x-ui client. The heal of
            v1.4.16–17 added a second client to the adopted packages, which
            pushed those links behind this panel; this is the repair pass, and it
            only removes a client this panel created itself. */}
        {editing ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
            <div className="flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5 text-emerald-300" />
              <p className="text-[12.5px] font-medium text-slate-200">{t('resellers.form.mergeCard')}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-[10.5px] leading-5 text-slate-500">{t('resellers.form.mergeHint')}</p>
              <Button
                variant="ghost"
                size="sm"
                loading={merging}
                icon={RefreshCw}
                onClick={() => {
                  setMerging(true);
                  Promise.resolve(mergePackages(editing.id)).finally(() => setMerging(false));
                }}
              >
                {t('resellers.form.mergeButton')}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Panel v1.4.21: the customers whose x-ui client was deleted on the node
            panel. One client is built back per package, with the same email, UUID
            and subscription id, so their old link works again. */}
        {editing ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
            <div className="flex items-center gap-2">
              <WifiOff className="h-3.5 w-3.5 text-rose-300" />
              <p className="text-[12.5px] font-medium text-slate-200">{t('resellers.form.recreateCard')}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 flex-1 text-[10.5px] leading-5 text-slate-500">{t('resellers.form.recreateHint')}</p>
              <Button
                variant="ghost"
                size="sm"
                loading={recreating}
                icon={RefreshCw}
                onClick={() => {
                  setRecreating(true);
                  Promise.resolve(recreateMissing(editing.id)).finally(() => setRecreating(false));
                }}
              >
                {t('resellers.form.recreateButton')}
              </Button>
            </div>
          </div>
        ) : null}

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
                    // The «hidden» mark stays static while the box toggles, so
                    // this cannot re-introduce the v1.4.12 / v1.4.15 scroll jump.
                    label={(
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{row.remark || `#${row.id}`}</span>
                        <span className="shrink-0 text-slate-500">({row.protocol})</span>
                        {row.visible === false ? (
                          <Badge tone="amber" className="shrink-0 px-1.5 py-0 text-[9px]">{t('common.hidden')}</Badge>
                        ) : null}
                      </span>
                    )}
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

/**
 * v1.5.2 — the wallet adjustment the owner can actually use on a phone.
 *
 * The field used to be `type="number"`, so mobile opened the numeric keypad,
 * which has no «−» on it: deducting was impossible without a desktop. Now the
 * sign is a pair of explicit buttons (افزایش / کاهش), the field is plain text so
 * the FULL keyboard opens, and a typed «−» still works and flips the button for
 * him. The result is previewed against the real balance before anything is sent.
 */
const BALANCE_PRESETS = [100000, 500000, 1000000, 5000000];

function toEnglishDigits(value) {
  return String(value || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function BalanceModal({ open, onClose, user }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('add');
  const [description, setDescription] = useState('');

  useEffect(() => { if (open) { setAmount(''); setMode('add'); setDescription(''); } }, [open]);

  const balance = Number(user?.balance || 0);
  const normalized = toEnglishDigits(amount).replace(/[,\s٬،]/g, '');
  const typedNegative = normalized.trim().startsWith('-');
  const value = Number(normalized.replace(/[^0-9]/g, '') || 0);
  const negative = typedNegative || mode === 'sub';
  const signed = negative ? -value : value;
  const after = balance + signed;
  const invalid = !Number.isFinite(value) || value <= 0 || after < 0;

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

  const onAmountChange = (raw) => {
    setAmount(raw);
    // A typed minus is the operator's own choice: follow it instead of fighting
    // him with a sign he cannot see on the keypad.
    if (toEnglishDigits(raw).trim().startsWith('-')) setMode('sub');
  };

  const submit = () => {
    if (invalid) return;
    adjust.mutate({ amount: signed, description });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('resellers.detail.adjustBalance')}
      subtitle={`${user?.username} · ${formatMoney(balance, lang)}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            loading={adjust.isPending}
            disabled={invalid}
            onClick={submit}
            icon={Wallet}
            variant={negative ? 'danger' : 'primary'}
          >
            {t('common.apply')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant={mode === 'add' && !typedNegative ? 'primary' : 'secondary'}
            size="sm"
            icon={Plus}
            onClick={() => { setMode('add'); setAmount(toEnglishDigits(amount).replace(/^-/, '')); }}
          >
            {t('resellers.detail.addCredit')}
          </Button>
          <Button
            variant={negative ? 'danger' : 'secondary'}
            size="sm"
            icon={Minus}
            onClick={() => { setMode('sub'); setAmount(toEnglishDigits(amount).replace(/^-/, '')); }}
          >
            {t('resellers.detail.deduct')}
          </Button>
        </div>
        <Field
          label={t('resellers.detail.amount')}
          hint={t('resellers.detail.amountKeyboardHint')}
        >
          <Input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            placeholder={negative ? '-500000' : '500000'}
            dir="ltr"
            className="text-center text-lg font-semibold"
          />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {BALANCE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setAmount(String(preset))}
              className={cx(
                'rounded-lg border px-2 py-1 text-[11px] transition',
                value === preset
                  ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:border-white/25'
              )}
            >
              {formatNumber(preset, lang)}
            </button>
          ))}
        </div>
        <div
          className={cx(
            'rounded-xl border px-3 py-2 text-xs',
            after < 0 ? 'border-rose-400/40 bg-rose-400/10 text-rose-200' : 'border-white/10 bg-white/5 text-slate-300'
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span>{t('resellers.detail.balanceAfter')}</span>
            <b dir="ltr" className="text-sm">{formatMoney(after, lang)}</b>
          </div>
          {value <= 0 ? (
            <p className="mt-1 text-[11px] opacity-80">{t('resellers.detail.balanceZero')}</p>
          ) : after < 0 ? (
            <p className="mt-1 text-[11px]">{t('resellers.detail.balanceNegative')}</p>
          ) : null}
        </div>
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

  // The drawer names the fixed inbound by its remark, so it needs the inbound
  // list too — only fetched while a fixed inbound is actually set.
  const detailInboundsQuery = useQuery({
    queryKey: ['admin', 'inbounds', 'fixed-label'],
    queryFn: () => api.get('/admin/inbounds'),
    staleTime: 60000,
    enabled: Boolean(userId),
  });

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

  const fetchSubscriptions = useMutation({
    mutationFn: () => api.post(`/admin/users/${userId}/import`),
    onSuccess: (result) => {
      const added = Number(result?.imported || 0) + Number(result?.restored || 0);
      if (added) toast.success(importMessage(result, t));
      else if (Number(result?.conflicts || 0) || Number(result?.failed || 0)) toast.warning(importMessage(result, t));
      else toast.info(importMessage(result, t));
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askFetch = () => {
    if (!user?.telegramId) { toast.error(t('resellers.import.noId')); return; }
    if (user?.importConfigs === false) { toast.error(t('resellers.import.disabled')); return; }
    fetchSubscriptions.mutate();
  };

  // Quick on/off switch inside the reseller drawer. Enabling runs one adoption
  // pass immediately; disabling only hides the adopted rows (x-ui untouched).
  const setImportConfigs = useMutation({
    mutationFn: (value) => api.patch(`/admin/users/${userId}`, { import_configs: value }),
    onSuccess: (result, value) => {
      toast.success(value ? t('resellers.detail.on') : t('resellers.detail.off'));
      if (value && result?.import) {
        const added = Number(result.import.imported || 0) + Number(result.import.restored || 0);
        const refreshed = Number(result.import.refreshed || 0);
        if (added || refreshed) toast.success(importMessage(result.import, t));
        else if (Number(result.import.conflicts || 0) || Number(result.import.failed || 0)) toast.warning(importMessage(result.import, t));
      }
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
      invalidate();
    },
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
      body: `@${user?.username || ''} · ${t('resellers.detail.deleteNote')}`,
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
                { label: t('common.customers'), value: formatNumber(stats.packages ?? stats.configs, lang), icon: Boxes },
                { label: t('common.active'), value: formatNumber(stats.activePackages ?? stats.active, lang), icon: Activity },
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
                <InfoRow label={t('resellers.detail.telegramId')} value={user.telegramId || '—'} />
                <InfoRow label={t('resellers.table.lastLogin')} value={user.lastLoginAt ? relativeTime(user.lastLoginAt, lang) : '—'} />
                <InfoRow label={t('common.createdAt')} value={formatDate(user.createdAt, lang)} />
              </div>
              {Number(user.fixedInbound || 0) > 0 ? (
                <div className="mt-2 flex items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-500/[0.05] px-3 py-2">
                  <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-300" />
                  <div className="min-w-0">
                    <p className="text-[11.5px] font-medium text-slate-200">{t('resellers.form.fixedInbound')}</p>
                    <p className="mt-0.5 truncate text-[10.5px] text-sky-100/80" dir="auto">
                      {(detailInboundsQuery.data?.rows || []).find((row) => Number(row.id) === Number(user.fixedInbound))?.remark
                        || `#${user.fixedInbound}`}
                    </p>
                  </div>
                </div>
              ) : null}
              {user.allowedInbounds?.length ? (
                <div className="mt-2 flex flex-wrap gap-1 border-t border-white/[0.06] pt-3">
                  {user.allowedInbounds.map((id) => <Badge key={id} tone="cyan">#{id}</Badge>)}
                </div>
              ) : null}
              {user.note ? <p className="mt-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-[11px] text-slate-400">{user.note}</p> : null}
              <div className={cx(
                'mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5 transition',
                user.importConfigs !== false ? 'border-emerald-400/25 bg-emerald-500/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'
              )}>
                <div className="min-w-0">
                  <p className="text-[12px] font-medium text-slate-200">{t('resellers.detail.importConfigs')}</p>
                  <p className="mt-0.5 text-[10px] leading-5 text-slate-500">{t('resellers.form.importHint')}</p>
                </div>
                <Switch
                  checked={user.importConfigs !== false}
                  disabled={setImportConfigs.isPending}
                  onChange={(value) => setImportConfigs.mutate(value)}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
                <Button size="xs" variant="soft" icon={DownloadCloud} onClick={askFetch} loading={fetchSubscriptions.isPending}>{t('resellers.detail.fetch')}</Button>
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
                        <p className="truncate text-[11.5px] text-slate-200">{row.customerName || row.label || row.email}</p>
                        <p className="truncate text-[9.5px] text-slate-500">
                          {row.groupCount > 1
                            ? `${t('configs.packageCount', { n: formatNumber(row.groupCount, lang) })} · ${(row.inbounds || []).map((item) => item.remark).join(' + ')}`
                            : `${row.inbound?.remark || ''} · ${formatBytes(row.used, lang)}`}
                        </p>
                      </div>
                      {row.groupStatus === 'mixed'
                        ? <Badge tone="amber" dot>{t('configs.mixedStatus')}</Badge>
                        : <StatusBadge status={row.groupStatus || row.status} />}
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
      <ConfigDetail key={configId || 'closed'} open={Boolean(configId)} configId={configId} onSelect={setConfigId} onClose={() => setConfigId(null)} onChanged={invalidate} />
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

  // Same soft delete the edit dialog and the detail drawer use: the account is
  // disabled and hidden, its configs leave the list, and x-ui stays untouched.
  // The only owner can never be deleted — the API refuses it and the reason is
  // shown as a toast.
  const removeRow = async (row) => {
    const ok = await confirm({
      title: t('resellers.detail.deleteConfirm'),
      body: `@${row.username} · ${t('resellers.detail.deleteNote')}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/admin/users/${row.id}`);
      toast.success(t('common.deleted'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'configs'] });
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
                            <p className="max-w-[180px] truncate text-[10px] text-slate-500">@{row.username} · {row.role === 'admin' ? t('common.admin') : t('common.reseller')}{row.telegramId ? ` · TG ${row.telegramId}` : ''}</p>
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
                        <p className="text-[11.5px] text-slate-300">{formatNumber(row.stats?.packages ?? row.stats?.configs, lang)} {t('common.customers')}</p>
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
                          <IconButton
                            icon={Trash2}
                            variant="ghost"
                            label={t('resellers.detail.deleteUser')}
                            className="text-rose-300/80 hover:bg-rose-500/15 hover:text-rose-200"
                            onClick={() => removeRow(row)}
                          />
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
                      <p className="truncate text-[9.5px] text-slate-500">{formatNumber(row.stats?.packages ?? row.stats?.configs, lang)} {t('common.customers')}</p>
                    </div>
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <div className="mt-2.5 flex items-center justify-between text-[10.5px]">
                  <span className="text-slate-500">{t('common.balance')}</span>
                  <span className="font-semibold text-emerald-300">{formatNumber(row.balance, lang)}</span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-2">
                  {row.role === 'reseller' ? (
                    <Button
                      size="xs"
                      variant="soft"
                      icon={Percent}
                      onClick={(event) => { event.stopPropagation(); setDiscountUser(row); }}
                    >
                      {t('resellers.detail.discounts')}
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="soft"
                    icon={Trash2}
                    className="text-rose-300/85 hover:text-rose-200"
                    onClick={(event) => { event.stopPropagation(); removeRow(row); }}
                  >
                    {t('resellers.detail.deleteUser')}
                  </Button>
                </div>
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
