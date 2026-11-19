import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCheck,
  Fingerprint,
  Network,
  Search,
  Server,
  UserPlus,
  X,
} from 'lucide-react';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatBytes, formatDate, formatNumber } from '../../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  SectionCard,
  Select,
  Skeleton,
  Textarea,
  cx,
} from '../../components/ui.jsx';
import { useToast } from '../../components/feedback.jsx';

/**
 * Find existing x-ui clients and hand them to a reseller — one, or everything the
 * admin ticked (v1.5.6).
 *
 * The search is deliberately manual (a button, not a live keystroke query): each
 * run asks every enabled node for its client list, which is a real network call
 * per panel. Nothing here writes to x-ui — a hand-over only changes who owns the
 * rows in THIS panel, so the customer's link, quota and expiry stay as they are.
 *
 * The page mixes two kinds of hit and the backend decides which verb each one
 * needs: a client this panel already holds is MOVED from its current reseller,
 * and a client nobody here holds is ADOPTED. Both go through the same endpoint,
 * so a mixed selection is one click, and the answer says per customer what
 * happened — a batch is not all-or-nothing.
 */

const keyOf = (row) => `${Number(row.serverId) || 0}:${String(row.email || '').toLowerCase()}`;

function ClientCard({ row, selected, onToggle, onAssign }) {
  const { t, lang } = useI18n();
  const used = Number(row.up || 0) + Number(row.down || 0);
  const otherOwner = (row.owners || []).length > 0;
  return (
    <article className={cx('p-4 transition', selected ? 'bg-emerald-400/[0.06]' : 'hover:bg-white/[0.02]')}>
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox checked={selected} onChange={(next) => onToggle(row, next)} className="shrink-0" />
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-cyan-300">
          <Fingerprint className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-slate-100" dir="ltr">{row.email}</span>
        <CopyButton value={row.email} />
        {row.enabled ? <Badge tone="emerald" dot>{t('common.active')}</Badge> : <Badge tone="slate">{t('common.disabled')}</Badge>}
        {otherOwner ? <Badge tone="violet">{t('nodeSearch.adopted')}</Badge> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <Server className="h-3 w-3" />
          {row.serverName || `#${row.serverId}`}
        </span>
        <span className="inline-flex items-center gap-1" dir="ltr">
          <Network className="h-3 w-3" />
          {formatNumber((row.inbounds || []).length || (row.inboundIds || []).length, lang)} × {t('common.inbound')}
        </span>
        <span>
          {t('nodeSearch.usage')}: <b className="text-slate-300">{formatBytes(used, lang)}</b>
          {Number(row.totalBytes || 0) > 0 ? ` / ${formatBytes(row.totalBytes, lang)}` : ` · ${t('common.unlimited')}`}
        </span>
        <span>
          {t('nodeSearch.expiry')}: <b className="text-slate-300">{Number(row.expiryAt || 0) > 0 ? formatDate(row.expiryAt, lang) : t('common.unlimited')}</b>
        </span>
      </div>

      {row.uuid ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
          <span className="shrink-0 text-[10px] text-slate-500">{t('nodeSearch.uuid')}</span>
          <code className="min-w-0 flex-1 truncate text-[10.5px] text-slate-300" dir="ltr">{row.uuid}</code>
          <CopyButton value={row.uuid} />
        </div>
      ) : null}

      {(row.inbounds || []).length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {row.inbounds.map((inbound) => (
            <span key={inbound.id} className="rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-300">
              {inbound.remark || `#${inbound.id}`}
              <span className="ms-1 text-slate-500" dir="ltr">{inbound.port}</span>
            </span>
          ))}
        </div>
      ) : null}

      {otherOwner ? (
        <p className="mt-2 text-[10.5px] text-slate-500">
          {t('nodeSearch.owner')}:{' '}
          {[...new Set((row.owners || []).map((owner) => owner.username || `#${owner.userId}`))].join(' · ')}
        </p>
      ) : null}

      <div className="mt-2.5">
        <Button size="sm" icon={otherOwner ? ArrowLeftRight : UserPlus} onClick={() => onAssign(row)}>
          {otherOwner ? t('nodeSearch.moveToReseller') : t('nodeSearch.addToReseller')}
        </Button>
      </div>
    </article>
  );
}

