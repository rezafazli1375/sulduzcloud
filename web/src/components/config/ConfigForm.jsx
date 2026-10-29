import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Boxes, Check, Clock, CreditCard, Globe2, Info, Network, Server, UserRound, Wallet } from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatBytes, formatMoney, formatNumber } from '../../lib/format.js';
import { nodeLabel } from '../../lib/nodes.js';
import { Badge, Button, Checkbox, Field, Input, Modal, Select, Skeleton, Textarea, cx } from '../ui.jsx';
import { useToast } from '../feedback.jsx';

function InboundPicker({ rows, value, onToggle, lang, t, gb = 0, days = 0, currency = '' }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const node = row.nodeName || 'local';
      const key = row.serverName ? `${row.serverName} · ${node}` : node;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()];
  }, [rows]);

  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-4 py-8 text-center text-[12px] text-slate-500">
        {t('inbounds.empty')}
      </div>
    );
  }

  return (
    <div className="max-h-[330px] space-y-3 overflow-y-auto rounded-xl border border-white/[0.07] bg-white/[0.015] p-2.5">
      {grouped.map(([node, list]) => (
        <div key={node}>
          <div className="mb-1.5 flex items-center gap-1.5 px-1">
            <Server className="h-3 w-3 text-slate-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{nodeLabel(node, lang)}</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {list.map((row) => {
              const selected = value.includes(row.id);
              const rowBase = Number(row.priceFixed || 0)
                + Number(row.pricePerGb || 0) * Number(gb || 0)
                + Number(row.pricePerDay || 0) * Number(days || 0);
              const rowPrice = Math.round(rowBase * (1 - Math.min(100, Math.max(0, Number(row.discountPercent || 0))) / 100));
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onToggle(row.id)}
                  className={cx(
                    'group flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-start transition-all duration-200',
                    selected
                      ? 'border-emerald-400/40 bg-emerald-500/[0.09] shadow-[inset_0_0_0_1px_rgba(16,185,129,.15)]'
                      : 'border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]'
                  )}
                >
                  <span
                    className={cx(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition',
                      selected ? 'border-emerald-400/60 bg-emerald-500 text-[#04120f]' : 'border-white/15 bg-white/[0.03]'
                    )}
                  >
                    {selected ? <Check className="h-3 w-3" strokeWidth={3.5} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[11.5px] font-medium text-slate-200">{row.remark || `#${row.id}`}</span>
                      {row.visible === false ? <Badge tone="slate" className="px-1.5 py-0 text-[9px]">{t('common.hidden')}</Badge> : null}
                      {Number(row.discountPercent) > 0 ? (
                        <Badge tone="emerald" className="px-1.5 py-0 text-[9px]">{formatNumber(row.discountPercent, lang)}%</Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-1.5 text-[9.5px] text-slate-500">
                      <span className="truncate">
                        {row.protocol}{row.network ? ` · ${row.network}` : ''} · :{row.port}
                      </span>
                      {rowPrice > 0 ? (
                        <span className="shrink-0 font-semibold text-emerald-300/90">{formatMoney(rowPrice, lang, currency)}</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ConfigForm({ open, onClose, onCreated, resellerId }) {
  const { t, lang } = useI18n();
  const { isAdmin, can, meta, user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const billing = Boolean(meta?.billing?.enabled);

  const [form, setForm] = useState({
    userId: resellerId || '',
    inboundIds: [],
    gb: 30,
    days: 30,
    unlimited: false,
    label: '',
    customerName: '',
    customerPhone: '',
    note: '',
  });
  // Unlimited is an admin-only option; resellers always get a metered quota.
  const isUnlimited = isAdmin && form.unlimited;

  useEffect(() => {
    if (!open) return;
    setForm((prev) => ({ ...prev, userId: resellerId || prev.userId || '' }));
  }, [open, resellerId]);

  const usersQuery = useQuery({
    queryKey: ['admin', 'users', 'picker'],
    queryFn: () => api.get('/admin/users?pageSize=200&role=reseller'),
    enabled: open && isAdmin,
  });

  const inboundsQuery = useQuery({
    queryKey: ['inbounds', 'picker', isAdmin ? `admin:${form.userId || 0}` : 'reseller'],
    queryFn: () => api.get(isAdmin ? `/admin/inbounds${form.userId ? `?userId=${form.userId}` : ''}` : '/reseller/inbounds'),
    enabled: open,
  });

  const quoteReady = billing && open && form.inboundIds.length > 0 && Number(form.days) > 0 && (!isAdmin || Boolean(form.userId));
  const quoteQuery = useQuery({
    queryKey: [
      'quote',
      isAdmin ? 'admin' : 'reseller',
      isAdmin ? String(form.userId || '') : 'self',
      [...form.inboundIds].sort((a, b) => a - b).join(','),
      isUnlimited ? 0 : Number(form.gb || 0),
      Number(form.days || 0),
    ],
    queryFn: () => api.post(isAdmin ? '/admin/pricing/quote' : '/reseller/configs/quote', {
      userId: isAdmin ? Number(form.userId) : undefined,
      inboundIds: form.inboundIds,
      gb: isUnlimited ? 0 : Number(form.gb || 0),
      days: Number(form.days || 0),
      unlimited: isUnlimited,
    }),
    enabled: quoteReady,
    staleTime: 15000,
    retry: false,
  });

  const inbounds = (inboundsQuery.data?.rows || []).filter((row) => row.enabled && (isAdmin || row.visible));
  const resellers = usersQuery.data?.rows || [];
  const selectedUser = resellers.find((row) => String(row.id) === String(form.userId));
  const limits = selectedUser?.limits || inboundsQuery.data?.limits || {};

  const selectedInbounds = inbounds.filter((row) => form.inboundIds.includes(row.id));
  const crossServer = new Set(selectedInbounds.map((row) => row.serverId || 0)).size > 1;
  const fallbackPrice = selectedInbounds.reduce(
    (max, row) => Math.max(
      max,
      Math.round(
        (Number(row.priceFixed || 0)
          + Number(row.pricePerGb || 0) * (isUnlimited ? 0 : Number(form.gb || 0))
          + Number(row.pricePerDay || 0) * Number(form.days || 0))
        * (1 - Math.min(100, Math.max(0, Number(row.discountPercent || 0))) / 100)
      )
    ),
    0
  );
  const quote = quoteQuery.data;
  const baseTotal = quote ? Number(quote.subtotal || 0) : fallbackPrice;
  const discountTotal = quote ? Number(quote.discountTotal || 0) : 0;
  const totalPrice = quote ? Number(quote.total || 0) : fallbackPrice;
  const currency = meta?.billing?.currency || quote?.currency || '';
  const balance = Number(quote?.balance ?? (isAdmin ? selectedUser?.balance ?? 0 : user?.balance ?? 0));
  const insufficient = quote ? quote.sufficient === false : billing && totalPrice > 0 && balance < totalPrice;

  const create = useMutation({
    mutationFn: (payload) => api.post(isAdmin ? '/admin/configs' : '/reseller/configs', payload),
    onSuccess: (data) => {
      toast.success(t('common.created'));
      queryClient.invalidateQueries({ queryKey: ['configs'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
      queryClient.invalidateQueries({ queryKey: ['reseller', 'overview'] });
      queryClient.invalidateQueries({ queryKey: ['inbounds'] });
      const created = data?.configs || [];
      onClose?.();
      onCreated?.(created);
      setForm((prev) => ({ ...prev, inboundIds: [], label: '', customerName: '', customerPhone: '', note: '' }));
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const toggleInbound = (id) => {
    setForm((prev) => ({
      ...prev,
      inboundIds: prev.inboundIds.includes(id) ? prev.inboundIds.filter((value) => value !== id) : [...prev.inboundIds, id],
    }));
  };

  const submit = (event) => {
    event.preventDefault();
    if (isAdmin && !form.userId) {
      toast.error(t('configs.form.reseller'));
      return;
    }
    if (!form.inboundIds.length) {
      toast.error(t('configs.form.inbound'));
      return;
    }
    if (crossServer) {
      toast.error(t('configs.form.serverMismatch'));
      return;
    }
    if (!isUnlimited && Number(form.gb) <= 0) {
      toast.error(t('configs.form.gb'));
      return;
    }
    if (Number(form.days) <= 0) {
      toast.error(t('configs.form.days'));
      return;
    }
    create.mutate({
      userId: isAdmin ? Number(form.userId) : undefined,
      inboundIds: form.inboundIds,
      gb: isUnlimited ? 0 : Number(form.gb),
      days: Number(form.days),
      unlimited: isUnlimited,
      label: form.label.trim(),
      customerName: form.customerName.trim(),
      customerPhone: form.customerPhone.trim(),
      note: form.note.trim(),
    });
  };

  const limitGb = Number(limits.maxGbPerConfig || 0);
  const limitDays = Number(limits.maxDaysPerConfig || 0);
  const overGb = limitGb > 0 && Number(form.gb) > limitGb && !isUnlimited;
  const overDays = limitDays > 0 && Number(form.days) > limitDays;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('configs.new')}
      subtitle={t('configs.newHint')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={submit} loading={create.isPending} icon={Boxes} disabled={insufficient || crossServer || create.isPending}>
            {create.isPending ? t('configs.form.creating') : t('configs.form.submit')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {isAdmin ? (
            <Field label={t('configs.form.reseller')} required>
              {usersQuery.isLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <Select value={form.userId} onChange={(e) => setForm((prev) => ({ ...prev, userId: e.target.value }))} required>
                  <option value="">{t('common.select')}</option>
                  {resellers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name ? `${row.name} (@${row.username})` : `@${row.username}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field label={t('configs.form.label')}>
              <Input value={form.label} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} placeholder={t('configs.form.labelPlaceholder')} />
            </Field>
          )}

          <Field label={t('configs.form.customerName')}>
            <Input value={form.customerName} onChange={(e) => setForm((prev) => ({ ...prev, customerName: e.target.value }))} placeholder="—" />
          </Field>

          <Field label={t('configs.form.customerPhone')}>
            <Input value={form.customerPhone} onChange={(e) => setForm((prev) => ({ ...prev, customerPhone: e.target.value }))} placeholder="09..." dir="ltr" />
          </Field>

          {isAdmin ? (
            <Field label={t('configs.form.label')}>
              <Input value={form.label} onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))} placeholder={t('configs.form.labelPlaceholder')} />
            </Field>
          ) : (
            <Field label={t('configs.form.days')} hint={limitDays ? `${t('common.total')}: ${formatNumber(limitDays, lang)} ${t('common.days')}` : t('resellers.form.zeroHint')}>
              <Input type="number" min={1} value={form.days} onChange={(e) => setForm((prev) => ({ ...prev, days: e.target.value }))} />
            </Field>
          )}
        </div>

        <div className={cx('grid gap-4', isAdmin ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
          {isAdmin ? (
            <>
              <Field label={t('configs.form.gb')} hint={limitGb ? `${t('common.total')}: ${formatNumber(limitGb, lang)} GB` : t('resellers.form.zeroHint')}>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={isUnlimited ? 0 : form.gb}
                  disabled={isUnlimited}
                  onChange={(e) => setForm((prev) => ({ ...prev, gb: e.target.value }))}
                />
              </Field>
              <Field label={t('configs.form.days')}>
                <Input type="number" min={1} value={form.days} onChange={(e) => setForm((prev) => ({ ...prev, days: e.target.value }))} />
              </Field>
            </>
          ) : (
            <Field label={t('configs.form.gb')} hint={limitGb ? `${t('common.total')}: ${formatNumber(limitGb, lang)} GB` : t('resellers.form.zeroHint')}>
              <Input
                type="number"
                min={0}
                step="0.5"
                value={isUnlimited ? 0 : form.gb}
                disabled={isUnlimited}
                onChange={(e) => setForm((prev) => ({ ...prev, gb: e.target.value }))}
              />
            </Field>
          )}
          {isAdmin ? (
            <div className="flex items-end pb-2.5">
              <Checkbox checked={form.unlimited} onChange={(value) => setForm((prev) => ({ ...prev, unlimited: value }))} label={t('common.unlimited')} />
            </div>
          ) : null}
        </div>

        {overGb || overDays ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-500/[0.07] px-3 py-2.5 text-[11.5px] text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {overGb ? `${t('errors.limitGb')} (${formatNumber(limitGb, lang)} GB)` : ''}
              {overGb && overDays ? ' · ' : ''}
              {overDays ? `${t('errors.limitDays')} (${formatNumber(limitDays, lang)})` : ''}
            </span>
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label mb-0">{t('configs.form.inbound')} <span className="text-rose-400">*</span></span>
            <span className="text-[10px] text-slate-500">{formatNumber(form.inboundIds.length, lang)} {t('common.select')}</span>
          </div>
          {inboundsQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <InboundPicker
              rows={inbounds}
              value={form.inboundIds}
              onToggle={toggleInbound}
              lang={lang}
              t={t}
              gb={isUnlimited ? 0 : Number(form.gb || 0)}
              days={Number(form.days || 0)}
              currency={currency}
            />
          )}
          <p className="mt-1.5 text-[10.5px] text-slate-500">{t('configs.form.inboundHint')}</p>
          {crossServer ? (
            <p className="mt-1 text-[10px] leading-5 text-rose-300">{t('configs.form.crossServerWarn')}</p>
          ) : null}
          {form.inboundIds.length > 1 ? (
            <p className="mt-1 text-[10px] leading-5 text-emerald-200/70">{t('configs.form.multiHint')}</p>
          ) : null}
        </div>

        <Field label={t('configs.form.note')}>
          <Textarea rows={2} value={form.note} onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))} placeholder={t('common.optional')} />
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-gradient-to-r from-emerald-500/[0.06] to-cyan-500/[0.03] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] text-slate-500">{discountTotal > 0 ? t('configs.form.netTotal') : t('configs.form.totalPrice')}</p>
            <p className="mt-0.5 text-base font-bold text-emerald-300">
              {formatMoney(totalPrice, lang, currency)}
            </p>
            {discountTotal > 0 ? (
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
                <span className="text-slate-500 line-through">{formatMoney(baseTotal, lang, currency)}</span>
                <span className="text-emerald-300/90">
                  {t('configs.form.discount')}: {formatMoney(discountTotal, lang, currency)}
                </span>
              </p>
            ) : null}
            <p className="text-[9.5px] text-slate-600">
              {!billing ? t('configs.form.billingOff') : discountTotal > 0 ? t('configs.form.discountApplied') : t('configs.form.priceHint')}
            </p>
          </div>
          <div className="text-end">
            <p className="text-[10px] text-slate-500">{billing ? t('configs.form.balanceAfter') : t('common.balance')}</p>
            <p className={cx('text-[12.5px] font-semibold', insufficient ? 'text-rose-300' : 'text-slate-200')}>
              {formatMoney(billing ? balance - totalPrice : balance, lang, currency)}
            </p>
            <p className="text-[9.5px] text-slate-600">
              {isAdmin && selectedUser ? selectedUser.name || `@${selectedUser.username}` : t('wallet.balance')}
            </p>
          </div>
        </div>
      </form>
    </Modal>
  );
}
