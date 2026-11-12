import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Fingerprint,
  Network,
  Plus,
  Search,
  Server,
  UserPlus,
} from 'lucide-react';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatBytes, formatDate, formatNumber } from '../../lib/format.js';
import {
  Badge,
  Button,
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
 * Find an existing x-ui client and hand it to a reseller.
 *
 * The search is deliberately manual (a button, not a live keystroke query): each
 * run asks every enabled node for its client list, which is a real network call
 * per panel. Nothing here writes to x-ui — adopting only adds panel rows.
 */

function ClientCard({ row, onAdopt }) {
  const { t, lang } = useI18n();
  const used = Number(row.up || 0) + Number(row.down || 0);
  const otherOwner = (row.owners || []).length > 0;
  return (
    <article className="p-4 transition hover:bg-white/[0.02]">
      <div className="flex flex-wrap items-center gap-2">
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
        <Button size="sm" icon={UserPlus} onClick={() => onAdopt(row)}>
          {t('nodeSearch.addToReseller')}
        </Button>
      </div>
    </article>
  );
}

function AdoptModal({ open, onClose, client }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ userId: '', label: '', customerName: '', customerPhone: '', note: '' });

  const usersQuery = useQuery({
    queryKey: ['adopt-resellers'],
    queryFn: () => api.get('/admin/users?role=reseller&pageSize=200'),
    enabled: open,
  });

  useEffect(() => {
    if (open && client) {
      setForm({
        userId: '',
        label: client.remark || client.email || '',
        customerName: '',
        customerPhone: '',
        note: '',
      });
    }
  }, [open, client?.email, client?.serverId]);

  const resellers = usersQuery.data?.rows || [];
  const chosen = resellers.find((user) => String(user.id) === String(form.userId));
  const importOff = chosen && chosen.importConfigs === false;

  const adopt = useMutation({
    mutationFn: () => api.post('/admin/configs/adopt', {
      email: client.email,
      serverId: client.serverId,
      userId: Number(form.userId),
      label: form.label.trim(),
      customerName: form.customerName.trim(),
      customerPhone: form.customerPhone.trim(),
      note: form.note.trim(),
    }),
    onSuccess: (data) => {
      const count = Number(data?.configs?.length || 0);
      if (Number(data?.imported || 0) + Number(data?.restored || 0) === 0) {
        toast.success(t('nodeSearch.alreadyOwned'));
      } else {
        toast.success(t('nodeSearch.added', { n: formatNumber(count, lang) }));
      }
      queryClient.invalidateQueries({ queryKey: ['node-clients'] });
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  if (!client) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('nodeSearch.addTitle')}
      subtitle={client.email}
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={Plus}
            loading={adopt.isPending}
            disabled={!form.userId || importOff}
            onClick={() => adopt.mutate()}
          >
            {t('nodeSearch.add')}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px] text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-500">{t('nodeSearch.node')}</span>
            <span className="text-slate-200">{client.serverName || `#${client.serverId}`}</span>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-slate-500">{t('nodeSearch.inbound')}</span>
            <span className="text-slate-200">
              {(client.inbounds || []).map((inbound) => inbound.remark || `#${inbound.id}`).join(' · ') || '—'}
            </span>
          </div>
        </div>

        <Field label={t('nodeSearch.reseller')} required>
          <Select value={form.userId} onChange={(e) => setForm((prev) => ({ ...prev, userId: e.target.value }))}>
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

        <Field label={t('nodeSearch.note')}>
          <Textarea rows={2} value={form.note} maxLength={500} onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))} />
        </Field>

        <p className="text-[10.5px] leading-5 text-slate-500">{t('nodeSearch.addNote')}</p>
      </div>
    </Modal>
  );
}

export default function NodeSearch() {
  const { t, lang } = useI18n();
  const [term, setTerm] = useState('');
  const [serverId, setServerId] = useState('');
  const [submitted, setSubmitted] = useState(null);
  const [adopt, setAdopt] = useState(null);

  const nodesQuery = useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: () => api.get('/admin/nodes'),
  });

  const searchQuery = useQuery({
    queryKey: ['node-clients', submitted?.q, submitted?.serverId],
    queryFn: () => api.get(`/admin/node-clients?q=${encodeURIComponent(submitted.q)}&serverId=${submitted.serverId || 0}&limit=60`),
    enabled: Boolean(submitted),
    // A node client list is a live snapshot of somebody else's panel: keep it,
    // but never silently re-run the network sweep in the background.
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const nodes = nodesQuery.data?.rows || [];
  const trimmed = term.trim();
  const canSearch = trimmed.length >= 2;

  const runSearch = () => {
    if (!canSearch) return;
    setSubmitted({ q: trimmed, serverId: String(serverId || '') });
  };

  const rows = searchQuery.data?.rows || [];
  const errors = searchQuery.data?.errors || [];
  const scanned = Number(searchQuery.data?.scanned || 0);
  const resultCount = useMemo(() => formatNumber(rows.length, lang), [rows.length, lang]);

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
                <div className={cx('divide-y divide-white/[0.05]')}>
                  {rows.map((row) => (
                    <ClientCard key={`${row.serverId}:${row.email}`} row={row} onAdopt={setAdopt} />
                  ))}
                </div>
              ) : (
                <EmptyState icon={Search} title={t('nodeSearch.empty')} hint={t('nodeSearch.emptyHint')} />
              )}
            </>
          )}
        </SectionCard>
      </div>

      <AdoptModal open={Boolean(adopt)} onClose={() => setAdopt(null)} client={adopt} />
    </>
  );
}