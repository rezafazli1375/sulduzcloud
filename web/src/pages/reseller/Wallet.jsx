import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CreditCard,
  Info,
  ReceiptText,
  Send,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { translateError, useI18n } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatMoney, formatNumber, relativeTime } from '../../lib/format.js';
import { useToast } from '../../components/feedback.jsx';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Pagination,
  SectionCard,
  StatCard,
  TableSkeleton,
  cx,
} from '../../components/ui.jsx';

// The labels live in the stats namespace (Stats.jsx uses the same ones). Pointing
// at dash.* printed the raw key — «dash.typeCredit» — on every wallet row.
const TYPE_LABEL = {
  credit: 'stats.typeCredit',
  debit: 'stats.typeDebit',
  purchase: 'stats.typePurchase',
  renew: 'stats.typeRenew',
  manual: 'stats.typeManual',
  refund: 'stats.typeRefund',
};

const CREDIT_TYPES = new Set(['credit', 'refund']);

const RECEIPT_TONE = { pending: 'amber', approved: 'emerald', rejected: 'rose' };
const RECEIPT_KEY = { pending: 'wallet.receiptPending', approved: 'wallet.receiptApproved', rejected: 'wallet.receiptRejected' };

/**
 * The reseller's own payment receipts (v1.5.2). He sends them through the
 * Telegram bot; this is where he sees whether the admin approved or rejected
 * one, without having to ask. Only rendered once he has sent at least one.
 */
function MyReceipts({ currency }) {
  const { t, lang } = useI18n();
  const { data } = useQuery({
    queryKey: ['wallet', 'topups'],
    queryFn: () => api.get('/reseller/topups?pageSize=5'),
    refetchInterval: 60000,
  });
  const rows = data?.rows || [];
  if (!rows.length) return null;
  return (
    <SectionCard icon={ReceiptText} title={t('wallet.receipts')} subtitle={t('wallet.receiptsHint')} bodyClass="p-0">
      <div className="divide-y divide-white/[0.05]">
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <Badge tone={RECEIPT_TONE[row.status] || 'slate'} dot>
              {t(RECEIPT_KEY[row.status] || 'wallet.receipts')}
            </Badge>
            <span className="text-[10.5px] text-slate-500">#{row.id}</span>
            <span className="text-[12px] font-semibold text-slate-100" dir="ltr">
              {formatMoney(row.amount, lang, currency)}
            </span>
            <span className="ms-auto text-[10.5px] text-slate-500">{relativeTime(row.createdAt, lang)}</span>
            {row.decisionNote ? (
              <p className="w-full whitespace-pre-line text-[10.5px] leading-5 text-slate-400">{row.decisionNote}</p>
            ) : null}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/**
 * v1.5.3: «افزایش موجودی از طریق ربات تلگرام».
 *
 * The owner asked for one button that carries the reseller into the bot instead
 * of making him search for it and type /start. The link is a /start deep link
 * with the `topup` payload, so Telegram opens THIS chat with this bot and the bot
 * drops him straight into the receipt conversation — the same screen as pressing
 * the «افزایش موجودی» button himself.
 *
 * The link is built from the bot's own getMe username, which the poller caches;
 * with the bot switched off, or before it has introduced itself, the card says so
 * and tells him what to do instead of offering a broken t.me/… URL.
 */
function BotTopup() {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ['wallet', 'bot'],
    queryFn: () => api.get('/reseller/bot'),
    staleTime: 120000,
  });

  const link = data?.link || '';
  const steps = ['wallet.botStep1', 'wallet.botStep2', 'wallet.botStep3', 'wallet.botStep4'];

  return (
    <SectionCard icon={Send} title={t('wallet.botTopup')} subtitle={t('wallet.botTopupHint')}>
      {!data?.enabled ? (
        <p className="text-[11.5px] leading-6 text-slate-400">{t('wallet.botOff')}</p>
      ) : link ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary inline-flex h-9 items-center gap-2 px-4 text-[11.5px]"
            >
              <Send className="h-4 w-4" />
              {t('wallet.botOpen')}
            </a>
            <CopyButton value={link} label={t('wallet.botCopy')} />
            <span className="ms-auto text-[10.5px] text-slate-500" dir="ltr">
              t.me/{data.botName}
            </span>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {steps.map((key, index) => (
              <p
                key={key}
                className="flex items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-[11.5px] leading-6 text-slate-300"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-[10px] font-bold text-emerald-300">
                  {index + 1}
                </span>
                {t(key)}
              </p>
            ))}
          </div>
          <p className="mt-3 text-[10.5px] text-slate-500">{t('wallet.botLive')}</p>
        </>
      ) : (
        <p className="text-[11.5px] leading-6 text-slate-400">{t('wallet.botNoLink')}</p>
      )}
    </SectionCard>
  );
}

