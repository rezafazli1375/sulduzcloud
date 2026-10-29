import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Boxes,
  CircleDollarSign,
  Eye,
  EyeOff,
  Network,
  RefreshCw,
  Router,
  Server,
  Settings2,
  Signal,
  SlidersHorizontal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { nodeLabel } from '../../lib/nodes.js';
import { formatBytes, formatMoney, formatNumber } from '../../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  SectionCard,
  Select,
  StatusBadge,
  Switch,
  TableSkeleton,
  Toolbar,
  cx,
  useDebounced,
} from '../../components/ui.jsx';
import { useConfirm, useToast } from '../../components/feedback.jsx';

function PriceCell({ row, lang, t }) {
  const has = row.priceFixed || row.pricePerGb || row.pricePerDay;
  if (!has) return <span className="text-[11px] text-slate-600">—</span>;
  return (
    <div className="space-y-0.5 text-[10px] text-slate-400">
      {row.priceFixed ? <p>{t('inbounds.price.fixed')}: {formatNumber(row.priceFixed, lang)}</p> : null}
      {row.pricePerGb ? <p>{t('inbounds.price.perGb')}: {formatNumber(row.pricePerGb, lang)}</p> : null}
      {row.pricePerDay ? <p>{t('inbounds.price.perDay')}: {formatNumber(row.pricePerDay, lang)}</p> : null}
    </div>
  );
}

