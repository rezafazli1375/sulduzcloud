import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  FilterX,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useI18n } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, relativeTime } from '../../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Pagination,
  Select,
  TableSkeleton,
  Toolbar,
  cx,
} from '../../components/ui.jsx';

const ACTIONS = [
  'auth.login',
  'auth.logout',
  'auth.password_change',
  'user.create',
  'user.update',
  'user.delete',
  'user.balance',
  'user.password_reset',
  'user.api_key',
  'config.create',
  'config.extend',
  'config.quota',
  'config.toggle',
  'config.reset',
  'config.delete',
  'config.sync',
  'inbound.update',
  'inbound.sync',
  'ticket.create',
  'ticket.reply',
  'ticket.status',
  'broadcast.send',
  'backup.create',
  'backup.delete',
  'backup.restore',
  'settings.update',
];

const ENTITIES = ['user', 'config', 'inbound', 'ticket', 'settings', 'backup', 'broadcast', 'auth'];

const ACTION_TONE = {
  create: 'emerald',
  update: 'cyan',
  delete: 'rose',
  restore: 'amber',
  sync: 'violet',
  login: 'slate',
  logout: 'slate',
};

function actionTone(action) {
  const suffix = String(action || '').split('.').pop();
  return ACTION_TONE[suffix] || 'slate';
}

export default function Audit() {
  const { t, lang } = useI18n();
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => { setPage(1); }, [action, entity, userId]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['audit', action, entity, userId, page],
    queryFn: () => {
      const query = new URLSearchParams({ page: String(page), pageSize: '30' });
      if (action) query.set('action', action);
      if (entity) query.set('entity', entity);
      if (userId) query.set('userId', userId);
      return api.get(`/admin/audit?${query.toString()}`);
    },
    placeholderData: (prev) => prev,
  });

  const rows = data?.rows || [];
  const hasFilters = Boolean(action || entity || userId);

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
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

      <Toolbar>
        <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-auto min-w-[170px]">
          <option value="">{t('audit.action')}</option>
          {ACTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-auto min-w-[140px]">
          <option value="">{t('audit.entity')}</option>
          {ENTITIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        <input
          type="number"
          min="0"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder={`${t('audit.user')} ID`}
          className="input w-32"
        />
        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            icon={FilterX}
            onClick={() => { setAction(''); setEntity(''); setUserId(''); }}
          >
            {t('common.reset')}
          </Button>
        ) : null}
        <span className="ms-auto text-[11px] text-slate-500">
          {t('common.total')}: {new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US').format(data?.total || 0)}
        </span>
      </Toolbar>

      <div className="table-wrap">
        {isLoading ? (
          <TableSkeleton rows={8} cols={5} />
        ) : isError ? (
          <ErrorState message={error?.message} onRetry={refetch} />
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('audit.time')}</th>
                  <th>{t('audit.user')}</th>
                  <th>{t('audit.action')}</th>
                  <th>{t('audit.entity')}</th>
                  <th>{t('audit.ip')}</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isOpen = expanded === row.id;
                  const details = row.details && Object.keys(row.details).length ? row.details : null;
                  return (
                    <React.Fragment key={row.id}>
                      <tr className={isOpen ? 'bg-white/[0.03]' : undefined}>
                        <td className="whitespace-nowrap">
                          <p className="text-[11.5px] text-slate-300">{formatDate(row.createdAt, lang, true)}</p>
                          <p className="mt-0.5 text-[10px] text-slate-500">{relativeTime(row.createdAt, lang)}</p>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <Avatar name={row.username || 'S'} size="xs" />
                            <div className="min-w-0">
                              <p className="truncate text-[11.5px] font-medium text-slate-200">{row.username}</p>
                              <p className="mt-0.5 text-[9.5px] text-slate-500">
                                {row.role ? t(`common.${row.role}`) : '—'}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Badge tone={actionTone(row.action)}>{row.action}</Badge>
                        </td>
                        <td className="whitespace-nowrap">
                          <span className="text-[11.5px] text-slate-300">{row.entity || '—'}</span>
                          {row.entityId ? <span className="ms-1.5 font-mono text-[10px] text-slate-500">#{row.entityId}</span> : null}
                        </td>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-slate-500">{row.ip || '—'}</td>
                        <td>
                          {details ? (
                            <IconButton
                              icon={isOpen ? ChevronUp : ChevronDown}
                              label={t('audit.details')}
                              className="h-7 w-7"
                              onClick={() => setExpanded(isOpen ? null : row.id)}
                            />
                          ) : null}
                        </td>
                      </tr>
                      {isOpen && details ? (
                        <tr>
                          <td colSpan={6} className="!bg-[#070d18]/80">
                            <div className="flex items-start gap-2.5 py-1">
                              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
                              <pre
                                dir="ltr"
                                className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[10.5px] leading-5 text-slate-300"
                              >
                                {JSON.stringify(details, null, 2)}
                              </pre>
                            </div>
                            {row.ua ? (
                              <p dir="ltr" className="mt-1 truncate ps-6 font-mono text-[9.5px] text-slate-600">{row.ua}</p>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={ScrollText}
            title={t('audit.empty')}
            hint={hasFilters ? t('common.reset') : t('audit.subtitle')}
            action={hasFilters ? (
              <Button size="sm" variant="secondary" icon={FilterX} onClick={() => { setAction(''); setEntity(''); setUserId(''); }}>
                {t('common.reset')}
              </Button>
            ) : null}
          />
        )}
      </div>

      {rows.length ? (
        <Pagination page={page} pageSize={30} total={data?.total || 0} onChange={setPage} />
      ) : null}
    </>
  );
}
