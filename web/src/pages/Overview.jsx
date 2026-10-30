import React, { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowUpRight,
  Boxes,
  CalendarClock,
  Car,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  CreditCard,
  Gauge,
  LayoutGrid,
  MessageSquare,
  Network,
  Plus,
  Radio,
  Server,
  ShieldCheck,
  Signal,
  Sparkles,
  Ticket,
  TrendingUp,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatBytes, formatMoney, formatNumber, pct } from '../lib/format.js';
import { nodeLabel } from '../lib/nodes.js';
import { Badge, Button, EmptyState, PageHeader, SectionCard, Skeleton, StatCard, StatusBadge, UsageBar, cx } from '../components/ui.jsx';
import { StatusDonut, TrafficChart } from '../components/charts.jsx';

function todayLabel(lang) {
  try {
    return new Intl.DateTimeFormat(lang === 'fa' ? 'fa-IR' : 'en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date());
  } catch (_) {
    return '';
  }
}

function Kpi({ icon, label, value, hint, tone, to }) {
  return (
    <Link to={to || '/'} className="block">
      <StatCard icon={icon} label={label} value={value} hint={hint} tone={tone} className="h-full" />
    </Link>
  );
}

function NodePill({ node }) {
  const { lang } = useI18n();
  const online = node.status === 'up' || node.status === 'online';
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cx('relative flex h-1.5 w-1.5 shrink-0 rounded-full', online ? 'bg-emerald-400' : 'bg-rose-400')} />
        <span className="truncate text-[11px] text-slate-300">{nodeLabel(node.name || `node-${node.id}`, lang)}</span>
      </div>
      <span className={cx('shrink-0 text-[10px] font-medium', online ? 'text-emerald-300/80' : 'text-rose-300/80')}>
        {node.latencyMs !== null && node.latencyMs !== undefined ? `${formatNumber(node.latencyMs, 'en')}ms` : node.status}
      </span>
    </div>
  );
}