export default function Inbounds() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [node, setNode] = useState('');
  const [visibility, setVisibility] = useState('');
  const [selected, setSelected] = useState([]);
  const [editing, setEditing] = useState(null);
  const [priceForm, setPriceForm] = useState({ price_fixed: 0, price_per_gb: 0, price_per_day: 0 });

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['inbounds', 'admin', 'list'],
    queryFn: () => api.get('/admin/inbounds'),
  });

  const rows = data?.rows || [];
  const nodes = useMemo(() => [...new Set(rows.map((row) => row.nodeName || 'local'))], [rows]);

  const filtered = useMemo(() => {
    const term = debounced.trim().toLowerCase();
    return rows.filter((row) => {
      if (node && (row.nodeName || 'local') !== node) return false;
      if (visibility === 'visible' && !row.visible) return false;
      if (visibility === 'hidden' && row.visible) return false;
      if (term && !`${row.remark} ${row.protocol} ${row.tag} ${row.port} ${row.nodeName} ${row.serverName}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [rows, node, visibility, debounced]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['inbounds'] });
  };

  const sync = useMutation({
    mutationFn: () => api.post('/admin/inbounds/sync'),
    onSuccess: (result) => {
      toast.success(`${t('inbounds.synced')} · ${formatNumber(result?.count, lang)}`);
      invalidate();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }) => api.patch(`/admin/inbounds/${id}`, patch),
    onSuccess: () => { toast.success(t('common.saved')); setEditing(null); invalidate(); },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const bulk = useMutation({
    mutationFn: ({ ids, visible }) => api.post('/admin/inbounds/visibility', { ids, visible }),
    onSuccess: (result) => {
      toast.success(`${t('common.saved')} · ${formatNumber(result?.updated, lang)}`);
      setSelected([]);
      invalidate();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const openEdit = (row) => {
    setEditing(row);
    setPriceForm({ price_fixed: row.priceFixed || 0, price_per_gb: row.pricePerGb || 0, price_per_day: row.pricePerDay || 0 });
  };

  const allSelected = filtered.length > 0 && filtered.every((row) => selected.includes(row.id));
  const toggleAll = () => setSelected(allSelected ? [] : filtered.map((row) => row.id));
  const toggleRow = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));

  const onlineCount = rows.filter((row) => row.nodeStatus === 'up' || row.nodeStatus === 'online').length;
  const visibleCount = rows.filter((row) => row.visible).length;

  return (
    <>
      <PageHeader
        title={t('inbounds.title')}
        subtitle={t('inbounds.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={RefreshCw} onClick={() => sync.mutate()} loading={sync.isPending}>{t('inbounds.sync')}</Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: t('common.inbounds'), value: formatNumber(rows.length, lang), icon: Network, tone: 'bg-emerald-500/10 text-emerald-300' },
          { label: t('common.visible'), value: formatNumber(visibleCount, lang), icon: Eye, tone: 'bg-cyan-500/10 text-cyan-300' },
          { label: t('common.hidden'), value: formatNumber(rows.length - visibleCount, lang), icon: EyeOff, tone: 'bg-slate-500/10 text-slate-300' },
          { label: t('dash.nodeOnline'), value: formatNumber(onlineCount, lang), icon: Wifi, tone: 'bg-violet-500/10 text-violet-300' },
        ].map((item) => (
          <div key={item.label} className="card flex items-center gap-3 p-3.5">
            <span className={cx('kpi-icon', item.tone)}><item.icon className="h-[18px] w-[18px]" /></span>
            <div>
              <p className="text-[10px] text-slate-500">{item.label}</p>
              <p className="mt-0.5 text-base font-bold text-white">{item.value}</p>
            </div>
          </div>
        ))}
      </div>

      <Toolbar>
        <SearchInput value={search} onChange={setSearch} placeholder={t('common.search')} className="w-full max-w-xs" />
        <Select value={node} onChange={(e) => setNode(e.target.value)} className="w-auto max-w-[180px]">
          <option value="">{t('common.nodes')}</option>
          {nodes.map((name) => <option key={name} value={name}>{name}</option>)}
        </Select>
        <Select value={visibility} onChange={(e) => setVisibility(e.target.value)} className="w-auto max-w-[140px]">
          <option value="">{t('inbounds.table.visibility')}</option>
          <option value="visible">{t('common.visible')}</option>
          <option value="hidden">{t('common.hidden')}</option>
        </Select>
        {selected.length ? (
          <div className="flex items-center gap-1.5 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.06] px-2 py-1">
            <span className="text-[10.5px] text-emerald-200">{formatNumber(selected.length, lang)} {t('common.select')}</span>
            <Button size="xs" variant="soft" icon={Eye} onClick={() => bulk.mutate({ ids: selected, visible: true })}>{t('common.visible')}</Button>
            <Button size="xs" variant="ghost" icon={EyeOff} onClick={() => bulk.mutate({ ids: selected, visible: false })}>{t('common.hidden')}</Button>
          </div>
        ) : null}
        <div className="ms-auto">
          <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={() => refetch()} className={cx(isFetching && '[&>svg]:animate-spin')} />
        </div>
      </Toolbar>

      {isLoading ? (
        <div className="table-wrap"><TableSkeleton rows={7} cols={6} /></div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : filtered.length ? (
        <div className="table-wrap">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10"><Checkbox checked={allSelected} onChange={toggleAll} /></th>
                  <th>{t('inbounds.table.remark')}</th>
                  <th>{t('inbounds.table.server')}</th>
                  <th>{t('inbounds.table.subOrder')}</th>
                  <th>{t('inbounds.table.node')}</th>
                  <th>{t('inbounds.table.protocol')}</th>
                  <th>{t('inbounds.table.configs')}</th>
                  <th>{t('inbounds.table.price')}</th>
                  <th>{t('inbounds.table.visibility')}</th>
                  <th>{t('inbounds.table.status')}</th>
                  <th className="text-end">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id}>
                    <td><Checkbox checked={selected.includes(row.id)} onChange={() => toggleRow(row.id)} /></td>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/15 to-cyan-500/10 text-emerald-300">
                          <Signal className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="max-w-[180px] truncate text-[12px] font-medium text-slate-200">{row.remark || `#${row.id}`}</p>
                          <p className="truncate text-[9.5px] text-slate-500">#{row.id} · {row.tag || '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <p className="max-w-[140px] truncate text-[11.5px] text-slate-300">{row.serverName || '—'}</p>
                      <p className="text-[9.5px] text-slate-500">#{formatNumber(row.xuiId ?? row.id, lang)}</p>
                    </td>
                    <td>
                      {row.subSortIndex > 0 ? (
                        <Badge tone="slate" className="font-mono">#{formatNumber(row.subSortIndex, lang)}</Badge>
                      ) : (
                        <span className="text-[11px] text-slate-600">—</span>
                      )}
                    </td>
                    <td>
                      <p className="flex items-center gap-1 text-[11.5px] text-slate-300"><Server className="h-3 w-3 text-slate-500" />{nodeLabel(row.nodeName, lang)}</p>
                      <p className="text-[9.5px] text-slate-500">{row.nodeAddress || '—'}</p>
                    </td>
                    <td>
                      <Badge tone="cyan" className="uppercase">{row.protocol}</Badge>
                      <p className="mt-1 text-[9.5px] text-slate-500">{row.network || 'tcp'} · :{row.port}</p>
                    </td>
                    <td>
                      <p className="text-[11.5px] font-medium text-slate-300">{formatNumber(row.configCount, lang)}</p>
                      <p className="text-[9.5px] text-slate-500">{formatBytes(row.usedBytes, lang)}</p>
                    </td>
                    <td><PriceCell row={row} lang={lang} t={t} /></td>
                    <td>
                      <button
                        type="button"
                        onClick={() => update.mutate({ id: row.id, patch: { visible: !row.visible } })}
                        className={cx(
                          'flex h-7 w-7 items-center justify-center rounded-lg border transition',
                          row.visible
                            ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                            : 'border-white/10 bg-white/[0.04] text-slate-500 hover:text-slate-300'
                        )}
                        title={t('inbounds.visibilityHint')}
                      >
                        {row.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <StatusBadge status={row.enabled ? 'active' : 'disabled'} />
                        {row.nodeStatus ? (
                          <span className={cx('text-[9.5px]', row.nodeStatus === 'up' || row.nodeStatus === 'online' ? 'text-emerald-400/80' : 'text-rose-400/80')}>
                            {row.nodeStatus === 'up' || row.nodeStatus === 'online' ? t('common.online') : t('common.offline')}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center justify-end">
                        <IconButton icon={CircleDollarSign} label={t('inbounds.price.total')} onClick={() => openEdit(row)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/[0.06] px-4 py-2.5 text-[10.5px] text-slate-500">{t('inbounds.subOrderHint')} · {t('inbounds.visibilityHint')}</div>
        </div>
      ) : (
        <div className="card">
          <EmptyState
            icon={Network}
            title={t('inbounds.empty')}
            action={<Button size="sm" icon={RefreshCw} onClick={() => sync.mutate()} loading={sync.isPending}>{t('inbounds.sync')}</Button>}
          />
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.remark || t('inbounds.price.total')}
        subtitle={`${editing?.protocol || ''} · :${editing?.port || ''} · ${nodeLabel(editing?.nodeName, lang)}`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
            <Button
              loading={update.isPending}
              onClick={() => update.mutate({ id: editing.id, patch: {
                price_fixed: Number(priceForm.price_fixed || 0),
                price_per_gb: Number(priceForm.price_per_gb || 0),
                price_per_day: Number(priceForm.price_per_day || 0),
                visible: Boolean(editing.visible),
              } })}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('inbounds.price.fixed')}>
            <Input type="number" min={0} value={priceForm.price_fixed} onChange={(e) => setPriceForm((prev) => ({ ...prev, price_fixed: e.target.value }))} dir="ltr" />
          </Field>
          <Field label={t('inbounds.price.perGb')}>
            <Input type="number" min={0} value={priceForm.price_per_gb} onChange={(e) => setPriceForm((prev) => ({ ...prev, price_per_gb: e.target.value }))} dir="ltr" />
          </Field>
          <Field label={t('inbounds.price.perDay')}>
            <Input type="number" min={0} value={priceForm.price_per_day} onChange={(e) => setPriceForm((prev) => ({ ...prev, price_per_day: e.target.value }))} dir="ltr" />
          </Field>
        </div>
        <p className="mt-2 text-[10.5px] leading-5 text-slate-500">
          {t('inbounds.price.formula')}
        </p>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-white/[0.03] px-3 py-2">
          <span className="text-[11px] text-slate-400">{t('inbounds.table.visibility')}</span>
          <Switch
            checked={Boolean(editing?.visible)}
            onChange={(value) => setEditing((prev) => ({ ...prev, visible: value }))}
          />
        </div>
        {editing ? (
          <p className="mt-3 text-[10.5px] text-slate-500">
            {formatNumber(editing.configCount, lang)} {t('common.configs')} · {formatBytes(editing.usedBytes, lang)}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