/**
 * v1.5.4 — پرداخت واقعی, narrowed by v1.5.5 to the two ways the owner kept.
 *
 * He dropped the prepared بلو link and کارت به کارت as a separate method, so this
 * panel is now: pay online through زرین‌پال, or pay into one of his card numbers
 * and file the receipt. Both rules from 1.5.4 still hold and are the reason the
 * copy is worded the way it is — pressing a button here either opens the bank's
 * own page or files a CLAIM, and only the admin (or the schedule he configured)
 * turns a claim into money, except زرین‌پال, whose server-to-server verify is real
 * proof and credits on its own.
 *
 * A reseller who is told "پرداخت شما ثبت شد" for a receipt he has not sent yet
 * will call the owner; a reseller who is told "در انتظار تایید مدیر" knows what to
 * wait for. The card list moved into this tab for the same reason the bot reads it
 * out (his item 2): a claim without a number to pay into is a guess.
 */
function PayMethods({ currency }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');

  const { data: methods } = useQuery({
    queryKey: ['payments', 'methods'],
    queryFn: () => api.get('/reseller/payments/methods'),
    staleTime: 60000,
  });

  const cards = methods?.cards || [];
  const options = [
    ...(methods?.zarinpal?.enabled ? [{ key: 'zarinpal', label: t('pay.zarinpal'), ready: methods.zarinpal.ready, reason: methods.zarinpal.reason }] : []),
    ...(methods?.receipt?.enabled ? [{ key: 'receipt', label: t('pay.receipt'), ready: methods.receipt.ready }] : []),
  ];

  // Whichever tab is available first becomes the active one, and a tab that
  // disappears (the owner switched off receipts) cannot stay selected.
  const active = options.some((option) => option.key === method) ? method : (options[0]?.key || '');

  const numericAmount = Number(String(amount).replace(/[^\d]/g, '') || 0);

  const claim = useMutation({
    mutationFn: (payload) => api.post('/reseller/payments/claim', payload),
    onSuccess: (data) => {
      toast.success(t('pay.claimedHint', { id: data?.request?.id || '' }), { title: t('pay.claimed') });
      setReference('');
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['payments', 'orders'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err) => toast.error(translateError(err, t), { title: t('common.failed') }),
  });

  const gateway = useMutation({
    mutationFn: () => api.post('/reseller/payments/zarinpal/start', { amount: numericAmount }),
    onSuccess: (data) => {
      // Leaving the SPA is the point: the bank page must not be inside an iframe
      // and the callback is a plain server-rendered page, not a route here.
      if (data?.paymentUrl) window.location.assign(data.paymentUrl);
    },
    onError: (err) => toast.error(translateError(err, t), { title: t('common.failed') }),
  });

  const needAmount = () => {
    if (numericAmount <= 0) {
      toast.warning(t('pay.needAmount'));
      return false;
    }
    return true;
  };

  if (!methods) return null;

  return (
    <SectionCard icon={CreditCard} title={t('pay.title')} subtitle={t('pay.subtitle')}>
      {!options.length ? (
        <p className="text-[11.5px] leading-6 text-slate-400">{t('pay.noneEnabled')}</p>
      ) : (
      <div className="grid gap-3 sm:grid-cols-[minmax(0,240px)_1fr]">
        <Field label={t('pay.amount')} hint={t('pay.amountHint', { currency })}>
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ''))}
            inputMode="text"
            enterKeyHint="done"
            dir="ltr"
            placeholder="100000"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[50000, 100000, 200000, 500000, 1000000].map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => setAmount(String(step))}
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[10.5px] font-semibold text-slate-300 transition hover:border-emerald-400/40 hover:text-white"
                dir="ltr"
              >
                {formatNumber(step, lang)}
              </button>
            ))}
          </div>
        </Field>

        <div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {options.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setMethod(option.key)}
                className={cx(
                  'rounded-xl border px-3 py-1.5 text-[11.5px] font-semibold transition',
                  active === option.key
                    ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200'
                    : 'border-white/[0.08] bg-white/[0.04] text-slate-300 hover:border-emerald-400/30 hover:text-white'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {active === 'zarinpal' ? (
            <div className="space-y-3">
              {options.find((option) => option.key === 'zarinpal')?.ready ? (
                <>
                  <p className="text-[11.5px] leading-6 text-slate-400">{t('pay.zarinpalHint')}</p>
                  <Button variant="primary" onClick={() => { if (needAmount()) gateway.mutate(); }} loading={gateway.isPending}>
                    {t('pay.payNow', { currency })}
                  </Button>
                </>
              ) : (
                <p className="text-[11.5px] leading-6 text-amber-300/90">{t('pay.zarinpalNotReady')}</p>
              )}
            </div>
          ) : null}

          {/*
            v1.5.5: the card numbers belong to the receipt tab, not to a method of
            their own. They are the answer to «کجا واریز کنم؟», so they are shown
            before the claim form and each one can be copied instead of typed.
          */}
          {active === 'receipt' ? (
            <div className="space-y-3">
              <p className="text-[11.5px] leading-6 text-slate-400">{t('pay.receiptHint')}</p>
              {cards.length ? (
                <div>
                  <p className="mb-2 text-[11px] font-semibold text-slate-300">{t('pay.cardsTitle')}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {cards.map((card) => (
                      <div key={card.number} className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
                        <p className="font-mono text-[13px] tracking-wider text-white" dir="ltr">
                          {card.number.replace(/(\d{4})(?=\d)/g, '$1 ')}
                        </p>
                        <p className="mt-1 truncate text-[10.5px] text-slate-400">{card.holder || '—'} · {card.bank || '—'}</p>
                        {card.note ? <p className="mt-0.5 truncate text-[10px] text-slate-500">{card.note}</p> : null}
                        <CopyButton
                          value={card.number}
                          label={t('pay.cardCopy')}
                          iconOnly
                          className="mt-2"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3.5 py-2.5 text-[11px] leading-6 text-amber-100/90">{t('pay.noCards')}</p>
              )}
            </div>
          ) : null}

          {active === 'receipt' ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label={t('pay.reference')} hint={t('pay.referenceHint')}>
                <Input value={reference} onChange={(event) => setReference(event.target.value)} dir="ltr" placeholder="1234567890123" />
              </Field>
              <Field label={t('pay.note')} hint={t('pay.noteHint')}>
                <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('pay.notePlaceholder')} />
              </Field>
              <div className="sm:col-span-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    if (!needAmount()) return;
                    claim.mutate({ amount: numericAmount, method: 'receipt', reference, note });
                  }}
                  loading={claim.isPending}
                >
                  {t('pay.sendClaim')}
                </Button>
                <p className="mt-2 text-[10.5px] leading-5 text-slate-500">{t('pay.pendingAfterClaim')}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      )}

      {claim.data ? (
        <p className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] px-3 py-2 text-[11.5px] leading-6 text-emerald-200">
          {t('pay.claimRecorded', { id: claim.data.request.id, amount: formatNumber(claim.data.request.amount, lang), currency })}
        </p>
      ) : null}
    </SectionCard>
  );
}

