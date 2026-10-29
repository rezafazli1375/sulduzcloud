import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Check,
  Copy,
  CreditCard,
  ExternalLink,
  Fingerprint,
  Link2,
  Loader2,
  Layers,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  RotateCcw,
  Server,
  Ticket,
  Trash2,
  UserRound,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { copyText, daysLeft, formatBytes, formatDate, formatMoney, formatNumber, pct, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  CopyButton,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  InfoRow,
  Input,
  Modal,
  QrModal,
  SectionCard,
  Skeleton,
  StatusBadge,
  UsageBar,
  cx,
} from '../ui.jsx';
import { useConfirm, useToast } from '../feedback.jsx';

function UsageRing({ used, total, lang }) {
  const percent = pct(used, total);
  const value = percent === null ? 100 : Math.min(100, percent);
  const color = percent === null ? '#34d399' : percent >= 90 ? '#f43f5e' : percent >= 70 ? '#f59e0b' : '#34d399';
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <div className="relative flex h-[120px] w-[120px] items-center justify-center">
      <svg viewBox="0 0 110 110" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="55" cy="55" r={radius} fill="none" stroke="rgba(148,163,184,.12)" strokeWidth="8" />
        <circle
          cx="55"
          cy="55"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.22,1,.36,1)', filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="relative text-center">
        <p className="text-lg font-bold text-white">{percent === null ? '∞' : `${formatNumber(percent, lang, 1)}%`}</p>
        <p className="text-[9.5px] text-slate-500">{formatBytes(used, lang)}</p>
      </div>
    </div>
  );
}

function randomUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function randomSubId() {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default function ConfigDetail({ open, configId, onClose, onChanged }) {
  const { t, lang } = useI18n();
  const { isAdmin, meta } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const base = isAdmin ? '/admin/configs' : '/reseller/configs';
  const currency = meta?.billing?.currency || '';

  const [sheet, setSheet] = useState(null); // extend | quota | edit | identity | addInbound
  const [qr, setQr] = useState(null);
  const [extendForm, setExtendForm] = useState({ gb: 10, days: 30, resetUsage: false });
  const [quotaForm, setQuotaForm] = useState({ gb: 0, days: 0, enabled: true });
  const [editForm, setEditForm] = useState({ label: '', customerName: '', customerPhone: '', note: '' });
  const [identityForm, setIdentityForm] = useState({ uuid: '', subId: '' });

  const detail = useQuery({
    queryKey: ['config', configId],
    queryFn: () => api.get(`${base}/${configId}`),
    enabled: open && Boolean(configId),
  });

  const config = detail.data?.config;
  const group = detail.data?.group || [];
  const links = detail.data?.links || [];
  const subUrl = detail.data?.subUrl || '';
  const linksError = detail.data?.error || '';

  const addableQuery = useQuery({
    queryKey: ['config-inbounds', isAdmin, config?.userId],
    queryFn: () => api.get(isAdmin ? `/admin/inbounds?userId=${config?.userId || 0}` : '/reseller/inbounds'),
    enabled: open && sheet === 'addInbound',
  });

  const billingOn = Boolean(meta?.billing?.enabled);
  const groupInboundIds = group.length
    ? group.map((item) => item.inboundId)
    : config
      ? [config.inboundId]
      : [];
  const extendQuote = useQuery({
    queryKey: [
      'extend-quote',
      isAdmin ? 'admin' : 'reseller',
      isAdmin ? String(config?.userId || '') : 'self',
      [...groupInboundIds].sort((a, b) => a - b).join(','),
      Number(extendForm.gb || 0),
      Number(extendForm.days || 0),
    ],
    queryFn: () => api.post(isAdmin ? '/admin/pricing/quote' : '/reseller/configs/quote', {
      userId: isAdmin ? Number(config?.userId) : undefined,
      inboundIds: groupInboundIds,
      gb: Number(extendForm.gb || 0),
      days: Number(extendForm.days || 0),
    }),
    enabled: open && sheet === 'extend' && billingOn && groupInboundIds.length > 0,
    staleTime: 15000,
    retry: false,
  });
  const extendBasis = (extendQuote.data?.items || []).find((item) => item.basis);
  const extendInsufficient = billingOn && extendQuote.data?.sufficient === false;

  useEffect(() => {
    if (!config) return;
    setEditForm({
      label: config.label || '',
      customerName: config.customerName || '',
      customerPhone: config.customerPhone || '',
      note: config.note || '',
    });
    setQuotaForm({ gb: Number(config.totalGb || 0), days: 0, enabled: Boolean(config.enabled) });
    setIdentityForm({ uuid: config.uuid || '', subId: config.subId || '' });
  }, [config?.id, config?.label, config?.customerName, config?.customerPhone, config?.note, config?.totalGb, config?.enabled, config?.uuid, config?.subId]);

  // Prefer the live x-ui identity over the local copy when editing.
  useEffect(() => {
    const live = detail.data?.client;
    if (!live || (!live.uuid && !live.subId)) return;
    setIdentityForm({ uuid: live.uuid || '', subId: live.subId || '' });
  }, [detail.data?.client?.uuid, detail.data?.client?.subId]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['config', configId] });
    queryClient.invalidateQueries({ queryKey: ['configs'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
    queryClient.invalidateQueries({ queryKey: ['reseller', 'overview'] });
    onChanged?.();
  };

  const onError = (err) => toast.error(translateError(err, t));

  const extend = useMutation({
    mutationFn: (payload) => api.post(`${base}/${configId}/extend`, payload),
    onSuccess: () => { toast.success(t('common.saved')); setSheet(null); refresh(); },
    onError,
  });

  const quota = useMutation({
    mutationFn: (payload) => api.post(`${base}/${configId}/quota`, payload),
    onSuccess: () => { toast.success(t('common.saved')); setSheet(null); refresh(); },
    onError,
  });

  const toggle = useMutation({
    mutationFn: (enabled) => api.post(`${base}/${configId}/toggle`, { enabled }),
    onSuccess: (data) => { toast.success(t('common.updated')); refresh(); },
    onError,
  });

  const reset = useMutation({
    mutationFn: () => api.post(`${base}/${configId}/reset`),
    onSuccess: () => { toast.success(t('common.done')); refresh(); },
    onError,
  });

  const saveMeta = useMutation({
    mutationFn: (payload) => api.patch(`${base}/${configId}`, payload),
    onSuccess: () => { toast.success(t('common.saved')); setSheet(null); refresh(); },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => api.del(`${base}/${configId}`),
    onSuccess: () => { toast.success(t('common.deleted')); onClose?.(); refresh(); },
    onError,
  });

  const saveIdentity = useMutation({
    mutationFn: (payload) => api.post(`${base}/${configId}/identity`, payload),
    onSuccess: () => { toast.success(t('configs.identity.saved')); setSheet(null); refresh(); },
    onError,
  });

  const addInbound = useMutation({
    mutationFn: (inboundId) => api.post(`${base}/${configId}/inbounds`, { inboundId }),
    onSuccess: () => { toast.success(t('configs.group.added')); setSheet(null); refresh(); },
    onError,
  });

  const removeInbound = useMutation({
    mutationFn: (targetId) => api.del(`${base}/${targetId}`),
    onSuccess: (_data, targetId) => {
      toast.success(t('configs.group.removed'));
      if (Number(targetId) === Number(configId)) onClose?.();
      refresh();
    },
    onError,
  });

  const askRemoveInbound = async (item) => {
    const ok = await confirm({
      title: t('configs.group.removeConfirm'),
      body: item ? `${item.inbound?.remark || `#${item.inboundId}`} · ${item.email}` : '',
      danger: true,
      confirmText: t('configs.group.remove'),
    });
    if (ok) removeInbound.mutate(item.id);
  };

  const askDelete = async () => {
    const ok = await confirm({
      title: t('configs.deleteConfirm'),
      body: t('configs.deleteBody'),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) remove.mutate();
  };

  const askReset = async () => {
    const ok = await confirm({ title: t('configs.actions.reset'), body: t('common.irreversible'), danger: true });
    if (ok) reset.mutate();
  };

  const allLinks = [subUrl, ...links].filter(Boolean);
  const left = config ? daysLeft(config.expiryAt, lang) : null;
  const addable = (addableQuery.data?.rows || []).filter(
    (row) => row.enabled && (isAdmin || row.visible) && !group.some((item) => Number(item.inboundId) === Number(row.id))
  );

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={config ? config.label || config.customerName || config.email : t('configs.detail.title')}
        subtitle={config ? `${config.email} · #${config.id}` : ''}
        width="max-w-2xl"
        footer={
          config ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button variant="danger" size="sm" icon={Trash2} onClick={askDelete} loading={remove.isPending}>{t('common.delete')}</Button>
                <Button variant="ghost" size="sm" icon={RotateCcw} onClick={askReset} loading={reset.isPending}>{t('configs.actions.reset')}</Button>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" icon={Power} onClick={() => toggle.mutate(!config.enabled)} loading={toggle.isPending}>
                  {config.enabled ? t('configs.actions.disable') : t('configs.actions.enable')}
                </Button>
                <Button size="sm" icon={Zap} onClick={() => { setExtendForm({ gb: 10, days: 30, resetUsage: false }); setSheet('extend'); }}>
                  {t('configs.actions.extend')}
                </Button>
              </div>
            </div>
          ) : null
        }
      >
        {detail.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : detail.isError ? (
          <EmptyState icon={AlertTriangle} title={t('errors.generic')} hint={detail.error?.message} />
        ) : config ? (
          <div className="space-y-4">
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-gradient-to-br from-emerald-500/[0.07] via-transparent to-cyan-500/[0.04] p-4">
              <div className="pointer-events-none absolute -end-10 -top-10 h-32 w-32 rounded-full bg-emerald-500/10 blur-3xl" />
              <div className="relative flex items-center gap-4">
                <UsageRing used={config.used} total={config.totalBytes} lang={lang} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={config.status} />
                    {config.expiryAt ? (
                      <Badge tone={left !== null && left <= 3 ? 'amber' : 'slate'}>
                        <CalendarClock className="h-3 w-3" />
                        {left !== null && left > 0 ? `${formatNumber(left, lang)} ${t('common.days')}` : t('common.expired')}
                      </Badge>
                    ) : <Badge tone="cyan">{t('common.unlimited')}</Badge>}
                  </div>
                  <p className="mt-2 truncate text-[12px] text-slate-300">
                    {config.customerName || '—'} {config.customerPhone ? `· ${config.customerPhone}` : ''}
                  </p>
                  <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10.5px] text-slate-500">
                    <span className="flex items-center gap-1"><Wifi className="h-3 w-3" />{t('common.used')}: <b className="text-slate-300">{formatBytes(config.used, lang)}</b></span>
                    <span className="flex items-center gap-1"><Zap className="h-3 w-3" />{t('common.quota')}: <b className="text-slate-300">{config.totalBytes ? formatBytes(config.totalBytes, lang) : '∞'}</b></span>
                    <span className="flex items-center gap-1"><CalendarClock className="h-3 w-3" />{t('common.expiry')}: <b className="text-slate-300">{config.expiryAt ? formatDate(config.expiryAt, lang) : '∞'}</b></span>
                    <span className="flex items-center gap-1"><Activity className="h-3 w-3" />{t('configs.detail.lastOnline')}: <b className="text-slate-300">{config.lastOnlineAt ? relativeTime(config.lastOnlineAt, lang) : '—'}</b></span>
                  </div>
                </div>
              </div>
            </div>

            <SectionCard title={t('configs.detail.title')} bodyClass="p-4" className="border-white/[0.06]">
              <div className="grid gap-x-6 sm:grid-cols-2">
                <InfoRow label={t('configs.detail.email')} value={config.email} mono />
                <InfoRow label={t('common.inbound')} value={config.inbound ? `${config.inbound.remark} · ${config.inbound.protocol}${config.inbound.serverName ? ` · ${config.inbound.serverName}` : ''}` : `#${config.inboundId}`} />
                {isAdmin ? <InfoRow label={t('configs.table.reseller')} value={config.reseller ? `@${config.reseller.username}` : '—'} /> : null}
                <InfoRow label={t('common.createdAt')} value={formatDate(config.createdAt, lang, true)} />
                <InfoRow label={t('common.status')} value={<StatusBadge status={config.status} />} />
                <InfoRow label={t('common.updatedAt')} value={formatDate(config.updatedAt, lang, true)} />
                {config.note ? <InfoRow label={t('common.note')} value={config.note} className="sm:col-span-2" /> : null}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
                <Button variant="ghost" size="xs" icon={UserRound} onClick={() => setSheet('edit')}>{t('configs.actions.edit')}</Button>
                <Button variant="ghost" size="xs" icon={Fingerprint} onClick={() => setSheet('identity')}>{t('configs.actions.identity')}</Button>
                {isAdmin ? (
                  <Button variant="ghost" size="xs" icon={CreditCard} onClick={() => setSheet('quota')}>{t('configs.quota.title')}</Button>
                ) : null}
                <Button variant="ghost" size="xs" icon={RefreshCw} onClick={() => detail.refetch()} loading={detail.isFetching}>{t('configs.detail.syncLinks')}</Button>
              </div>
            </SectionCard>

            <SectionCard
              title={t('common.links')}
              icon={Link2}
              actions={
                <div className="flex items-center gap-1.5">
                  {allLinks.length ? <CopyButton value={allLinks.join('\n')} label={t('configs.detail.copyAll')} size="xs" /> : null}
                </div>
              }
              bodyClass="p-4"
            >
              {linksError ? (
                <p className="mb-3 rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">{linksError}</p>
              ) : null}

              {subUrl ? (
                <div className="mb-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.05] p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200">
                      <Ticket className="h-3.5 w-3.5" />
                      {t('common.subscription')}
                    </span>
                    <div className="flex items-center gap-1">
                      <IconButton icon={QrCode} variant="ghost" label={t('common.qr')} onClick={() => setQr({ title: t('common.subscription'), value: subUrl })} />
                      <CopyButton value={subUrl} iconOnly />
                    </div>
                  </div>
                  <p className="break-all rounded-lg bg-[#050811]/60 px-2 py-1.5 font-mono text-[10.5px] leading-5 text-emerald-100/80" dir="ltr">{subUrl}</p>
                </div>
              ) : null}

              {links.length ? (
                <div className="space-y-2">
                  {links.map((link, index) => {
                    const protocol = link.split('://')[0] || 'link';
                    const name = link.split('#')[1] ? decodeURIComponent(link.split('#')[1]) : `${protocol.toUpperCase()} ${index + 1}`;
                    return (
                      <div key={`${protocol}-${index}`} className="group rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <Badge tone="cyan" className="shrink-0 uppercase">{protocol}</Badge>
                            <span className="truncate text-[11px] text-slate-300">{name}</span>
                          </span>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <IconButton icon={QrCode} variant="ghost" label={t('common.qr')} onClick={() => setQr({ title: name, value: link })} />
                            <CopyButton value={link} iconOnly />
                          </div>
                        </div>
                        <p className="mt-1 truncate font-mono text-[10px] text-slate-600" dir="ltr">{link}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                !subUrl ? <EmptyState icon={Link2} title={t('configs.detail.noLinks')} className="py-6" /> : null
              )}
            </SectionCard>

            <SectionCard
              title={t('configs.group.title')}
              icon={Layers}
              actions={
                <Button variant="soft" size="xs" icon={Plus} onClick={() => setSheet('addInbound')}>
                  {t('configs.group.add')}
                </Button>
              }
              bodyClass="p-4"
            >
              <p className="mb-3 text-[10.5px] leading-5 text-slate-500">{t('configs.group.hint')}</p>
              <div className="space-y-2">
                {group.map((item) => (
                  <div
                    key={item.id}
                    className={cx(
                      'flex items-center justify-between gap-2 rounded-xl border px-3 py-2',
                      Number(item.id) === Number(configId)
                        ? 'border-emerald-400/25 bg-emerald-500/[0.05]'
                        : 'border-white/[0.06] bg-white/[0.02]'
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12px] text-slate-200">
                        {item.inbound?.remark || `#${item.inboundId}`}
                        {Number(item.id) === Number(configId) ? (
                          <span className="ms-1.5 text-[9.5px] text-emerald-300">({t('configs.group.current')})</span>
                        ) : null}
                      </p>
                      <p className="truncate font-mono text-[9.5px] text-slate-500" dir="ltr">{item.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={item.status} />
                      <span className="hidden text-[10px] text-slate-500 sm:inline">
                        {item.totalBytes ? formatBytes(item.totalBytes, lang) : '∞'}
                      </span>
                      <IconButton
                        icon={Trash2}
                        variant="ghost"
                        label={t('configs.group.remove')}
                        onClick={() => askRemoveInbound(item)}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {group.length <= 1 ? (
                <p className="mt-2 text-[10px] leading-5 text-slate-600">{t('configs.group.single')}</p>
              ) : null}
            </SectionCard>
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={sheet === 'extend'}
        onClose={() => setSheet(null)}
        title={t('configs.extend.title')}
        subtitle={t('configs.extend.hint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(null)}>{t('common.cancel')}</Button>
            <Button loading={extend.isPending} disabled={extendInsufficient || extend.isPending} onClick={() => extend.mutate({ gb: Number(extendForm.gb || 0), days: Number(extendForm.days || 0), resetUsage: extendForm.resetUsage })}>
              {t('configs.extend.submit')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('configs.extend.gb')}>
            <Input type="number" min={0} value={extendForm.gb} onChange={(e) => setExtendForm((prev) => ({ ...prev, gb: e.target.value }))} />
          </Field>
          <Field label={t('configs.extend.days')}>
            <Input type="number" min={0} value={extendForm.days} onChange={(e) => setExtendForm((prev) => ({ ...prev, days: e.target.value }))} />
          </Field>
        </div>
        <div className="mt-3">
          <Checkbox checked={extendForm.resetUsage} onChange={(value) => setExtendForm((prev) => ({ ...prev, resetUsage: value }))} label={t('configs.extend.resetUsage')} />
        </div>
        {group.length > 1 ? (
          <p className="mt-3 flex items-start gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.06] px-3 py-2 text-[10.5px] leading-5 text-cyan-100/80">
            <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t('configs.extend.groupNote')} ({formatNumber(group.length, lang)})</span>
          </p>
        ) : null}
        {billingOn ? (
          <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] text-emerald-200/80">{t('configs.extend.price')}</span>
              <span className="text-[13px] font-bold text-emerald-300">{formatMoney(extendQuote.data?.total ?? 0, lang, currency)}</span>
            </div>
            {extendBasis ? (
              <p className="mt-1 text-[9.5px] text-slate-500">
                {t('configs.extend.basis')}: {extendBasis.remark || `#${extendBasis.inboundId}`} · {formatMoney(extendBasis.total, lang, currency)}
              </p>
            ) : null}
            <p className="mt-1 text-[9.5px] text-slate-500">{t('configs.extend.priceHint')}</p>
            {extendInsufficient ? <p className="mt-1.5 text-[10px] text-rose-300">{t('errors.insufficientBalance')}</p> : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={sheet === 'quota'}
        onClose={() => setSheet(null)}
        title={t('configs.quota.title')}
        subtitle={t('configs.quota.hint')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(null)}>{t('common.cancel')}</Button>
            <Button loading={quota.isPending} onClick={() => quota.mutate({ gb: Number(quotaForm.gb || 0), days: Number(quotaForm.days || 0), enabled: quotaForm.enabled })}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('configs.quota.gb')}>
            <Input type="number" min={0} step="0.5" value={quotaForm.gb} onChange={(e) => setQuotaForm((prev) => ({ ...prev, gb: e.target.value }))} />
          </Field>
          <Field label={t('configs.quota.days')}>
            <Input type="number" min={0} value={quotaForm.days} onChange={(e) => setQuotaForm((prev) => ({ ...prev, days: e.target.value }))} />
          </Field>
        </div>
        <div className="mt-3">
          <Checkbox checked={quotaForm.enabled} onChange={(value) => setQuotaForm((prev) => ({ ...prev, enabled: value }))} label={t('configs.quota.enabled')} />
        </div>
      </Modal>

      <Modal
        open={sheet === 'edit'}
        onClose={() => setSheet(null)}
        title={t('configs.actions.edit')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(null)}>{t('common.cancel')}</Button>
            <Button loading={saveMeta.isPending} onClick={() => saveMeta.mutate(editForm)}>{t('common.save')}</Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('configs.form.label')}>
            <Input value={editForm.label} onChange={(e) => setEditForm((prev) => ({ ...prev, label: e.target.value }))} />
          </Field>
          <Field label={t('configs.form.customerName')}>
            <Input value={editForm.customerName} onChange={(e) => setEditForm((prev) => ({ ...prev, customerName: e.target.value }))} />
          </Field>
          <Field label={t('configs.form.customerPhone')}>
            <Input value={editForm.customerPhone} onChange={(e) => setEditForm((prev) => ({ ...prev, customerPhone: e.target.value }))} dir="ltr" />
          </Field>
          <Field label={t('configs.form.note')} className="sm:col-span-2">
            <Input value={editForm.note} onChange={(e) => setEditForm((prev) => ({ ...prev, note: e.target.value }))} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={sheet === 'identity'}
        onClose={() => setSheet(null)}
        title={t('configs.identity.title')}
        subtitle={t('configs.identity.hint')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(null)}>{t('common.cancel')}</Button>
            <Button loading={saveIdentity.isPending} onClick={() => saveIdentity.mutate({ uuid: identityForm.uuid, subId: identityForm.subId })}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('configs.identity.uuid')} hint={t('configs.identity.uuidHint')}>
            <div className="flex items-center gap-2">
              <Input value={identityForm.uuid} dir="ltr" onChange={(e) => setIdentityForm((prev) => ({ ...prev, uuid: e.target.value }))} />
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => setIdentityForm((prev) => ({ ...prev, uuid: randomUuid() }))}
              >
                {t('configs.identity.regenerate')}
              </Button>
            </div>
          </Field>
          <Field label={t('configs.identity.subId')} hint={t('configs.identity.subIdHint')}>
            <div className="flex items-center gap-2">
              <Input value={identityForm.subId} dir="ltr" onChange={(e) => setIdentityForm((prev) => ({ ...prev, subId: e.target.value }))} />
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => setIdentityForm((prev) => ({ ...prev, subId: randomSubId() }))}
              >
                {t('configs.identity.regenerate')}
              </Button>
            </div>
          </Field>
          <p className="rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-3 py-2 text-[10.5px] leading-5 text-amber-200">
            {t('configs.identity.warning')}
          </p>
        </div>
      </Modal>

      <Modal
        open={sheet === 'addInbound'}
        onClose={() => setSheet(null)}
        title={t('configs.group.add')}
        subtitle={t('configs.group.addHint')}
        size="md"
      >
        {addableQuery.isLoading ? (
          <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : addable.length ? (
          <div className="max-h-[380px] space-y-2 overflow-y-auto pe-1">
            {addable.map((row) => {
              const addGb = Number(config?.totalGb || 0);
              const addDays = config?.expiryAt ? Math.max(1, Math.ceil((config.expiryAt - Date.now()) / 86400000)) : 0;
              const rowBase = Number(row.priceFixed || 0) + Number(row.pricePerGb || 0) * addGb + Number(row.pricePerDay || 0) * addDays;
              const rowPrice = Math.round(rowBase * (1 - Math.min(100, Math.max(0, Number(row.discountPercent || 0))) / 100));
              return (
                <button
                  key={row.id}
                  type="button"
                  disabled={addInbound.isPending}
                  onClick={() => addInbound.mutate(row.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-start transition hover:border-emerald-400/25 hover:bg-emerald-500/[0.04] disabled:opacity-60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-medium text-slate-200">{row.remark || `#${row.id}`}</p>
                    <p className="text-[10px] text-slate-500">
                      {row.protocol}{row.network ? ` · ${row.network}` : ''}{row.nodeName ? ` · ${row.nodeName}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11.5px] font-semibold text-emerald-300/90">{formatMoney(rowPrice, lang, currency)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={Server} title={t('configs.group.noMore')} className="py-6" />
        )}
      </Modal>

      <QrModal
        open={Boolean(qr)}
        onClose={() => setQr(null)}
        value={qr?.value}
        title={qr?.title}
        subtitle={t('configs.detail.qrHint')}
      />
    </>
  );
}