const ACTION_TONE = { transfer: 'cyan', adopt: 'emerald', already: 'slate' };

function ActionBadge({ action, ok, t }) {
  if (!ok) return <Badge tone="rose">{t('nodeSearch.actionFailed')}</Badge>;
  const key = action === 'transfer' ? 'actionTransfer' : action === 'adopt' ? 'actionAdopt' : 'actionAlready';
  return <Badge tone={ACTION_TONE[action] || 'slate'}>{t(`nodeSearch.${key}`)}</Badge>;
}

/** One line per customer: what will happen (preview) or what did happen (result). */
function PlanRow({ item, lang, t }) {
  const from = (item.from || []).filter(Boolean).join(' · ');
  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-200" dir="ltr">{item.email}</span>
        <ActionBadge action={item.action} ok={item.ok} t={t} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
        {from ? <span>{t('nodeSearch.from')}: <b className="text-slate-300">{from}</b></span> : null}
        {Number(item.totalGb || 0) > 0 ? (
          <span>{t('common.quota')}: <b className="text-slate-300">{formatNumber(item.totalGb, lang)} {t('common.gb')}</b></span>
        ) : null}
        {Number(item.inboundCount || (item.configs || []).length) > 0 ? (
          <span>{formatNumber(Number(item.inboundCount || (item.configs || []).length), lang)} × {t('common.inbound')}</span>
        ) : null}
        {item.needsSync ? <span className="text-amber-200/90">{t('nodeSearch.needsSync')}</span> : null}
      </div>
      {!item.ok && item.message ? (
        <p className="mt-1 text-[10px] leading-4 text-rose-200/90">{item.message}</p>
      ) : null}
    </li>
  );
}

