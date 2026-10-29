import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  History,
  Megaphone,
  Send,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  SearchInput,
  SectionCard,
  Skeleton,
  Textarea,
  cx,
} from '../../components/ui.jsx';
import { useToast } from '../../components/feedback.jsx';

const AUDIENCES = [
  { value: 'all', icon: Users, label: 'broadcasts.all', tone: 'emerald' },
  { value: 'admin', icon: ShieldCheck, label: 'broadcasts.admins', tone: 'cyan' },
  { value: 'selected', icon: CheckCircle2, label: 'broadcasts.selected', tone: 'violet' },
];

const AUDIENCE_LABEL = { all: 'broadcasts.all', admin: 'broadcasts.admins', selected: 'broadcasts.selected' };

function AudienceCard({ option, active, onClick, hint }) {
  const { t } = useI18n();
  const Icon = option.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex flex-1 items-start gap-2.5 rounded-xl border px-3 py-2.5 text-start transition-all duration-200',
        active
          ? 'border-emerald-400/35 bg-emerald-500/[0.09] shadow-[0_0_0_1px_rgba(16,185,129,.18)]'
          : 'border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]'
      )}
    >
      <span
        className={cx(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
          active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.05] text-slate-400'
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className={cx('block text-[12px] font-semibold', active ? 'text-emerald-100' : 'text-slate-200')}>
          {t(option.label)}
        </span>
        {hint ? <span className="mt-0.5 block text-[10px] text-slate-500">{hint}</span> : null}
      </span>
    </button>
  );
}

export default function Broadcasts() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ title: '', body: '', audience: 'all' });
  const [selected, setSelected] = useState([]);
  const [userSearch, setUserSearch] = useState('');

  const usersQuery = useQuery({
    queryKey: ['broadcast-users'],
    queryFn: () => api.get('/admin/users?role=reseller&pageSize=200'),
  });

  const historyQuery = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => api.get('/admin/broadcasts'),
  });

  const resellers = usersQuery.data?.rows || [];
  const filteredUsers = useMemo(() => {
    const term = userSearch.trim().toLowerCase();
    if (!term) return resellers;
    return resellers.filter((user) => [user.username, user.name, user.phone]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(term)));
  }, [resellers, userSearch]);

  const send = useMutation({
    mutationFn: () => api.post('/admin/broadcast', {
      title: form.title.trim(),
      body: form.body.trim(),
      audience: form.audience,
      userIds: form.audience === 'selected' ? selected : undefined,
    }),
    onSuccess: (data) => {
      toast.success(`${t('broadcasts.sent')} · ${data?.recipients ?? 0}`);
      setForm({ title: '', body: '', audience: form.audience });
      setSelected([]);
      queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const toggleRecipient = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((row) => row !== id) : [...prev, id]));
  };

  const recipientsCount = form.audience === 'all'
    ? usersQuery.data?.total || 0
    : form.audience === 'selected'
      ? selected.length
      : null;

  const canSend = form.title.trim().length > 0
    && form.body.trim().length > 0
    && (form.audience !== 'selected' || selected.length > 0);

  const history = historyQuery.data?.rows || [];

  return (
    <>
      <PageHeader title={t('broadcasts.title')} subtitle={t('broadcasts.subtitle')} />

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <SectionCard icon={Megaphone} title={t('broadcasts.new')}>
          <div className="space-y-4">
            <div>
              <span className="label">{t('broadcasts.audience')}</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                {AUDIENCES.map((option) => (
                  <AudienceCard
                    key={option.value}
                    option={option}
                    active={form.audience === option.value}
                    onClick={() => setForm((prev) => ({ ...prev, audience: option.value }))}
                    hint={option.value === 'all' && usersQuery.data ? `${usersQuery.data.total}` : undefined}
                  />
                ))}
              </div>
            </div>

            {form.audience === 'selected' ? (
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-medium text-slate-300">
                    {t('broadcasts.recipients')}
                    <span className="ms-1.5 text-emerald-300">{selected.length}</span>
                  </span>
                  <SearchInput
                    value={userSearch}
                    onChange={setUserSearch}
                    placeholder={t('common.searchPlaceholder')}
                    className="w-44"
                  />
                </div>
                <div className="max-h-52 space-y-1 overflow-y-auto pe-1">
                  {filteredUsers.map((user) => (
                    <label
                      key={user.id}
                      className="flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[12px] transition hover:bg-white/[0.04]"
                    >
                      <Checkbox
                        checked={selected.includes(user.id)}
                        onChange={() => toggleRecipient(user.id)}
                        label={(
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-slate-200">{user.name || user.username}</span>
                            <span className="truncate text-[10px] text-slate-500">@{user.username}</span>
                          </span>
                        )}
                      />
                      {user.status !== 'active' ? <Badge tone="slate">{user.status}</Badge> : null}
                    </label>
                  ))}
                  {!filteredUsers.length ? (
                    <p className="py-6 text-center text-[11.5px] text-slate-500">{t('common.noData')}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            <Field label={t('broadcasts.titleField')} required>
              <Input
                value={form.title}
                maxLength={140}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder={t('broadcasts.titleField')}
              />
            </Field>

            <Field label={t('broadcasts.body')} required>
              <Textarea
                rows={6}
                value={form.body}
                maxLength={2000}
                onChange={(e) => setForm((prev) => ({ ...prev, body: e.target.value }))}
                placeholder={t('broadcasts.body')}
              />
            </Field>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
              <p className="text-[11px] text-slate-500">
                {recipientsCount !== null ? `${t('broadcasts.recipients')}: ${recipientsCount}` : t('broadcasts.audience')}
              </p>
              <Button icon={Send} loading={send.isPending} disabled={!canSend} onClick={() => send.mutate()}>
                {t('broadcasts.send')}
              </Button>
            </div>
          </div>
        </SectionCard>

        <SectionCard icon={History} title={t('broadcasts.history')} bodyClass="p-0">
          {historyQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : historyQuery.isError ? (
            <ErrorState message={historyQuery.error?.message} onRetry={historyQuery.refetch} />
          ) : history.length ? (
            <div className="divide-y divide-white/[0.05]">
              {history.map((row) => (
                <article key={row.id} className="p-4 transition hover:bg-white/[0.02]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                    <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-slate-100">{row.title}</h3>
                    <Badge tone={row.audience === 'admin' ? 'cyan' : row.audience === 'selected' ? 'violet' : 'emerald'}>
                      {t(AUDIENCE_LABEL[row.audience] || AUDIENCE_LABEL.all)}
                    </Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-[11.5px] leading-5 text-slate-400">{row.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span>{relativeTime(row.createdAt, lang)}</span>
                    <span>·</span>
                    <span>{formatDate(row.createdAt, lang, true)}</span>
                    <span className="ms-auto inline-flex items-center gap-1 text-emerald-300/80">
                      <Users className="h-3 w-3" />
                      {new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US').format(row.recipients || 0)}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState icon={Megaphone} title={t('broadcasts.empty')} />
          )}
        </SectionCard>
      </div>
    </>
  );
}
