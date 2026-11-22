import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Layers, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatMoney, formatNumber } from '../../lib/format.js';
import { Badge, Button, Checkbox, Field, Input, Modal, Skeleton } from '../ui.jsx';
import { useToast } from '../feedback.jsx';

/**
 * v2.3.0, item 6 — bulk renewal and bulk delete for the configs list.
 *
 * Both dialogs are thin wrappers over the two bulk service functions, which in
 * turn call the SAME single-config code the drawer uses (extendConfig /
 * deletePackage). Nothing about a package is reimplemented here: the price, the
 * wallet, the shared quota pool, the x-ui writes, the ledger line, the Trash
 * entry and the audit trail are exactly the ones a single click would produce.
 *
 * The list an operator ticks is a list of CONFIG ROWS, and several rows can be
 * one customer (a multi-inbound package shares one client on the node). The
 * server folds the ticks down to one head per package and answers `packages`
 * and `merged`, so the confirm button names the packages that will really be
 * touched — never the tick count.
 *
 * The preview is the same endpoint with dryRun on. It is the gate, not a
 * decoration: it prices every package, says which channel count and which new
 * size/expiry each customer gets, and marks the item where a wallet runs out
 * BEFORE anything is written.
 */

function useBulkPreview({ open, path, body, ready }) {
  const fingerprint = useMemo(() => JSON.stringify(body), [body]);
  return useQuery({
    queryKey: ['bulk-preview', path, fingerprint],
    queryFn: () => api.post(path, { ...body, dryRun: true }),
    enabled: open && ready,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * One package line, used for both the preview and the result. It only prints
 * what the server sent — a line never computes a price or a new expiry itself.
 */
function PackageLine({ item, mode, outcomeLabel }) {
  const { t, lang } = useI18n();
  const { meta } = useAuth();
  const currency = meta?.billing?.currency || '';
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <p className="max-w-[280px] truncate font-mono text-[11px] text-slate-200" dir="ltr">
          {item.email || `#${item.id}`}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
          <span className="flex items-center gap-1">
            <Layers className="h-3 w-3" />
            {t('configs.bulk.channels', { n: formatNumber(Number(item.rows || 0), lang) })}
          </span>
          {item.reseller ? <span>· {item.reseller}</span> : null}
        </p>
        {mode === 'extend' && item.ok ? (
          <p className="mt-0.5 text-[10px] text-cyan-200/80">
            {outcomeLabel}{' '}
            {formatNumber(Number(item.resultGb || 0), lang, 2)} GB ·{' '}
            {item.resultExpiryAt ? formatDate(item.resultExpiryAt, lang) : t('common.unlimited')}
          </p>
        ) : null}
        {mode === 'delete' && item.ok ? (
          <p className="mt-0.5 text-[10px] text-amber-200/80">
            {Number(item.xuiDeleted || 0) > 0
              ? t('configs.bulk.remoteClients', { n: formatNumber(Number(item.xuiDeleted), lang) })
              : t('configs.bulk.localOnlyLine')}
          </p>
        ) : null}
        {!item.ok && item.message ? (
          <p className="mt-0.5 max-w-[300px] text-[10px] leading-4 text-rose-200/90">{item.message}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {mode === 'extend' && item.ok && item.charged ? (
          <span className="text-[11px] text-slate-300">{formatMoney(Number(item.amount || 0), lang, currency)}</span>
        ) : null}
        {mode === 'extend' && item.ok && !item.charged ? (
          <Badge tone="cyan">{t('configs.extend.noCharge')}</Badge>
        ) : null}
        <Badge tone={item.ok ? 'emerald' : 'rose'}>
          {item.ok ? t('configs.bulk.willApply') : t('configs.bulk.willSkip')}
        </Badge>
      </div>
    </li>
  );
}

function PreviewBox({ title, plan, result, lines, mode, note, loading, error, lang, t, outcomeLabel }) {
  const { meta } = useAuth();
  const currency = meta?.billing?.currency || '';
  const done = Boolean(result);
  const source = result || plan;
  const packages = Number(source?.packages || 0);
  const failed = Number(source?.failed || 0);
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.05] px-3 py-2">
        <span className="text-[11px] font-semibold text-slate-200">
          {done ? t('configs.bulk.resultTitle') : title}
        </span>
        {source ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={mode === 'delete' ? 'rose' : 'emerald'}>
              {t('configs.bulk.packages', { n: formatNumber(packages, lang) })}
            </Badge>
            {Number(source.merged || 0) ? (
              <Badge tone="slate">{t('configs.bulk.merged', { n: formatNumber(Number(source.merged), lang) })}</Badge>
            ) : null}
            {mode === 'delete' && Number(source.remote || 0) ? (
              <Badge tone="amber">{t('configs.bulk.remote', { n: formatNumber(Number(source.remote), lang) })}</Badge>
            ) : null}
            {mode === 'delete' && Number(source.localOnly || 0) ? (
              <Badge tone="slate">{t('configs.bulk.localOnly', { n: formatNumber(Number(source.localOnly), lang) })}</Badge>
            ) : null}
            {mode === 'extend' ? (
              Number(source.amount || 0) > 0 ? (
                <Badge tone="amber">{t('configs.bulk.chargeTotal', { amount: formatMoney(Number(source.amount), lang, currency) })}</Badge>
              ) : (
                <Badge tone="cyan">{t('configs.extend.noCharge')}</Badge>
              )
            ) : null}
            {failed ? <Badge tone="rose">{t('configs.bulk.failed', { n: formatNumber(failed, lang) })}</Badge> : null}
          </span>
        ) : null}
      </div>
      {!done && loading ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : !done && error ? (
        <p className="px-3 py-2 text-[10.5px] leading-5 text-rose-200/90">{translateError(error, t)}</p>
      ) : (
        <ul className="max-h-64 divide-y divide-white/[0.05] overflow-y-auto">
          {lines.map((item) => <PackageLine key={item.id} item={item} mode={mode} />)}
        </ul>
      )}
      <p className="border-t border-white/[0.05] px-3 py-2 text-[10px] leading-4 text-slate-500">{note}</p>
    </div>
  );
}

export function BulkRenewModal({ open, onClose, ids, isAdmin, onDone }) {
  const { t, lang } = useI18n();
  const { meta } = useAuth();
  const currency = meta?.billing?.currency || '';
  const toast = useToast();
  const [form, setForm] = useState({ gb: 10, days: 30, resetUsage: false, charge: false });
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setForm({ gb: 10, days: 30, resetUsage: false, charge: false });
    }
  }, [open]);

  const path = `${isAdmin ? '/admin' : '/reseller'}/configs/bulk-extend`;
  const gb = Math.max(0, Number(form.gb || 0));
  const days = Math.max(0, Math.round(Number(form.days || 0)));
  // A reseller's charge is decided by the server (always), so his tick is never
  // even sent — the admin box is the only place the flag exists.
  const body = { ids, gb, days, resetUsage: form.resetUsage, ...(isAdmin ? { charge: form.charge } : {}) };
  const ready = ids.length > 0 && (gb > 0 || days > 0);

  const preview = useBulkPreview({ open, path, body, ready: !result && ready });
  const plan = preview.data || null;
  const source = result || plan;
  const lines = source?.results || [];
  const packages = Number(source?.packages || 0);

  const run = useMutation({
    mutationFn: () => api.post(path, body),
    onSuccess: (data) => {
      setResult(data);
      const ok = Number(data?.renewed || 0);
      const failed = Number(data?.failed || 0);
      if (ok && failed) toast.error(t('configs.bulk.partial', { ok: formatNumber(ok, lang), fail: formatNumber(failed, lang) }));
      else if (ok) toast.success(t('configs.bulk.renewDone', { n: formatNumber(ok, lang) }));
      onDone?.(data);
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  // A free renewal still has a price — it is just not taken. Saying «بدون کسر»
  // and nothing else would hide how much the batch would have cost, which is the
  // number the reseller asks about when the admin renews for him.
  const note = Number(source?.tariff || 0) > 0 && Number(source?.amount || 0) === 0
    ? t('configs.bulk.tariffNotCharged', { amount: formatMoney(Number(source.tariff), lang, currency) })
    : t('configs.bulk.renewNote');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('configs.bulk.renewTitle')}
      subtitle={t('configs.bulk.selected', { n: formatNumber(ids.length, lang) })}
      footer={result ? (
        <Button onClick={onClose}>{t('common.close')}</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            icon={Layers}
            loading={run.isPending}
            disabled={!ready || (Boolean(plan) && packages === 0)}
            onClick={() => run.mutate()}
          >
            {t('configs.bulk.renewConfirm', { n: formatNumber(packages || ids.length, lang) })}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={form.resetUsage ? t('configs.extend.gbNew') : t('configs.extend.gb')}>
            <Input type="number" min="0" step="1" value={form.gb} onChange={(e) => setForm((p) => ({ ...p, gb: e.target.value }))} />
          </Field>
          <Field label={form.resetUsage ? t('configs.extend.daysNew') : t('configs.extend.days')}>
            <Input type="number" min="0" step="1" value={form.days} onChange={(e) => setForm((p) => ({ ...p, days: e.target.value }))} />
          </Field>
        </div>

        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
          <Checkbox
            checked={form.resetUsage}
            onChange={(value) => setForm((p) => ({ ...p, resetUsage: value }))}
            label={t('configs.extend.resetUsage')}
          />
          <p className="mt-1 text-[10.5px] leading-5 text-slate-500">
            {form.resetUsage ? t('configs.extend.resetHintOn') : t('configs.extend.hint')}
          </p>
        </div>

        {isAdmin ? (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
            <Checkbox
              checked={form.charge}
              onChange={(value) => setForm((p) => ({ ...p, charge: value }))}
              label={t('configs.extend.chargeReseller')}
            />
            <p className="mt-1 text-[10.5px] leading-5 text-slate-500">
              {form.charge ? t('configs.extend.chargeOnHint') : t('configs.extend.adminFreeHint')}
            </p>
          </div>
        ) : null}

        {!ready ? (
          <p className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-5 text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('configs.extend.enterAmount')}
          </p>
        ) : null}

        {ready || result ? (
          <PreviewBox
            title={t('configs.bulk.previewTitle')}
            plan={plan}
            result={result}
            lines={lines}
            mode="extend"
            outcomeLabel={form.resetUsage ? t('configs.extend.becomesReplace') : t('configs.extend.becomesAdd')}
            loading={preview.isLoading || preview.isFetching}
            error={preview.error}
            lang={lang}
            t={t}
            note={note}
          />
        ) : null}

        {run.isError ? (
          <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] leading-5 text-rose-200">
            {translateError(run.error, t)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function BulkDeleteModal({ open, onClose, ids, onDone }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (open) setResult(null);
  }, [open]);

  const path = `${isAdmin ? '/admin' : '/reseller'}/configs/bulk-delete`;
  const preview = useBulkPreview({ open, path, body: { ids }, ready: ids.length > 0 });
  const plan = preview.data || null;
  const source = result || plan;
  const lines = source?.results || [];
  const packages = Number(source?.packages || 0);

  const run = useMutation({
    mutationFn: () => api.post(path, { ids }),
    onSuccess: (data) => {
      setResult(data);
      const ok = Number(data?.deleted || 0);
      const failed = Number(data?.failed || 0);
      if (ok && failed) toast.error(t('configs.bulk.partial', { ok: formatNumber(ok, lang), fail: formatNumber(failed, lang) }));
      else if (ok) toast.success(t('configs.bulk.deleteDone', { n: formatNumber(ok, lang) }));
      onDone?.(data);
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('configs.bulk.deleteTitle')}
      subtitle={t('configs.bulk.selected', { n: formatNumber(ids.length, lang) })}
      footer={result ? (
        <Button onClick={onClose}>{t('common.close')}</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            icon={Trash2}
            loading={run.isPending}
            disabled={ids.length === 0 || (Boolean(plan) && packages === 0)}
            onClick={() => run.mutate()}
          >
            {t('configs.bulk.deleteConfirm', { n: formatNumber(packages || ids.length, lang) })}
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] leading-5 text-rose-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('configs.bulk.deleteWarning')}
        </p>

        <PreviewBox
          title={t('configs.bulk.previewTitle')}
          plan={plan}
          result={result}
          lines={lines}
          mode="delete"
          loading={preview.isLoading || preview.isFetching}
          error={preview.error}
          lang={lang}
          t={t}
          note={t('configs.bulk.deleteNote')}
        />

        {run.isError ? (
          <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[11px] leading-5 text-rose-200">
            {translateError(run.error, t)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
