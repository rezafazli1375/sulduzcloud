import React, { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n } from '../lib/i18n.jsx';
import { dayLabel, formatBytes, formatNumber } from '../lib/format.js';

const GB = 1024 ** 3;

function ChartTooltip({ active, payload, label, lang, unit = 'traffic' }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a1220]/95 px-3 py-2 text-[11px] shadow-[0_20px_50px_-20px_#000] backdrop-blur">
      {label !== undefined ? <p className="mb-1.5 font-semibold text-slate-200">{label}</p> : null}
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={item.dataKey || item.name} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ background: item.color || item.fill }} />
              {item.name}
            </span>
            <span className="font-semibold text-slate-100">
              {unit === 'traffic'
                ? formatBytes(item.value, lang)
                : unit === 'money'
                  ? formatNumber(item.value, lang)
                  : formatNumber(item.value, lang)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrafficChart({ data = [], height = 250, compact = false, showUpDown = true }) {
  const { t, lang } = useI18n();
  const rows = useMemo(
    () =>
      (data || []).map((row) => ({
        ...row,
        label: dayLabel(row.day, lang),
        up: Number(row.up || 0),
        down: Number(row.down || 0),
        total: Number(row.total || (Number(row.up || 0) + Number(row.down || 0))),
      })),
    [data, lang]
  );
  const hasData = rows.some((row) => row.total > 0);
  return (
    <div style={{ height }} className="relative w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
          <defs>
            <linearGradient id="trafficDown" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.42} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="trafficUp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.36} />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: '#64748b', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={compact ? 30 : 16}
          />
          <YAxis
            tick={{ fill: '#64748b', fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={46}
            tickFormatter={(value) => (value >= GB ? `${formatNumber(value / GB, lang, value / GB >= 10 ? 0 : 1)}G` : `${formatNumber(value / 1024 ** 2, lang, 0)}M`)}
          />
          <Tooltip
            content={
              <ChartTooltip lang={lang} />
            }
            cursor={{ stroke: 'rgba(16,185,129,0.25)', strokeWidth: 1 }}
          />
          {showUpDown ? (
            <>
              <Area
                type="monotone"
                dataKey="down"
                name={lang === 'fa' ? 'دانلود' : 'Download'}
                stroke="#10b981"
                strokeWidth={2}
                fill="url(#trafficDown)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: '#34d399' }}
              />
              <Area
                type="monotone"
                dataKey="up"
                name={lang === 'fa' ? 'آپلود' : 'Upload'}
                stroke="#22d3ee"
                strokeWidth={2}
                fill="url(#trafficUp)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: '#67e8f9' }}
              />
            </>
          ) : (
            <Area
              type="monotone"
              dataKey="total"
              name={t('common.traffic')}
              stroke="#10b981"
              strokeWidth={2.4}
              fill="url(#trafficDown)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: '#34d399' }}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      {!hasData ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full border border-white/[0.07] bg-[#070c17]/70 px-3 py-1.5 text-[11px] text-slate-500">
            {t('dash.noTraffic')}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function Sparkline({ values = [], color = '#10b981', height = 40 }) {
  const data = (values || []).map((value, index) => ({ index, value: Number(value || 0) }));
  if (!data.length) return null;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.8} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusDonut({ items = [], height = 220 }) {
  const { lang } = useI18n();
  const rows = items.filter((item) => Number(item.value) > 0);
  const total = rows.reduce((acc, item) => acc + Number(item.value || 0), 0);
  if (!total) {
    return <div style={{ height }} className="flex items-center justify-center text-[11px] text-slate-500">—</div>;
  }
  return (
    <div style={{ height }} className="relative">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="88%" paddingAngle={3} stroke="none">
            {rows.map((item) => (
              <Cell key={item.name} fill={item.color} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const item = payload[0].payload;
              return (
                <div className="rounded-lg border border-white/10 bg-[#0a1220]/95 px-2.5 py-1.5 text-[11px] text-slate-200">
                  {item.name}: {formatNumber(item.value, lang)}
                </div>
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-white">{formatNumber(total, lang)}</span>
        <span className="mt-0.5 text-[10px] text-slate-500">{lang === 'fa' ? 'کل' : 'total'}</span>
      </div>
    </div>
  );
}

export function RevenueBars({ data = [], height = 220 }) {
  const { lang } = useI18n();
  const rows = (data || []).map((row) => ({ ...row, label: dayLabel(row.day, lang) }));
  if (!rows.length) {
    return <div style={{ height }} className="flex items-center justify-center text-[11px] text-slate-500">—</div>;
  }
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 6, left: 6, bottom: 0 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} width={46} tickFormatter={(v) => formatNumber(v, lang)} />
          <Tooltip content={<ChartTooltip lang={lang} unit="money" />} cursor={{ fill: 'rgba(148,163,184,0.06)' }} />
          <Bar dataKey="amount" name={lang === 'fa' ? 'مبلغ' : 'Amount'} radius={[6, 6, 0, 0]} fill="#22d3ee" maxBarSize={26}>
            {rows.map((row) => (
              <Cell key={`${row.day}-${row.type}`} fill={row.amount < 0 ? '#f43f5e' : '#10b981'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HorizontalBars({ rows = [], height = 240 }) {
  const { lang } = useI18n();
  const data = rows.slice(0, 8).map((row) => ({ ...row, name: row.name || row.label || '' }));
  if (!data.length) {
    return <div style={{ height }} className="flex items-center justify-center text-[11px] text-slate-500">—</div>;
  }
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 10, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.07)" horizontal={false} />
          <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatNumber(v, lang)} />
          <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={104} />
          <Tooltip content={<ChartTooltip lang={lang} />} cursor={{ fill: 'rgba(148,163,184,0.05)' }} />
          <Bar dataKey="value" name={lang === 'fa' ? 'مصرف' : 'Usage'} radius={[0, 6, 6, 0]} fill="#10b981" maxBarSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LegendDots({ items = [] }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((item) => (
        <span key={item.name} className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
          {item.name}
        </span>
      ))}
    </div>
  );
}
