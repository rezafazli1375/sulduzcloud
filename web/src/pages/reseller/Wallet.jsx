import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CreditCard,
  Info,
  ReceiptText,
  Wallet as WalletIcon,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatMoney, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SectionCard,
  StatCard,
  TableSkeleton,
  cx,
} from '../../components/ui.jsx';

const TYPE_LABEL = {
  credit: 'dash.typeCredit',
  debit: 'dash.typeDebit',
  purchase: 'dash.typePurchase',
  renew: 'dash.typeRenew',
  manual: 'dash.typeManual',
  refund: 'dash.typeRefund',
};

const CREDIT_TYPES = new Set(['credit', 'refund']);

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
