import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArchiveRestore,
  Clock,
  Database,
  Eye,
  HardDriveDownload,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UserX,
} from 'lucide-react';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatBytes, formatDate, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  TableSkeleton,
  Toolbar,
  cx,
} from '../../components/ui.jsx';
import { useConfirm, useToast } from '../../components/feedback.jsx';

// Panel v2.1.0 — «زباله‌دان».
//
// The owner's ask: «کانفینگ هایی که حذف بطور کامل حذف میشوند این قسمت تو لیست
// قرار بگیرند / و اطلاعات ایمیل و uuid و subscribe اونها و میزان زمان و حجم باقی
// ماندشون سیو بشه / اگر مشتری بعدا اومد درخواست داد که همون اشتراک قبلیشو
// میخوام بشه مجدد با همون مشخصات قبلی کانفینگ ساخت».
//
// So this page is not a log — it is the undo. Every row is one package snapshot
// (server/src/services/trash.js) and the restore call rebuilds the SAME client on
// the node: same email, same uuid, same subscription token. That is what makes
// «همون اشتراک قبلی» true instead of a nicer-looking new one the customer's apps
// cannot use.
//
// Two choices the dialog hands over, because they are the owner's call and not
// ours: which reseller owns the rebuilt package (default: the one who had it), and
// whether the leftover time/volume restarts from the day of deletion (the honest
// reading of «همون مشخصات») or keeps the original window (what he wants ten
// minutes after deleting the wrong man).

const MODE_TONE = { soft: 'amber', hard: 'rose' };

// The list is filtered by four things at once, and `api.get` takes a path, not an
// options object — so the query string is built here, exactly like Audit.jsx and
// NodeSearch.jsx build theirs.
function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === '' || value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/** `left_bytes` / `left_days` are what the customer still had; 0 means gone. */
function LeftCell({ row, lang, t }) {
  const volume = Number(row.leftBytes || 0) > 0;
  const time = Number(row.leftDays || 0) > 0;
  if (!volume && !time) {
    return (
      <span className="text-[11px] text-slate-500">{t('trash.exhausted')}</span>
    );
  }
  return (
    <div className="space-y-0.5">
      <p className="text-[11.5px] text-slate-200">
        {formatBytes(row.leftBytes || 0, lang)}
        <span className="ms-1 text-[10px] text-slate-500">/ {formatBytes(row.totalBytes || 0, lang)}</span>
      </p>
      <p className="text-[10.5px] text-slate-500">
        {t('trash.daysLeft', { d: formatNumber(row.leftDays || 0, lang) })}
      </p>
    </div>
  );
}

/**
 * The identity the snapshot keeps: email (x-ui client), uuid and subscribe token.
 * Shown in one compact block because this is exactly what an operator has to read
 * back to a customer on the phone.
 */
