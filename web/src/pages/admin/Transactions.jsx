import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  FilterX,
  ReceiptText,
  RefreshCw,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, formatMoney, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  TableSkeleton,
  Toolbar,
  cx,
} from '../../components/ui.jsx';

// v2.3.0, item 3: «منوی کناری یک گزینه تراکنش‌ها… کل تراکنش‌های مربوط به خرید و
// تمدید و شارژ و کسر موجودی و جزئیاتشان اینجا ثبت شه، با دو فیلتر».
// The ledger has always been written; this is the first place that reads all of it.
// The five types are the ones the server actually writes (utils.TX_TYPES) — a
// label for a type that cannot exist would be a filter that always answers empty.
const TYPES = ['credit', 'debit', 'purchase', 'renew', 'commission'];
const TYPE_LABEL = {
  credit: 'stats.typeCredit',
  debit: 'stats.typeDebit',
  purchase: 'stats.typePurchase',
  renew: 'stats.typeRenew',
  commission: 'stats.typeCommission',
};
const TYPE_TONE = {
  credit: 'emerald',
  debit: 'rose',
  purchase: 'violet',
  renew: 'cyan',
  commission: 'amber',
};

/** One money line: sign and colour come from `direction`, never from the number. */
function TxAmount({ row, lang, size = 'sm' }) {
  const credit = row.direction === 'in';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 font-semibold tabular-nums',
        size === 'base' ? 'text-[13px]' : 'text-[11.5px]',
        credit ? 'text-emerald-300' : 'text-rose-300'
      )}
      dir="ltr"
    >
      {credit ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
      {credit ? '+' : '−'}{formatNumber(row.magnitude, lang)}
    </span>
  );
}

