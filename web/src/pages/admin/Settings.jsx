import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  CreditCard,
  DatabaseBackup,
  Download,
  Globe2,
  KeyRound,
  Lock,
  Mail,
  MessageSquareText,
  Plug,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { formatDate } from '../../lib/format.js';
import {
  Button,
  ErrorState,
  Field,
  Input,
  PageHeader,
  SectionCard,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
  cx,
} from '../../components/ui.jsx';
import { useConfirm, useToast } from '../../components/feedback.jsx';

const TIMEZONES = [
  'Asia/Tehran',
  'UTC',
  'Asia/Dubai',
  'Europe/Istanbul',
  'Europe/Berlin',
  'Europe/London',
  'America/New_York',
  'Asia/Tokyo',
];

const TAB_LIST = [
  { value: 'general', icon: Globe2, label: 'settings.tabs.general' },
  { value: 'xui', icon: Plug, label: 'settings.tabs.xui' },
  { value: 'monitor', icon: BellRing, label: 'settings.tabs.monitor' },
  { value: 'smtp', icon: Mail, label: 'settings.tabs.smtp' },
  { value: 'sms', icon: MessageSquareText, label: 'settings.tabs.sms' },
  { value: 'billing', icon: CreditCard, label: 'settings.tabs.billing' },
  { value: 'backup', icon: DatabaseBackup, label: 'settings.tabs.backup' },
  { value: 'telegram', icon: Send, label: 'settings.tabs.telegram' },
  { value: 'security', icon: Lock, label: 'settings.tabs.security' },
  { value: 'update', icon: Download, label: 'settings.tabs.update' },
];

function SwitchRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-slate-200">{label}</p>
        {hint ? <p className="mt-0.5 text-[10.5px] leading-5 text-slate-500">{hint}</p> : null}
      </div>
      <Switch checked={Boolean(checked)} onChange={onChange} />
    </div>
  );
}

function SaveBar({ onSave, saving, extra }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
      <p className="text-[10.5px] text-slate-500">{t('settings.tabHint')}</p>
      <div className="flex items-center gap-2">
        {extra}
        <Button icon={Save} loading={saving} onClick={onSave}>{t('common.save')}</Button>
      </div>
    </div>
  );
}

