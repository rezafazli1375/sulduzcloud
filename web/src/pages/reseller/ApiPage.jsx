import React, { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  BookOpen,
  Boxes,
  Code2,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Terminal,
} from 'lucide-react';
import { useAuth } from '../../lib/auth.jsx';
import { useI18n, translateError } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  PageHeader,
  SectionCard,
  Tabs,
  cx,
} from '../../components/ui.jsx';
import { useConfirm, useToast } from '../../components/feedback.jsx';

const ENDPOINTS = [
  { method: 'GET', path: '/api/v1/me', desc: 'Account, limits and usage' },
  { method: 'GET', path: '/api/v1/inbounds', desc: 'Inbounds available to you' },
  { method: 'GET', path: '/api/v1/configs', desc: 'List configs (status, search, page)' },
  { method: 'POST', path: '/api/v1/configs', desc: 'Create one config per inbound' },
  { method: 'GET', path: '/api/v1/configs/:id', desc: 'Config details, links and subscription' },
  { method: 'POST', path: '/api/v1/configs/:id/extend', desc: 'Add volume / days, reset usage' },
  { method: 'POST', path: '/api/v1/configs/:id/toggle', desc: 'Enable or disable a config' },
  { method: 'DELETE', path: '/api/v1/configs/:id', desc: 'Remove a config and its client' },
  { method: 'GET', path: '/api/v1/usage', desc: 'Traffic series for the last N days' },
];

const METHOD_TONE = { GET: 'cyan', POST: 'emerald', DELETE: 'rose', PATCH: 'amber' };

export default function ApiPage() {
  const { t } = useI18n();
  const { user, patchUser } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState('create');

  const base = typeof window !== 'undefined' ? `${window.location.origin}/api/v1` : 'https://sulduzcloud.ir/api/v1';
  const key = user?.apiKey || '';
  const placeholder = key || 'sc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  const regenerate = useMutation({
    mutationFn: () => api.post('/auth/api-key'),
    onSuccess: (result) => {
      patchUser({ apiKey: result?.apiKey || '' });
      toast.success(t('apiPage.regenerate'));
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askRegenerate = async () => {
    const ok = await confirm({
      title: t('apiPage.regenerate'),
      body: t('profile.apiKeyWarn'),
      danger: true,
      confirmText: t('apiPage.regenerate'),
    });
    if (ok) regenerate.mutate();
  };

  const samples = useMemo(() => ({
    create: `curl -X POST ${base}/configs \\
  -H "X-API-Key: ${placeholder}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "inboundIds": [1],
    "gb": 30,
    "days": 30,
    "customerName": "Ali",
    "label": "ali-30d"
  }'`,
    list: `curl "${base}/configs?status=active&page=1&pageSize=20" \\
  -H "X-API-Key: ${placeholder}"`,
    extend: `curl -X POST ${base}/configs/123/extend \\
  -H "X-API-Key: ${placeholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"gb": 10, "days": 30}'`,
    usage: `curl "${base}/usage?days=30" \\
  -H "X-API-Key: ${placeholder}"`,
  }), [base, placeholder]);

  return (
    <>
      <PageHeader
        title={t('apiPage.title')}
        subtitle={t('apiPage.subtitle')}
        actions={key ? (
          <Button variant="secondary" icon={RefreshCw} loading={regenerate.isPending} onClick={askRegenerate}>
            {t('apiPage.regenerate')}
          </Button>
        ) : null}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <div className="space-y-4">
          <SectionCard icon={KeyRound} title={t('apiPage.key')}>
            {key ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-black/30 px-3 py-3">
                  <code dir="ltr" className="min-w-0 flex-1 break-all font-mono text-[11px] text-emerald-200/90">{key}</code>
                  <CopyButton value={key} iconOnly size="sm" variant="ghost" />
                </div>
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/25 bg-amber-500/[0.07] p-3.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <p className="text-[11.5px] leading-6 text-amber-100/90">{t('apiPage.warn')}</p>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                  <p className="text-[10.5px] text-slate-500">{t('apiPage.docsHint')}</p>
                  <Badge tone="emerald" dot>Active</Badge>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={KeyRound}
                title={t('apiPage.noKey')}
                hint={t('profile.apiHint')}
                className="py-8"
                action={(
                  <Button size="sm" icon={Plus} loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
                    {t('apiPage.generate')}
                  </Button>
                )}
              />
            )}
          </SectionCard>

          <SectionCard icon={BookOpen} title={t('apiPage.endpoints')} bodyClass="p-0">
            <div className="divide-y divide-white/[0.05]">
              {ENDPOINTS.map((endpoint) => (
                <div key={`${endpoint.method}-${endpoint.path}`} className="flex items-center gap-2.5 px-4 py-2.5">
                  <Badge tone={METHOD_TONE[endpoint.method]} className="w-[62px] justify-center font-mono">{endpoint.method}</Badge>
                  <code dir="ltr" className="shrink-0 font-mono text-[10.5px] text-slate-300">{endpoint.path}</code>
                  <span className="ms-auto hidden text-[10px] text-slate-500 sm:block">{endpoint.desc}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          <div className="card flex items-start gap-3 p-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-300">
              <Terminal className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-slate-100">{t('apiPage.docsHint')}</p>
              <p dir="ltr" className="mt-1 break-all font-mono text-[10.5px] text-slate-500">{base}</p>
            </div>
          </div>
        </div>

        <SectionCard
          icon={Code2}
          title={t('apiPage.docs')}
          bodyClass="p-0"
          actions={(
            <Tabs
              tabs={[
                { value: 'create', label: 'Create' },
                { value: 'list', label: 'List' },
                { value: 'extend', label: 'Extend' },
                { value: 'usage', label: 'Usage' },
              ]}
              active={tab}
              onChange={setTab}
            />
          )}
        >
          <div className="relative">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <span className="h-2 w-2 rounded-full bg-rose-400/70" />
                <span className="h-2 w-2 rounded-full bg-amber-400/70" />
                <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
                <span className="ms-2 font-mono">bash</span>
              </span>
              <CopyButton value={samples[tab]} iconOnly size="xs" variant="ghost" />
            </div>
            <pre dir="ltr" className="max-h-[520px] overflow-auto p-4 font-mono text-[10.5px] leading-6 text-slate-300">
              <code>{samples[tab]}</code>
            </pre>
          </div>
          <div className={cx('border-t border-white/[0.06] px-4 py-3 text-[10.5px] leading-6 text-slate-500')}>
            {t('apiPage.warn')}
          </div>
        </SectionCard>
      </div>
    </>
  );
}