export default function Wallet() {
  const { t, lang } = useI18n();
  const { user, meta } = useAuth();
  const [page, setPage] = useState(1);
  const payRef = useRef(null);

  // v1.5.4, item 1: the header button is /wallet?topup=1. The page already
  // renders the payment panel, so all the query has to do is bring it under his
  // eyes instead of leaving him to scroll for it.
  const search = useLocation().search;
  useEffect(() => {
    if (!new URLSearchParams(search).get('topup')) return undefined;
    const node = payRef.current;
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return undefined;
  }, [search]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['wallet', page],
    queryFn: () => api.get(`/reseller/transactions?page=${page}&pageSize=20`),
    placeholderData: (prev) => prev,
  });

  const rows = data?.rows || [];
  const balance = data?.balance ?? user?.balance ?? 0;
  const currency = meta?.billing?.currency || (lang === 'fa' ? 'تومان' : 'Toman');
  const totalIn = rows.filter((row) => CREDIT_TYPES.has(row.type)).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalOut = rows.filter((row) => !CREDIT_TYPES.has(row.type)).reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return (
    <>
      <PageHeader title={t('wallet.title')} subtitle={t('wallet.subtitle')} />

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <div className="card relative overflow-hidden p-5 lg:col-span-1">
          <div className="pointer-events-none absolute -end-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-14 start-6 h-36 w-36 rounded-full bg-cyan-500/10 blur-3xl" />
          <div className="relative">
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 text-[#04120f] shadow-[0_12px_30px_-12px_rgba(16,185,129,.8)]">
                <WalletIcon className="h-5 w-5" />
              </span>
              <Badge tone="emerald" dot>{t('common.active')}</Badge>
            </div>
            <p className="mt-4 text-[11px] font-medium uppercase tracking-wider text-slate-500">{t('wallet.balance')}</p>
            <p className="mt-1.5 text-2xl font-bold tracking-tight text-white">
              {formatMoney(balance, lang, currency)}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-slate-500">
              <Info className="h-3 w-3" />
              {t('wallet.hint')}
            </p>
          </div>
        </div>

        <StatCard
          icon={ArrowDownLeft}
          label={t('wallet.credit')}
          value={formatMoney(totalIn, lang, currency)}
          hint={t('common.page')}
          tone="emerald"
        />
        <StatCard
          icon={ArrowUpRight}
          label={t('wallet.debit')}
          value={formatMoney(totalOut, lang, currency)}
          hint={t('common.page')}
          tone="rose"
        />
      </div>

      {/* v1.5.4: the real payment panel — gateway, بلو link, card numbers, receipt. */}
      <div className="mb-4" ref={payRef}>
        <PayMethods currency={currency} />
      </div>

      {/* v1.5.3: the one button that carries him into the bot's receipt chat. */}
      <div className="mb-4">
        <BotTopup />
      </div>

      <div className="mb-4">
        <MyReceipts currency={currency} />
      </div>

      <SectionCard icon={ReceiptText} title={t('wallet.transactions')} bodyClass="p-0">
        {isLoading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : isError ? (
          <ErrorState message={error?.message} onRetry={refetch} />
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.type')}</th>
                  <th>{t('common.description')}</th>
                  <th>{t('common.amount')}</th>
                  <th>{t('common.balance')}</th>
                  <th>{t('common.date')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const credit = CREDIT_TYPES.has(row.type);
                  return (
                    <tr key={row.id}>
                      <td>
                        <span className={cx(
                          'inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10.5px] font-semibold',
                          credit ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
                        )}>
                          {credit ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                          {TYPE_LABEL[row.type] ? t(TYPE_LABEL[row.type]) : row.type}
                        </span>
                      </td>
                      <td className="max-w-[280px]">
                        <p className="truncate text-[11.5px] text-slate-300">{row.description || '—'}</p>
                      </td>
                      <td className="whitespace-nowrap font-mono text-[11.5px]">
                        <span className={credit ? 'text-emerald-300' : 'text-rose-300'} dir="ltr">
                          {credit ? '+' : '−'}{formatNumber(row.amount, lang)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap font-mono text-[11px] text-slate-400">
                        {formatMoney(row.balanceAfter, lang, currency)}
                      </td>
                      <td className="whitespace-nowrap">
                        <p className="text-[11px] text-slate-300">{formatDate(row.createdAt, lang, true)}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">{relativeTime(row.createdAt, lang)}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={CreditCard}
            title={t('wallet.empty')}
            hint={t('wallet.hint')}
          />
        )}
      </SectionCard>

      {rows.length ? (
        <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
      ) : null}
    </>
  );
}
