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
  Pin,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  RotateCcw,
  Server,
  Ticket,
  Trash2,
  UserRound,
  UserRoundX,
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

export default function ConfigDetail({ open, configId, onClose, onChanged, onSelect }) {
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
  // Bumped every time the renew dialog opens, so its price request is a fresh key
  // and must go to the server — a wallet or tariff that changed in the meantime
  // cannot be hidden behind a cached preview.
  const [extendQuoteKey, setExtendQuoteKey] = useState(0);
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
  // Where the subscription link comes from. Since v1.4.20 the customer is always
  // handed the link the NODE panel shows for his own x-ui client — the panel never
  // inserts its own address in front of it unless the server carries no
  // subscription base at all.
  const subs = detail.data?.subscriptions || null;
  const nodeLinks = Array.isArray(subs?.node) ? subs.node.filter((item) => item?.url) : [];
  const clientCount = Number(subs?.clientCount || nodeLinks.length || 1);
  const isPanelLink = subs?.source === 'panel';
  // A package still spread over two clients (a leftover from before v1.4.18): the
  // channels the shown link does NOT carry stay listed right under it.
  const otherNodeLinks = nodeLinks.filter((item) => item.url !== subUrl);
  // The customer's x-ui client is gone from the node panel. The panel asks the
  // node about the client on every open, so a null client with no error means
  // "there is no such client" — an error would mean the node could not answer.
  const clientMissing = Boolean(config)
    && detail.data?.client === null
    && !linksError
    && !detail.isFetching;

  const addableQuery = useQuery({
    queryKey: ['config-inbounds', isAdmin, config?.userId],
    queryFn: () => api.get(isAdmin ? `/admin/inbounds?userId=${config?.userId || 0}` : '/reseller/inbounds'),
    enabled: open && sheet === 'addInbound',
  });

  const billingOn = Boolean(meta?.billing?.enabled);
  const extendAmountGb = Number(extendForm.gb || 0);
  const extendDays = Number(extendForm.days || 0);
  // Since v1.4.23 the renewal drawer prices the renewal itself. It asks the panel
  // for the amount of THIS package — the very code path extendConfig charges — and
  // shows it whether or not wallet billing is switched on, so the reseller confirms
  // a price he has actually seen instead of an invisible deduction. The package is
  // resolved server-side, so the preview cannot be steered by the client.
  const extendQuote = useQuery({
    queryKey: ['extend-quote', configId, extendAmountGb, extendDays, extendQuoteKey],
    queryFn: () => api.post(`${base}/${configId}/extend/quote`, {
      gb: extendAmountGb,
      days: extendDays,
    }),
    enabled: open && sheet === 'extend' && Boolean(configId) && (extendAmountGb > 0 || extendDays > 0),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
  const extendPrice = extendQuote.data || null;
  const extendBasis = extendPrice?.basis || null;
  const extendTotal = Number(extendPrice?.total || 0);
  const extendBalance = Number(extendPrice?.balance || 0);
  const extendInsufficient = billingOn && extendPrice?.sufficient === false;

  // Opens the renew dialog on a clean slate AND on a brand-new preview key, so the
  // amount it shows was priced against the wallet and tariff of this very moment.
  const openExtendDialog = () => {
    setExtendForm({ gb: 10, days: 30, resetUsage: false });
    setExtendQuoteKey((n) => n + 1);
    setSheet('extend');
  };

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
    // Renewal/identity changes can affect siblings already viewed in this drawer.
    queryClient.invalidateQueries({ queryKey: ['config'] });
    queryClient.invalidateQueries({ queryKey: ['configs'] });
    queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
    queryClient.invalidateQueries({ queryKey: ['reseller', 'overview'] });
    onChanged?.();
  };

  const onError = (err) => toast.error(translateError(err, t));

  const extend = useMutation({
    mutationFn: (payload) => api.post(`${base}/${configId}/extend`, payload),
    // v1.4.24: the renewal gets its own wording instead of the generic "saved", so
    // the reseller sees the action that actually happened. The money and the new
    // expiry are in the notification the panel writes for him.
    onSuccess: () => { toast.success(t('configs.extend.done')); setSheet(null); refresh(); },
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

  // Panel v1.4.24: the whole customer goes — every channel of the package and his
  // x-ui client, which is the one case the fixed-inbound lock allows. The server
  // answers how much of it actually left the node, and the toast says exactly that
  // instead of a generic "deleted".
  const removePackage = useMutation({
    mutationFn: () => api.del(`${base}/${configId}/package`),
    onSuccess: (data) => {
      const removed = Number(data?.xuiDeleted?.length || 0);
      toast.success(removed > 0
        ? t('configs.group.packageDeletedRemote', { n: formatNumber(Number(data?.rows || 0), lang) })
        : t('configs.group.packageDeletedLocal', { n: formatNumber(Number(data?.rows || 0), lang) }));
      onClose?.();
      refresh();
    },
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

  // Panel v1.4.21: the customer's x-ui client was deleted on the node panel.
  // This builds ONE client back — same email, UUID and subscription id, every
  // channel of the package on it — so the customer's old link works again.
  const recreate = useMutation({
    mutationFn: () => api.post(`${base}/${configId}/recreate`),
    onSuccess: () => { toast.success(t('configs.detail.recreated')); refresh(); },
    onError,
  });

  const removeInbound = useMutation({
    mutationFn: (targetId) => api.del(`${base}/${targetId}`),
    onSuccess: (data, targetId) => {
      // Three outcomes worth telling apart: an adopted row (nothing was written
      // to the other panel), a channel taken off the customer's own client (he
      // stays connected), and his last channel (that client is gone).
      const message = data?.detachedOnly
        ? t('configs.group.detached')
        : (data?.inboundDetached
          ? t('configs.group.channelDetached', { n: Number(data?.keptInbounds || 0) })
          : t('configs.group.removed'));
      toast.success(message);
      if (Number(targetId) === Number(configId)) onClose?.();
      refresh();
    },
    onError,
  });

  // Since v1.4.18 a package is ONE x-ui client holding every channel of that
  // customer, so taking one row off a package whose client has other members does
  // NOT delete the client and does NOT cut him off — it detaches that channel.
  // Only a row that stands alone on its client really deletes a x-ui client, and
  // the wording must say which of the two the operator is about to do.
  const sharesClient = (item) => group.some((other) => Number(other.id) !== Number(item?.id)
    && String(other.email || '').toLowerCase() === String(item?.email || '').toLowerCase());

  const askRemoveInbound = async (item) => {
    const external = item?.origin === 'external';
    const detach = external || sharesClient(item);
    const ok = await confirm({
      title: detach ? t('configs.group.detachConfirm') : t('configs.group.removeConfirm'),
      body: `${item ? `${item.inbound?.remark || `#${item.inboundId}`} · ${item.email}` : ''}`
        + (external ? `\n${t('configs.group.detachNote')}`
          : (detach ? `\n${t('configs.group.channelDetachNote')}` : '')),
      danger: true,
      confirmText: detach ? t('configs.group.detach') : t('configs.group.remove'),
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

  // v1.4.24: the action the fixed-inbound lock points at. It names how many
  // channels go, and — when some of them were adopted from another panel — says
  // plainly that those subscriptions stay live over there, because this panel
  // never writes to another operator's x-ui.
  const askDeletePackage = async () => {
    const channels = group.length || 1;
    const adopted = group.filter((item) => item?.origin === 'external').length;
    const ok = await confirm({
      title: t('configs.group.packageDeleteConfirm'),
      body: `${t('configs.group.packageDeleteBody', { n: formatNumber(channels, lang) })}`
        + (adopted
          ? `\n${t('configs.group.packageDeleteAdopted', { n: formatNumber(adopted, lang) })}`
          : `\n${t('configs.group.packageDeleteNode')}`),
      danger: true,
      confirmText: t('configs.group.deletePackage'),
    });
    if (ok) removePackage.mutate();
  };

  const askReset = async () => {
    const body = group.length > 1
      ? `${t('common.irreversible')}\n${t('configs.group.resetNote', { n: formatNumber(group.length, lang) })}`
      : t('common.irreversible');
    const ok = await confirm({ title: t('configs.actions.reset'), body, danger: true });
    if (ok) reset.mutate();
  };

  const askRecreate = async () => {
    const ok = await confirm({
      title: t('configs.detail.recreateConfirm'),
      body: t('configs.detail.recreateBody'),
      confirmText: t('configs.actions.recreate'),
    });
    if (ok) recreate.mutate();
  };

  const allLinks = [subUrl, ...links].filter(Boolean);
  const left = config ? daysLeft(config.expiryAt, lang) : null;
  // A package spans ONE x-ui panel and one subscription link, and a reseller can
  // only sell the inbounds they are allowed — so the "add inbound" list drops
  // everything else instead of offering rows the server would refuse. Before
  // this, an adopted config with no listed group even offered its own inbound
  // again.
  const packageServerId = Number(config?.serverId || config?.inbound?.serverId || 0);
  const allowedList = Array.isArray(config?.reseller?.allowedInbounds) ? config.reseller.allowedInbounds.map(Number) : [];
  const addable = (addableQuery.data?.rows || []).filter((row) => {
    if (!row.enabled) return false;
    if (!isAdmin && row.visible === false) return false;
    if (group.some((item) => Number(item.inboundId) === Number(row.id))) return false;
    if (packageServerId && Number(row.serverId || 0) !== packageServerId) return false;
    if (allowedList.length && !allowedList.includes(Number(row.id))) return false;
    return true;
  });
  const fixedInboundId = Number(config?.reseller?.fixedInbound || 0);
  // The row this drawer was opened on IS the guaranteed base of a package that
  // still holds other channels. The server refuses to take it off — 409
  // fixed_inbound_locked, the owner's own rule — so since v1.4.24 the button shows
  // that up front instead of looking live and failing after the click.
  const fixedBaseLocked = fixedInboundId > 0
    && Number(config?.inboundId) === fixedInboundId
    && group.length > 1;

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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  icon={Trash2}
                  onClick={askDelete}
                  loading={remove.isPending}
                  disabled={fixedBaseLocked || removePackage.isPending}
                  title={fixedBaseLocked ? t('configs.group.fixedLocked') : undefined}
                >
                  {t('common.delete')}
                </Button>
                {group.length > 1 ? (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={UserRoundX}
                    onClick={askDeletePackage}
                    loading={removePackage.isPending}
                    disabled={remove.isPending}
                    title={t('configs.group.deletePackageHint')}
                  >
                    {t('configs.group.deletePackage')}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" icon={RotateCcw} onClick={askReset} loading={reset.isPending}>{t('configs.actions.reset')}</Button>
                {/* A disabled button cannot show its tooltip, so the reason the
                    server would refuse this delete is spelled out next to it. */}
                {fixedBaseLocked ? (
                  <p className="w-full text-[10px] leading-5 text-amber-300/85">
                    {t('configs.group.fixedLocked')} · {t('configs.group.deletePackageHint')}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" icon={Power} onClick={() => toggle.mutate(!config.enabled)} loading={toggle.isPending}>
                  {config.enabled ? t('configs.actions.disable') : t('configs.actions.enable')}
                </Button>
                <Button size="sm" icon={Zap} onClick={openExtendDialog}>
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

            {clientMissing ? (
              <div className="rounded-2xl border border-rose-400/25 bg-rose-500/[0.07] p-4">
                <div className="flex items-start gap-3">
                  <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] font-semibold text-rose-100">{t('configs.detail.clientMissingTitle')}</p>
                    <p className="mt-1 text-[11px] leading-5 text-rose-100/75">{t('configs.detail.clientMissingBody')}</p>
                    <Button
                      variant="soft"
                      size="sm"
                      icon={RefreshCw}
                      className="mt-3"
                      onClick={askRecreate}
                      loading={recreate.isPending}
                    >
                      {t('configs.actions.recreate')}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}

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
                  <p className="mt-1 text-[10px] text-slate-400">
                    {
                      // eslint-disable-next-line no-nested-ternary
                      isPanelLink
                        ? t('configs.detail.subSourcePanel')
                        : clientCount > 1
                          ? t('configs.detail.subSourceNodeSplit')
                          : t('configs.detail.subSourceNode')
                    }
                  </p>
                  {clientCount > 1 ? (
                    <div className="mt-2 space-y-1.5">
                      <p className="rounded-lg border border-amber-400/20 bg-amber-500/[0.06] px-2 py-1.5 text-[10px] leading-4 text-amber-200">
                        {t('configs.detail.subSplitCaution', { n: clientCount })}
                      </p>
                      {otherNodeLinks.length ? (
                        <p className="text-[10px] text-slate-400">{t('configs.detail.subOtherLinks')}</p>
                      ) : null}
                      {otherNodeLinks.map((item) => (
                        <div key={item.url} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                          <span className="min-w-0 truncate text-[10px] text-slate-400" dir="ltr">
                            {item.email} · {t('configs.detail.subInbounds', { n: item.inboundCount || 1 })}
                          </span>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <IconButton icon={QrCode} variant="ghost" label={t('common.qr')} onClick={() => setQr({ title: item.email, value: item.url })} />
                            <CopyButton value={item.url} iconOnly />
                          </div>
                          <p className="w-full break-all font-mono text-[10px] text-slate-500" dir="ltr">{item.url}</p>
                        </div>
                      ))}
                      {subs?.aggregated && subs.aggregated !== subUrl ? (
                        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                          <span className="text-[10px] text-slate-400">{t('configs.detail.subCombinedLink')}</span>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <IconButton icon={QrCode} variant="ghost" label={t('common.qr')} onClick={() => setQr({ title: t('common.subscription'), value: subs.aggregated })} />
                            <CopyButton value={subs.aggregated} iconOnly />
                          </div>
                          <p className="w-full break-all font-mono text-[10px] text-slate-500" dir="ltr">{subs.aggregated}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
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
              {group.length > 1 ? (
                <div className="mb-3 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.06] px-3 py-2 text-[10.5px] leading-5 text-cyan-100/80">
                  <p className="flex items-start gap-2">
                    <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{t('configs.memberActionHint')}</span>
                  </p>
                  <p className="mt-1 text-cyan-200/70">
                    {t('configs.group.poolUsage', {
                      used: formatBytes(config.used, lang),
                      total: config.totalBytes ? formatBytes(config.totalBytes, lang) : '∞',
                      n: formatNumber(group.length, lang),
                    })}
                  </p>
                </div>
              ) : null}
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
                        {item.fixed ? (
                          <Badge tone="blue" className="ms-1.5 align-middle px-1.5 py-0 text-[9px]">{t('configs.group.fixedBadge')}</Badge>
                        ) : null}
                        {item.origin === 'external' ? (
                          <Badge tone="amber" className="ms-1.5 align-middle px-1.5 py-0 text-[9px]">{t('configs.originExternalBadge')}</Badge>
                        ) : null}
                        {Number(item.id) === Number(configId) ? (
                          <span className="ms-1.5 text-[9.5px] text-emerald-300">({t('configs.group.current')})</span>
                        ) : null}
                      </p>
                      <p className="truncate font-mono text-[9.5px] text-slate-500" dir="ltr">{item.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge status={item.status} />
                      {onSelect && Number(item.id) !== Number(configId) ? (
                        <IconButton
                          icon={ExternalLink}
                          label={`${t('configs.manageInbound')}: ${item.inbound?.remark || item.inboundId}`}
                          disabled={[extend, quota, toggle, reset, saveMeta, remove, saveIdentity, addInbound, removeInbound].some((mutation) => mutation.isPending)}
                          onClick={() => onSelect(item.id)}
                        />
                      ) : null}
                      {item.fixed && group.length > 1 ? (
                        <IconButton
                          icon={Pin}
                          variant="ghost"
                          label={t('configs.group.fixedLocked')}
                          disabled
                        />
                      ) : (
                        <IconButton
                          icon={Trash2}
                          variant="ghost"
                          label={item.origin === 'external' || sharesClient(item)
                            ? t('configs.group.detach') : t('configs.group.remove')}
                          onClick={() => askRemoveInbound(item)}
                        />
                      )}
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
        <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-emerald-200/80">{t('configs.extend.price')}</span>
            <span className="text-[13px] font-bold text-emerald-300">
              {extendPrice
                ? formatMoney(extendTotal, lang, currency)
                : (extendAmountGb > 0 || extendDays > 0
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : t('configs.extend.enterAmount'))}
            </span>
          </div>
          {extendBasis ? (
            <p className="mt-1 text-[9.5px] text-slate-500">
              {t('configs.extend.basis')}: {extendBasis.remark || `#${extendBasis.inboundId}`} · {formatMoney(extendBasis.total, lang, currency)}
              {Number(extendBasis.discountPercent || 0) > 0 ? (
                <span className="text-emerald-300/90">
                  {' '}— {t('configs.extend.discount')} {formatNumber(extendBasis.discountPercent, lang, 0)}٪
                  {' '}(−{formatMoney(Math.max(0, Number(extendBasis.base || 0) - extendBasis.total), lang, currency)})
                </span>
              ) : null}
            </p>
          ) : null}
          {billingOn ? (
            <p className="mt-1 flex items-center justify-between gap-2 text-[9.5px] text-slate-500">
              <span>{t('configs.extend.balanceAfter')}</span>
              <span className={cx('font-semibold', extendInsufficient ? 'text-rose-300' : 'text-slate-300')}>
                {formatMoney(extendBalance - extendTotal, lang, currency)}
              </span>
            </p>
          ) : null}
          <p className="mt-1 text-[9.5px] text-slate-500">
            {extendInsufficient
              ? t('errors.insufficientBalance')
              : (!billingOn
                ? t('configs.form.billingOff')
                : (extendTotal === 0 && (extendAmountGb > 0 || extendDays > 0)
                  ? t('configs.extend.zeroTariff')
                  : t('configs.extend.priceHint')))}
          </p>
        </div>
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
          <>
            {!group.some((item) => Number(item.inboundId) === fixedInboundId) && fixedInboundId > 0 ? (
              <p className="mb-2 flex items-start gap-2 rounded-xl border border-sky-400/20 bg-sky-500/[0.06] px-3 py-2 text-[10.5px] leading-5 text-sky-100/80">
                <Pin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {t('configs.group.addFixedHint', {
                    inbound: addable.find((row) => Number(row.id) === fixedInboundId)?.remark
                      || `#${fixedInboundId}`,
                  })}
                </span>
              </p>
            ) : null}
            <div className="max-h-[380px] space-y-2 overflow-y-auto pe-1">
              {addable.map((row) => {
                const addGb = Number(config?.totalGb || 0);
                const addDays = config?.expiryAt ? Math.max(1, Math.ceil((config.expiryAt - Date.now()) / 86400000)) : 0;
                const rowBase = Number(row.priceFixed || 0) + Number(row.pricePerGb || 0) * addGb + Number(row.pricePerDay || 0) * addDays;
                const rowPrice = Math.round(rowBase * (1 - Math.min(100, Math.max(0, Number(row.discountPercent || 0))) / 100));
                const isFixed = fixedInboundId > 0 && Number(row.id) === fixedInboundId;
                return (
                  <button
                    key={row.id}
                    type="button"
                    disabled={addInbound.isPending}
                    onClick={() => addInbound.mutate(row.id)}
                    className={cx(
                      'flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-start transition disabled:opacity-60',
                      isFixed
                        ? 'border-sky-400/30 bg-sky-500/[0.07] hover:border-sky-400/45 hover:bg-sky-500/[0.1]'
                        : 'border-white/[0.06] bg-white/[0.02] hover:border-emerald-400/25 hover:bg-emerald-500/[0.04]'
                    )}
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-[12px] font-medium text-slate-200">
                        <span className="truncate">{row.remark || `#${row.id}`}</span>
                        {isFixed ? (
                          <Badge tone="blue" className="shrink-0 px-1.5 py-0 text-[9px]">{t('configs.group.fixedBadge')}</Badge>
                        ) : null}
                      </p>
                      <p className="text-[10px] text-slate-500">
                        {row.protocol}{row.network ? ` · ${row.network}` : ''}{row.nodeName ? ` · ${row.nodeName}` : ''}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11.5px] font-semibold text-emerald-300/90">{formatMoney(rowPrice, lang, currency)}</span>
                  </button>
                );
              })}
            </div>
          </>
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
