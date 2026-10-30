import React, { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BellRing,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Radar,
  RefreshCw,
  Server,
  ServerOff,
  Settings,
  Timer,
  Wifi,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { nodeLabel } from '../../lib/nodes.js';
import { formatDate, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  SectionCard,
  Skeleton,
  StatCard,
  StatusBadge,
  cx,
} from '../../components/ui.jsx';
import { useToast } from '../../components/feedback.jsx';
import ServersPanels from '../../components/ServersPanels.jsx';

function gbText(value, lang) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${formatNumber(Number(value) / 1024 ** 3, lang, 1)} GB`;
}

function MetricBar({ icon: Icon, label, value, total, suffix = '%' }) {
  const percent = total ? Math.min(100, Math.round((Number(value) / Number(total)) * 1000) / 10) : value !== null && value !== undefined ? Math.min(100, Number(value)) : null;
  const tone = percent === null ? 'bg-slate-500/40' : percent >= 90 ? 'bg-gradient-to-r from-rose-500 to-orange-400' : percent >= 70 ? 'bg-gradient-to-r from-amber-400 to-yellow-300' : 'bg-gradient-to-r from-emerald-500 to-cyan-400';
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1.5 text-slate-400"><Icon className="h-3.5 w-3.5 text-slate-500" />{label}</span>
        <span className="font-medium text-slate-200">{percent === null ? '—' : `${formatNumber(percent, 'en', 1)}${suffix}`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={cx('h-full rounded-full transition-all', tone)} style={{ width: `${percent === null ? 0 : Math.max(2, percent)}%` }} />
      </div>
    </div>
  );
}

function UptimeStrip({ samples = [] }) {
  const ticks = samples.slice(-48);
  if (!ticks.length) return <div className="h-3 w-full rounded bg-white/[0.04]" />;
  return (
    <div className="flex h-3 w-full items-stretch gap-[1px] overflow-hidden rounded">
      {ticks.map((sample, index) => (
        <span
          key={index}
          title={`${sample.status} · ${sample.latencyMs ?? '—'}ms`}
          className={cx(
            'flex-1 rounded-[1px]',
            sample.status === 'online' ? 'bg-emerald-400/70' : 'bg-rose-500/70'
          )}
        />
      ))}
    </div>
  );
}

export default function Servers() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'servers'],
    queryFn: () => api.get('/admin/servers'),
    refetchInterval: 60000,
  });

  const check = useMutation({
    mutationFn: () => api.post('/admin/servers/check'),
    onSuccess: (result) => {
      toast.success(`${t('servers.checked')} · ${formatNumber(result?.nodes?.nodes ?? result?.nodes, lang) || ''}`);
      queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
      queryClient.invalidateQueries({ queryKey: ['nodes', 'status'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const nodes = data?.nodes || [];
  const panels = data?.panels || [];
  const panel = data?.panel || {};
  const monitor = data?.monitor || {};
  const series = data?.series || [];

  const byNode = useMemo(() => {
    const map = new Map();
    for (const sample of series) {
      if (!map.has(sample.nodeId)) map.set(sample.nodeId, []);
      map.get(sample.nodeId).push(sample);
    }
    return map;
  }, [series]);

  const online = nodes.filter((node) => node.status === 'online' || node.status === 'up').length;
  const onlinePanels = panels.filter((server) => server.status === 'online').length;

  return (
    <>
      <PageHeader
        title={t('servers.title')}
        subtitle={t('servers.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={Settings} onClick={() => navigate('/settings')}>{t('common.settings')}</Button>
            <Button icon={Radar} onClick={() => check.mutate()} loading={check.isPending}>{t('servers.checkNow')}</Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard icon={Network} label={t('servers.panelsStatus')} value={panels.length ? `${formatNumber(onlinePanels, lang)} / ${formatNumber(panels.length, lang)}` : '—'} hint={panels.length ? t('common.online') : t('servers.panelsEmptyHint')} tone={panels.length ? (onlinePanels === panels.length ? 'emerald' : onlinePanels ? 'amber' : 'rose') : 'cyan'} />
        <StatCard icon={Server} label={t('servers.nodes')} value={`${formatNumber(online, lang)} / ${formatNumber(nodes.length, lang)}`} hint={t('common.online')} tone="cyan" />
        <StatCard icon={BellRing} label={t('servers.alerts')} value={monitor.running ? t('servers.monitorOn') : t('servers.monitorOff')} hint={t('servers.alertsHint')} tone={monitor.running ? 'violet' : 'amber'} />
        <StatCard icon={Timer} label={t('servers.lastCheck')} value={panel.checkedAt ? relativeTime(panel.checkedAt, lang) : '—'} hint={monitor.lastRunAt ? formatDate(monitor.lastRunAt, lang, true) : ''} tone="amber" />
      </div>

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-56 lg:col-span-3" />{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : (
        <>
          <div className="mb-4">
            <ServersPanels panels={panels} onChanged={() => refetch()} />
          </div>

          <SectionCard
            title={t('servers.panelsStatus')}
            subtitle={panels.length ? t('servers.subtitle') : t('servers.panelsEmptyHint')}
            icon={Server}
            actions={<IconButtonRefresh onClick={() => refetch()} spinning={isFetching} label={t('common.refresh')} />}
            bodyClass="p-0"
          >
            {panels.length ? (
              <div className="divide-y divide-white/[0.05]">
                {panels.map((server) => {
                  const res = server.resources || {};
                  const isOnline = server.status === 'online';
                  return (
                    <div key={server.id} className="px-4 py-4">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className={cx('kpi-icon shrink-0', isOnline ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300')}>
                          <Server className="h-[18px] w-[18px]" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-[12.5px] font-semibold text-slate-100">{server.name}</p>
                            <StatusBadge status={isOnline ? 'online' : server.status || 'unknown'} />
                            {server.enabled === false ? <Badge tone="slate">{t('servers.panels.disabled')}</Badge> : null}
                          </div>
                          <p className="truncate font-mono text-[10px] text-slate-500" dir="ltr">{server.url}</p>
                        </div>
                        <span className="flex items-center gap-1 text-[10.5px] text-slate-500"><Wifi className="h-3 w-3" />{server.latencyMs ?? '—'} ms</span>
                      </div>

                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                          <MetricBar icon={Cpu} label={t('servers.cpu')} value={res.cpu ?? null} />
                        </div>
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                          <MetricBar icon={MemoryStick} label={t('servers.memory')} value={res.memCurrent ?? null} total={res.memTotal ?? null} />
                          <p className="mt-2 text-[10px] text-slate-500">
                            {gbText(res.memCurrent, lang)}{res.memTotal ? ` / ${gbText(res.memTotal, lang)}` : ''}
                          </p>
                        </div>
                        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                          <MetricBar icon={HardDrive} label={t('servers.disk')} value={res.diskCurrent ?? null} total={res.diskTotal ?? null} />
                          <p className="mt-2 text-[10px] text-slate-500">
                            {gbText(res.diskCurrent, lang)}{res.diskTotal ? ` / ${gbText(res.diskTotal, lang)}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[10.5px] text-slate-500">
                        <Badge tone={res.xrayState === 'running' ? 'emerald' : 'slate'} dot>
                          {t('servers.xray')}: {res.xrayState === 'running' ? t('servers.xrayRunning') : res.xrayState === 'stopped' ? t('servers.xrayStopped') : res.xrayState || '—'}
                        </Badge>
                        {res.coreVersion ? <Badge tone="cyan">{t('servers.coreVersion')}: {res.coreVersion}</Badge> : null}
                        {res.uptime ? <Badge tone="slate">{t('servers.uptime')}: {formatNumber(Math.floor(res.uptime / 3600), lang)}h</Badge> : null}
                        {server.resourcesError ? <span className="text-amber-300/80">{t('servers.resourcesUnavailable')}</span> : null}
                        {server.message ? <span className="truncate">{server.message}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-8">
                <EmptyState icon={Server} title={t('servers.panels.empty')} hint={t('servers.panelsEmptyHint')} />
              </div>
            )}
          </SectionCard>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {nodes.map((node) => {
              const samples = byNode.get(node.id) || [];
              const onlineSamples = samples.filter((sample) => sample.status === 'online').length;
              const uptimePct = samples.length ? Math.round((onlineSamples / samples.length) * 1000) / 10 : null;
              const isOnline = node.status === 'online' || node.status === 'up';
              return (
                <div key={node.id} className={cx('card card-hover relative overflow-hidden p-4', !isOnline && 'border-rose-400/20')}>
                  <div className={cx('pointer-events-none absolute -top-12 end-0 h-24 w-24 rounded-full blur-2xl', isOnline ? 'bg-emerald-500/10' : 'bg-rose-500/10')} />
                  <div className="relative flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className={cx('kpi-icon', isOnline ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300')}>
                        {isOnline ? <Server className="h-[18px] w-[18px]" /> : <ServerOff className="h-[18px] w-[18px]" />}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[12.5px] font-semibold text-slate-100">{nodeLabel(node.name, lang)}</p>
                        <p className="truncate font-mono text-[10px] text-slate-500" dir="ltr">{node.address}:{node.port}</p>
                      </div>
                    </div>
                    <StatusBadge status={isOnline ? 'online' : 'offline'} />
                  </div>

                  <div className="relative mt-3.5 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-white/[0.03] px-1 py-1.5">
                      <p className="text-[10px] text-slate-500">{t('servers.latency')}</p>
                      <p className={cx('text-[11.5px] font-semibold', isOnline ? 'text-emerald-300' : 'text-slate-500')}>{node.latencyMs !== null && node.latencyMs !== undefined ? `${node.latencyMs}ms` : '—'}</p>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] px-1 py-1.5">
                      <p className="text-[10px] text-slate-500">{t('servers.heartbeat')}</p>
                      <p className="text-[10.5px] font-medium text-slate-300">{node.heartbeat ? relativeTime(node.heartbeat, lang) : '—'}</p>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] px-1 py-1.5">
                      <p className="text-[10px] text-slate-500">24h</p>
                      <p className="text-[10.5px] font-semibold text-slate-300">{uptimePct === null ? '—' : `${formatNumber(uptimePct, lang, 1)}%`}</p>
                    </div>
                  </div>

                  <div className="relative mt-3">
                    <UptimeStrip samples={samples} />
                    <div className="mt-1.5 flex items-center justify-between text-[9.5px] text-slate-600">
                      <span>{t('servers.history')}</span>
                      <span>{node.checkedAt ? relativeTime(node.checkedAt, lang) : t('common.unknown')}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {!nodes.length ? (
            <div className="card mt-4">
              <EmptyState icon={AlertTriangle} title={t('servers.noLive')} hint={data?.liveError} />
            </div>
          ) : null}

          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-cyan-400/15 bg-cyan-500/[0.04] px-4 py-3">
            <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
            <p className="text-[11.5px] leading-6 text-cyan-100/70">{t('servers.alertsHint')} · {t('servers.monitorInterval')}: {formatNumber(monitor.intervalSec || 120, lang)}s</p>
          </div>
        </>
      )}
    </>
  );
}

function IconButtonRefresh({ onClick, spinning, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
    >
      <RefreshCw className={cx('h-4 w-4', spinning && 'animate-spin')} />
    </button>
  );
}