function NetworkCard({ compact = false }) {
  const { t } = useI18n();
  const { data, isLoading } = useQuery({
    queryKey: ['nodes', 'status'],
    queryFn: () => api.get('/nodes/status'),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const nodes = data?.nodes || [];
  const online = nodes.filter((node) => node.status === 'up' || node.status === 'online').length;
  const panelUp = data?.panel?.status === 'up' || data?.panel?.status === 'online';

  return (
    <SectionCard
      title={t('dash.networkStatus')}
      icon={Network}
      actions={<Badge tone={online === nodes.length && nodes.length ? 'emerald' : nodes.length ? 'amber' : 'slate'} dot>{online}/{nodes.length || 0}</Badge>}
      bodyClass="p-4"
    >
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-emerald-400/15 bg-emerald-500/[0.06] px-3 py-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
              <Server className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11.5px] font-semibold text-slate-200">{t('servers.panel')}</p>
              <p className="text-[10px] text-slate-500">{data?.panel?.latencyMs ? `${formatNumber(data.panel.latencyMs, 'en')} ms` : '—'}</p>
            </div>
            <StatusBadge status={panelUp ? 'online' : data?.panel?.status || 'unknown'} label={panelUp ? t('common.online') : t('common.offline')} />
          </div>
          <div className={cx('grid gap-1.5', compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2')}>
            {nodes.slice(0, compact ? 4 : 8).map((node) => (
              <NodePill key={node.id} node={node} />
            ))}
          </div>
          {!nodes.length ? <p className="py-4 text-center text-[11px] text-slate-500">{t('servers.noLive')}</p> : null}
        </>
      )}
    </SectionCard>
  );
}

function AdminDashboard() {
  const { t, lang } = useI18n();
  const { user, meta } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get('/admin/overview'),
    refetchInterval: 60000,
  });

  const configs = data?.configs || {};
  const users = data?.users || {};
  const revenue = data?.revenue || {};

  // Counts are customer packages: every inbound of one subscription is one row.
  // A package whose inbounds disagree (one expired, one still active) is mixed.
  const donut = useMemo(
    () => [
      { name: t('common.active'), value: configs.active || 0, color: '#10b981' },
      { name: t('common.expired'), value: configs.expired || 0, color: '#f59e0b' },
      { name: t('common.depleted'), value: configs.depleted || 0, color: '#f43f5e' },
      { name: t('common.disabled'), value: configs.disabled || 0, color: '#64748b' },
      ...(Number(configs.mixed) > 0 ? [{ name: t('dash.mixedPackages'), value: Number(configs.mixed), color: '#8b5cf6' }] : []),
    ],
    [configs, t]
  );

  return (
    <>
      <PageHeader
        title={`${t('dash.hello')}، ${user?.name || user?.username}`}
        subtitle={`${todayLabel(lang)} · ${t('dash.adminSub')}`}
        actions={
          <>
            <Button variant="secondary" icon={MessageSquare} onClick={() => navigate('/tickets')}>
              {t('common.tickets')}
            </Button>
            <Button icon={Plus} onClick={() => navigate('/configs?new=1')}>
              {t('dash.createConfig')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi icon={Boxes} label={t('dash.kpiCustomers')} value={formatNumber(configs.total, lang)} hint={`${formatNumber(configs.active, lang)} ${t('common.active')}`} tone="emerald" to="/configs" />
        <Kpi icon={Users} label={t('dash.kpiUsers')} value={formatNumber(users.resellers, lang)} hint={`${formatNumber(users.active, lang)} ${t('common.active')}`} tone="cyan" to="/resellers" />
        <Kpi icon={Activity} label={t('dash.kpiTrafficToday')} value={data ? formatBytes(data.today?.total, lang, { digits: 1 }) : '—'} hint={data ? `${t('common.week')}: ${formatBytes(data.week?.total, lang)}` : ''} tone="violet" to="/stats" />
        <Kpi icon={Ticket} label={t('dash.kpiOpenTickets')} value={formatNumber(data?.openTickets, lang)} hint={t('dash.kpiExpiring').concat(': ').concat(formatNumber(data?.expiring3d, lang))} tone={data?.openTickets ? 'amber' : 'rose'} to="/tickets" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <SectionCard
          className="xl:col-span-2"
          title={t('dash.trafficChart')}
          subtitle={t('dash.trafficChartHint')}
          icon={TrendingUp}
          actions={
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400"><i className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{lang === 'fa' ? 'دانلود' : 'Down'}</span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400"><i className="h-1.5 w-1.5 rounded-full bg-cyan-400" />{lang === 'fa' ? 'آپلود' : 'Up'}</span>
            </div>
          }
          bodyClass="px-2 pb-3 pt-4 sm:px-4"
        >
          {isLoading ? <Skeleton className="h-[250px] w-full" /> : <TrafficChart data={data?.series || []} height={250} />}
        </SectionCard>

        <NetworkCard compact />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <SectionCard title={t('dash.kpiCustomers')} subtitle={`${formatNumber(configs.total, lang)} ${t('common.customers')}`} icon={Gauge}>
          {configs.total ? (
            <>
              <StatusDonut items={donut} height={190} />
              <div className="mt-2 grid grid-cols-2 gap-2">
                {donut.map((item) => (
                  <div key={item.name} className="flex items-center justify-between rounded-lg bg-white/[0.025] px-2.5 py-1.5">
                    <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400">
                      <i className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                      {item.name}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-200">{formatNumber(item.value, lang)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState icon={Boxes} title={t('common.noData')} className="py-10" />
          )}
        </SectionCard>

        <SectionCard
          title={t('dash.topResellers')}
          subtitle={t('common.week')}
          icon={Users}
          actions={<Link to="/resellers" className="text-[11px] font-medium text-emerald-300 hover:text-emerald-200">{t('common.viewAll')}</Link>}
          bodyClass="p-3"
        >
          {(data?.topUsers || []).length ? (
            <div className="space-y-1">
              {data.topUsers.slice(0, 6).map((row, index) => (
                <div key={row.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-white/[0.03]">
                  <span className="w-4 text-center text-[10px] font-bold text-slate-600">{formatNumber(index + 1, 'en')}</span>
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 text-[10px] font-bold text-emerald-300">
                    {(row.name || row.username || '?').charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-medium text-slate-200">{row.name || row.username}</p>
                    <p className="truncate text-[9.5px] text-slate-500">@{row.username}</p>
                  </div>
                  <span className="text-[10.5px] font-semibold text-slate-300">{formatBytes(row.usedBytes, lang)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={Users} title={t('common.noData')} className="py-8" />
          )}
        </SectionCard>

        <SectionCard
          title={t('dash.inboundUsage')}
          subtitle={t('common.inbounds')}
          icon={LayoutGrid}
          actions={<Link to="/inbounds" className="text-[11px] font-medium text-emerald-300 hover:text-emerald-200">{t('common.viewAll')}</Link>}
          bodyClass="p-3"
        >
          {(data?.inbounds || []).slice(0, 6).map((row) => (
            <div key={row.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400">
                <Radio className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] text-slate-200">{row.remark || `#${row.id}`}</p>
                <p className="truncate text-[9.5px] text-slate-500">{nodeLabel(row.nodeName, lang)} · {row.protocol}</p>
              </div>
              <div className="text-end">
                <p className="text-[10.5px] font-semibold text-slate-300">{formatNumber(row.configs, lang)}</p>
                <p className="text-[9px] text-slate-600">{formatBytes(row.usedBytes, lang)}</p>
              </div>
            </div>
          ))}
          {!(data?.inbounds || []).length ? <EmptyState icon={Network} title={t('common.noData')} className="py-8" /> : null}
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: CircleDollarSign, label: t('stats.totalSpent'), value: formatMoney(revenue.spent || 0, lang, meta?.billing?.currency || ''), tone: 'text-emerald-300 bg-emerald-500/10' },
          { icon: CalendarClock, label: t('dash.kpiExpiring'), value: formatNumber(data?.expiring3d, lang), tone: 'text-amber-300 bg-amber-500/10' },
          { icon: Zap, label: t('dash.kpiQuota'), value: formatBytes(configs.quotaBytes, lang), tone: 'text-cyan-300 bg-cyan-500/10' },
          { icon: ShieldCheck, label: t('common.used'), value: formatBytes(configs.usedBytes, lang), tone: 'text-violet-300 bg-violet-500/10' },
        ].map((item) => (
          <div key={item.label} className="card flex items-center gap-3 p-3.5">
            <span className={cx('kpi-icon', item.tone)}><item.icon className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} /></span>
            <div className="min-w-0">
              <p className="text-[10px] text-slate-500">{item.label}</p>
              <p className="mt-0.5 truncate text-sm font-bold text-white">{item.value}</p>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function LimitRow({ label, used, total, lang, suffix }) {
  const percent = pct(used, total || 1);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        <span className="font-medium text-slate-300">
          {formatNumber(used, lang)} / {total ? formatNumber(total, lang) : '∞'} {suffix || ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cx(
            'h-full rounded-full',
            total ? 'bg-gradient-to-r from-emerald-500 to-cyan-400' : 'bg-emerald-500/40'
          )}
          style={{ width: `${total ? Math.max(2, Math.min(100, percent || 0)) : 100}%` }}
        />
      </div>
    </div>
  );
}

function ResellerDashboard() {
  const { t, lang } = useI18n();
  const { user, meta } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['reseller', 'overview'],
    queryFn: () => api.get('/reseller/overview'),
    refetchInterval: 60000,
  });

  const configs = data?.configs || {};
  const limits = data?.limits || {};
  const currency = meta?.billing?.currency || '';

  return (
    <>
      <PageHeader
        title={`${t('dash.hello')}، ${user?.name || user?.username}`}
        subtitle={`${todayLabel(lang)} · ${t('dash.resellerSub')}`}
        actions={
          <>
            <Button variant="secondary" icon={MessageSquare} onClick={() => navigate('/tickets')}>
              {t('dash.newTicket')}
            </Button>
            <Button icon={Plus} onClick={() => navigate('/configs?new=1')}>
              {t('dash.createConfig')}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi icon={Boxes} label={t('dash.kpiCustomers')} value={formatNumber(configs.total, lang)} hint={`${formatNumber(configs.active, lang)} ${t('common.active')}`} tone="emerald" to="/configs" />
        <Kpi icon={Activity} label={t('dash.kpiTrafficToday')} value={data ? formatBytes(data.today?.total, lang, { digits: 1 }) : '—'} hint={data ? `${t('common.month')}: ${formatBytes(data.month?.total, lang)}` : ''} tone="cyan" to="/stats" />
        <Kpi icon={CreditCard} label={t('dash.kpiBalance')} value={formatMoney(data?.balance ?? user?.balance ?? 0, lang, currency)} hint={t('dash.balanceHint')} tone="violet" to="/wallet" />
        <Kpi icon={CalendarClock} label={t('dash.kpiExpiring')} value={formatNumber(data?.expiring3d, lang)} hint={t('common.days')} tone="amber" to="/configs?expiring=3" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <SectionCard
          className="xl:col-span-2"
          title={t('dash.trafficChart')}
          subtitle={t('dash.trafficChartHint')}
          icon={TrendingUp}
          actions={
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400"><i className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{lang === 'fa' ? 'دانلود' : 'Down'}</span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-slate-400"><i className="h-1.5 w-1.5 rounded-full bg-cyan-400" />{lang === 'fa' ? 'آپلود' : 'Up'}</span>
            </div>
          }
          bodyClass="px-2 pb-3 pt-4 sm:px-4"
        >
          {isLoading ? <Skeleton className="h-[240px] w-full" /> : <TrafficChart data={data?.series || []} height={240} />}
        </SectionCard>

        <SectionCard title={t('resellers.detail.limits')} icon={Gauge} bodyClass="space-y-4 p-4">
          <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <div>
              <p className="text-[10px] text-slate-500">{t('dash.kpiBalance')}</p>
              <p className="mt-0.5 text-base font-bold text-emerald-300">{formatMoney(data?.balance ?? 0, lang, currency)}</p>
            </div>
            <Button size="xs" variant="soft" onClick={() => navigate('/wallet')}>{t('nav.wallet')}</Button>
          </div>
          <LimitRow label={t('dash.kpiCustomers')} used={configs.total || 0} total={limits.maxConfigs} lang={lang} />
          <LimitRow label={t('resellers.form.maxTotalGb')} used={Math.round((configs.quotaBytes || 0) / 1024 ** 3)} total={limits.maxTotalGb} lang={lang} suffix="GB" />
          <div className="grid grid-cols-2 gap-2 pt-1">
            <div className="rounded-lg bg-white/[0.025] px-2.5 py-2">
              <p className="text-[9.5px] text-slate-500">{t('resellers.form.maxGbPerConfig')}</p>
              <p className="mt-0.5 text-[11.5px] font-semibold text-slate-200">{limits.maxGbPerConfig ? `${formatNumber(limits.maxGbPerConfig, lang)} GB` : '∞'}</p>
            </div>
            <div className="rounded-lg bg-white/[0.025] px-2.5 py-2">
              <p className="text-[9.5px] text-slate-500">{t('resellers.form.maxDaysPerConfig')}</p>
              <p className="mt-0.5 text-[11.5px] font-semibold text-slate-200">{limits.maxDaysPerConfig ? `${formatNumber(limits.maxDaysPerConfig, lang)} ${t('common.days')}` : '∞'}</p>
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <SectionCard
          title={t('dash.topConfigs')}
          subtitle={t('common.week')}
          icon={Signal}
          actions={<Link to="/configs" className="text-[11px] font-medium text-emerald-300 hover:text-emerald-200">{t('common.viewAll')}</Link>}
          bodyClass="p-3"
        >
          {(data?.topConfigs || []).length ? (
            <div className="space-y-1">
              {data.topConfigs.slice(0, 6).map((row) => (
                <div key={row.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-white/[0.03]">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300">
                    <Wifi className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] text-slate-200">{row.label || row.customerName || row.email}</p>
                    <p className="truncate text-[9.5px] text-slate-500">{row.email}</p>
                  </div>
                  <span className="text-[10.5px] font-semibold text-slate-300">{formatBytes(row.usedBytes, lang)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={Boxes} title={t('configs.empty')} action={<Button size="sm" variant="soft" icon={Plus} onClick={() => navigate('/configs?new=1')}>{t('configs.new')}</Button>} />
          )}
        </SectionCard>

        <SectionCard title={t('configs.form.inbound')} subtitle={t('common.inbounds')} icon={Network} actions={<Link to="/configs?new=1" className="text-[11px] font-medium text-emerald-300 hover:text-emerald-200">{t('configs.new')}</Link>} bodyClass="p-3">
          {(data?.inbounds || []).map((row) => (
            <div key={row.id} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.04] text-slate-400">
                <Radio className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11.5px] text-slate-200">{row.remark || `#${row.id}`}</p>
                <p className="truncate text-[9.5px] text-slate-500">{nodeLabel(row.nodeName, lang)} · {row.protocol} · :{row.port}</p>
              </div>
              <Badge tone={row.enabled ? 'emerald' : 'slate'} dot>{row.enabled ? t('common.active') : t('common.disabled')}</Badge>
            </div>
          ))}
          {!(data?.inbounds || []).length ? <EmptyState icon={WifiOff} title={t('common.noData')} className="py-8" /> : null}
        </SectionCard>

        <NetworkCard compact />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: CheckCircle2, label: t('common.active'), value: formatNumber(configs.active, lang), tone: 'bg-emerald-500/10 text-emerald-300' },
          { icon: Sparkles, label: t('common.expired'), value: formatNumber(configs.expired, lang), tone: 'bg-amber-500/10 text-amber-300' },
          { icon: WifiOff, label: t('common.depleted'), value: formatNumber(configs.depleted, lang), tone: 'bg-rose-500/10 text-rose-300' },
          { icon: Ticket, label: t('dash.kpiOpenTickets'), value: formatNumber(data?.openTickets, lang), tone: 'bg-cyan-500/10 text-cyan-300' },
        ].map((item) => (
          <div key={item.label} className="card flex items-center gap-3 p-3.5">
            <span className={cx('kpi-icon', item.tone)}><item.icon className="h-[18px] w-[18px]" /></span>
            <div>
              <p className="text-[10px] text-slate-500">{item.label}</p>
              <p className="mt-0.5 text-sm font-bold text-white">{item.value}</p>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export default function Overview() {
  const { isAdmin, loading } = useAuth();
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-2/3" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-24" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  return isAdmin ? <AdminDashboard /> : <ResellerDashboard />;
}
