import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowUpRight,
  Boxes,
  CalendarClock,
  Download,
  ExternalLink,
  Filter,
  Layers,
  Link2,
  Plus,
  QrCode,
  RefreshCw,
  SearchX,
  Server,
  SlidersHorizontal,
  UserRound,
  Wifi,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { downloadFile, api } from '../lib/api.js';
import { daysLeft, formatBytes, formatDate, formatNumber, relativeTime } from '../lib/format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
  TableSkeleton,
  Toolbar,
  UsageBar,
  cx,
  useDebounced,
} from '../components/ui.jsx';
import ConfigForm from '../components/config/ConfigForm.jsx';
import ConfigDetail from '../components/config/ConfigDetail.jsx';
import { useToast } from '../components/feedback.jsx';

const STATUSES = ['active', 'expired', 'depleted', 'disabled'];

export default function Configs() {
  const { t, lang } = useI18n();
  const { isAdmin, can } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 350);
  const [status, setStatus] = useState('');
  const [inboundId, setInboundId] = useState('');
  const [userId, setUserId] = useState('');
  const [expiringDays, setExpiringDays] = useState(Number(params.get('expiring') || 0));
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(params.get('new') === '1');
  const [detailId, setDetailId] = useState(null);

  const base = isAdmin ? '/admin' : '/reseller';

  useEffect(() => {
    if (params.get('new') === '1') {
      setFormOpen(true);
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setPage(1); }, [debounced, status, inboundId, userId, expiringDays]);

  const filters = useMemo(() => {
    const query = new URLSearchParams();
    if (debounced) query.set('search', debounced);
    if (status) query.set('status', status);
    if (inboundId) query.set('inboundId', inboundId);
    if (userId) query.set('userId', userId);
    if (expiringDays) query.set('expiringDays', String(expiringDays));
    query.set('page', String(page));
    query.set('pageSize', '20');
    return query.toString();
  }, [debounced, status, inboundId, userId, expiringDays, page]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['configs', base, filters],
    queryFn: () => api.get(`${base}/configs?${filters}`),
    placeholderData: (prev) => prev,
  });

  const inboundsQuery = useQuery({
    queryKey: ['inbounds', 'filter', isAdmin ? 'admin' : 'reseller'],
    queryFn: () => api.get(isAdmin ? '/admin/inbounds' : '/reseller/inbounds'),
    staleTime: 120000,
  });

  const usersQuery = useQuery({
    queryKey: ['admin', 'users', 'filter'],
    queryFn: () => api.get('/admin/users?pageSize=200&role=reseller'),
    enabled: isAdmin,
    staleTime: 120000,
  });

  const rows = data?.rows || [];
  const inbounds = inboundsQuery.data?.rows || [];

  const exportCsv = () => {
    const query = new URLSearchParams();
    if (debounced) query.set('search', debounced);
    if (status) query.set('status', status);
    if (inboundId) query.set('inboundId', inboundId);
    if (userId) query.set('userId', userId);
    downloadFile(`${base}/configs/export.csv?${query.toString()}`, 'configs.csv');
  };

  const resetFilters = () => {
    setSearch('');
    setStatus('');
    setInboundId('');
    setUserId('');
    setExpiringDays(0);
    setPage(1);
  };

  const activeFilters = Boolean(search || status || inboundId || userId || expiringDays);

  return (
    <>
      <PageHeader
        title={t('configs.title')}
        subtitle={t('configs.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={Download} onClick={exportCsv}>{t('common.export')}</Button>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('configs.new')}</Button>
          </>
        }
      />

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder={t('configs.searchPlaceholder')} className="w-full max-w-xs" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-[132px]">
          <option value="">{t('common.allStatuses')}</option>
          {STATUSES.map((item) => <option key={item} value={item}>{t(`common.${item}`)}</option>)}
        </Select>
        <Select value={inboundId} onChange={(e) => setInboundId(e.target.value)} className="w-auto max-w-[200px]">
          <option value="">{t('configs.filterInbound')}</option>
          {inbounds.map((row) => <option key={row.id} value={row.id}>{row.remark || `#${row.id}`}</option>)}
        </Select>
        {isAdmin ? (
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-auto max-w-[200px]">
            <option value="">{t('configs.table.reseller')}</option>
            {(usersQuery.data?.rows || []).map((row) => <option key={row.id} value={row.id}>{row.name || `@${row.username}`}</option>)}
          </Select>
        ) : null}
        <Button
          variant={expiringDays ? 'soft' : 'ghost'}
          size="sm"
          icon={CalendarClock}
          onClick={() => setExpiringDays(expiringDays ? 0 : 3)}
        >
          {t('dash.kpiExpiring')}
        </Button>
        <div className="ms-auto flex items-center gap-1.5">
          {activeFilters ? (
            <Button variant="ghost" size="sm" onClick={resetFilters}>{t('common.reset')}</Button>
          ) : null}
          <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={() => refetch()} className={cx(isFetching && '[&>svg]:animate-spin')} />
        </div>
      </Toolbar>

      {isLoading ? (
        <div className="table-wrap"><TableSkeleton rows={8} cols={6} /></div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : rows.length ? (
        <>
          <div className="table-wrap hidden md:block">
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('configs.table.customer')}</th>
                    <th>{t('configs.table.inbound')}</th>
                    <th className="w-[180px]">{t('configs.table.usage')}</th>
                    <th>{t('configs.table.expiry')}</th>
                    {isAdmin ? <th>{t('configs.table.reseller')}</th> : null}
                    <th>{t('common.status')}</th>
                    <th className="text-end">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const left = daysLeft(row.expiryAt, lang);
                    const grouped = Number(row.groupCount || 1) > 1;
                    return (
                      <tr key={row.id} className="cursor-pointer" onClick={() => setDetailId(row.id)}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 text-[10px] font-bold text-emerald-300">
                              {(row.customerName || row.label || row.email || '?').charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <p className="max-w-[190px] truncate text-[12.5px] font-medium text-slate-200">{row.customerName || row.label || '—'}</p>
                              {grouped ? (
                                <p className="flex items-center gap-1 text-[10px] text-cyan-300/80">
                                  <Layers className="h-3 w-3" />
                                  {t('configs.packageCount', { n: formatNumber(row.groupCount, lang) })}
                                </p>
                              ) : (
                                <p className="max-w-[190px] truncate font-mono text-[10px] text-slate-500" dir="ltr">{row.email}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td>
                          {grouped ? (
                            <div className="flex max-w-[220px] flex-wrap gap-1">
                              {(row.inbounds || []).map((item) => (
                                <span
                                  key={item.configId || item.id}
                                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 text-[10px] text-slate-300"
                                  title={`${item.protocol}${item.network ? ` · ${item.network}` : ''}`}
                                >
                                  <Server className="h-2.5 w-2.5 shrink-0 text-slate-500" />
                                  <span className="truncate">{item.remark}</span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <>
                              <p className="max-w-[160px] truncate text-[12px] text-slate-300">{row.inbound?.remark || `#${row.inboundId}`}</p>
                              <p className="text-[10px] text-slate-500">{row.inbound?.protocol}{row.inbound?.network ? ` · ${row.inbound.network}` : ''}</p>
                            </>
                          )}
                        </td>
                        <td>
                          <UsageBar used={row.used} total={row.totalBytes} showLabel />
                        </td>
                        <td>
                          {row.expiryAt ? (
                            <div>
                              <p className="text-[11.5px] text-slate-300">{formatDate(row.expiryAt, lang)}</p>
                              <p className={cx('text-[10px]', left !== null && left <= 3 ? 'text-amber-300' : 'text-slate-500')}>
                                {left !== null && left > 0 ? `${formatNumber(left, lang)} ${t('common.days')}` : t('common.expired')}
                              </p>
                            </div>
                          ) : (
                            <Badge tone="cyan">{t('common.unlimited')}</Badge>
                          )}
                        </td>
                        {isAdmin ? (
                          <td>
                            <span className="text-[11.5px] text-slate-300">{row.reseller?.name || row.reseller?.username || '—'}</span>
                          </td>
                        ) : null}
                        <td><StatusBadge status={row.status} /></td>
                        <td onClick={(event) => event.stopPropagation()}>
                          <div className="flex items-center justify-end gap-0.5">
                            <IconButton icon={Link2} label={t('configs.actions.links')} onClick={() => setDetailId(row.id)} />
                            <IconButton icon={SlidersHorizontal} label={t('configs.actions.details')} onClick={() => setDetailId(row.id)} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2.5 md:hidden">
            {rows.map((row) => {
              const left = daysLeft(row.expiryAt, lang);
              const grouped = Number(row.groupCount || 1) > 1;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setDetailId(row.id)}
                  className="card w-full p-3.5 text-start transition hover:border-emerald-400/25"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-semibold text-slate-100">{row.customerName || row.label || row.email}</p>
                      {grouped ? (
                        <p className="flex items-center gap-1 text-[9.5px] text-cyan-300/80">
                          <Layers className="h-3 w-3" />
                          {t('configs.packageCount', { n: formatNumber(row.groupCount, lang) })}
                        </p>
                      ) : (
                        <p className="truncate font-mono text-[9.5px] text-slate-500" dir="ltr">{row.email}</p>
                      )}
                    </div>
                    <StatusBadge status={row.status} />
                  </div>
                  <div className="mt-2.5 flex items-center gap-2 text-[10px] text-slate-500">
                    <span className="flex min-w-0 items-center gap-1">
                      <Server className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {grouped
                          ? (row.inbounds || []).map((item) => item.remark).join(' + ')
                          : (row.inbound?.remark || `#${row.inboundId}`)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1"><CalendarClock className="h-3 w-3" />{row.expiryAt ? (left !== null && left > 0 ? `${formatNumber(left, lang)} ${t('common.days')}` : t('common.expired')) : '∞'}</span>
                  </div>
                  <div className="mt-2.5"><UsageBar used={row.used} total={row.totalBytes} showLabel compact /></div>
                </button>
              );
            })}
          </div>

          <Pagination page={data?.page || 1} pageSize={data?.pageSize || 20} total={data?.total || 0} onChange={setPage} />
        </>
      ) : (
        <div className="card">
          <EmptyState
            icon={activeFilters ? SearchX : Boxes}
            title={activeFilters ? t('common.noData') : t('configs.empty')}
            hint={activeFilters ? t('common.reset') : t('configs.emptyHint')}
            action={
              activeFilters
                ? <Button variant="secondary" size="sm" onClick={resetFilters}>{t('common.reset')}</Button>
                : <Button icon={Plus} size="sm" onClick={() => setFormOpen(true)}>{t('configs.new')}</Button>
            }
          />
        </div>
      )}

      <ConfigForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onCreated={(created) => {
          if (created?.length) setDetailId(created[0].id);
          queryClient.invalidateQueries({ queryKey: ['configs'] });
        }}
      />
      <ConfigDetail
        open={Boolean(detailId)}
        configId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['configs'] })}
      />
    </>
  );
}
