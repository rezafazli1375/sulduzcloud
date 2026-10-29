import React, { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
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
  WifiOff,
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

function readNumber(source, keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), source);
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
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
  const live = data?.live || {};
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
  const cpu = readNumber(live, ['cpu', 'cpuUsage', 'cpu.usage', 'cpuPercent']);
  const memCurrent = readNumber(live, ['mem.current', 'mem.used', 'memory.current', 'memory.used']);
  const memTotal = readNumber(live, ['mem.total', 'memory.total']);
  const diskCurrent = readNumber(live, ['disk.current', 'disk.used', 'diskUsage.used']);
  const diskTotal = readNumber(live, ['disk.total', 'diskUsage.total']);
  const uptime = readNumber(live, ['uptime', 'uptimeSeconds', 'uptime_seconds']);
  const xrayState = live?.xray?.state || live?.xrayState || (live?.xray?.running ? 'running' : '');
  const coreVersion = live?.xray?.version || live?.coreVersion || live?.version || '';

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
        <StatCard icon={Network} label={t('servers.panel')} value={panel.status === 'online' ? t('common.online') : panel.status === 'offline' ? t('common.offline') : t('common.unknown')} hint={panel.latencyMs ? `${formatNumber(panel.latencyMs, lang)} ms` : ''} tone={panel.status === 'online' ? 'emerald' : 'rose'} />
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
            title={t('servers.panel')}
            subtitle={data?.liveError || panels[0]?.name || 'x-ui'}
            icon={Server}
            actions={
              <div className="flex items-center gap-2">
                <StatusBadge status={panel.status} label={panel.status === 'online' ? t('common.online') : t('common.offline')} />
                <IconButtonRefresh onClick={() => refetch()} spinning={isFetching} label={t('common.refresh')} />
              </div>
            }
            bodyClass="p-4"
          >
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-400">{t('servers.cpu')}</span>
                  <span className="text-[10px] text-slate-500">{data?.liveError ? t('servers.noLive') : ''}</span>
                </div>
                <MetricBar icon={Cpu} label={t('servers.cpu')} value={cpu} />
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <MetricBar icon={MemoryStick} label={t('servers.memory')} value={memCurrent} total={memTotal} />
                <p className="mt-2 text-[10px] text-slate-500">
                  {memCurrent !== null ? `${formatNumber((memCurrent / 1024 ** 3), lang, 1)} GB` : '—'}
                  {memTotal ? ` / ${formatNumber((memTotal / 1024 ** 3), lang, 1)} GB` : ''}
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <MetricBar icon={HardDrive} label={t('servers.disk')} value={diskCurrent} total={diskTotal} />
                <p className="mt-2 text-[10px] text-slate-500">
                  {diskCurrent !== null ? `${formatNumber((diskCurrent / 1024 ** 3), lang, 1)} GB` : '—'}
                  {diskTotal ? ` / ${formatNumber((diskTotal / 1024 ** 3), lang, 1)} GB` : ''}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3 text-[10.5px] text-slate-500">
              <Badge tone={xrayState === 'running' ? 'emerald' : 'slate'} dot>
                {t('servers.xray')}: {xrayState === 'running' ? t('servers.xrayRunning') : xrayState === 'stopped' ? t('servers.xrayStopped') : xrayState || '—'}
              </Badge>
              {coreVersion ? <Badge tone="cyan">{t('servers.coreVersion')}: {coreVersion}</Badge> : null}
              {uptime ? <Badge tone="slate">{t('servers.uptime')}: {formatNumber(Math.floor(uptime / 3600), lang)}h</Badge> : null}
              <span className="ms-auto flex items-center gap-1"><Wifi className="h-3 w-3" />{panel.latencyMs ?? '—'} ms</span>
            </div>
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
