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

const CONFIG_TX_TYPES = new Set(['purchase', 'renew', 'commission']);
const RAW_UUID = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i;
const COMPACT_UUID = /^[0-9a-f]{32}$/i;
const CONFIG_URI = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const MAX_TX_INBOUNDS = 2;

// Imported x-ui clients can use a UUID as their email/remark. Keep identifiers
// and subscription links out of the ledger instead of exposing those tokens.
function safeConfigText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || RAW_UUID.test(text) || COMPACT_UUID.test(text) || CONFIG_URI.test(text)) return '';
  return text;
}

function txConfigId(row) {
  if (!CONFIG_TX_TYPES.has(row?.type) || !row?.config || typeof row.config !== 'object' || Array.isArray(row.config)) return null;
  const id = Number(row.configId ?? row.config.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function txInboundSummary(inbound, lang) {
  const remark = safeConfigText(inbound?.remark);
  const protocol = safeConfigText(inbound?.protocol);
  const nodeName = safeConfigText(inbound?.nodeName);
  const port = Number(inbound?.port);
  const portLabel = Number.isInteger(port) && port > 0 && port <= 65535
    ? `:${formatNumber(port, lang)}`
    : '';
  return [remark, protocol, portLabel, nodeName].filter(Boolean).join(' · ');
}

/** Historical package details attached to a purchase, renewal or commission. */
function TxConfig({ row, mobile = false }) {
  const { t, lang } = useI18n();
  const configId = txConfigId(row);
  if (configId === null) return null;

  const config = row.config;
  const identities = [config.customerName, config.label, config.email]
    .map(safeConfigText)
    .filter((value, index, list) => value && list.indexOf(value) === index);
  const identity = identities[0] || t('common.unknown');
  const secondaryIdentity = identities.slice(1).join(' · ');
  const description = safeConfigText(row.description);
  const summaries = (Array.isArray(config.inbounds) ? config.inbounds : [])
    .map((inbound) => txInboundSummary(inbound, lang))
    .filter(Boolean);
  const shownInbounds = summaries.slice(0, MAX_TX_INBOUNDS);
  const hiddenInbounds = summaries.length - shownInbounds.length;
  const textClass = mobile ? 'line-clamp-2 break-words leading-4' : 'truncate';

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10.5px] font-semibold text-cyan-200" dir="auto">
          {t('transactions.configNumber', { id: formatNumber(configId, lang) })}
        </span>
        {config.deleted === true || config.deleted === 1 ? (
          <Badge tone="rose" className="px-1.5 py-0 text-[9px]">{t('transactions.deletedPackage')}</Badge>
        ) : null}
      </div>
      <p className={cx('text-[11px] font-medium text-slate-200', textClass)} dir="auto" title={identity}>
        {identity}
      </p>
      {secondaryIdentity ? (
        <p className={cx('text-[10px] text-slate-500', textClass)} dir="auto" title={secondaryIdentity}>
          {secondaryIdentity}
        </p>
      ) : null}
      {shownInbounds.length ? (
        <ul className="space-y-0.5" aria-label={t('common.inbounds')}>
          {shownInbounds.map((summary, index) => (
            <li key={index} className={cx('text-[10px] text-slate-400', textClass)} dir="auto" title={summary}>
              {summary}
            </li>
          ))}
          {hiddenInbounds > 0 ? (
            <li className="text-[9.5px] text-slate-500">
              {t('transactions.moreInbounds', { n: formatNumber(hiddenInbounds, lang) })}
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="text-[10px] leading-4 text-slate-500">{t('transactions.noInboundDetails')}</p>
      )}
      {description ? (
        <p className={cx('text-[10px] text-slate-500', textClass)} dir="auto" title={description}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

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
                        {txConfigId(row) === null ? (
                          <p className="truncate text-[11px] text-slate-300" title={row.description || ''}>{row.description || '—'}</p>
                        ) : (
                          <TxConfig row={row} />
                        )}
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
                {txConfigId(row) === null ? (
                  <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-400">{row.description || '—'}</p>
                ) : (
                  <div className="mt-1"><TxConfig row={row} mobile /></div>
                )}
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
