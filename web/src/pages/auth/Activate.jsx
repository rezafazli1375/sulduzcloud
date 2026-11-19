import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { useI18n } from '../../lib/i18n.jsx';
import { api } from '../../lib/api.js';
import { copyText } from '../../lib/format.js';
import { Button, Field, Input } from '../../components/ui.jsx';
import { useToast } from '../../components/feedback.jsx';

// Panel v2.1.0 — the unlock screen.
//
// The owner's condition, in his words: «اگر کسی این پنل نصب کرد و ادرس پنل تو
// مرورگر زد که براش اجرا بشه ازش رمز و کلید بخواد / کلیدشم به این گونه باشه که
// نر و مادگی باشه / کلید های نر تو خود برنامه باشه و هنگام اجرا یک کلید نر بصورت
// رندوم به طرف نشون بده و ازش بخواد مادگی این کلید بده تا پنل واسش فعال شه».
//
// So this screen has exactly one job: show THIS install's male key and ask for its
// female half. The male id is chosen by src/activation.js from the ids shipped in
// the code and is handed to us by GET /api/activation (one of the three endpoints
// that stay open behind the gate); the matching female keys are never in the
// repository — only in the text file the owner passes over himself. A stranger with
// the source and no key therefore gets a locked panel that cannot be set up,
// because /api/setup answers 423 behind the same gate.
//
// Nothing else renders while the gate is up: no login form, no setup wizard. The
// panel is not usable yet, and pretending otherwise would be a dead button.

export default function Activate({ activation, onUnlocked }) {
  const { t } = useI18n();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');

  const maleKey = String(activation?.maleKey || '');

  const unlock = useMutation({
    mutationFn: () => api.post('/activation', { key: key.trim() }),
    onSuccess: () => {
      setError('');
      toast.success(t('activate.success'));
      onUnlocked?.();
    },
    onError: (err) => setError(err?.message || t('activate.failed')),
  });

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="card w-full max-w-md p-7">
        <div className="flex items-start gap-3">
          <span className="relative flex h-12 w-12 shrink-0 items-center justify-center">
            <span className="absolute inset-0 rounded-2xl bg-violet-500/30 blur-xl" />
            <span className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-500 text-white">
              <ShieldAlert className="h-6 w-6" />
            </span>
          </span>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-white">{t('activate.title')}</h1>
            <p className="mt-1 text-[11.5px] leading-5 text-slate-400">{t('activate.subtitle')}</p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-slate-500">{t('activate.maleLabel')}</p>
          <div className="mt-2 flex items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[17px] font-semibold tracking-[0.08em] text-emerald-300">
              {maleKey || t('common.loading')}
            </code>
            <button
              type="button"
              className="rounded-lg border border-white/[0.08] bg-white/[0.04] p-2 text-slate-300 transition hover:text-white"
              onClick={async () => {
                try {
                  await copyText(maleKey);
                  toast.success(t('common.copied'));
                } catch (_) {
                  toast.error(t('errors.generic'));
                }
              }}
              aria-label={t('common.copy')}
              title={t('common.copy')}
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-[10.5px] leading-5 text-slate-500">{t('activate.maleHint')}</p>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim()) {
              setError(t('activate.required'));
              return;
            }
            setError('');
            unlock.mutate();
          }}
        >
          <Field label={t('activate.femaleLabel')} hint={t('activate.femaleHint')}>
            <Input
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="XXX-XXXX-XXXX-XXXX-XXXX"
              className="text-center font-mono tracking-[0.1em]"
            />
          </Field>

          {error ? (
            <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11.5px] leading-5 text-rose-200">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            icon={unlock.isSuccess ? CheckCircle2 : KeyRound}
            loading={unlock.isPending}
            disabled={unlock.isSuccess || !maleKey}
          >
            {unlock.isSuccess ? t('activate.success') : t('activate.submit')}
          </Button>
        </form>

        <p className="mt-5 text-[10.5px] leading-5 text-slate-500">{t('activate.footer')}</p>
      </div>
    </div>
  );
}
