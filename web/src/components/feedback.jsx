import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useI18n } from '../lib/i18n.jsx';

const ToastContext = createContext(null);
const ConfirmContext = createContext(null);

let toastSeq = 0;

const TONES = {
  success: {
    icon: CheckCircle2,
    ring: 'border-emerald-400/35',
    bg: 'from-emerald-500/15 to-emerald-500/5',
    iconColor: 'text-emerald-300',
  },
  error: {
    icon: XCircle,
    ring: 'border-rose-400/35',
    bg: 'from-rose-500/15 to-rose-500/5',
    iconColor: 'text-rose-300',
  },
  warning: {
    icon: AlertTriangle,
    ring: 'border-amber-400/35',
    bg: 'from-amber-500/15 to-amber-500/5',
    iconColor: 'text-amber-300',
  },
  info: {
    icon: Info,
    ring: 'border-cyan-400/35',
    bg: 'from-cyan-500/15 to-cyan-500/5',
    iconColor: 'text-cyan-300',
  },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message, tone = 'info', opts = {}) => {
      if (!message) return;
      const id = ++toastSeq;
      const item = { id, message: String(message), tone, title: opts.title || '' };
      setToasts((list) => [...list.slice(-4), item]);
      const timeout = opts.duration || (tone === 'error' ? 7000 : 4200);
      timers.current.set(id, setTimeout(() => dismiss(id), timeout));
      return id;
    },
    [dismiss]
  );

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (msg, opts) => push(msg, 'success', opts),
      error: (msg, opts) => push(msg, 'error', opts),
      warning: (msg, opts) => push(msg, 'warning', opts),
      info: (msg, opts) => push(msg, 'info', opts),
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          className="pointer-events-none fixed bottom-5 z-[95] flex w-[min(92vw,380px)] flex-col gap-2.5"
          style={{ insetInlineEnd: '1.25rem' }}
        >
          {toasts.map((toast) => {
            const tone = TONES[toast.tone] || TONES.info;
            const Icon = tone.icon;
            return (
              <div
                key={toast.id}
                role="status"
                className={`pointer-events-auto flex items-start gap-3 rounded-2xl border ${tone.ring} bg-gradient-to-br ${tone.bg} p-3.5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)] backdrop-blur-xl`}
                style={{ animation: 'fadeUp .25s cubic-bezier(.22,1,.36,1)' }}
              >
                <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.iconColor}`} />
                <div className="min-w-0 flex-1">
                  {toast.title ? <p className="text-sm font-semibold text-white">{toast.title}</p> : null}
                  <p className="whitespace-pre-line text-[13px] leading-5 text-slate-200">{toast.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  className="rounded-lg p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
                  aria-label="close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

export function ConfirmProvider({ children }) {
  const { t } = useI18n();
  const [state, setState] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((options = {}) => {
    return new Promise((resolve) => {
      resolver.current = resolve;
      setState({
        title: options.title || t('common.confirm'),
        body: options.body || '',
        confirmText: options.confirmText || t('common.confirm'),
        cancelText: options.cancelText || t('common.cancel'),
        danger: Boolean(options.danger),
        tone: options.tone || (options.danger ? 'danger' : 'primary'),
      });
    });
  }, [t]);

  const close = useCallback((result) => {
    setState(null);
    if (resolver.current) {
      resolver.current(result);
      resolver.current = null;
    }
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') close(false);
      if (event.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state
        ? createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <div
                className="absolute inset-0 bg-[#02040a]/75 backdrop-blur-sm"
                onClick={() => close(false)}
                aria-hidden="true"
              />
              <div
                role="dialog"
                aria-modal="true"
                className="surface relative w-full max-w-md rounded-2xl p-6"
                style={{ animation: 'fadeUp .22s cubic-bezier(.22,1,.36,1)' }}
              >
                <div className="flex items-start gap-3.5">
                  <span
                    className={`kpi-icon ${state.danger ? 'bg-rose-500/12 text-rose-300' : 'bg-emerald-500/12 text-emerald-300'}`}
                  >
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold text-white">{state.title}</h3>
                    {state.body ? (
                      <p className="mt-2 whitespace-pre-line text-[13px] leading-6 text-slate-400">{state.body}</p>
                    ) : null}
                  </div>
                </div>
                <div className="mt-6 flex items-center justify-end gap-2">
                  <button type="button" className="btn btn-secondary" onClick={() => close(false)}>
                    {state.cancelText}
                  </button>
                  <button
                    type="button"
                    autoFocus
                    className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`}
                    onClick={() => close(true)}
                  >
                    {state.confirmText}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx.confirm;
}