function AssignModal({ open, onClose, clients, onLanded }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [form, setForm] = useState({ label: '', customerName: '', customerPhone: '', note: '' });
  const [result, setResult] = useState(null);

  const items = useMemo(
    () => clients.map((client) => ({ email: client.email, serverId: Number(client.serverId) || 0 })),
    [clients],
  );
  const itemsKey = items.map((item) => `${item.serverId}:${item.email}`).join('|');
  const single = clients.length === 1;
  const first = clients[0] || null;

  useEffect(() => {
    if (!open) return;
    setUserId('');
    setResult(null);
    setForm({
      label: single ? String(first?.remark || first?.email || '') : '',
      customerName: '',
      customerPhone: '',
      note: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemsKey]);

  const usersQuery = useQuery({
    queryKey: ['adopt-resellers'],
    queryFn: () => api.get('/admin/users?role=reseller&pageSize=200'),
    enabled: open,
  });
  const resellers = usersQuery.data?.rows || [];
  const chosen = resellers.find((user) => String(user.id) === String(userId));

  // The preview is the same endpoint with dryRun on: the backend classifies every
  // customer with the very guards the real run uses, so nothing is guessed here.
  const preview = useQuery({
    queryKey: ['bulk-assign-preview', itemsKey, userId],
    queryFn: () => api.post('/admin/configs/bulk-assign', { items, toUserId: Number(userId), dryRun: true }),
    enabled: open && Boolean(userId) && !result,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const plan = preview.data || null;
  const planRows = plan?.results || [];
  const adoptCount = planRows.filter((row) => row.action === 'adopt').length;
  // Before the preview answers, the search row itself already says whether this
  // panel holds the client: owners present = a move, owners empty = an adoption.
  const firstOwned = (first?.owners || []).length > 0;
  const importOff = chosen && chosen.importConfigs === false
    && (adoptCount > 0 || (!plan && single && !firstOwned));
  const allBlocked = Boolean(plan) && Number(plan.total || 0) > 0 && plan.failed === plan.total;
  const singleAdopt = single && (plan ? planRows[0]?.action === 'adopt' : !firstOwned);

  const assign = useMutation({
    mutationFn: (list) => api.post('/admin/configs/bulk-assign', {
      items: list,
      toUserId: Number(userId),
      note: form.note.trim(),
      label: single ? form.label.trim() : '',
      customerName: single ? form.customerName.trim() : '',
      customerPhone: single ? form.customerPhone.trim() : '',
    }),
    onSuccess: (data) => {
      setResult(data);
      const ok = Number(data?.moved || 0) + Number(data?.adopted || 0);
      const failed = Number(data?.failed || 0);
      if (failed) {
        toast.error(t('nodeSearch.bulkPartial', { ok: formatNumber(ok, lang), fail: formatNumber(failed, lang) }));
      } else if (ok) {
        toast.success(t('nodeSearch.bulkDone', { n: formatNumber(ok, lang) }));
      } else {
        toast.success(t('nodeSearch.alreadyOwned'));
      }
      queryClient.invalidateQueries({ queryKey: ['node-clients'] });
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      onLanded?.(data);
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const failedItems = (result?.results || [])
    .filter((row) => !row.ok)
    .map((row) => ({ email: row.email, serverId: Number(row.serverId) || 0 }));

  if (!first) return null;

  const shown = result ? (result.results || []) : planRows;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={single ? t('nodeSearch.addTitle') : t('nodeSearch.bulkTitle')}
      subtitle={single ? first.email : t('nodeSearch.selectedCount', { n: formatNumber(clients.length, lang) })}
      size="lg"
      footer={result ? (
        <>
          {failedItems.length ? (
            <Button
              variant="secondary"
              icon={ArrowLeftRight}
              loading={assign.isPending}
              onClick={() => assign.mutate(failedItems)}
            >
              {t('nodeSearch.retryFailed')}
            </Button>
          ) : null}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={ArrowLeftRight}
            loading={assign.isPending}
            disabled={!userId || importOff || allBlocked}
            onClick={() => assign.mutate(items)}
          >
            {single ? t('nodeSearch.add') : t('nodeSearch.bulkConfirm', { n: formatNumber(clients.length, lang) })}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        {single ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px] text-slate-400">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">{t('nodeSearch.node')}</span>
              <span className="text-slate-200">{first.serverName || `#${first.serverId}`}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-slate-500">{t('nodeSearch.inbound')}</span>
              <span className="text-slate-200">
                {(first.inbounds || []).map((inbound) => inbound.remark || `#${inbound.id}`).join(' · ') || '—'}
              </span>
            </div>
          </div>
        ) : null}

        <Field label={t('nodeSearch.reseller')} required>
          <Select value={userId} disabled={Boolean(result)} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('nodeSearch.pickReseller')}</option>
            {resellers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name ? `${user.name} (@${user.username})` : `@${user.username}`}
              </option>
            ))}
          </Select>
        </Field>

        {importOff ? (
          <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-5 text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('nodeSearch.importOff')}
          </p>
        ) : null}

        {userId && !result ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2">
              <span className="text-[11px] font-semibold text-slate-200">{t('nodeSearch.previewTitle')}</span>
              {plan ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  {plan.moved ? <Badge tone="cyan">{t('nodeSearch.actionTransfer')}: {formatNumber(plan.moved, lang)}</Badge> : null}
                  {plan.adopted ? <Badge tone="emerald">{t('nodeSearch.actionAdopt')}: {formatNumber(plan.adopted, lang)}</Badge> : null}
                  {plan.already ? <Badge tone="slate">{t('nodeSearch.actionAlready')}: {formatNumber(plan.already, lang)}</Badge> : null}
                  {plan.failed ? <Badge tone="rose">{t('nodeSearch.actionFailed')}: {formatNumber(plan.failed, lang)}</Badge> : null}
                </span>
              ) : null}
            </div>
            {preview.isLoading || preview.isFetching ? (
              <div className="space-y-2 p-3">
                <p className="text-[10.5px] text-slate-500">{t('nodeSearch.previewLoading')}</p>
                <Skeleton className="h-10" />
              </div>
            ) : preview.isError ? (
              <p className="px-3 py-2 text-[10.5px] leading-5 text-rose-200/90">{translateError(preview.error, t)}</p>
            ) : (
              <>
                <ul className="max-h-64 divide-y divide-white/[0.05] overflow-y-auto">
                  {shown.map((item) => (
                    <PlanRow key={`${item.serverId}:${item.email}`} item={item} lang={lang} t={t} />
                  ))}
                </ul>
                <p className="border-t border-white/[0.05] px-3 py-2 text-[10px] leading-4 text-slate-500">
                  {allBlocked ? t('nodeSearch.bulkAllFailed') : t('nodeSearch.previewHint')}
                </p>
              </>
            )}
          </div>
        ) : null}

        {result ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2">
              <span className="text-[11px] font-semibold text-slate-200">{t('nodeSearch.resultTitle')}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone="emerald">
                  {t('nodeSearch.bulkDone', { n: formatNumber(Number(result.moved || 0) + Number(result.adopted || 0), lang) })}
                </Badge>
                {result.failed ? <Badge tone="rose">{t('nodeSearch.actionFailed')}: {formatNumber(result.failed, lang)}</Badge> : null}
              </span>
            </div>
            <ul className="max-h-64 divide-y divide-white/[0.05] overflow-y-auto">
              {shown.map((item) => (
                <PlanRow key={`${item.serverId}:${item.email}`} item={item} lang={lang} t={t} />
              ))}
            </ul>
          </div>
        ) : null}

        {!result && singleAdopt ? (
          <>
            <Field label={t('nodeSearch.label')}>
              <Input value={form.label} maxLength={120} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('nodeSearch.customerName')}>
                <Input value={form.customerName} maxLength={120} onChange={(e) => setForm((prev) => ({ ...prev, customerName: e.target.value }))} />
              </Field>
              <Field label={t('nodeSearch.customerPhone')}>
                <Input value={form.customerPhone} maxLength={40} dir="ltr" onChange={(e) => setForm((prev) => ({ ...prev, customerPhone: e.target.value }))} />
              </Field>
            </div>
          </>
        ) : null}

        {!result ? (
          <Field label={t('nodeSearch.note')}>
            <Textarea rows={2} value={form.note} maxLength={500} onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))} />
          </Field>
        ) : null}

        <p className="text-[10.5px] leading-5 text-slate-500">{t('nodeSearch.bulkNote')}</p>
      </div>
    </Modal>
  );
}

