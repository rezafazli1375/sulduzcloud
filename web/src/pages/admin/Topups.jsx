import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CheckCircle2,
  Clock,
  ImageOff,
  Receipt,
  RefreshCw,
  Send,
  Wallet,
  XCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatMoney, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SectionCard,
  Skeleton,
  Tabs,
  Textarea,
  cx,
} from '../../components/ui.jsx';
import { useToast } from '../../components/feedback.jsx';

const STATUS_TONE = { pending: 'amber', approved: 'emerald', rejected: 'rose' };
const STATUS_KEY = { pending: 'topups.pending', approved: 'topups.approved', rejected: 'topups.rejected' };

/** The receipt itself, proxied by the panel — the bot token never reaches here. */
function ReceiptImage({ id, kind, className }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (!kind || failed) {
    return (
      <div className={cx('flex items-center justify-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-6 text-[11px] text-slate-500', className)}>
        <ImageOff className="h-4 w-4" />
        {t('topups.noPreview')}
      </div>
    );
  }
  return (
    <img
      src={`/api/admin/topups/${id}/receipt`}
      alt={t('topups.receipt')}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cx('max-h-[70vh] w-full rounded-xl border border-white/[0.07] object-contain', className)}
    />
  );
}

function DecideModal({ open, onClose, request, mode }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  // A decided row can only be looked at. Rendering the reject form for it (the
  // first version did) offered a button that the API answers with 409.
  const viewing = mode === 'view' || (request && request.status !== 'pending');
  const approving = !viewing && mode === 'approve';
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open && request) {
      setAmount(String(request.amount || ''));
      setNote('');
    }
  }, [open, request?.id]);

  const decide = useMutation({
    mutationFn: () => api.post(`/admin/topups/${request.id}/${approving ? 'approve' : 'reject'}`, {
      ...(approving ? { amount: Number(String(amount).replace(/[^0-9-]/g, '')) || 0 } : {}),
      note,
    }),
    onSuccess: (data) => {
      toast.success(approving
        ? t('topups.approvedToast', { n: formatMoney(Number(data?.request?.credited || 0), lang) })
        : t('topups.rejectedToast'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'topups'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  if (!request) return null;
  const value = Number(String(amount).replace(/[^0-9-]/g, '')) || 0;
  const changed = approving && value !== Number(request.amount || 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={viewing ? t('topups.viewTitle') : approving ? t('topups.approveTitle') : t('topups.rejectTitle')}
      subtitle={`#${request.id} · ${request.username}`}
      size="md"
      footer={viewing ? (
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={approving ? 'primary' : 'danger'}
            icon={approving ? CheckCircle2 : XCircle}
            loading={decide.isPending}
            disabled={approving && value <= 0}
            onClick={() => decide.mutate()}
          >
            {approving ? t('topups.approve') : t('topups.reject')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <ReceiptImage id={request.id} kind={request.fileKind} />
        {request.caption ? (
          <p className="whitespace-pre-line rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 text-[11.5px] text-slate-300">
            {request.caption}
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11.5px]">
            <span className="text-slate-500">{viewing ? t('topups.finalAmount') : t('topups.claimed')}</span>
            <b className="ms-2 text-slate-100">{formatMoney(request.amount, lang)}</b>
          </div>
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11.5px]">
            <span className="text-slate-500">{t('topups.currentBalance')}</span>
            <b className="ms-2 text-slate-100">{formatMoney(request.balance || 0, lang)}</b>
          </div>
        </div>
        {viewing ? (
          <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-[11.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">{t('common.status')}</span>
              <Badge tone={STATUS_TONE[request.status] || 'slate'} dot>
                {t(STATUS_KEY[request.status] || 'topups.all')}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">{t('topups.decidedBy')}</span>
              <span className="text-slate-200">{request.decidedByName || '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">{t('topups.decidedAt')}</span>
              <span className="text-slate-200">{request.decidedAt ? formatDate(request.decidedAt, lang, true) : '—'}</span>
            </div>
            {request.decisionNote ? (
              <p className="whitespace-pre-line border-t border-white/[0.06] pt-2 text-slate-300">{request.decisionNote}</p>
            ) : null}
          </div>
        ) : (
          <>
            {approving ? (
              <Field label={t('topups.creditAmount')} hint={t('topups.creditHint')}>
                <Input
                  type="text"
                  inputMode="numeric"
                  dir="ltr"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="text-center font-semibold"
                />
              </Field>
            ) : null}
            {changed ? (
              <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
                {t('topups.amountChanged', {
                  a: formatMoney(request.amount, lang),
                  b: formatMoney(value, lang),
                })}
              </p>
            ) : null}
            <Field label={t('topups.note')}>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('topups.notePlaceholder')} />
            </Field>
            <p className="text-[10.5px] leading-5 text-slate-500">
              {approving ? t('topups.approveNote') : t('topups.rejectNote')}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

export default function Topups() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [decide, setDecide] = useState(null);
  // /admin/bot needs the settings permission; an admin who only manages users
  // still gets the poller state from the list response instead of a 403.
  const canBot = can('settings');

  const listQuery = useQuery({
    queryKey: ['admin', 'topups', status, page],
    queryFn: () => api.get(`/admin/topups?status=${status === 'all' ? '' : status}&page=${page}&pageSize=20`),
    refetchInterval: 30000,
  });

  const botQuery = useQuery({
    queryKey: ['admin', 'bot'],
    queryFn: () => api.get('/admin/bot'),
    refetchInterval: 60000,
    enabled: canBot,
  });

  const restart = useMutation({
    mutationFn: () => api.post('/admin/bot/restart', {}),
    onSuccess: (data) => {
      // "started" only means the poller is alive again. With the switch off (or
      // no token saved) it just idles, and calling that a restart would promise
      // the operator a working bot he does not have.
      if (data?.started && data?.enabled) toast.success(t('topups.botRestarted'));
      else if (data?.started) toast.warning(t('topups.botRestartIdle'));
      else toast.error(t('topups.botNotStarted'));
      queryClient.invalidateQueries({ queryKey: ['admin', 'bot'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const rows = listQuery.data?.rows || [];
  const counts = listQuery.data?.counts || { pending: 0, approved: 0, rejected: 0 };
  const bot = botQuery.data || listQuery.data?.bot || {};
  const total = Number(listQuery.data?.total || 0);

  const tabs = useMemo(() => ([
    { value: 'pending', label: `${t('topups.pending')} (${formatNumber(counts.pending, lang)})` },
    { value: 'approved', label: `${t('topups.approved')} (${formatNumber(counts.approved, lang)})` },
    { value: 'rejected', label: `${t('topups.rejected')} (${formatNumber(counts.rejected, lang)})` },
    { value: 'all', label: t('topups.all') },
  ]), [counts, lang, t]);

  useEffect(() => { setPage(1); }, [status]);

  return (
    <>
      <PageHeader
        title={t('topups.title')}
        subtitle={t('topups.subtitle')}
        actions={(
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => { listQuery.refetch(); if (canBot) botQuery.refetch(); }}>
            {t('common.refresh')}
          </Button>
        )}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <SectionCard
          icon={Receipt}
          title={t('topups.list')}
          bodyClass="p-0"
          actions={<Tabs tabs={tabs} active={status} onChange={setStatus} />}
        >
          {listQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : listQuery.isError ? (
            <ErrorState message={listQuery.error?.message} onRetry={listQuery.refetch} />
          ) : rows.length ? (
            <div className="divide-y divide-white/[0.05]">
              {rows.map((row) => (
                <article key={row.id} className="p-4 transition hover:bg-white/[0.02]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[row.status] || 'slate'} dot>
                      {t(STATUS_KEY[row.status] || 'topups.all')}
                    </Badge>
                    <span className="text-[11px] text-slate-500">#{row.id}</span>
                    <Link to="/resellers" className="min-w-0 truncate text-[12.5px] font-semibold text-slate-100 hover:text-emerald-200">
                      {row.username || `#${row.userId}`}
                    </Link>
                    <span className="ms-auto text-[13px] font-bold text-emerald-200" dir="ltr">
                      {formatMoney(row.amount, lang)}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {relativeTime(row.createdAt, lang)} · {formatDate(row.createdAt, lang, true)}
                    </span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      {row.source === 'bot' ? <Bot className="h-3 w-3" /> : <Send className="h-3 w-3" />}
                      {row.source === 'bot' ? t('topups.sourceBot') : t('topups.sourcePanel')}
                    </span>
                    {row.fileKind ? (
                      <>
                        <span>·</span>
                        <span>{row.fileKind === 'photo' ? t('topups.photo') : t('topups.document')}</span>
                      </>
                    ) : null}
                    {row.status !== 'pending' ? (
                      <>
                        <span>·</span>
                        <span>
                          {row.decidedByName || '—'} · {formatDate(row.decidedAt, lang, true)}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {row.caption ? (
                    <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-[11.5px] text-slate-400">{row.caption}</p>
                  ) : null}
                  {row.decisionNote ? (
                    <p className="mt-1.5 whitespace-pre-line text-[11px] text-slate-400">
                      <span className="text-slate-500">{t('topups.note')}: </span>{row.decisionNote}
                    </p>
                  ) : null}
                  {row.status === 'pending' ? (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      <Button size="sm" icon={CheckCircle2} onClick={() => setDecide({ request: row, mode: 'approve' })}>
                        {t('topups.approve')}
                      </Button>
                      <Button size="sm" variant="danger" icon={XCircle} onClick={() => setDecide({ request: row, mode: 'reject' })}>
                        {t('topups.reject')}
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-2.5">
                      <Button size="sm" variant="ghost" icon={Receipt} onClick={() => setDecide({ request: row, mode: 'view' })}>
                        {t('topups.viewReceipt')}
                      </Button>
                    </div>
                  )}
                </article>
              ))}
              {total > 20 ? (
                <div className="p-3">
                  <Pagination page={page} pageSize={20} total={total} onChange={setPage} />
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState icon={Receipt} title={t('topups.empty')} hint={t('topups.emptyHint')} />
          )}
        </SectionCard>

        <div className="space-y-4">
          <SectionCard icon={Bot} title={t('topups.botCard')}>
            <div className="space-y-2.5 text-[11.5px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('topups.botSwitch')}</span>
                <Badge tone={bot.enabled ? 'emerald' : 'slate'} dot>
                  {bot.enabled ? t('common.on') : t('common.off')}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('topups.botPolling')}</span>
                <Badge tone={bot.conflict ? 'rose' : bot.running ? 'emerald' : 'amber'} dot>
                  {bot.conflict ? t('topups.botConflict') : bot.running ? t('topups.botRunning') : t('topups.botIdle')}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('topups.botToken')}</span>
                <span className="text-slate-200">{bot.hasToken ? t('topups.botTokenSet') : t('topups.botTokenMissing')}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">{t('topups.adminChat')}</span>
                <span className="text-slate-200" dir="ltr">{bot.adminChatId || '—'}</span>
              </div>
              {bot.conflict ? (
                <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[10.5px] leading-5 text-rose-200">
                  {t('topups.botConflictHint')}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 border-t border-white/[0.06] pt-3">
                {canBot ? (
                  <>
                    <Button size="sm" variant="secondary" icon={RefreshCw} loading={restart.isPending} onClick={() => restart.mutate()}>
                      {t('topups.botRestart')}
                    </Button>
                    <Link to="/settings" className="btn btn-ghost rounded-lg px-3 py-1.5 text-xs">
                      {t('topups.botSettings')}
                    </Link>
                  </>
                ) : (
                  <span className="text-[10.5px] text-slate-500">{t('topups.botReadOnly')}</span>
                )}
              </div>
            </div>
          </SectionCard>

          <SectionCard icon={Wallet} title={t('topups.howTitle')}>
            <ol className="space-y-2 text-[11.5px] leading-6 text-slate-400">
              <li>{t('topups.how1')}</li>
              <li>{t('topups.how2')}</li>
              <li>{t('topups.how3')}</li>
              <li>{t('topups.how4')}</li>
            </ol>
            <p className={cx('mt-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[10.5px] leading-5 text-slate-500')}>
              {t('topups.howNote')}
            </p>
          </SectionCard>
        </div>
      </div>

      <DecideModal
        open={Boolean(decide)}
        onClose={() => setDecide(null)}
        request={decide?.request || null}
        mode={decide?.mode || 'approve'}
      />
    </>
  );
}