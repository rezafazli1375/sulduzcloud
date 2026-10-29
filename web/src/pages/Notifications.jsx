import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCheck,
  Inbox,
  Info,
  Megaphone,
  MessageSquare,
} from 'lucide-react';
import { useI18n, translateError } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatDate, relativeTime } from '../lib/format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Skeleton,
  Tabs,
  cx,
} from '../components/ui.jsx';
import { useToast } from '../components/feedback.jsx';

const TYPE_META = {
  broadcast: { icon: Megaphone, tone: 'text-emerald-300', bg: 'bg-emerald-500/10' },
  alert: { icon: AlertTriangle, tone: 'text-rose-300', bg: 'bg-rose-500/10' },
  expiry: { icon: CalendarClock, tone: 'text-amber-300', bg: 'bg-amber-500/10' },
  expiry_warning: { icon: CalendarClock, tone: 'text-amber-300', bg: 'bg-amber-500/10' },
  traffic: { icon: Activity, tone: 'text-violet-300', bg: 'bg-violet-500/10' },
  traffic_warning: { icon: Activity, tone: 'text-violet-300', bg: 'bg-violet-500/10' },
  ticket: { icon: MessageSquare, tone: 'text-cyan-300', bg: 'bg-cyan-500/10' },
  system: { icon: Info, tone: 'text-slate-300', bg: 'bg-white/[0.06]' },
};

export default function Notifications() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [filter]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['notifications', 'page', filter, page],
    queryFn: () => api.get(`/notifications?page=${page}&pageSize=30${filter === 'unread' ? '&unread=1' : ''}`),
    refetchInterval: 45000,
    placeholderData: (prev) => prev,
  });

  const mark = useMutation({
    mutationFn: (id) => api.post('/notifications/read', { id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read', { id: 0 }),
    onSuccess: () => {
      toast.success(t('common.markAllRead'));
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const rows = data?.rows || [];
  const unread = data?.unread || 0;

  const openNotification = (row) => {
    if (!row.readAt) mark.mutate(row.id);
    if (row.link) navigate(row.link);
  };

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        subtitle={unread ? `${unread} ${t('common.unread')}` : t('common.done')}
        actions={(
          <Button
            variant="secondary"
            icon={CheckCheck}
            loading={markAll.isPending}
            disabled={!unread}
            onClick={() => markAll.mutate()}
          >
            {t('notifications.markAll')}
          </Button>
        )}
      />

      <Tabs
        tabs={[
          { value: 'all', label: t('common.all') },
          { value: 'unread', label: `${t('common.unread')}${unread ? ` (${unread})` : ''}` },
        ]}
        active={filter}
        onChange={setFilter}
        className="mb-4 w-fit"
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : rows.length ? (
        <>
          <div className="space-y-2">
            {rows.map((row) => {
              const meta = TYPE_META[row.type] || TYPE_META.system;
              const Icon = meta.icon;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => openNotification(row)}
                  className={cx(
                    'card card-hover flex w-full items-start gap-3 p-3.5 text-start',
                    !row.readAt && 'border-emerald-400/20 bg-emerald-500/[0.035]'
                  )}
                >
                  <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', meta.bg, meta.tone)}>
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={cx('truncate text-[12.5px]', row.readAt ? 'font-medium text-slate-300' : 'font-semibold text-white')}>
                        {row.title}
                      </p>
                      {row.type ? <Badge tone="slate">{row.type}</Badge> : null}
                      {!row.readAt ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,.9)]" /> : null}
                    </div>
                    <p className="mt-1 line-clamp-3 whitespace-pre-line text-[11.5px] leading-5 text-slate-400">{row.body}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                      <span>{relativeTime(row.createdAt, lang)}</span>
                      <span>·</span>
                      <span>{formatDate(row.createdAt, lang, true)}</span>
                      {row.link ? <span className="ms-auto text-emerald-300/80">{t('common.viewAll')}</span> : null}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <Pagination page={page} pageSize={30} total={data?.total || 0} onChange={setPage} />
        </>
      ) : (
        <div className="card">
          <EmptyState
            icon={filter === 'unread' ? CheckCheck : Inbox}
            title={t('notifications.empty')}
            hint={filter === 'unread' ? t('common.done') : t('notifications.title')}
            action={filter === 'unread' ? (
              <Button size="sm" variant="secondary" icon={Bell} onClick={() => setFilter('all')}>
                {t('common.all')}
              </Button>
            ) : null}
          />
        </div>
      )}
    </>
  );
}
