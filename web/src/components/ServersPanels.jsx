import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Server, Trash2, Wifi } from 'lucide-react';
import { useI18n, translateError } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatNumber, relativeTime } from '../lib/format.js';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  SectionCard,
  StatusBadge,
  cx,
} from './ui.jsx';
import { useConfirm, useToast } from './feedback.jsx';

const EMPTY = { name: '', token: '', subBase: '', verifyTls: false, enabled: true };

/** "https://host:2053/path" -> { scheme: 'https', host: 'host:2053/path' } */
function splitUrl(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(https?):\/\/(.*)$/i);
  if (match) return { scheme: match[1].toLowerCase(), host: match[2] };
  return { scheme: 'https', host: text };
}

/**
 * Admin CRUD for the x-ui panels ("servers") this dashboard controls.
 * Tokens are write-only: the API returns hasToken and never the secret.
 *
 * The scheme is an explicit https/http selector (default https) instead of
 * free text, so a TLS panel address can always be entered and the server never
 * has to guess the protocol.
 */
export default function ServersPanels({ panels = [], onChanged }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [scheme, setScheme] = useState('https');
  const [host, setHost] = useState('');

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin', 'servers'] });
    queryClient.invalidateQueries({ queryKey: ['inbounds'] });
    queryClient.invalidateQueries({ queryKey: ['inbounds', 'picker'] });
    onChanged?.();
  };

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        url: host.trim() ? `${scheme}://${host.trim()}` : '',
        subBase: form.subBase.trim(),
        verifyTls: form.verifyTls,
        enabled: form.enabled,
      };
      if (form.token.trim()) payload.token = form.token.trim();
      return editing
        ? api.patch(`/admin/servers/${editing.id}`, payload)
        : api.post('/admin/servers', payload);
    },
    onSuccess: () => {
      toast.success(t('servers.panels.saved'));
      setOpen(false);
      setEditing(null);
      setForm(EMPTY);
      setHost('');
      setScheme('https');
      refresh();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const test = useMutation({
    mutationFn: (id) => api.post(`/admin/servers/${id}/test`),
    onSuccess: (result) => {
      toast.success(`${t('servers.panels.tested')} · ${formatNumber(result?.inbounds || 0, lang)} ${t('servers.panels.inbounds')} · ${formatNumber(result?.latencyMs || 0, lang)}ms`);
      refresh();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const remove = useMutation({
    mutationFn: (id) => api.del(`/admin/servers/${id}`),
    onSuccess: () => {
      toast.success(t('servers.panels.deleted'));
      refresh();
    },
    onError: (err) => toast.error(translateError(err, t)),
  });

  const askDelete = async (server) => {
    const ok = await confirm({
      title: t('servers.panels.delete'),
      body: `${server.name} — ${server.url}\n\n${t('servers.panels.deleteWarn')}`,
      danger: true,
      confirmText: t('common.delete'),
    });
    if (ok) remove.mutate(server.id);
  };

  const startCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setScheme('https');
    setHost('');
    setOpen(true);
  };

  const startEdit = (server) => {
    const parsed = splitUrl(server.url);
    setEditing(server);
    setForm({
      name: server.name || '',
      token: '',
      subBase: server.subBase || '',
      verifyTls: Boolean(server.verifyTls),
      enabled: server.enabled !== false,
    });
    setScheme(parsed.scheme);
    setHost(parsed.host);
    setOpen(true);
  };

  /** Paste "https://host/path" into the host box: keep it, move the scheme. */
  const changeHost = (value) => {
    const match = value.match(/^(https?):\/\/(.*)$/i);
    if (match) {
      setScheme(match[1].toLowerCase());
      setHost(match[2]);
      return;
    }
    setHost(value);
  };

  return (
    <>
      <SectionCard
        title={t('servers.panels.title')}
        subtitle={t('servers.panels.subtitle')}
        icon={Server}
        actions={(
          <Button size="sm" icon={Plus} onClick={startCreate}>{t('servers.panels.add')}</Button>
        )}
        bodyClass="p-0"
      >
        <div className="divide-y divide-white/[0.05]">
          {panels.map((server) => {
            const online = server.status === 'online';
            return (
              <div key={server.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className={cx('kpi-icon shrink-0', online ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300')}>
                  <Server className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-[12.5px] font-semibold text-slate-100">{server.name}</p>
                    <StatusBadge status={online ? 'online' : server.status || 'unknown'} label={online ? t('common.online') : server.status === 'offline' ? t('common.offline') : t('common.unknown')} />
                    {server.enabled === false ? <Badge tone="slate">{t('servers.panels.disabled')}</Badge> : null}
                    {server.hasToken ? null : <Badge tone="amber">{t('servers.panels.noToken')}</Badge>}
                  </div>
                  <p className="truncate font-mono text-[10px] text-slate-500" dir="ltr">{server.url}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {server.latencyMs !== null && server.latencyMs !== undefined ? `${formatNumber(server.latencyMs, lang)} ms` : '—'}
                    {server.checkedAt ? ` · ${relativeTime(server.checkedAt, lang)}` : ''}
                    {server.message ? ` · ${server.message}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="xs" variant="ghost" icon={Wifi} loading={test.isPending && test.variables === server.id} onClick={() => test.mutate(server.id)}>
                    {t('servers.panels.test')}
                  </Button>
                  <Button size="xs" variant="ghost" icon={Pencil} onClick={() => startEdit(server)}>{t('common.edit')}</Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={Trash2}
                    className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                    loading={remove.isPending && remove.variables === server.id}
                    onClick={() => askDelete(server)}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
          {!panels.length ? (
            <p className="px-4 py-6 text-center text-[11.5px] text-slate-500">{t('servers.panels.empty')}</p>
          ) : null}
        </div>
      </SectionCard>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? t('servers.panels.edit') : t('servers.panels.add')}
        subtitle={t('servers.panels.hint')}
        size="sm"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
          </>
        )}
      >
        <div className="space-y-3">
          <Field label={t('servers.panels.name')} required>
            <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Panel #2" />
          </Field>
          <Field label={t('servers.panels.url')} hint={t('servers.panels.urlHint')} required>
            <div className="flex gap-2">
              <div className="flex shrink-0 items-center rounded-xl bg-white/[0.04] p-0.5" role="group" aria-label="scheme">
                {['https', 'http'].map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setScheme(item)}
                    className={cx(
                      'rounded-[10px] px-2.5 py-1.5 text-[11px] font-semibold uppercase transition',
                      scheme === item ? 'bg-cyan-500/20 text-cyan-200 shadow-[0_0_0_1px_rgba(34,211,238,0.25)_inset]' : 'text-slate-500 hover:text-slate-300'
                    )}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <Input
                dir="ltr"
                className="min-w-0 flex-1"
                value={host}
                onChange={(e) => changeHost(e.target.value)}
                placeholder="dash.example.com:2053/panel-path"
              />
            </div>
            {host.trim() ? (
              <p className="mt-1 truncate font-mono text-[10px] text-slate-500" dir="ltr">{`${scheme}://${host.trim()}`}</p>
            ) : null}
          </Field>
          <Field label={t('servers.panels.token')} hint={editing?.hasToken ? t('servers.panels.tokenKeep') : t('servers.panels.tokenHint')}>
            <Input dir="ltr" type="password" value={form.token} onChange={(e) => setForm((p) => ({ ...p, token: e.target.value }))} placeholder={editing?.hasToken ? '••••••••' : 'apiToken'} />
          </Field>
          <Field label={t('servers.panels.subBase')} hint={t('servers.panels.subBaseHint')}>
            <Input dir="ltr" value={form.subBase} onChange={(e) => setForm((p) => ({ ...p, subBase: e.target.value }))} placeholder="https://sub.example.com:2096/sub" />
          </Field>
          <div className="flex flex-wrap gap-5 pt-1">
            <Checkbox checked={form.verifyTls} onChange={(value) => setForm((p) => ({ ...p, verifyTls: value }))} label={t('servers.panels.verifyTls')} />
            <Checkbox checked={form.enabled} onChange={(value) => setForm((p) => ({ ...p, enabled: value }))} label={t('servers.panels.enabled')} />
          </div>
          <p className="flex items-start gap-2 rounded-xl border border-amber-400/15 bg-amber-500/[0.05] px-3 py-2 text-[10.5px] leading-5 text-amber-100/70">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t('servers.panels.securityNote')}
          </p>
        </div>
      </Modal>
    </>
  );
}
