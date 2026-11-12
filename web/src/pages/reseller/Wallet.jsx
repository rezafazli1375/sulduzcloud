import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { useI18n } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatMoney, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  CopyButton,
  EmptyState,
  ErrorState,
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

export default function Wallet() {
  const { t, lang } = useI18n();
  const { user, meta } = useAuth();
  const [page, setPage] = useState(1);

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