export default function NodeSearch() {
  const { t, lang } = useI18n();
  const [term, setTerm] = useState('');
  const [serverId, setServerId] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const [selected, setSelected] = useState(() => new Map());
  const [assigning, setAssigning] = useState(null);

  const nodesQuery = useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: () => api.get('/admin/nodes'),
  });

  const searchQuery = useQuery({
    queryKey: ['node-clients', submitted?.q, submitted?.serverId],
    // v1.5.8: ask for the service ceiling, not a page-sized slice — the owner's
    // 210 «speed» clients must all arrive so «select all» really means all.
    queryFn: () => api.get(`/admin/node-clients?q=${encodeURIComponent(submitted.q)}&serverId=${submitted.serverId || 0}&limit=5000`),
    enabled: Boolean(submitted),
    // A node client list is a live snapshot of somebody else's panel: keep it,
    // but never silently re-run the network sweep in the background.
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const nodes = nodesQuery.data?.rows || [];
  const trimmed = term.trim();
  const canSearch = trimmed.length >= 2;

  const rows = searchQuery.data?.rows || [];
  const errors = searchQuery.data?.errors || [];
  const scanned = Number(searchQuery.data?.scanned || 0);
  const resultCount = useMemo(() => formatNumber(rows.length, lang), [rows.length, lang]);

  // A tick belongs to the search it was made in. Keeping it across searches would
  // hand over a customer the admin can no longer see on screen.
  useEffect(() => { setSelected(new Map()); }, [submitted?.q, submitted?.serverId]);

  const runSearch = () => {
    if (!canSearch) return;
    setSubmitted({ q: trimmed, serverId: String(serverId || '') });
  };

  const toggle = (row, next) => {
    setSelected((prev) => {
      const copy = new Map(prev);
      if (next) copy.set(keyOf(row), row);
      else copy.delete(keyOf(row));
      return copy;
    });
  };

  const selectedOnPage = rows.filter((row) => selected.has(keyOf(row))).length;
  const allOnPage = rows.length > 0 && selectedOnPage === rows.length;
  const selectedRows = [...selected.values()];

  const toggleAll = (next) => {
    setSelected((prev) => {
      const copy = new Map(prev);
      for (const row of rows) {
        if (next) copy.set(keyOf(row), row);
        else copy.delete(keyOf(row));
      }
      return copy;
    });
  };

  // What landed is no longer waiting for a decision; what failed stays ticked so
  // the admin can fix the reason and try again without hunting for it.
  const onLanded = (data) => {
    const done = new Set(
      (data?.results || [])
        .filter((row) => row.ok)
        .map((row) => `${Number(row.serverId) || 0}:${String(row.email || '').toLowerCase()}`),
    );
    setSelected((prev) => {
      const copy = new Map(prev);
      for (const key of done) copy.delete(key);
      return copy;
    });
  };

  return (
    <>
      <PageHeader title={t('nodeSearch.title')} subtitle={t('nodeSearch.subtitle')} />

      <SectionCard icon={Search} title={t('nodeSearch.query')}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label={t('nodeSearch.query')} hint={t('nodeSearch.queryHint')}>
              <Input
                value={term}
                dir="ltr"
                placeholder={t('nodeSearch.queryPlaceholder')}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              />
            </Field>
          </div>
          <div className="sm:w-56">
            <Field label={t('nodeSearch.server')}>
              <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                <option value="">{t('nodeSearch.allServers')}</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>{node.name || `#${node.id}`}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Button icon={Search} loading={searchQuery.isFetching} disabled={!canSearch} onClick={runSearch} className="sm:mb-0.5">
            {t('nodeSearch.search')}
          </Button>
        </div>
        {!canSearch && trimmed.length > 0 ? (
          <p className="mt-2 text-[10.5px] text-amber-200/90">{t('nodeSearch.tooShort')}</p>
        ) : null}
      </SectionCard>

      <div className="mt-4">
        <SectionCard
          icon={Network}
          title={t('nodeSearch.results')}
          bodyClass="p-0"
          actions={submitted && searchQuery.data ? (
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
              <Badge tone="cyan">{resultCount}</Badge>
              <span>{t('nodeSearch.scanned')}: {formatNumber(scanned, lang)}</span>
            </div>
          ) : null}
        >
          {!submitted ? (
            <EmptyState icon={Search} title={t('nodeSearch.start')} />
          ) : searchQuery.isLoading || searchQuery.isFetching ? (
            <div className="space-y-2 p-4">
              <p className="text-[11px] text-slate-500">{t('nodeSearch.searching')}</p>
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : searchQuery.isError ? (
            <ErrorState message={translateError(searchQuery.error, t)} onRetry={searchQuery.refetch} />
          ) : (
            <>
              {errors.length ? (
                <div className="border-b border-white/[0.05] p-3">
                  <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[10.5px] leading-5 text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0">
                      {t('nodeSearch.errors')}: <span dir="ltr">{errors.join(' | ')}</span>
                    </span>
                  </p>
                </div>
              ) : null}
              {searchQuery.data?.truncated ? (
                <p className="border-b border-white/[0.05] px-4 py-2 text-[10.5px] text-slate-500">{t('nodeSearch.truncated')}</p>
              ) : null}
              {rows.length ? (
                <>
                  <div className="sticky top-0 z-[2] flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-[#0a0f1d]/95 px-4 py-2.5 backdrop-blur">
                    <Checkbox
                      checked={allOnPage}
                      onChange={toggleAll}
                      label={t('nodeSearch.selectAll')}
                      className="text-[11.5px]"
                    />
                    <span className="text-[10.5px] text-slate-500">
                      {t('nodeSearch.selectedCount', { n: formatNumber(selected.size, lang) })}
                    </span>
                    <div className="ms-auto flex flex-wrap items-center gap-2">
                      {selected.size ? (
                        <Button size="sm" variant="ghost" icon={X} onClick={() => setSelected(new Map())}>
                          {t('nodeSearch.clearSelection')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        icon={CheckCheck}
                        disabled={!selected.size}
                        onClick={() => setAssigning(selectedRows)}
                      >
                        {t('nodeSearch.bulkAssign')}
                        {selected.size ? ` (${formatNumber(selected.size, lang)})` : ''}
                      </Button>
                    </div>
                  </div>
                  <div className="divide-y divide-white/[0.05]">
                    {rows.map((row) => (
                      <ClientCard
                        key={keyOf(row)}
                        row={row}
                        selected={selected.has(keyOf(row))}
                        onToggle={toggle}
                        onAssign={(one) => setAssigning([one])}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState icon={Search} title={t('nodeSearch.empty')} hint={t('nodeSearch.emptyHint')} />
              )}
            </>
          )}
        </SectionCard>
      </div>

      <AssignModal
        open={Boolean(assigning)}
        onClose={() => setAssigning(null)}
        clients={assigning || []}
        onLanded={onLanded}
      />
    </>
  );
}