import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  DatabaseBackup,
  Download,
  HardDrive,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api, downloadFile } from '../../lib/api.js';
import { formatBytes, formatDate, formatNumber, relativeTime } from '../../lib/format.js';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SectionCard,
  StatCard,
  Switch,
  TableSkeleton,
  cx,
} from '../../components/ui.jsx';
import { useConfirm, useToast } from '../../components/feedback.jsx';

function RestoreModal({ open, onClose, onRestarted }) {
  const { t } = useI18n();
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [phrase, setPhrase] = useState('');
  const [restarting, setRestarting] = useState(false);
  const [waited, setWaited] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setPhrase('');
      setRestarting(false);
      setWaited(0);
    }
  }, [open]);

  useEffect(() => {
    if (!restarting) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      setWaited((prev) => prev + 2);
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok && !cancelled) {
          clearInterval(timer);
          onRestarted?.();
        }
      } catch (_) {
        /* server is restarting */
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [restarting, onRestarted]);

  const restore = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('confirm', phrase);
      return api.upload('/admin/backups/restore', fd);
    },
    onSuccess: () => {
      setRestarting(true);
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const pickFile = (picked) => {
    if (!picked) return;
    if (!/\.db$/i.test(picked.name)) {
      toast.error(t('backups.invalid'));
      return;
    }
    setFile(picked);
  };

  return (
    <Modal
      open={open}
      onClose={restarting ? undefined : onClose}
      title={t('backups.restoreTitle')}
      subtitle={t('backups.restore')}
      size="md"
      footer={!restarting ? (
        <>
          <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            icon={RotateCcw}
            loading={restore.isPending}
            disabled={!file || phrase.trim() !== 'RESTORE'}
            onClick={() => restore.mutate()}
          >
            {restore.isPending ? t('backups.restoring') : t('backups.restore')}
          </Button>
        </>
      ) : null}
    >
      {restarting ? (
        <div className="flex flex-col items-center py-6 text-center">
          <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-500/10 text-emerald-300">
            <RefreshCw className="h-7 w-7 animate-spin" />
          </span>
          <h3 className="mt-4 text-sm font-semibold text-white">{t('backups.restoring')}</h3>
          <p className="mt-2 max-w-sm text-[12px] leading-6 text-slate-400">{t('backups.restoreWarning')}</p>
          <p className="mt-4 font-mono text-[11px] text-slate-500">{waited}s</p>
          {waited >= 90 ? (
            <Button variant="secondary" size="sm" className="mt-4" icon={RefreshCw} onClick={() => window.location.reload()}>
              {t('common.refresh')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] p-3.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            <p className="text-[11.5px] leading-6 text-rose-100/90">{t('backups.restoreWarning')}</p>
          </div>

          <Field label={t('backups.upload')} required>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-start transition',
                file
                  ? 'border-emerald-400/35 bg-emerald-500/[0.06]'
                  : 'border-white/15 bg-white/[0.02] hover:border-emerald-400/30 hover:bg-white/[0.04]'
              )}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] text-slate-300">
                <Upload className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium text-slate-200">
                  {file ? file.name : t('backups.upload')}
                </span>
                <span className="mt-0.5 block text-[10.5px] text-slate-500">
                  {file ? formatBytes(file.size) : '.db'}
                </span>
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".db,application/x-sqlite3,application/octet-stream"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </Field>

          <Field label={t('backups.confirmPhrase')} hint="RESTORE" required>
            <Input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="RESTORE"
              className="font-mono"
              autoComplete="off"
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

export default function Backups() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [sched, setSched] = useState(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get('/admin/backups'),
    refetchInterval: 60000,
  });

  const schedule = data?.schedule;
  const schedAuto = schedule?.auto;
  const schedHour = schedule?.hour;
  const schedMinute = schedule?.minute;
  const schedKeep = schedule?.keep;
  useEffect(() => {
    if (!schedule) return;
    setSched({ auto: Boolean(schedAuto), hour: String(schedHour ?? 3), minute: String(schedMinute ?? 30), keep: String(schedKeep ?? 14) });
  }, [schedAuto, schedHour, schedMinute, schedKeep, Boolean(schedule)]);

  const saveSchedule = useMutation({
    mutationFn: (payload) => api.patch('/admin/backups/schedule', payload),
    onSuccess: () => {
      toast.success(t('backups.scheduleSaved'));
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const create = useMutation({
    mutationFn: () => api.post('/admin/backups'),
    onSuccess: () => {
      toast.success(t('backups.created'));
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const remove = useMutation({
    mutationFn: (name) => api.del(`/admin/backups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success(t('backups.deleted'));
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const sendTelegram = useMutation({
    mutationFn: (name) => api.post(`/admin/backups/${encodeURIComponent(name)}/telegram`),
    onSuccess: () => toast.success(t('backups.telegramSent')),
    onError: (err) => toast.error(translateError(err, t)),
  });

  const telegramReady = Boolean(data?.telegram?.configured);

  const askDelete = async (row) => {
    const ok = await confirm({
      title: t('common.confirmDelete'),
      body: `${row.name}\n${t('common.irreversible')}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) remove.mutate(row.name);
  };

  const rows = data?.rows || [];
  const totalSize = rows.reduce((sum, row) => sum + Number(row.size || 0), 0);
  const latest = rows[0];

  return (
    <>
      <PageHeader
        title={t('backups.title')}
        subtitle={t('backups.subtitle')}
        actions={(
          <>
            <Button
              variant="secondary"
              icon={RotateCcw}
              onClick={() => setRestoreOpen(true)}
            >
              {t('backups.restore')}
            </Button>
            <Button icon={Plus} loading={create.isPending} onClick={() => create.mutate()}>
              {t('backups.create')}
            </Button>
          </>
        )}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={DatabaseBackup}
          label={t('backups.title')}
          value={formatNumber(rows.length, lang)}
          hint={`${data?.auto ? t('backups.auto') : t('common.disabled')}${data?.telegram?.enabled && data?.telegram?.configured ? ` · ${t('settings.tabs.telegram')}` : ''}`}
          tone="emerald"
        />
        <StatCard
          icon={HardDrive}
          label={t('backups.size')}
          value={formatBytes(totalSize, lang)}
          hint={`${formatNumber(rows.length, lang)} ${t('common.files')}`}
          tone="cyan"
        />
        <StatCard
          icon={CalendarClock}
          label={t('backups.backupTime')}
          value={latest ? relativeTime(latest.createdAt, lang) : '—'}
          hint={latest ? formatDate(latest.createdAt, lang, true) : ''}
          tone="violet"
        />
      </div>

      {sched ? (
        <SectionCard
          icon={CalendarClock}
          title={t('backups.schedule')}
          subtitle={schedule?.timezone ? `${t('backups.timezone')}: ${schedule.timezone}` : undefined}
          className="mb-4"
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 sm:col-span-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-slate-200">{t('settings.backup.auto')}</p>
                <p className="mt-0.5 text-[10px] text-slate-500">{sched.auto ? t('backups.scheduleOn') : t('common.disabled')}</p>
              </div>
              <Switch checked={sched.auto} onChange={(value) => setSched((prev) => ({ ...prev, auto: value }))} />
            </div>
            <Field label={t('settings.backup.hour')} hint="0 – 23">
              <Input type="number" min="0" max="23" dir="ltr" value={sched.hour} onChange={(e) => setSched((prev) => ({ ...prev, hour: e.target.value }))} />
            </Field>
            <Field label={t('settings.backup.minute')} hint="0 – 59">
              <Input type="number" min="0" max="59" dir="ltr" value={sched.minute} onChange={(e) => setSched((prev) => ({ ...prev, minute: e.target.value }))} />
            </Field>
            <Field label={t('settings.backup.keep')} hint="1 – 60" className="sm:col-span-2">
              <Input type="number" min="1" max="60" dir="ltr" value={sched.keep} onChange={(e) => setSched((prev) => ({ ...prev, keep: e.target.value }))} />
            </Field>
            <div className="flex items-end pb-0.5 sm:col-span-2 sm:justify-end">
              <Button
                size="sm"
                loading={saveSchedule.isPending}
                onClick={() => saveSchedule.mutate({
                  auto: sched.auto,
                  hour: Number(sched.hour || 0),
                  minute: Number(sched.minute || 0),
                  keep: Number(sched.keep || 14),
                })}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-5 text-slate-500">{t('backups.scheduleHint')}</p>
        </SectionCard>
      ) : null}

      <SectionCard
        icon={Archive}
        title={t('backups.title')}
        subtitle={data?.auto ? t('backups.auto') : undefined}
        bodyClass="p-0"
        actions={(
          <>
            {data?.telegram?.enabled && data?.telegram?.configured ? (
              <Badge tone="cyan" dot>{t('settings.tabs.telegram')}</Badge>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              icon={RefreshCw}
              className={isFetching ? 'opacity-60' : ''}
              onClick={() => refetch()}
            >
              {t('common.refresh')}
            </Button>
          </>
        )}
      >
        {isLoading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : isError ? (
          <ErrorState message={error?.message} onRetry={refetch} />
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('backups.name')}</th>
                  <th>{t('backups.size')}</th>
                  <th>{t('common.createdAt')}</th>
                  <th className="!text-end">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.name}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <span className={cx(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                          row.name.includes('-auto') ? 'bg-cyan-500/10 text-cyan-300' : 'bg-emerald-500/10 text-emerald-300'
                        )}>
                          <DatabaseBackup className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[11.5px] text-slate-200">{row.name}</p>
                          <p className="mt-0.5 text-[10px] text-slate-500">
                            {row.name.includes('-auto') ? t('backups.auto') : t('common.manual')}
                            {index === 0 ? ` · ${t('common.latest')}` : ''}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap font-mono text-[11.5px] text-slate-400">{formatBytes(row.size, lang)}</td>
                    <td className="whitespace-nowrap">
                      <p className="text-[11.5px] text-slate-300">{formatDate(row.createdAt, lang, true)}</p>
                      <p className="mt-0.5 text-[10px] text-slate-500">{relativeTime(row.createdAt, lang)}</p>
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        <IconButton
                          icon={Send}
                          label={telegramReady ? t('backups.telegram') : t('backups.telegramDisabled')}
                          disabled={!telegramReady || sendTelegram.isPending}
                          className={cx(sendTelegram.isPending && sendTelegram.variables === row.name ? '[&>svg]:animate-pulse' : '')}
                          onClick={() => sendTelegram.mutate(row.name)}
                        />
                        <IconButton
                          icon={Download}
                          label={t('backups.download')}
                          onClick={() => downloadFile(`/admin/backups/${encodeURIComponent(row.name)}/download`, row.name)}
                        />
                        <IconButton
                          icon={Trash2}
                          label={t('common.delete')}
                          variant="danger"
                          onClick={() => askDelete(row)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={DatabaseBackup}
            title={t('backups.empty')}
            hint={t('backups.subtitle')}
            action={(
              <Button size="sm" icon={Plus} loading={create.isPending} onClick={() => create.mutate()}>
                {t('backups.create')}
              </Button>
            )}
          />
        )}
      </SectionCard>

      <RestoreModal
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        onRestarted={() => window.location.reload()}
      />
    </>
  );
}
