import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  Clock,
  Eye,
  EyeOff,
  HardDrive,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Signal,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n, translateError } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatDate, formatMoney, formatNumber } from '../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  SectionCard,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TableSkeleton,
  Textarea,
  Toolbar,
  cx,
  useDebounced,
} from '../components/ui.jsx';
import { useConfirm, useToast } from '../components/feedback.jsx';

/**
 * v1.5.4, item 7 — پلن‌های آماده.
 *
 * One page, two faces of the same row. The owner writes a plan here: a volume,
 * a duration, the channels it runs on and HIS price instead of the tariff. The
 * reseller sees that list and can only ever pick one by id — no route on his
 * side reads a price, a gb, a days or an inbound list from the body (see
 * server/src/services/plans.js), which is the whole point of a "ready-made plan".
 *
 * Buying has two paths, exactly as the owner described them: a NEW customer, and
 * applying the plan again to an EXISTING one, in which case his usage and his
 * expiry are wiped and the plan starts over — that is the v1.4.26 replace-renewal
 * under the hood, so the UI has to say "reset" and not "extend".
 */

const EMPTY_PLAN = {
  name: '',
  description: '',
  gb: 10,
  days: 30,
  price: 0,
  inboundIds: [],
  visible: 1,
  sort: 0,
};

// Same ceilings the service enforces; the form uses them for its hints, not to
// hide a rule the owner would otherwise only learn from a red toast.
const LIMITS = { maxInbounds: 6, maxGb: 1024, maxDays: 3650 };

function PlanNumbers({ plan, lang, tone = 'text-slate-300' }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className={cx('inline-flex items-center gap-1 rounded-lg bg-white/[0.04] px-2 py-1', tone)}>
        <HardDrive className="h-3 w-3 text-slate-500" />
        {formatNumber(plan.gb, lang, 2)} GB
      </span>
      <span className={cx('inline-flex items-center gap-1 rounded-lg bg-white/[0.04] px-2 py-1', tone)}>
        <Clock className="h-3 w-3 text-slate-500" />
        {formatNumber(plan.days, lang)} {t_day(lang)}
      </span>
    </div>
  );
}

// Persian has no singular/plural form to switch on here, so the word is picked by
// language rather than counted.
function t_day(lang) {
  return lang === 'en' ? 'days' : 'روز';
}