function UpdateTab({ version }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const [startVersion, setStartVersion] = useState('');

  const info = useQuery({
    queryKey: ['panel-update'],
    queryFn: () => api.get('/admin/update'),
    refetchInterval: (query) => (waiting || query.state.data?.running ? 4000 : false),
    retry: 1,
  });

  const data = info.data || {};
  const latest = data.latest || '';
  const running = waiting || Boolean(data.running);

  useEffect(() => {
    if (!waiting) return;
    if (data.current && startVersion && data.current !== startVersion) {
      setWaiting(false);
      toast.success(t('settings.update.done', { version: data.current }));
      setTimeout(() => window.location.reload(), 1400);
    }
  }, [waiting, startVersion, data.current]);

  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setTimeout(() => {
      setWaiting(false);
      toast.error(t('settings.update.failed'));
    }, 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [waiting]);

  const check = useMutation({
    mutationFn: () => api.get('/admin/update?force=1'),
    onSuccess: (payload) => queryClient.setQueryData(['panel-update'], payload),
    onError: (err) => toast.error(translateError(err, t)),
  });

  const run = async () => {
    const ok = await confirm({
      title: t('settings.update.confirmTitle'),
      body: t('settings.update.confirmBody', { version: latest }),
      confirmText: t('settings.update.run', { version: latest }),
    });
    if (!ok) return;
    try {
      await api.post('/admin/update', { tag: latest });
      setStartVersion(data.current || version || '');
      setWaiting(true);
      toast.info(t('settings.update.waitingReload'));
      queryClient.invalidateQueries({ queryKey: ['panel-update'] });
    } catch (err) {
      toast.error(translateError(err, t));
    }
  };

  const disabled = data.checkError === 'disabled';

  return (
    <SectionCard icon={Download} title={t('settings.update.title')}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <p className="text-[10.5px] text-slate-500">{t('settings.update.current')}</p>
            <p className="mt-1 font-mono text-lg font-bold text-white" dir="ltr">v{version || '—'}</p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5">
            <p className="text-[10.5px] text-slate-500">{t('settings.update.latest')}</p>
            <p className="mt-1 font-mono text-lg font-bold text-emerald-300" dir="ltr">{latest ? latest : '—'}</p>
          </div>
        </div>

        <div className={cx(
          'flex items-start gap-2.5 rounded-xl border p-3.5 text-[11.5px] leading-6',
          data.updateAvailable
            ? 'border-amber-400/25 bg-amber-500/[0.07] text-amber-100/90'
            : 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-100/90'
        )}>
          {data.updateAvailable ? <Sparkles className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
          <p>
            {data.updateAvailable
              ? t('settings.update.available', { version: latest })
              : disabled
                ? t('settings.update.disabled')
                : t('settings.update.upToDate')}
          </p>
        </div>

        {data.checkError && !disabled ? (
          <p className="flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-3 py-2 text-[10.5px] leading-5 text-rose-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('settings.update.checkFailed')}: {data.checkError}
          </p>
        ) : null}

        {running ? (
          <p className="flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/[0.06] px-3 py-2 text-[10.5px] leading-5 text-cyan-100/90">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            {t('settings.update.running')}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={RefreshCw} loading={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? t('settings.update.checking') : t('settings.update.check')}
          </Button>
          {data.updateAvailable ? (
            <Button size="sm" icon={Download} loading={running} disabled={running || disabled} onClick={run}>
              {t('settings.update.run', { version: latest })}
            </Button>
          ) : null}
        </div>

        <p className="text-[10.5px] leading-6 text-slate-500">{t('settings.update.hint')}</p>

        {data.last ? (
          <p className="text-[10.5px] text-slate-500">
            {t('settings.update.lastRun')}: <b className="font-mono text-slate-300" dir="ltr">{data.last.tag}</b>
            {' · '}
            {data.last.ok ? t('common.done') : t('settings.update.failed')}
            {data.last.finishedAt ? ` · ${formatDate(data.last.finishedAt, lang, true)}` : ''}
          </p>
        ) : null}

        {data.log ? (
          <div>
            <p className="mb-1.5 text-[10.5px] font-medium text-slate-400">{t('settings.update.log')}</p>
            <pre className="max-h-56 overflow-auto rounded-xl border border-white/[0.06] bg-[#050811]/70 p-3 font-mono text-[10px] leading-5 text-slate-400" dir="ltr">{data.log}</pre>
          </div>
        ) : null}

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/[0.06] pt-3 text-[10.5px] text-slate-600">
          <span>{t('app.version')}:</span>
          <span className="font-mono text-slate-400" dir="ltr">v{version || '—'}</span>
          <span>·</span>
          <span>{t('settings.update.author')}:</span>
          <span className="text-slate-400">{t('app.authorName')}</span>
        </p>
      </div>
    </SectionCard>
  );
}

export default function Settings() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { refresh } = useAuth();
  const [tab, setTab] = useState('general');
  const [local, setLocal] = useState(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get('/admin/settings'),
  });

  useEffect(() => {
    if (data?.settings) setLocal(JSON.parse(JSON.stringify(data.settings)));
  }, [data]);

  const save = useMutation({
    mutationFn: ({ section, payload }) => api.patch(`/admin/settings/${section}`, payload),
    onSuccess: (result, variables) => {
      toast.success(t('settings.saved'));
      if (variables.section === 'general') refresh?.();
      if (variables.section === 'backup') queryClient.invalidateQueries({ queryKey: ['backups'] });
      if (result?.xuiTest) {
        if (result.xuiTest.ok) {
          toast.success(`${t('settings.xui.ok')} · ${result.xuiTest.latencyMs ?? 0}ms · ${result.xuiTest.inbounds ?? 0}`);
        } else {
          toast.error(result.xuiTest.error || t('settings.xui.failed'));
        }
      }
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const testEmail = useMutation({
    mutationFn: () => api.post('/admin/settings/test-email'),
    onSuccess: (result) => toast.success(`${t('settings.testSent')}${result?.to ? ` · ${result.to}` : ''}`),
    onError: (err) => toast.error(err?.message || t('errors.generic')),
  });

  const testSms = useMutation({
    mutationFn: () => api.post('/admin/settings/test-sms'),
    onSuccess: (result) => toast.success(`${t('settings.testSent')}${result?.to ? ` · ${result.to}` : ''}`),
    onError: (err) => toast.error(err?.message || t('errors.generic')),
  });

  const testXui = useMutation({
    mutationFn: () => api.post('/admin/settings/test-xui'),
    onSuccess: (result) => toast.success(`${t('settings.xui.ok')} · ${result?.latencyMs ?? 0}ms · ${result?.inbounds ?? 0}`),
    onError: (err) => toast.error(err?.message || t('settings.xui.failed')),
  });

  const testTelegram = useMutation({
    mutationFn: () => api.post('/admin/settings/test-telegram'),
    onSuccess: (result) => toast.success(`${t('settings.telegram.connected')}${result?.bot ? ` · @${result.bot}` : ''}`),
    onError: (err) => toast.error(err?.message || t('errors.generic')),
  });

  const patch = (section, field, value) => {
    setLocal((prev) => ({ ...prev, [section]: { ...prev[section], [field]: value } }));
  };

  const tabs = useMemo(() => TAB_LIST.map((item) => ({ value: item.value, label: t(item.label), icon: item.icon })), [t]);

  if (isLoading || !local) {
    return (
      <>
        <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
        {isError ? (
          <div className="card"><ErrorState message={error?.message} onRetry={refetch} /></div>
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-11" />
            <Skeleton className="h-96" />
          </div>
        )}
      </>
    );
  }

  const general = local.general || {};
  const xui = local.xui || {};
  const monitor = local.monitor || {};
  const smtp = local.smtp || {};
  const sms = local.sms || {};
  const billing = local.billing || {};
  const backup = local.backup || {};
  const telegram = local.telegram || {};
  const security = local.security || {};
  const savingSection = save.isPending ? save.variables?.section : null;

  return (
    <>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        actions={(
          <>
            <span className="chip border-white/10 bg-white/[0.04] text-slate-400">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              v{data?.version || '—'}
            </span>
            <span className="chip hidden border-emerald-400/15 bg-emerald-500/[0.06] text-emerald-300/80 sm:inline-flex">
              {t('app.author')}: {t('app.authorName')}
            </span>
          </>
        )}
      />

      <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-4 overflow-x-auto" />

      {tab === 'general' ? (
        <SectionCard icon={Globe2} title={t('settings.tabs.general')}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.general.panelName')} required>
                <Input value={general.panelName || ''} onChange={(e) => patch('general', 'panelName', e.target.value)} />
              </Field>
              <Field label={t('settings.general.tagline')}>
                <Input value={general.tagline || ''} onChange={(e) => patch('general', 'tagline', e.target.value)} />
              </Field>
            </div>
            <Field label={t('settings.general.description')}>
              <Textarea rows={2} value={general.description || ''} onChange={(e) => patch('general', 'description', e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.general.website')}>
                <Input dir="ltr" value={general.website || ''} onChange={(e) => patch('general', 'website', e.target.value)} placeholder="https://" />
              </Field>
              <Field label={t('settings.general.supportUrl')}>
                <Input dir="ltr" value={general.supportUrl || ''} onChange={(e) => patch('general', 'supportUrl', e.target.value)} placeholder="https://t.me/" />
              </Field>
              <Field label={t('settings.general.telegram')}>
                <Input dir="ltr" value={general.telegram || ''} onChange={(e) => patch('general', 'telegram', e.target.value)} placeholder="username" />
              </Field>
              <Field label={t('settings.general.timezone')}>
                <Select value={general.timezone || 'Asia/Tehran'} onChange={(e) => patch('general', 'timezone', e.target.value)}>
                  {TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                </Select>
              </Field>
              <Field label={t('settings.general.defaultLang')}>
                <Select value={general.defaultLang || 'fa'} onChange={(e) => patch('general', 'defaultLang', e.target.value)}>
                  <option value="fa">فارسی</option>
                  <option value="en">English</option>
                </Select>
              </Field>
            </div>
            <SaveBar
              saving={savingSection === 'general'}
              onSave={() => save.mutate({ section: 'general', payload: general })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'xui' ? (
        <SectionCard
          icon={Plug}
          title={t('settings.tabs.xui')}
          actions={(
            <Button
              size="sm"
              variant="secondary"
              icon={RefreshCw}
              loading={testXui.isPending}
              onClick={() => testXui.mutate()}
            >
              {t('settings.xui.test')}
            </Button>
          )}
        >
          <div className="space-y-4">
            <Field label={t('settings.xui.url')} hint="https://127.0.0.1:2053/panel-path" required>
              <Input dir="ltr" value={xui.url || ''} onChange={(e) => patch('xui', 'url', e.target.value)} placeholder="https://127.0.0.1:2053/panel-path" />
            </Field>
            <Field
              label={t('settings.xui.token')}
              hint={xui.hasToken ? t('settings.xui.tokenHint') : t('settings.xui.tokenHint')}
            >
              <Input
                dir="ltr"
                type="password"
                autoComplete="new-password"
                value={xui.token || ''}
                onChange={(e) => patch('xui', 'token', e.target.value)}
                placeholder={xui.hasToken ? '••••••••••••••••' : ''}
              />
            </Field>
            <Field label={t('settings.xui.subBase')} hint={t('settings.xui.subHint')}>
              <Input dir="ltr" value={xui.subBase || ''} onChange={(e) => patch('xui', 'subBase', e.target.value)} />
            </Field>
            <SwitchRow
              label={t('settings.xui.verifyTls')}
              hint={t('settings.xui.verifyTlsHint')}
              checked={xui.verifyTls}
              onChange={(value) => patch('xui', 'verifyTls', value)}
            />
            <SaveBar
              saving={savingSection === 'xui'}
              onSave={() => save.mutate({ section: 'xui', payload: xui })}
              extra={xui.token || xui.hasToken ? (
                <span className="hidden items-center gap-1.5 text-[10.5px] text-emerald-300/80 sm:inline-flex">
                  <KeyRound className="h-3.5 w-3.5" />
                  {t('settings.xui.tokenHint')}
                </span>
              ) : null}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'monitor' ? (
        <SectionCard icon={BellRing} title={t('settings.tabs.monitor')}>
          <div className="space-y-4">
            <SwitchRow
              label={t('settings.monitor.enabled')}
              hint={t('servers.alertsHint')}
              checked={monitor.enabled}
              onChange={(value) => patch('monitor', 'enabled', value)}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('settings.monitor.interval')} hint="60 – 3600">
                <Input type="number" min="60" max="3600" dir="ltr" value={monitor.intervalSec ?? 120} onChange={(e) => patch('monitor', 'intervalSec', e.target.value)} />
              </Field>
              <Field label={t('settings.monitor.threshold')} hint="1 – 10">
                <Input type="number" min="1" max="10" dir="ltr" value={monitor.failureThreshold ?? 2} onChange={(e) => patch('monitor', 'failureThreshold', e.target.value)} />
              </Field>
              <Field label={t('settings.monitor.retention')} hint="3 – 365">
                <Input type="number" min="3" max="365" dir="ltr" value={monitor.retentionDays ?? 30} onChange={(e) => patch('monitor', 'retentionDays', e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <SwitchRow label={t('settings.monitor.alertEmail')} checked={monitor.alertEmail} onChange={(value) => patch('monitor', 'alertEmail', value)} />
              <SwitchRow label={t('settings.monitor.alertSms')} checked={monitor.alertSms} onChange={(value) => patch('monitor', 'alertSms', value)} />
              <SwitchRow label={t('settings.monitor.expiryAlerts')} checked={monitor.expiryAlerts} onChange={(value) => patch('monitor', 'expiryAlerts', value)} />
              <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-slate-200">{t('settings.monitor.expiryDays')}</p>
                  <p className="mt-0.5 text-[10.5px] text-slate-500">3, 1</p>
                </div>
                <Input
                  dir="ltr"
                  className="w-24"
                  value={Array.isArray(monitor.expiryDays) ? monitor.expiryDays.join(', ') : String(monitor.expiryDays || '')}
                  onChange={(e) => patch('monitor', 'expiryDays', e.target.value)}
                />
              </div>
            </div>
            <Field label={t('settings.monitor.trafficPercent')} hint="1 – 100">
              <Input type="number" min="1" max="100" dir="ltr" value={monitor.trafficAlertPercent ?? 90} onChange={(e) => patch('monitor', 'trafficAlertPercent', e.target.value)} />
            </Field>
            <SaveBar
              saving={savingSection === 'monitor'}
              onSave={() => save.mutate({ section: 'monitor', payload: monitor })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'smtp' ? (
        <SectionCard
          icon={Mail}
          title={t('settings.tabs.smtp')}
          actions={(
            <Button size="sm" variant="secondary" icon={Send} loading={testEmail.isPending} onClick={() => testEmail.mutate()}>
              {t('settings.smtp.test')}
            </Button>
          )}
        >
          <div className="space-y-4">
            <SwitchRow label={t('settings.smtp.enabled')} checked={smtp.enabled} onChange={(value) => patch('smtp', 'enabled', value)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.smtp.host')} hint="smtp.gmail.com">
                <Input dir="ltr" value={smtp.host || ''} onChange={(e) => patch('smtp', 'host', e.target.value)} placeholder="smtp.example.com" />
              </Field>
              <Field label={t('settings.smtp.port')}>
                <Input type="number" min="1" max="65535" dir="ltr" value={smtp.port ?? 587} onChange={(e) => patch('smtp', 'port', e.target.value)} />
              </Field>
              <Field label={t('settings.smtp.user')}>
                <Input dir="ltr" value={smtp.user || ''} onChange={(e) => patch('smtp', 'user', e.target.value)} placeholder="alerts@example.com" />
              </Field>
              <Field label={t('settings.smtp.pass')} hint={smtp.hasPass ? '••••••••' : ''}>
                <Input
                  dir="ltr"
                  type="password"
                  autoComplete="new-password"
                  value={smtp.pass || ''}
                  onChange={(e) => patch('smtp', 'pass', e.target.value)}
                />
              </Field>
              <Field label={t('settings.smtp.from')} hint={t('common.optional')}>
                <Input dir="ltr" value={smtp.from || ''} onChange={(e) => patch('smtp', 'from', e.target.value)} placeholder="Sulduz Cloud <alerts@example.com>" />
              </Field>
              <Field label={t('settings.smtp.to')}>
                <Input dir="ltr" value={smtp.to || ''} onChange={(e) => patch('smtp', 'to', e.target.value)} placeholder="admin@example.com" />
              </Field>
            </div>
            <SwitchRow label={t('settings.smtp.secure')} hint="port 465" checked={smtp.secure} onChange={(value) => patch('smtp', 'secure', value)} />
            <SaveBar
              saving={savingSection === 'smtp'}
              onSave={() => save.mutate({ section: 'smtp', payload: smtp })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'sms' ? (
        <SectionCard
          icon={MessageSquareText}
          title={t('settings.tabs.sms')}
          actions={(
            <Button size="sm" variant="secondary" icon={Send} loading={testSms.isPending} onClick={() => testSms.mutate()}>
              {t('settings.sms.test')}
            </Button>
          )}
        >
          <div className="space-y-4">
            <SwitchRow label={t('settings.sms.enabled')} checked={sms.enabled} onChange={(value) => patch('sms', 'enabled', value)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.sms.provider')}>
                <Select value={sms.provider || 'kavenegar'} onChange={(e) => patch('sms', 'provider', e.target.value)}>
                  <option value="kavenegar">{t('settings.sms.kavenegar')}</option>
                  <option value="custom">{t('settings.sms.custom')}</option>
                </Select>
              </Field>
              <Field label={t('settings.sms.to')}>
                <Input dir="ltr" value={sms.to || ''} onChange={(e) => patch('sms', 'to', e.target.value)} placeholder="09xxxxxxxxx" />
              </Field>
              <Field label={t('settings.sms.apiKey')} hint={sms.hasApiKey ? '••••••••' : ''}>
                <Input
                  dir="ltr"
                  type="password"
                  autoComplete="new-password"
                  value={sms.apiKey || ''}
                  onChange={(e) => patch('sms', 'apiKey', e.target.value)}
                />
              </Field>
              <Field label={t('settings.sms.sender')}>
                <Input dir="ltr" value={sms.sender || ''} onChange={(e) => patch('sms', 'sender', e.target.value)} />
              </Field>
            </div>

            {sms.provider === 'custom' ? (
              <div className="space-y-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
                <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                  <Field label={t('settings.sms.customUrl')}>
                    <Input dir="ltr" value={sms.customUrl || ''} onChange={(e) => patch('sms', 'customUrl', e.target.value)} placeholder="https://api.example.com/sms" />
                  </Field>
                  <Field label={t('settings.sms.customMethod')}>
                    <Select value={sms.customMethod || 'POST'} onChange={(e) => patch('sms', 'customMethod', e.target.value)}>
                      <option value="POST">POST</option>
                      <option value="GET">GET</option>
                    </Select>
                  </Field>
                </div>
                <Field label={t('settings.sms.customHeaders')}>
                  <Textarea
                    dir="ltr"
                    rows={2}
                    className="font-mono text-[11px]"
                    value={sms.customHeaders || ''}
                    onChange={(e) => patch('sms', 'customHeaders', e.target.value)}
                    placeholder='{"Authorization":"Bearer ..."}'
                  />
                </Field>
                <Field label={t('settings.sms.customBody')}>
                  <Textarea
                    dir="ltr"
                    rows={3}
                    className="font-mono text-[11px]"
                    value={sms.customBody || ''}
                    onChange={(e) => patch('sms', 'customBody', e.target.value)}
                    placeholder='{"to":"{to}","text":"{text}"}'
                  />
                </Field>
              </div>
            ) : null}

            <SaveBar
              saving={savingSection === 'sms'}
              onSave={() => save.mutate({ section: 'sms', payload: sms })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'billing' ? (
        <SectionCard icon={CreditCard} title={t('settings.tabs.billing')}>
          <div className="space-y-4">
            <SwitchRow label={t('settings.billing.enabled')} hint={t('settings.billing.hint')} checked={billing.enabled} onChange={(value) => patch('billing', 'enabled', value)} />
            <Field label={t('settings.billing.currency')}>
              <Input value={billing.currency || ''} onChange={(e) => patch('billing', 'currency', e.target.value)} placeholder="تومان" />
            </Field>
            <div className={cx(
              'flex items-start gap-2.5 rounded-xl border p-3.5 text-[11.5px] leading-6',
              billing.enabled
                ? 'border-emerald-400/25 bg-emerald-500/[0.07] text-emerald-100/90'
                : 'border-amber-400/25 bg-amber-500/[0.07] text-amber-100/90'
            )}>
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{t('settings.billing.hint')}</p>
            </div>
            <SaveBar
              saving={savingSection === 'billing'}
              onSave={() => save.mutate({ section: 'billing', payload: billing })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'backup' ? (
        <SectionCard icon={DatabaseBackup} title={t('settings.tabs.backup')}>
          <div className="space-y-4">
            <SwitchRow label={t('settings.backup.auto')} hint={t('backups.subtitle')} checked={backup.auto} onChange={(value) => patch('backup', 'auto', value)} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('settings.backup.hour')} hint="0 – 23">
                <Input type="number" min="0" max="23" dir="ltr" value={backup.hour ?? 3} onChange={(e) => patch('backup', 'hour', e.target.value)} />
              </Field>
              <Field label={t('settings.backup.minute')} hint="0 – 59">
                <Input type="number" min="0" max="59" dir="ltr" value={backup.minute ?? 30} onChange={(e) => patch('backup', 'minute', e.target.value)} />
              </Field>
              <Field label={t('settings.backup.keep')} hint="1 – 60">
                <Input type="number" min="1" max="60" dir="ltr" value={backup.keep ?? 14} onChange={(e) => patch('backup', 'keep', e.target.value)} />
              </Field>
            </div>
            <p className="text-[10.5px] leading-5 text-slate-500">{t('backups.scheduleHint')}</p>
            <SaveBar
              saving={savingSection === 'backup'}
              onSave={() => save.mutate({ section: 'backup', payload: backup })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'telegram' ? (
        <SectionCard
          icon={Send}
          title={t('settings.tabs.telegram')}
          actions={(
            <Button size="sm" variant="secondary" icon={Send} loading={testTelegram.isPending} onClick={() => testTelegram.mutate()}>
              {t('settings.telegram.test')}
            </Button>
          )}
        >
          <div className="space-y-4">
            <SwitchRow
              label={t('settings.telegram.enabled')}
              hint={t('settings.telegram.enabledHint')}
              checked={telegram.enabled}
              onChange={(value) => patch('telegram', 'enabled', value)}
            />
            <SwitchRow
              label={t('settings.telegram.sendOnAuto')}
              hint={t('settings.telegram.autoHint')}
              checked={telegram.sendOnAuto}
              onChange={(value) => patch('telegram', 'sendOnAuto', value)}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.telegram.botToken')} hint={t('settings.telegram.tokenHint')}>
                <Input
                  dir="ltr"
                  type="password"
                  autoComplete="new-password"
                  value={telegram.botToken || ''}
                  onChange={(e) => patch('telegram', 'botToken', e.target.value)}
                  placeholder={telegram.hasBotToken ? '••••••••••••••••' : '123456789:AA...'}
                />
              </Field>
              <Field label={t('settings.telegram.chatId')} hint={t('settings.telegram.chatHint')}>
                <Input
                  dir="ltr"
                  value={telegram.chatId || ''}
                  onChange={(e) => patch('telegram', 'chatId', e.target.value)}
                  placeholder="-1001234567890"
                />
              </Field>
            </div>
            <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5 text-[11.5px] leading-6 text-slate-400">
              <Send className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300/80" />
              <p>{t('settings.telegram.createHint')}</p>
            </div>
            <SaveBar
              saving={savingSection === 'telegram'}
              onSave={() => save.mutate({ section: 'telegram', payload: telegram })}
              extra={telegram.hasBotToken && telegram.chatId ? (
                <span className="hidden items-center gap-1.5 text-[10.5px] text-emerald-300/80 sm:inline-flex">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t('settings.telegram.connected')}
                </span>
              ) : null}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'security' ? (
        <SectionCard icon={ShieldCheck} title={t('settings.tabs.security')}>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.security.sessionDays')} hint="1 – 90">
                <Input type="number" min="1" max="90" dir="ltr" value={security.sessionDays ?? 7} onChange={(e) => patch('security', 'sessionDays', e.target.value)} />
              </Field>
              <Field label={t('settings.security.loginRateLimit')} hint="3 – 100">
                <Input type="number" min="3" max="100" dir="ltr" value={security.loginRateLimit ?? 10} onChange={(e) => patch('security', 'loginRateLimit', e.target.value)} />
              </Field>
            </div>
            <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5 text-[11.5px] leading-6 text-slate-400">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300/80" />
              <p>{t('settings.tabs.security')} · {t('profile.password')}</p>
            </div>
            <SaveBar
              saving={savingSection === 'security'}
              onSave={() => save.mutate({ section: 'security', payload: security })}
            />
          </div>
        </SectionCard>
      ) : null}

      {tab === 'update' ? <UpdateTab version={data?.version} /> : null}
    </>
  );
}