export default function Transactions() {
  const { t, lang } = useI18n();
  const { meta } = useAuth();
  const [userId, setUserId] = useState('');
  const [type, setType] = useState('');
  const [direction, setDirection] = useState('');
  const [page, setPage] = useState(1);

  const currency = meta?.billing?.currency || (lang === 'fa' ? 'تومان' : 'Toman');

  useEffect(() => { setPage(1); }, [userId, type, direction]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'transactions', userId, type, direction, page],
    queryFn: () => {
      const query = new URLSearchParams({ page: String(page), pageSize: '30' });
      if (userId) query.set('userId', userId);
      if (type) query.set('type', type);
      if (direction) query.set('direction', direction);
      return api.get(`/admin/transactions?${query.toString()}`);
    },
    placeholderData: (prev) => prev,
    refetchInterval: 60000,
  });

  const rows = data?.rows || [];
  const actors = data?.actors || [];
  const sums = data?.sums || { in: 0, out: 0 };
  const byType = data?.byType || {};
  const hasFilters = Boolean(userId || type || direction);
  const reset = () => { setUserId(''); setType(''); setDirection(''); };
  // Lines that left a wallet below zero (v2.3.0 debt). The server counts them over
  // the whole filtered set, so the card does not change when you turn the page.
  const debtRows = Number(data?.debt || 0);

  return (
    <>
      <PageHeader
        title={t('transactions.title')}
        subtitle={t('transactions.subtitle')}
        actions={(
          <Button
            variant="secondary"
            icon={RefreshCw}
            className={isFetching ? 'opacity-60' : ''}
            onClick={() => refetch()}
          >
            {t('common.refresh')}
          </Button>
        )}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          icon={ArrowDownLeft}
          label={t('transactions.sumIn')}
          value={formatMoney(sums.in || 0, lang, currency)}
          hint={`${formatNumber(sums.countIn || 0, lang)} ${t('transactions.rows')}`}
          tone="emerald"
        />
        <StatCard
          icon={ArrowUpRight}
          label={t('transactions.sumOut')}
          value={formatMoney(sums.out || 0, lang, currency)}
          hint={`${formatNumber(sums.countOut || 0, lang)} ${t('transactions.rows')}`}
          tone="rose"
        />
        <StatCard
          icon={ReceiptText}
          label={t('transactions.totalLabel')}
          value={formatNumber(data?.total || 0, lang)}
          hint={hasFilters ? t('transactions.filtered') : t('transactions.unfiltered')}
          tone="cyan"
        />
        <StatCard
          icon={AlertTriangle}
          label={t('transactions.debtRows')}
          value={formatNumber(debtRows, lang)}
          hint={t('transactions.debtHint')}
          tone={debtRows > 0 ? 'rose' : 'cyan'}
        />
      </div>

      <Toolbar>
        {/* The reseller dropdown is built from the ledger itself, so it only ever
            lists people who actually have a money line — and it needs no extra
            permission. */}
        <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-auto min-w-[190px]">
          <option value="">{t('transactions.allResellers')}</option>
          {actors.map((actor) => (
            <option key={actor.id} value={String(actor.id)}>
              {actor.username || `#${actor.id}`} ({formatNumber(actor.count, lang)})
            </option>
          ))}
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-auto min-w-[160px]">
          <option value="">{t('transactions.allTypes')}</option>
          {TYPES.map((item) => (
            <option key={item} value={item}>
              {t(TYPE_LABEL[item])}{byType[item] ? ` (${formatNumber(byType[item].count, lang)})` : ''}
            </option>
          ))}
        </Select>
        <Select value={direction} onChange={(e) => setDirection(e.target.value)} className="w-auto min-w-[150px]">
          <option value="">{t('transactions.directionAll')}</option>
          <option value="in">{t('transactions.directionIn')}</option>
          <option value="out">{t('transactions.directionOut')}</option>
        </Select>
        {hasFilters ? (
          <Button variant="ghost" size="sm" icon={FilterX} onClick={reset}>{t('common.reset')}</Button>
        ) : null}
        <span className="ms-auto text-[11px] text-slate-500">
          {t('common.total')}: {formatNumber(data?.total || 0, lang)}
        </span>
      </Toolbar>

      {isLoading ? (
        <div className="table-wrap"><TableSkeleton rows={8} cols={6} /></div>
      ) : isError ? (
        <div className="table-wrap"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : rows.length ? (
        <>
          {/* Desktop: the whole line, including who made it. */}
          <div className="table-wrap hidden md:block">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.username')}</th>
                    <th>{t('transactions.type')}</th>
                    <th>{t('common.amount')}</th>
                    <th>{t('transactions.balanceAfter')}</th>
                    <th>{t('transactions.description')}</th>
                    <th>{t('transactions.actor')}</th>
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
                        <Link to="/resellers" className="text-[11.5px] font-medium text-slate-200 hover:text-emerald-200">
                          {row.username}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap">
                        <Badge tone={TYPE_TONE[row.type] || 'slate'}>{t(TYPE_LABEL[row.type] || 'transactions.type')}</Badge>
                      </td>
                      <td className="whitespace-nowrap"><TxAmount row={row} lang={lang} /></td>
                      <td
                        className={cx('whitespace-nowrap text-[11px]', Number(row.balanceAfter) < 0 ? 'font-semibold text-rose-300' : 'text-slate-400')}
                        dir="ltr"
                      >
                        {formatMoney(row.balanceAfter, lang, currency)}
                        {Number(row.balanceAfter) < 0 ? ` ${t('common.debt')}` : ''}
                      </td>
                      <td className="max-w-[320px]">
                        <p className="truncate text-[11px] text-slate-300" title={row.description || ''}>{row.description || '—'}</p>
                      </td>
                      <td className="whitespace-nowrap text-[10.5px] text-slate-500">
                        {row.createdByName || t('transactions.bySystem')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phone: the same rows, two lines each, nothing cut off. */}
          <div className="space-y-2 md:hidden">
            {rows.map((row) => (
              <div key={row.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TYPE_TONE[row.type] || 'slate'}>{t(TYPE_LABEL[row.type] || 'transactions.type')}</Badge>
                  <Link to="/resellers" className="min-w-0 truncate text-[12px] font-semibold text-slate-100">{row.username}</Link>
                  <span className="ms-auto"><TxAmount row={row} lang={lang} size="base" /></span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-400">{row.description || '—'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                  <span>{formatDate(row.createdAt, lang, true)}</span>
                  <span>·</span>
                  <span className={Number(row.balanceAfter) < 0 ? 'font-semibold text-rose-300' : ''} dir="ltr">
                    {t('transactions.balanceAfter')}: {formatMoney(row.balanceAfter, lang, currency)}
                  </span>
                  <span>·</span>
                  <span>{row.createdByName || t('transactions.bySystem')}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-3">
            <Pagination page={Number(data?.page) || 1} pageSize={Number(data?.pageSize) || 30} total={Number(data?.total) || 0} onChange={setPage} />
          </div>
        </>
      ) : (
        <EmptyState
          icon={ReceiptText}
          title={t('transactions.empty')}
          hint={hasFilters ? t('transactions.emptyFiltered') : t('transactions.emptyHint')}
          action={hasFilters ? (
            <Button size="sm" variant="secondary" icon={FilterX} onClick={reset}>{t('common.reset')}</Button>
          ) : null}
        />
      )}
    </>
  );
}