function InboundChips({ inbounds, lang, max = 4 }) {
  const { t } = useI18n();
  if (!inbounds?.length) return <span className="text-[11px] text-rose-300">{t('plans.noChannels')}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {inbounds.slice(0, max).map((item) => (
        <Badge key={item.id} tone={item.enabled === false ? 'rose' : 'cyan'} className="max-w-[160px] truncate">
          {item.remark || `#${item.id}`}
          {item.enabled === false ? ` · ${t('common.disabled')}` : ''}
        </Badge>
      ))}
      {inbounds.length > max ? <Badge tone="slate">+{formatNumber(inbounds.length - max, lang)}</Badge> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: authoring
// ─────────────────────────────────────────────────────────────────────────────

function PlanForm({ open, onClose, editing }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_PLAN);

  const inboundsQuery = useQuery({
    queryKey: ['inbounds', 'plans'],
    queryFn: () => api.get('/admin/inbounds'),
    enabled: open,
  });
  const inbounds = (inboundsQuery.data?.rows || []).filter((row) => row.enabled);

  useEffect(() => {
    if (!open) return;
    setForm(editing
      ? {
        name: editing.name || '',
        description: editing.description || '',
        gb: Number(editing.gb || 0),
        days: Number(editing.days || 0),
        price: Number(editing.price || 0),
        inboundIds: (editing.inbounds || []).map((item) => Number(item.id)),
        visible: Number(editing.visible ? 1 : 0),
        sort: Number(editing.sort || 0),
      }
      : EMPTY_PLAN);
  }, [open, editing]);

  const save = useMutation({
    mutationFn: (payload) => (editing
      ? api.patch(`/admin/plans/${editing.id}`, payload)
      : api.post('/admin/plans', payload)),
    onSuccess: () => {
      toast.success(editing ? t('common.saved') : t('common.created'));
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const toggle = (id) => setForm((prev) => ({
    ...prev,
    inboundIds: prev.inboundIds.includes(id)
      ? prev.inboundIds.filter((value) => value !== id)
      : [...prev.inboundIds, id],
  }));

  const selected = inbounds.filter((row) => form.inboundIds.includes(row.id));
  const servers = [...new Set(selected.map((row) => Number(row.serverId || row.server_id || 0)))];
  const mixedServer = servers.length > 1;
  const canSave = form.name.trim() && form.inboundIds.length > 0 && !mixedServer && !save.isPending;

  const submit = (event) => {
    event.preventDefault();
    if (!canSave) return;
    save.mutate({
      name: form.name.trim(),
      description: form.description.trim(),
      gb: Number(form.gb || 0),
      days: Number(form.days || 0),
      price: Number(form.price || 0),
      inbound_ids: form.inboundIds,
      visible: Boolean(form.visible),
      sort: Number(form.sort || 0),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t('plans.form.editTitle') : t('plans.form.createTitle')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button loading={save.isPending} disabled={!canSave} onClick={submit} icon={Layers}>{t('common.save')}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('plans.form.name')} required>
            <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} maxLength={80} />
          </Field>
          <Field label={t('plans.form.sort')} hint={t('plans.form.sortHint')}>
            <Input type="number" min={0} dir="ltr" value={form.sort} onChange={(e) => setForm((prev) => ({ ...prev, sort: e.target.value }))} />
          </Field>
        </div>
        <Field label={t('plans.form.description')} hint={t('plans.form.descriptionHint')}>
          <Textarea rows={2} maxLength={300} value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('plans.form.gb')} hint={`${t('plans.form.maxGb')} ${formatNumber(LIMITS.maxGb, lang)}`}>
            <Input type="number" min={0} step="0.5" dir="ltr" value={form.gb} onChange={(e) => setForm((prev) => ({ ...prev, gb: e.target.value }))} />
          </Field>
          <Field label={t('plans.form.days')} hint={`${t('plans.form.maxDays')} ${formatNumber(LIMITS.maxDays, lang)}`}>
            <Input type="number" min={1} dir="ltr" value={form.days} onChange={(e) => setForm((prev) => ({ ...prev, days: e.target.value }))} />
          </Field>
          <Field label={t('plans.form.price')} hint={t('plans.form.priceHint')}>
            <Input type="number" min={0} dir="ltr" value={form.price} onChange={(e) => setForm((prev) => ({ ...prev, price: e.target.value }))} />
          </Field>
        </div>

        <div>
          <span className="label">{t('plans.form.channels', { n: formatNumber(LIMITS.maxInbounds, lang) })}</span>
          <div className="max-h-[200px] overflow-y-auto rounded-xl border border-white/[0.07] bg-white/[0.015] p-2.5">
            {inbounds.length ? (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {inbounds.map((row) => (
                  <Checkbox
                    key={row.id}
                    checked={form.inboundIds.includes(row.id)}
                    onChange={() => toggle(row.id)}
                    label={(
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{row.remark || `#${row.id}`}</span>
                        <span className="shrink-0 text-slate-500">({row.protocol})</span>
                        <span className="shrink-0 text-slate-600">· {row.serverName || '—'}</span>
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
          {mixedServer ? (
            <p className="mt-1.5 rounded-lg border border-amber-400/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[10.5px] text-amber-200">
              {t('plans.form.mixedServer')}
            </p>
          ) : (
            <p className="mt-1.5 text-[10.5px] leading-5 text-slate-500">{t('plans.form.channelsHint')}</p>
          )}
        </div>

        <div className={cx(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-3 transition',
          form.visible ? 'border-emerald-400/25 bg-emerald-500/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'
        )}>
          <div className="min-w-0">
            <p className="text-[12.5px] font-medium text-slate-200">{t('plans.form.visible')}</p>
            <p className="mt-0.5 text-[10.5px] leading-5 text-slate-500">{t('plans.form.visibleHint')}</p>
          </div>
          <Switch checked={Boolean(form.visible)} onChange={(value) => setForm((prev) => ({ ...prev, visible: value ? 1 : 0 }))} />
        </div>
      </form>
    </Modal>
  );
}

function AdminPlans() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['plans', 'admin'],
    queryFn: () => api.get('/admin/plans'),
  });

  const plans = data?.plans || [];
  const filtered = useMemo(() => {
    const term = debounced.trim().toLowerCase();
    if (!term) return plans;
    return plans.filter((plan) => `${plan.name} ${plan.description} ${(plan.inbounds || []).map((item) => item.remark).join(' ')}`.toLowerCase().includes(term));
  }, [plans, debounced]);

  const remove = useMutation({
    mutationFn: (id) => api.del(`/admin/plans/${id}`),
    onSuccess: () => {
      toast.success(t('common.deleted'));
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const setVisible = useMutation({
    mutationFn: ({ id, visible }) => api.patch(`/admin/plans/${id}`, { visible }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plans'] }),
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askDelete = async (plan) => {
    const ok = await confirm({
      title: t('plans.deleteTitle'),
      body: t('plans.deleteBody', { name: plan.name }),
      danger: true,
    });
    if (ok) remove.mutate(plan.id);
  };

  const broken = plans.filter((plan) => !plan.inbounds.length || plan.inbounds.some((item) => !item.enabled));

  return (
    <>
      <PageHeader
        title={t('plans.title')}
        subtitle={t('plans.subtitleAdmin')}
        actions={<Button icon={Plus} onClick={() => { setEditing(null); setFormOpen(true); }}>{t('plans.new')}</Button>}
      />

      {isLoading ? (
        <div className="table-wrap"><TableSkeleton rows={6} cols={6} /></div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : (
        <>
          {broken.length ? (
            <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-amber-400/25 bg-amber-500/[0.06] px-4 py-3">
              <Signal className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <p className="text-[11.5px] leading-5 text-amber-100/90">
                {t('plans.brokenHint', { n: formatNumber(broken.length, lang) })}
              </p>
            </div>
          ) : null}

          <Toolbar>
            <SearchInput value={search} onChange={setSearch} placeholder={t('plans.search')} className="w-full max-w-xs" />
            <Badge tone="slate">{formatNumber(plans.length, lang)} {t('plans.count')}</Badge>
            <div className="ms-auto">
              <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={() => refetch()} className={cx(isFetching && '[&>svg]:animate-spin')} />
            </div>
          </Toolbar>

          {filtered.length ? (
            <div className="table-wrap">
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('plans.table.name')}</th>
                      <th>{t('plans.table.size')}</th>
                      <th>{t('plans.table.channels')}</th>
                      <th>{t('plans.table.price')}</th>
                      <th>{t('plans.table.visibility')}</th>
                      <th className="text-end">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((plan) => (
                      <tr key={plan.id}>
                        <td>
                          <p className="max-w-[220px] truncate text-[12px] font-medium text-slate-200">{plan.name}</p>
                          {plan.description ? (
                            <p className="max-w-[260px] truncate text-[9.5px] text-slate-500">{plan.description}</p>
                          ) : null}
                          <p className="mt-0.5 text-[9px] text-slate-600">#{formatNumber(plan.id, lang)} · {t('plans.sortValue', { n: formatNumber(plan.sort, lang) })}</p>
                        </td>
                        <td><PlanNumbers plan={plan} lang={lang} /></td>
                        <td><InboundChips inbounds={plan.inbounds} lang={lang} /></td>
                        <td>
                          {plan.price > 0 ? (
                            <span className="text-[11.5px] font-semibold text-emerald-300">{formatMoney(plan.price, lang)}</span>
                          ) : (
                            <Badge tone="violet">{t('plans.free')}</Badge>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() => setVisible.mutate({ id: plan.id, visible: !plan.visible })}
                            className={cx(
                              'flex h-7 w-7 items-center justify-center rounded-lg border transition',
                              plan.visible
                                ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                                : 'border-white/10 bg-white/[0.04] text-slate-500 hover:text-slate-300'
                            )}
                          >
                            {plan.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                          </button>
                        </td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <IconButton icon={Pencil} label={t('common.edit')} onClick={() => { setEditing(plan); setFormOpen(true); }} />
                            <IconButton icon={Trash2} label={t('common.delete')} onClick={() => askDelete(plan)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-white/[0.06] px-4 py-2.5 text-[10.5px] text-slate-500">{t('plans.footerHint')}</div>
            </div>
          ) : (
            <div className="card">
              <EmptyState
                icon={Layers}
                title={plans.length ? t('plans.noMatch') : t('plans.emptyAdmin')}
                action={plans.length ? null : <Button size="sm" icon={Plus} onClick={() => { setEditing(null); setFormOpen(true); }}>{t('plans.new')}</Button>}
              />
            </div>
          )}
        </>
      )}

      <PlanForm open={formOpen} onClose={() => setFormOpen(false)} editing={editing} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reseller: the shop window, and the two ways of buying
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quote line: what the plan costs, what the tariff would have cost, and whether
 * his wallet covers it. All three numbers come from the server — the reseller
 * never types a price.
 */
function QuoteLines({ quote, lang, t }) {
  if (!quote) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  return (
    <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className="text-slate-400">{t('plans.tariff')}</span>
        <span className="text-slate-500 line-through">{formatMoney(quote.tariff, lang)}</span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[13px] font-semibold">
        <span className="text-slate-300">{t('plans.price')}</span>
        <span className="text-emerald-300">{formatMoney(quote.price, lang)}</span>
      </div>
      {quote.saved > 0 ? (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-slate-400">{t('plans.saved')}</span>
          <Badge tone="emerald">{formatMoney(quote.saved, lang)}</Badge>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-slate-400"><Wallet className="h-3 w-3" />{t('common.balance')}</span>
        <span className={cx('font-semibold', quote.sufficient ? 'text-slate-200' : 'text-rose-300')}>
          {formatMoney(quote.balance, lang)}
        </span>
      </div>
      {!quote.sufficient ? (
        <p className="rounded-lg border border-rose-400/25 bg-rose-500/[0.07] px-2.5 py-1.5 text-[10.5px] text-rose-200">
          {t('plans.notEnough')}
        </p>
      ) : null}
      {!quote.charged ? (
        <p className="text-[10.5px] leading-5 text-slate-500">{t('plans.notCharged')}</p>
      ) : null}
    </div>
  );
}

function BuyNewModal({ open, onClose, plan }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [quote, setQuote] = useState(null);
  const [customer, setCustomer] = useState({ customerName: '', customerPhone: '', label: '', note: '' });

  useEffect(() => {
    if (!open || !plan) return;
    setQuote(null);
    setCustomer({ customerName: '', customerPhone: '', label: '', note: '' });
    let alive = true;
    api.post('/reseller/plans/quote', { planId: plan.id })
      .then((data) => { if (alive) setQuote(data); })
      .catch((err) => toast.error(translateError(err, t)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan?.id]);

  const buy = useMutation({
    mutationFn: (payload) => api.post('/reseller/plans/new', payload),
    onSuccess: (result) => {
      toast.success(t('plans.boughtNew', { n: formatNumber((result?.configs || []).length, lang) }));
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      queryClient.invalidateQueries({ queryKey: ['reseller'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  // The button waits for the real quote: until the server has said his wallet
  // covers the plan, there is nothing honest to enable.
  const canBuy = Boolean(customer.customerName.trim()) && Boolean(quote) && quote.sufficient !== false && !buy.isPending;

  return (
    <Modal
      open={open && Boolean(plan)}
      onClose={onClose}
      title={t('plans.buyNewTitle')}
      subtitle={plan?.name}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            disabled={!canBuy}
            loading={buy.isPending}
            icon={Boxes}
            onClick={() => buy.mutate({
              planId: plan.id,
              customerName: customer.customerName.trim(),
              customerPhone: customer.customerPhone.trim(),
              label: customer.label.trim(),
              note: customer.note.trim(),
            })}
          >
            {t('plans.buy')}
          </Button>
        </>
      }
    >
      {plan ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.05] px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-semibold text-white">{plan.name}</p>
              <PlanNumbers plan={plan} lang={lang} tone="text-emerald-100" />
            </div>
            <div className="mt-2"><InboundChips inbounds={plan.inbounds} lang={lang} /></div>
            {plan.description ? <p className="mt-2 text-[11px] leading-5 text-slate-400">{plan.description}</p> : null}
          </div>

          <QuoteLines quote={quote} lang={lang} t={t} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('plans.customerName')} required>
              <Input value={customer.customerName} onChange={(e) => setCustomer((prev) => ({ ...prev, customerName: e.target.value }))} maxLength={80} />
            </Field>
            <Field label={t('plans.customerPhone')}>
              <Input value={customer.customerPhone} onChange={(e) => setCustomer((prev) => ({ ...prev, customerPhone: e.target.value }))} dir="ltr" maxLength={32} placeholder="09..." />
            </Field>
          </div>
          <Field label={t('plans.label')} hint={t('plans.labelHint')}>
            <Input value={customer.label} onChange={(e) => setCustomer((prev) => ({ ...prev, label: e.target.value }))} maxLength={80} />
          </Field>
          <Field label={t('common.note')}>
            <Textarea rows={2} maxLength={500} value={customer.note} onChange={(e) => setCustomer((prev) => ({ ...prev, note: e.target.value }))} />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

function RenewModal({ open, onClose, plans }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [planId, setPlanId] = useState('');
  const [configId, setConfigId] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 350);
  const [preview, setPreview] = useState(null);
  const [quote, setQuote] = useState(null);

  const customers = useQuery({
    queryKey: ['reseller', 'configs', 'plans-renew', debounced],
    queryFn: () => api.get(`/reseller/configs?pageSize=30&page=1${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`),
    enabled: open,
    placeholderData: (prev) => prev,
  });

  useEffect(() => { if (open) { setPreview(null); setQuote(null); } }, [open]);

  const plan = plans.find((item) => Number(item.id) === Number(planId)) || null;

  useEffect(() => {
    if (!open || !planId || !configId) return;
    let alive = true;
    setPreview(null);
    setQuote(null);
    Promise.all([
      api.post('/reseller/plans/renew/preview', { planId: Number(planId), configId: Number(configId) }),
      api.post('/reseller/plans/quote', { planId: Number(planId) }),
    ])
      .then(([previewData, quoteData]) => { if (alive) { setPreview(previewData); setQuote(quoteData); } })
      .catch((err) => { if (alive) toast.error(translateError(err, t)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, planId, configId]);

  const apply = useMutation({
    mutationFn: () => api.post('/reseller/plans/renew', { planId: Number(planId), configId: Number(configId) }),
    onSuccess: (result) => {
      toast.success(t('plans.renewed', { name: result?.plan?.name || '' }));
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      queryClient.invalidateQueries({ queryKey: ['reseller'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askApply = async () => {
    const ok = await confirm({
      title: t('plans.renewConfirmTitle'),
      body: t('plans.renewConfirmBody', {
        name: plan?.name || '',
        gb: formatNumber(preview?.gb || 0, lang, 2),
        days: formatNumber(preview?.days || 0, lang),
      }),
      danger: true,
    });
    if (ok) apply.mutate();
  };

  const rows = customers.data?.rows || [];
  const chosen = rows.find((row) => Number(row.id) === Number(configId)) || null;
  const canApply = Boolean(planId && configId) && preview?.usable !== false && quote?.sufficient !== false && !apply.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('plans.renewTitle')}
      subtitle={t('plans.renewSubtitle')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!canApply} loading={apply.isPending} icon={RefreshCw} onClick={askApply}>{t('plans.applyPlan')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('plans.pickPlan')}>
          <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">{t('plans.pickPlanNone')}</option>
            {plans.map((item) => (
              <option key={item.id} value={item.id}>
                {`${item.name} · ${formatNumber(item.gb, lang, 2)} GB · ${formatNumber(item.days, lang)} ${t_day(lang)}`}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <span className="label">{t('plans.pickCustomer')}</span>
          <SearchInput value={search} onChange={setSearch} placeholder={t('plans.searchCustomer')} className="mb-2 w-full" />
          <div className="max-h-[220px] overflow-y-auto rounded-xl border border-white/[0.07] bg-white/[0.015] p-1.5">
            {customers.isLoading ? (
              <div className="space-y-1.5 p-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
            ) : rows.length ? (
              rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setConfigId(String(row.id))}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition',
                    Number(configId) === Number(row.id) ? 'bg-emerald-500/10 ring-1 ring-emerald-400/30' : 'hover:bg-white/[0.04]'
                  )}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-slate-400">
                    <Users className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] text-slate-200">{row.customerName || row.label || row.email}</span>
                    <span className="block truncate text-[9.5px] text-slate-500">
                      {row.groupCount > 1 ? `${t('configs.packageCount', { n: formatNumber(row.groupCount, lang) })} · ` : ''}
                      {row.expiryAt ? `${t('plans.expiresOn')} ${formatDate(row.expiryAt, lang)}` : t('plans.noExpiry')}
                    </span>
                  </span>
                  <Badge tone="slate">{formatNumber(row.totalGb, lang, 2)} GB</Badge>
                </button>
              ))
            ) : (
              <p className="py-3 text-center text-[11px] text-slate-500">{t('plans.noCustomers')}</p>
            )}
          </div>
        </div>

        {preview && chosen ? (
          <>
            <div className={cx(
              'rounded-xl border px-3.5 py-3',
              preview.usable ? 'border-amber-400/25 bg-amber-500/[0.05]' : 'border-rose-400/25 bg-rose-500/[0.06]'
            )}>
              <p className="text-[12px] font-medium text-slate-200">{t('plans.resetTitle')}</p>
              <p className="mt-1 text-[10.5px] leading-5 text-slate-400">
                {preview.usable ? t('plans.resetBody', { name: preview.plan?.name || '', gb: formatNumber(preview.gb, lang, 2), days: formatNumber(preview.days, lang) }) : t('plans.notUsable')}
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
                <p className="text-[10px] uppercase tracking-[0.14em] text-slate-500">{t('plans.now')}</p>
                <div className="mt-1.5 space-y-1 text-[11.5px] text-slate-300">
                  {preview.configs.map((member) => (
                    <div key={member.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-400">{(member.email || '').slice(0, 26) || `#${member.id}`}</span>
                      <span className="shrink-0">{formatNumber(member.usedGb, lang, 2)} / {formatNumber(member.totalGb, lang, 2)} GB</span>
                    </div>
                  ))}
                  <p className="pt-1 text-[10px] text-slate-500">
                    {chosen.expiryAt ? `${t('plans.expiresOn')} ${formatDate(chosen.expiryAt, lang)}` : t('plans.noExpiry')}
                  </p>
                </div>
              </div>
              <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.05] px-3.5 py-3">
                <p className="text-[10px] uppercase tracking-[0.14em] text-emerald-300/70">{t('plans.after')}</p>
                <div className="mt-1.5 space-y-1.5">
                  <PlanNumbers plan={{ gb: preview.gb, days: preview.days }} lang={lang} tone="text-emerald-100" />
                  <p className="text-[10.5px] text-slate-400">{t('plans.usedResets')}</p>
                </div>
              </div>
            </div>

            <QuoteLines quote={quote} lang={lang} t={t} />
          </>
        ) : (
          <p className="text-[11px] leading-5 text-slate-500">{t('plans.renewPickHint')}</p>
        )}
      </div>
    </Modal>
  );
}

function ResellerPlans() {
  const { t, lang } = useI18n();
  const [buyPlan, setBuyPlan] = useState(null);
  const [renewOpen, setRenewOpen] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['plans', 'reseller'],
    queryFn: () => api.get('/reseller/plans'),
  });

  const plans = data?.plans || [];

  if (isLoading) {
    return (
      <>
        <PageHeader title={t('plans.title')} subtitle={t('plans.subtitleReseller')} />
        <div className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-40 w-full" />)}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('plans.title')}
        subtitle={t('plans.subtitleReseller')}
        actions={(
          <>
            <Button variant="secondary" icon={RefreshCw} onClick={() => refetch()} className={cx(isFetching && '[&>svg]:animate-spin')}>{t('common.refresh')}</Button>
            <Button icon={Users} onClick={() => setRenewOpen(true)}>{t('plans.renewTitle')}</Button>
          </>
        )}
      />

      {isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : plans.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => (
            <div key={plan.id} className="card flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-bold text-white">{plan.name}</p>
                  <p className="mt-0.5 text-[9.5px] text-slate-500">{t('plans.sortValue', { n: formatNumber(plan.sort, lang) })} · #{formatNumber(plan.id, lang)}</p>
                </div>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/15 to-cyan-500/10 text-emerald-300">
                  <Layers className="h-4 w-4" />
                </span>
              </div>

              {plan.description ? <p className="text-[11px] leading-5 text-slate-400">{plan.description}</p> : null}

              <PlanNumbers plan={plan} lang={lang} />
              <InboundChips inbounds={plan.inbounds} lang={lang} />

              <div className="mt-auto flex items-end justify-between gap-2 border-t border-white/[0.06] pt-3">
                <div>
                  <p className="text-[9.5px] text-slate-500">{t('plans.price')}</p>
                  {plan.price > 0
                    ? <p className="text-[15px] font-bold text-emerald-300">{formatMoney(plan.price, lang)}</p>
                    : <Badge tone="violet">{t('plans.free')}</Badge>}
                </div>
                <Button size="sm" icon={Boxes} onClick={() => setBuyPlan(plan)}>{t('plans.buy')}</Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <EmptyState icon={Layers} title={t('plans.emptyReseller')} hint={t('plans.emptyResellerHint')} />
        </div>
      )}

      <BuyNewModal open={Boolean(buyPlan)} onClose={() => setBuyPlan(null)} plan={buyPlan} />
      <RenewModal open={renewOpen} onClose={() => setRenewOpen(false)} plans={plans} />
    </>
  );
}

export default function Plans() {
  const { isAdmin } = useAuth();
  return isAdmin ? <AdminPlans /> : <ResellerPlans />;
}
