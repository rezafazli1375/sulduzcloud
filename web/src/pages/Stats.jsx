import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Boxes,
  CalendarClock,
  CircleDollarSign,
  Download,
  Gauge,
  Globe2,
  Network,
  Receipt,
  TrendingUp,
  Users,
  Wifi,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { api, downloadFile } from '../lib/api.js';
import { formatBytes, formatDate, formatMoney, formatNumber } from '../lib/format.js';
import { nodeLabel } from '../lib/nodes.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  SectionCard,
  Select,
  Skeleton,
  StatCard,
  Tabs,
  cx,
} from '../components/ui.jsx';
import { LegendDots, RevenueBars, StatusDonut, TrafficChart } from '../components/charts.jsx';

const RANGES = [7, 30, 90];

const TX_LABEL = {
  credit: 'stats.typeCredit',
  debit: 'stats.typeDebit',
  purchase: 'stats.typePurchase',
  renew: 'stats.typeRenew',
  manual: 'stats.typeManual',
  refund: 'stats.typeRefund',
};

function AdminStats() {
  const { t, lang } = useI18n();
  const { meta } = useAuth();
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const currency = meta?.billing?.currency || '';

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['admin', 'stats', days],
    queryFn: () => api.get(`/admin/stats?days=${days}`),
  });

  const tx = useQuery({
    queryKey: ['admin', 'transactions', page],
    queryFn: () => api.get(`/admin/transactions?page=${page}&pageSize=20`),
  });

  const overview = data?.overview || {};
  const configs = overview.configs || {};
  const revenue = overview.revenue || {};

  const donut = useMemo(() => [
    { name: t('common.active'), value: configs.active || 0, color: '#10b981' },
    { name: t('common.expired'), value: configs.expired || 0, color: '#f59e0b' },
    { name: t('common.depleted'), value: configs.depleted || 0, color: '#f43f5e' },
    { name: t('common.disabled'), value: configs.disabled || 0, color: '#64748b' },
  ], [configs, t]);

  return (
    <>
      <PageHeader
        title={t('stats.title')}
        subtitle={t('stats.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={Download} onClick={() => downloadFile('/admin/configs/export.csv', 'configs.csv')}>{t('stats.exportHint')}</Button>
            <Tabs tabs={RANGES.map((value) => ({ value: String(value), label: t(`stats.days${value}`) }))} active={String(days)} onChange={(value) => { setDays(Number(value)); setPage(1); }} />
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard icon={Boxes} label={t('dash.kpiConfigs')} value={formatNumber(configs.total, lang)} hint={`${formatNumber(configs.active, lang)} ${t('common.active')}`} tone="emerald" />
        <StatCard icon={TrendingUp} label={t('common.month')} value={formatBytes(overview.month?.total, lang, { digits: 1 })} hint={`${t('dash.kpiTrafficToday')}: ${formatBytes(overview.today?.total, lang)}`} tone="cyan" />
        <StatCard icon={CircleDollarSign} label={t('stats.totalSpent')} value={formatMoney(revenue.spent || 0, lang, currency)} hint={`${formatNumber(revenue.transactions, lang)} ${t('stats.txCount')}`} tone="violet" />
        <StatCard icon={CalendarClock} label={t('dash.kpiExpiring')} value={formatNumber(overview.expiring3d, lang)} hint={t('common.days')} tone="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard className="xl:col-span-2" title={t('stats.usageChart')} icon={Activity} bodyClass="px-2 pb-3 pt-4 sm:px-4">
          {isLoading ? <Skeleton className="h-[260px] w-full" /> : <TrafficChart data={data?.series || []} height={260} />}
        </SectionCard>
        <SectionCard title={t('dash.kpiConfigs')} icon={Gauge}>
          <StatusDonut items={donut} height={190} />
          <div className="mt-2 grid grid-cols-2 gap-2">
            {donut.map((item) => (
              <div key={item.name} className="flex items-center justify-between rounded-lg bg-white/[0.025] px-2.5 py-1.5">
                <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400"><i className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />{item.name}</span>
                <span className="text-[11px] font-semibold text-slate-200">{formatNumber(item.value, lang)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('stats.revenue')} subtitle={`${formatNumber(days, lang)} ${t('common.days')}`} icon={Receipt} bodyClass="px-2 pb-3 pt-4 sm:px-4">
          {isLoading ? <Skeleton className="h-[220px] w-full" /> : <RevenueBars data={(data?.revenue || []).map((row) => ({ day: row.day, amount: row.type === 'debit' || row.type === 'purchase' ? row.amount : row.amount, type: row.type }))} height={220} />}
        </SectionCard>
        <SectionCard title={t('stats.inbounds')} icon={Network} bodyClass="p-0">
          <div className="max-h-[280px] overflow-y-auto">
            {(data?.inbounds || []).map((row) => (
              <div key={row.id} className="flex items-center gap-2.5 border-b border-white/[0.04] px-4 py-2.5 last:border-0">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400"><Wifi className="h-3.5 w-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11.5px] text-slate-200">{row.remark || `#${row.id}`}</p>
                  <p className="truncate text-[9.5px] text-slate-500">{nodeLabel(row.nodeName, lang)} · {row.protocol}</p>
                </div>
                <div className="text-end">
                  <p className="text-[11px] font-semibold text-slate-200">{formatNumber(row.configs, lang)}</p>
                  <p className="text-[9px] text-slate-500">{formatBytes(row.usedBytes, lang)}</p>
                </div>
              </div>
            ))}
            {!(data?.inbounds || []).length && !isLoading ? <EmptyState icon={Network} title={t('common.noData')} className="py-8" /> : null}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('stats.topUsers')} icon={Users} bodyClass="p-0">
          <div className="max-h-[320px] overflow-y-auto">
            {(data?.topUsers || []).map((row, index) => (
              <div key={row.id} className="flex items-center gap-2.5 border-b border-white/[0.04] px-4 py-2.5 last:border-0">
                <span className="w-4 text-center text-[10px] font-bold text-slate-600">{formatNumber(index + 1, 'en')}</span>
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 text-[10px] font-bold text-emerald-300">
                  {(row.name || row.username || '?').charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11.5px] text-slate-200">{row.name || row.username}</p>
                  <p className="truncate text-[9.5px] text-slate-500">@{row.username}</p>
                </div>
                <span className="text-[10.5px] font-semibold text-slate-300">{formatBytes(row.usedBytes, lang)}</span>
              </div>
            ))}
            {!(data?.topUsers || []).length && !isLoading ? <EmptyState icon={Users} title={t('common.noData')} className="py-8" /> : null}
          </div>
        </SectionCard>
        <SectionCard title={t('stats.topConfigs')} icon={Boxes} bodyClass="p-0">
          <div className="max-h-[320px] overflow-y-auto">
            {(data?.topConfigs || []).map((row, index) => (
              <div key={row.id} className="flex items-center gap-2.5 border-b border-white/[0.04] px-4 py-2.5 last:border-0">
                <span className="w-4 text-center text-[10px] font-bold text-slate-600">{formatNumber(index + 1, 'en')}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11.5px] text-slate-200">{row.label || row.customerName || row.email}</p>
                  <p className="truncate font-mono text-[9px] text-slate-500" dir="ltr">{row.email}</p>
                </div>
                <span className="text-[10.5px] font-semibold text-slate-300">{formatBytes(row.usedBytes, lang)}</span>
              </div>
            ))}
            {!(data?.topConfigs || []).length && !isLoading ? <EmptyState icon={Boxes} title={t('common.noData')} className="py-8" /> : null}
          </div>
        </SectionCard>
      </div>

      <SectionCard className="mt-4" title={t('stats.transactions')} icon={Receipt} bodyClass="p-0">
        {tx.data?.rows?.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('common.username')}</th>
                    <th>{t('common.type')}</th>
                    <th>{t('common.amount')}</th>
                    <th>{t('common.balance')}</th>
                    <th>{t('common.description')}</th>
                    <th>{t('common.date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tx.data.rows.map((row) => (
                    <tr key={row.id}>
                      <td className="text-[11.5px] text-slate-300">@{row.username || '—'}</td>
                      <td><Badge tone={row.amount > 0 ? 'emerald' : 'rose'}>{t(TX_LABEL[row.type] || 'stats.typeManual')}</Badge></td>
                      <td className={cx('text-[11.5px] font-semibold', row.amount > 0 ? 'text-emerald-300' : 'text-rose-300')}>
                        {row.amount > 0 ? '+' : ''}{formatNumber(row.amount, lang)}
                      </td>
                      <td className="text-[11px] text-slate-400">{formatNumber(row.balanceAfter, lang)}</td>
                      <td className="max-w-[240px] truncate text-[11px] text-slate-400">{row.description || '—'}</td>
                      <td className="text-[10.5px] text-slate-500">{formatDate(row.createdAt, lang, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 pb-3">
              <Pagination page={tx.data.page || 1} pageSize={tx.data.pageSize || 20} total={tx.data.total || 0} onChange={setPage} />
            </div>
          </>
        ) : (
          <EmptyState icon={Receipt} title={t('stats.noRevenue')} />
        )}
      </SectionCard>
    </>
  );
}

function ResellerStats() {
  const { t, lang } = useI18n();
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['reseller', 'stats', days],
    queryFn: () => api.get(`/reseller/stats?days=${days}`),
  });

  const configs = data?.configs || {};
  const donut = useMemo(() => [
    { name: t('common.active'), value: configs.active || 0, color: '#10b981' },
    { name: t('common.expired'), value: configs.expired || 0, color: '#f59e0b' },
    { name: t('common.depleted'), value: configs.depleted || 0, color: '#f43f5e' },
    { name: t('common.disabled'), value: configs.disabled || 0, color: '#64748b' },
  ], [configs, t]);

  return (
    <>
      <PageHeader
        title={t('stats.title')}
        subtitle={t('stats.subtitle')}
        actions={<Tabs tabs={RANGES.map((value) => ({ value: String(value), label: t(`stats.days${value}`) }))} active={String(days)} onChange={(value) => setDays(Number(value))} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard icon={Boxes} label={t('dash.kpiConfigs')} value={formatNumber(configs.total, lang)} hint={`${formatNumber(configs.active, lang)} ${t('common.active')}`} tone="emerald" />
        <StatCard icon={Activity} label={t('dash.kpiTrafficToday')} value={formatBytes(data?.today?.total, lang, { digits: 1 })} hint={`${t('common.week')}: ${formatBytes(data?.week?.total, lang)}`} tone="cyan" />
        <StatCard icon={TrendingUp} label={t('common.month')} value={formatBytes(data?.month?.total, lang, { digits: 1 })} hint={t('common.traffic')} tone="violet" />
        <StatCard icon={Gauge} label={t('common.used')} value={formatBytes(configs.usedBytes, lang)} hint={formatBytes(configs.quotaBytes, lang)} tone="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <SectionCard className="xl:col-span-2" title={t('stats.usageChart')} icon={Activity} bodyClass="px-2 pb-3 pt-4 sm:px-4">
          {isLoading ? <Skeleton className="h-[260px] w-full" /> : <TrafficChart data={data?.series || []} height={260} />}
        </SectionCard>
        <SectionCard title={t('dash.kpiConfigs')} icon={Gauge}>
          <StatusDonut items={donut} height={190} />
          <div className="mt-2 grid grid-cols-2 gap-2">
            {donut.map((item) => (
              <div key={item.name} className="flex items-center justify-between rounded-lg bg-white/[0.025] px-2.5 py-1.5">
                <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400"><i className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />{item.name}</span>
                <span className="text-[11px] font-semibold text-slate-200">{formatNumber(item.value, lang)}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <SectionCard title={t('stats.topConfigs')} icon={Boxes} bodyClass="p-0">
          {(data?.topConfigs || []).map((row) => (
            <div key={row.id} className="flex items-center gap-2.5 border-b border-white/[0.04] px-4 py-2.5 last:border-0">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300"><Wifi className="h-3.5 w-3.5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] text-slate-200">{row.label || row.customerName || row.email}</p>
                <p className="truncate font-mono text-[9px] text-slate-500" dir="ltr">{row.email}</p>
              </div>
              <span className="text-[10.5px] font-semibold text-slate-300">{formatBytes(row.usedBytes, lang)}</span>
            </div>
          ))}
          {!(data?.topConfigs || []).length && !isLoading ? <EmptyState icon={Boxes} title={t('common.noData')} className="py-8" /> : null}
        </SectionCard>
        <SectionCard title={t('stats.inbounds')} icon={Network} bodyClass="p-0">
          {(data?.inbounds || []).map((row) => (
            <div key={row.id} className="flex items-center gap-2.5 border-b border-white/[0.04] px-4 py-2.5 last:border-0">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400"><Network className="h-3.5 w-3.5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] text-slate-200">{row.remark || `#${row.id}`}</p>
                <p className="truncate text-[9.5px] text-slate-500">{nodeLabel(row.nodeName, lang)} · {row.protocol}</p>
              </div>
              <div className="text-end">
                <p className="text-[11px] font-semibold text-slate-200">{formatNumber(row.configs, lang)}</p>
                <p className="text-[9px] text-slate-500">{formatBytes(row.usedBytes, lang)}</p>
              </div>
            </div>
          ))}
          {!(data?.inbounds || []).length && !isLoading ? <EmptyState icon={Network} title={t('common.noData')} className="py-8" /> : null}
        </SectionCard>
      </div>
    </>
  );
}

export default function Stats() {
  const { isAdmin } = useAuth();
  return isAdmin ? <AdminStats /> : <ResellerStats />;
}