function Identity({ entry, compact = false }) {
  const { t } = useI18n();
  const lines = [
    { key: 'email', label: t('trash.email'), value: entry.email },
    { key: 'uuid', label: t('trash.uuid'), value: entry.uuid },
    { key: 'sub', label: t('trash.subToken'), value: entry.subId },
  ].filter((line) => line.value);
  if (!lines.length) {
    return <p className="text-[11px] text-slate-500">{t('trash.noIdentity')}</p>;
  }
  return (
    <div className={cx('space-y-1.5', compact && 'text-[11px]')}>
      {lines.map((line) => (
        <div key={line.key} className="flex items-center gap-2">
          <span className="w-[92px] shrink-0 text-slate-500">{line.label}</span>
          <code dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-200" title={line.value}>
            {line.value}
          </code>
          <CopyButton value={line.value} iconOnly className="h-7 w-7 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/**
 * Restore dialog — reads the snapshot detail first, so the operator ticks only
 * channels that still exist on a panel, and is told plainly when none do.
 */
function RestoreDialog({ trashId, onClose }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [inboundIds, setInboundIds] = useState(null);
  const [userId, setUserId] = useState('');
  const [keepWindow, setKeepWindow] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['trash-detail', trashId],
    queryFn: () => api.get(`/admin/trash/${trashId}`),
    enabled: Boolean(trashId),
  });

  const entry = detailQuery.data?.entry || null;
  const inbounds = detailQuery.data?.inbounds || [];
  const usable = useMemo(() => inbounds.filter((item) => item.exists && item.enabled), [inbounds]);
  // First render picks everything that is still there; after that the operator's
  // ticks win, including "nothing ticked" (which the button refuses).
  const selected = useMemo(() => {
    if (inboundIds === null) return usable.map((item) => item.inboundId);
    return inboundIds;
  }, [inboundIds, usable]);

  const resellers = useQuery({
    queryKey: ['trash-resellers'],
    queryFn: () => api.get('/admin/users?role=reseller&status=active&pageSize=200'),
    enabled: Boolean(trashId),
  });

  const restore = useMutation({
    mutationFn: () => api.post(`/admin/trash/${trashId}/restore`, {
      userId: Number(userId || entry?.userId || 0),
      inboundIds: selected,
      keepUsageWindow: keepWindow,
    }),
    onSuccess: (result) => {
      toast.success(t('trash.restored', { email: result?.email || '' }));
      queryClient.invalidateQueries({ queryKey: ['trash'] });
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      onClose();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  return (
    <Modal
      open={Boolean(trashId)}
      onClose={onClose}
      title={t('trash.restoreTitle')}
      subtitle={entry ? `${entry.email || '—'} · ${entry.username || '—'}` : undefined}
      size="lg"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={RotateCcw}
            loading={restore.isPending}
            disabled={!detailQuery.data || !selected.length || !entry?.email}
            onClick={() => restore.mutate()}
          >
            {t('trash.restore')}
          </Button>
        </>
      )}
    >
      {detailQuery.isLoading ? <Skeleton className="h-48" /> : null}
      {detailQuery.isError ? <ErrorState message={detailQuery.error?.message} onRetry={detailQuery.refetch} /> : null}
      {entry ? (
        <div className="space-y-4">
          <SectionCard icon={Database} title={t('trash.snapshot')}>
            <Identity entry={entry} />
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                <p className="text-[10px] text-slate-500">{t('trash.leftVolume')}</p>
                <p className="mt-0.5 text-[12.5px] font-semibold text-slate-200">{formatBytes(entry.leftBytes || 0, lang)}</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                <p className="text-[10px] text-slate-500">{t('trash.leftTime')}</p>
                <p className="mt-0.5 text-[12.5px] font-semibold text-slate-200">{t('trash.daysLeft', { d: formatNumber(entry.leftDays || 0, lang) })}</p>
              </div>
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2">
                <p className="text-[10px] text-slate-500">{t('trash.server')}</p>
                <p className="mt-0.5 truncate text-[12.5px] font-semibold text-slate-200">{entry.serverName || '—'}</p>
              </div>
            </div>
          </SectionCard>

          {!entry.email ? (
            <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11.5px] text-rose-200">
              {t('trash.noEmailBlock')}
            </p>
          ) : null}
          {detailQuery.data && !detailQuery.data.usable ? (
            <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-200">
              {t('trash.noUsableInbound')}
            </p>
          ) : null}

          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{t('trash.inbounds')}</p>
            {inbounds.map((item) => {
              const on = selected.includes(item.inboundId);
              const dead = !item.exists || !item.enabled;
              return (
                <label
                  key={item.inboundId}
                  className={cx(
                    'flex items-center gap-2.5 rounded-xl border px-3 py-2',
                    dead ? 'border-white/[0.05] bg-white/[0.01] opacity-60' : 'border-white/[0.07] bg-white/[0.02]',
                    on && !dead && 'border-emerald-400/40 bg-emerald-500/[0.06]'
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-emerald-500"
                    checked={on}
                    disabled={dead}
                    onChange={(e) => setInboundIds(
                      e.target.checked
                        ? [...selected, item.inboundId]
                        : selected.filter((id) => id !== item.inboundId)
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">
                    {item.remark || t('trash.inboundGone', { id: item.inboundId })}
                  </span>
                  {item.exists ? null : <Badge tone="rose">{t('trash.missing')}</Badge>}
                  {item.exists && !item.enabled ? <Badge tone="amber">{t('trash.disabled')}</Badge> : null}
                </label>
              );
            })}
            {!inbounds.length ? <p className="text-[11.5px] text-slate-500">{t('trash.noInbounds')}</p> : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('trash.owner')} hint={t('trash.ownerHint')}>
              <Select
                value={String(userId || entry.userId || '')}
                onChange={(e) => setUserId(e.target.value)}
              >
                <option value="">
                  {entry.username ? `${entry.username} (${t('trash.original')})` : t('trash.original')}
                </option>
                {(resellers.data?.rows || []).map((row) => (
                  <option key={row.id} value={String(row.id)}>{row.username}{row.name ? ` — ${row.name}` : ''}</option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end pb-1">
              <Checkbox
                checked={keepWindow}
                onChange={setKeepWindow}
                label={t('trash.keepWindow')}
              />
            </div>
          </div>
          <p className="text-[10.5px] leading-5 text-slate-500">
            {keepWindow ? t('trash.keepWindowNote') : t('trash.freshWindowNote')}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

export default function Trash() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('');
  const [showRestored, setShowRestored] = useState(false);
  const [page, setPage] = useState(1);
  const [restoreId, setRestoreId] = useState(null);

  const list = useQuery({
    queryKey: ['trash', { q, mode, showRestored, page }],
    queryFn: () => api.get(`/admin/trash?${qs({
      q,
      mode,
      includeRestored: showRestored ? 1 : 0,
      page,
      pageSize: 25,
    })}`),
  });

  const purge = useMutation({
    mutationFn: (id) => api.del(`/admin/trash/${id}`),
    onSuccess: (result) => {
      toast.success(t('trash.purged', { id: formatNumber(result?.id ?? 0, lang) }));
      queryClient.invalidateQueries({ queryKey: ['trash'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askPurge = async (row) => {
    const yes = await confirm({
      title: t('trash.purgeTitle'),
      // useConfirm renders `body`, not `message` — every other caller in the app
      // uses body, and a purge dialog with no sentence in it would ask the owner
      // to destroy a snapshot without ever naming whose subscription it is.
      body: t('trash.purgeHint', { email: row.email || `#${row.id}` }),
      confirmText: t('trash.purge'),
      danger: true,
    });
    if (yes) purge.mutate(row.id);
  };

  const rows = list.data?.rows || [];
  const counts = list.data?.counts || { kept: 0, back: 0 };

  return (
    <>
      <PageHeader
        title={t('trash.title')}
        subtitle={t('trash.subtitle')}
        actions={(
          <span className="chip border-white/10 bg-white/[0.04] text-slate-400">
            {t('trash.kept', { n: formatNumber(counts.kept, lang) })}
            <span className="mx-1.5 text-slate-600">·</span>
            {t('trash.back', { n: formatNumber(counts.back, lang) })}
          </span>
        )}
      />

      <Toolbar className="mb-3">
        <SearchInput
          value={q}
          onChange={(value) => { setQ(value); setPage(1); }}
          placeholder={t('trash.searchPlaceholder')}
          className="min-w-[220px] flex-1"
        />
        <Select value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }} className="w-[150px]">
          <option value="">{t('trash.allModes')}</option>
          <option value="soft">{t('trash.modeSoft')}</option>
          <option value="hard">{t('trash.modeHard')}</option>
        </Select>
        <Checkbox checked={showRestored} onChange={(v) => { setShowRestored(v); setPage(1); }} label={t('trash.showRestored')} />
        <Button variant="secondary" icon={RefreshCw} onClick={() => list.refetch()} loading={list.isFetching}>
          {t('common.refresh')}
        </Button>
      </Toolbar>

      <SectionCard icon={Trash2} title={t('trash.list')}>
        <div className="table-wrap">
          {list.isLoading ? (
            <TableSkeleton rows={7} cols={6} />
          ) : list.isError ? (
            <ErrorState message={list.error?.message} onRetry={list.refetch} />
          ) : rows.length ? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('trash.deletedAt')}</th>
                    <th>{t('trash.reseller')}</th>
                    <th>{t('trash.customer')}</th>
                    <th>{t('trash.identity')}</th>
                    <th>{t('trash.remaining')}</th>
                    <th>{t('common.status')}</th>
                    <th className="w-24 text-end">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap">
                        <p className="text-[11.5px] text-slate-300">{formatDate(row.createdAt, lang, true)}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">{relativeTime(row.createdAt, lang)}</p>
                      </td>
                      <td className="whitespace-nowrap">
                        <p className="text-[11.5px] font-medium text-slate-200">{row.username || '—'}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">{row.serverName || '—'}</p>
                      </td>
                      <td className="max-w-[210px]">
                        <p className="truncate text-[11.5px] text-slate-200">{row.customerName || row.label || '—'}</p>
                        <p className="mt-0.5 truncate text-[10px] text-slate-500" dir="ltr">
                          {row.customerPhone || row.note || '—'}
                        </p>
                      </td>
                      <td className="min-w-[210px]">
                        <Identity entry={row} compact />
                      </td>
                      <td className="whitespace-nowrap">
                        <LeftCell row={row} lang={lang} t={t} />
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="flex flex-col items-start gap-1">
                          <Badge tone={MODE_TONE[row.mode] || 'slate'}>
                            {row.mode === 'hard' ? t('trash.modeHard') : t('trash.modeSoft')}
                          </Badge>
                          {row.restoredAt > 0 ? (
                            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300">
                              <ArchiveRestore className="h-3 w-3" />
                              {t('trash.wasRestored')}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
                              <Clock className="h-3 w-3" />
                              {row.origin === 'panel' ? t('trash.panelBorn') : t('trash.adopted')}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            icon={Eye}
                            label={t('trash.restore')}
                            className="h-8 w-8"
                            disabled={row.restoredAt > 0}
                            onClick={() => setRestoreId(row.id)}
                          />
                          <IconButton
                            icon={HardDriveDownload}
                            label={t('trash.purge')}
                            className="h-8 w-8 text-rose-300"
                            onClick={() => askPurge(row)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={UserX}
              title={q || mode ? t('trash.noMatches') : t('trash.empty')}
              hint={q || mode ? t('trash.noMatchesHint') : t('trash.emptyHint')}
            />
          )}
        </div>
        {list.data ? (
          <Pagination
            page={list.data.page}
            pageSize={list.data.pageSize}
            total={list.data.total}
            onChange={setPage}
          />
        ) : null}
      </SectionCard>

      <p className="mt-3 flex items-start gap-2 text-[10.5px] leading-5 text-slate-500">
        <Search className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t('trash.footerHint')}
      </p>

      {restoreId ? <RestoreDialog trashId={restoreId} onClose={() => setRestoreId(null)} /> : null}
    </>
  );
}
