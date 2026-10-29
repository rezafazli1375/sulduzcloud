import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Inbox,
  MessageSquare,
  Plus,
  Send,
  Ticket as TicketIcon,
  UserRound,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n, translateError } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatDate, relativeTime } from '../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  TableSkeleton,
  Textarea,
  Toolbar,
  cx,
} from '../components/ui.jsx';
import { useToast } from '../components/feedback.jsx';

function NewTicketModal({ open, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ subject: '', body: '', priority: 'normal' });

  useEffect(() => { if (open) setForm({ subject: '', body: '', priority: 'normal' }); }, [open]);

  const create = useMutation({
    mutationFn: () => api.post('/tickets', form),
    onSuccess: () => {
      toast.success(t('tickets.created'));
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
      onClose?.();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('tickets.new')}
      subtitle={t('tickets.newHint')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button icon={Send} loading={create.isPending} onClick={() => create.mutate()} disabled={!form.subject.trim() || !form.body.trim()}>
            {t('tickets.send')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('tickets.subject')} required>
          <Input value={form.subject} onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))} placeholder="—" />
        </Field>
        <Field label={t('tickets.message')} required>
          <Textarea rows={5} value={form.body} onChange={(e) => setForm((prev) => ({ ...prev, body: e.target.value }))} placeholder={t('tickets.replyPlaceholder')} />
        </Field>
        <Field label={t('common.priority')}>
          <Select value={form.priority} onChange={(e) => setForm((prev) => ({ ...prev, priority: e.target.value }))}>
            <option value="low">{t('common.low')}</option>
            <option value="normal">{t('common.normal')}</option>
            <option value="high">{t('common.high')}</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function TicketDetail({ ticketId, onClose }) {
  const { t, lang } = useI18n();
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const scrollRef = useRef(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => api.get(`/tickets/${ticketId}`),
    enabled: Boolean(ticketId),
  });

  const messages = data?.messages || [];

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, ticketId]);

  const send = useMutation({
    mutationFn: () => api.post(`/tickets/${ticketId}/reply`, { body: reply }),
    onSuccess: () => {
      setReply('');
      toast.success(t('tickets.replied'));
      queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const setStatus = useMutation({
    mutationFn: (status) => api.post(`/tickets/${ticketId}/status`, { status }),
    onSuccess: () => {
      toast.success(t('tickets.closedMsg'));
      queryClient.invalidateQueries({ queryKey: ['ticket', ticketId] });
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  return (
    <Drawer
      open={Boolean(ticketId)}
      onClose={onClose}
      title={data?.subject || t('tickets.title')}
      subtitle={data ? `#${data.id} · ${formatDate(data.createdAt, lang, true)}` : ''}
      width="max-w-2xl"
      footer={
        data && data.status !== 'closed' ? (
          <div className="flex w-full items-end gap-2">
            <Textarea
              rows={2}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={t('tickets.replyPlaceholder')}
              className="min-h-[44px] flex-1"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && reply.trim()) send.mutate();
              }}
            />
            <Button icon={Send} loading={send.isPending} onClick={() => send.mutate()} disabled={!reply.trim()}>{t('tickets.reply')}</Button>
          </div>
        ) : null
      }
    >
      {isLoading ? (
        <div className="space-y-3"><div className="skeleton h-16" /><div className="skeleton h-16" /><div className="skeleton h-16" /></div>
      ) : isError ? (
        <ErrorState message={error?.message} onRetry={refetch} />
      ) : data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.status} />
            <Badge tone={data.priority === 'high' ? 'rose' : data.priority === 'low' ? 'slate' : 'cyan'}>{t(`common.${data.priority}`)}</Badge>
            <span className="text-[10.5px] text-slate-500">{relativeTime(data.updatedAt, lang)}</span>
            {isAdmin && data.status !== 'closed' ? (
              <Button size="xs" variant="ghost" icon={XCircle} className="ms-auto" onClick={() => setStatus.mutate('closed')}>
                {t('tickets.closeTicket')}
              </Button>
            ) : null}
            {isAdmin && data.status === 'closed' ? (
              <Button size="xs" variant="ghost" icon={CheckCheck} className="ms-auto" onClick={() => setStatus.mutate('open')}>
                {t('common.open')}
              </Button>
            ) : null}
          </div>

          <div ref={scrollRef} className="max-h-[55vh] space-y-3 overflow-y-auto pe-1">
            {messages.map((message) => {
              const mine = isAdmin ? message.isStaff : !message.isStaff;
              return (
                <div key={message.id} className={cx('flex gap-2.5', mine ? 'flex-row-reverse' : 'flex-row')}>
                  <Avatar name={message.isStaff ? (message.username || 'S') : data.user?.name || data.username || 'U'} size="sm" />
                  <div
                    className={cx(
                      'max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[12px] leading-6',
                      message.isStaff
                        ? 'border border-emerald-400/20 bg-emerald-500/[0.08] text-emerald-50'
                        : 'border border-white/[0.07] bg-white/[0.04] text-slate-200'
                    )}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-[9.5px] text-slate-500">
                      <span className="font-medium text-slate-400">{message.isStaff ? t('tickets.staff') : `@${message.username || data.username || ''}`}</span>
                      <span>·</span>
                      <span>{formatDate(message.createdAt, lang, true)}</span>
                    </div>
                    <p className="whitespace-pre-line">{message.body}</p>
                  </div>
                </div>
              );
            })}
            {!messages.length ? <EmptyState icon={MessageSquare} title={t('common.noData')} className="py-8" /> : null}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

export default function Tickets() {
  const { t, lang } = useI18n();
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);

  useEffect(() => { setPage(1); }, [status]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tickets', isAdmin ? 'admin' : 'reseller', status, page],
    queryFn: () => api.get(`${isAdmin ? '/admin/tickets' : '/tickets'}?status=${status}&page=${page}&pageSize=20`),
    refetchInterval: 60000,
    placeholderData: (prev) => prev,
  });

  const rows = data?.rows || [];

  return (
    <>
      <PageHeader
        title={t('tickets.title')}
        subtitle={t('tickets.subtitle')}
        actions={<Button icon={Plus} onClick={() => setNewOpen(true)}>{t('tickets.new')}</Button>}
      />

      <Toolbar>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-[140px]">
          <option value="">{t('common.allStatuses')}</option>
          <option value="open">{t('common.open')}</option>
          <option value="answered">{t('common.answered')}</option>
          <option value="closed">{t('common.closed')}</option>
        </Select>
      </Toolbar>

      {isLoading ? (
        <div className="table-wrap"><TableSkeleton rows={6} cols={4} /></div>
      ) : isError ? (
        <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
      ) : rows.length ? (
        <>
          <div className="space-y-2">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setDetailId(row.id)}
                className="card card-hover flex w-full items-center gap-3 p-3.5 text-start"
              >
                <span className={cx(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                  row.status === 'open' ? 'bg-cyan-500/10 text-cyan-300' : row.status === 'answered' ? 'bg-violet-500/10 text-violet-300' : 'bg-white/[0.04] text-slate-500'
                )}>
                  <TicketIcon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[12.5px] font-semibold text-slate-100">{row.subject}</p>
                    <StatusBadge status={row.status} />
                    {row.priority === 'high' ? <Badge tone="rose">{t('common.high')}</Badge> : null}
                  </div>
                  <p className="mt-1 truncate text-[11px] text-slate-500">{row.lastMessage || '—'}</p>
                  {isAdmin ? (
                    <p className="mt-1 flex items-center gap-1 text-[9.5px] text-slate-600">
                      <UserRound className="h-3 w-3" />{row.name || `@${row.username}`} · {formatNumberMessageCount(row.messageCount, lang, t)}
                    </p>
                  ) : (
                    <p className="mt-1 text-[9.5px] text-slate-600">{formatNumberMessageCount(row.messageCount, lang, t)}</p>
                  )}
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-[10px] text-slate-500">{relativeTime(row.updatedAt, lang)}</p>
                  <span className="mt-1 inline-flex items-center gap-1 text-[9.5px] text-slate-600">
                    {row.lastReplyBy === 'admin' ? t('tickets.staff') : t('tickets.you')}
                  </span>
                </div>
                <ChevronLeft className="h-4 w-4 shrink-0 text-slate-600 rtl:block ltr:hidden" />
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 ltr:block rtl:hidden" />
              </button>
            ))}
          </div>
          <Pagination page={page} pageSize={20} total={data?.total || 0} onChange={setPage} />
        </>
      ) : (
        <div className="card">
          <EmptyState
            icon={Inbox}
            title={t('tickets.empty')}
            action={<Button size="sm" icon={Plus} onClick={() => setNewOpen(true)}>{t('tickets.new')}</Button>}
          />
        </div>
      )}

      <NewTicketModal open={newOpen} onClose={() => setNewOpen(false)} />
      <TicketDetail ticketId={detailId} onClose={() => setDetailId(null)} />
    </>
  );
}

function formatNumberMessageCount(count, lang, t) {
  const n = Number(count || 0);
  return `${n.toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US')} ${t('common.message')}`;
}
