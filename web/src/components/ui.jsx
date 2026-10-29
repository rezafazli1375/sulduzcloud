import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Inbox,
  Loader2,
  Moon,
  RefreshCw,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { useI18n } from '../lib/i18n.jsx';
import { useTheme } from '../lib/theme.jsx';
import { copyText, formatNumber, pct } from '../lib/format.js';
import { useToast } from './feedback.jsx';

export function cx(...values) {
  return values.filter(Boolean).join(' ');
}

const VARIANTS = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  soft: 'btn-soft',
};

const SIZES = {
  xs: 'rounded-lg px-2.5 py-1.5 text-[11px]',
  sm: 'rounded-lg px-3 py-1.5 text-xs',
  md: '',
  lg: 'px-5 py-3 text-[15px]',
};

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', loading = false, icon: Icon, iconRight: IconRight, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', VARIANTS[variant] || VARIANTS.primary, SIZES[size] || '', className)}
      disabled={rest.disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className={size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> : null}
      {children}
      {IconRight && !loading ? <IconRight className="h-4 w-4" /> : null}
    </button>
  );
});

export function IconButton({ icon: Icon, label, variant = 'ghost', className, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('btn h-9 w-9 rounded-lg p-0', VARIANTS[variant], className)}
      {...rest}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function ThemeToggle({ className }) {
  const { t } = useI18n();
  const { isLight, toggle } = useTheme();
  const label = isLight ? t('theme.toDark') : t('theme.toLight');
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cx(
        'flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-slate-300 transition hover:border-emerald-400/30 hover:text-white',
        className
      )}
    >
      {isLight ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] text-slate-400">{subtitle}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionCard({ title, subtitle, actions, children, className, bodyClass, icon: Icon }) {
  return (
    <section className={cx('card', className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon ? (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300">
                <Icon className="h-4 w-4" />
              </span>
            ) : null}
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-white">{title}</h2>
              {subtitle ? <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('p-5', bodyClass)}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, error, children, className, required }) {
  return (
    <label className={cx('block', className)}>
      {label ? (
        <span className="label">
          {label}
          {required ? <span className="text-rose-400"> *</span> : null}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="mt-1.5 block text-[11px] font-medium text-rose-400">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[11px] leading-5 text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

export const Input = forwardRef(function Input({ icon: Icon, className, ...rest }, ref) {
  if (!Icon) return <input ref={ref} className={cx('input', className)} {...rest} />;
  return (
    <span className="relative block">
      <Icon className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" style={{ insetInlineStart: '0.85rem' }} />
      <input ref={ref} className={cx('input', className)} style={{ paddingInlineStart: '2.4rem' }} {...rest} />
    </span>
  );
});

export const Textarea = forwardRef(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('input', className)} {...rest} />;
});

export const Select = forwardRef(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx('input', className)} {...rest}>
      {children}
    </select>
  );
});

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2.5 disabled:opacity-50"
    >
      <span
        className={cx(
          'relative h-6 w-11 shrink-0 rounded-full border transition-all duration-200',
          checked
            ? 'border-emerald-400/40 bg-gradient-to-r from-emerald-500 to-cyan-500 shadow-[0_0_18px_-4px_rgba(16,185,129,.7)]'
            : 'border-white/10 bg-white/[0.06]'
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all duration-200',
            checked ? 'start-[22px]' : 'start-0.5'
          )}
        />
      </span>
      {label ? <span className="text-[13px] text-slate-300">{label}</span> : null}
    </button>
  );
}

export function Checkbox({ checked, onChange, label, className, disabled }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-[13px] text-slate-300', disabled && 'opacity-50', className)}>
      <span
        className={cx(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border transition',
          checked ? 'border-emerald-400/50 bg-emerald-500/90 text-[#04120f]' : 'border-white/15 bg-white/[0.04]'
        )}
      >
        {checked ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : null}
      </span>
      <input type="checkbox" className="sr-only" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const TONES = {
  emerald: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300',
  amber: 'border-amber-400/25 bg-amber-500/10 text-amber-300',
  rose: 'border-rose-400/25 bg-rose-500/10 text-rose-300',
  cyan: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-300',
  violet: 'border-violet-400/25 bg-violet-500/10 text-violet-300',
  slate: 'border-white/10 bg-white/[0.06] text-slate-300',
  blue: 'border-sky-400/25 bg-sky-500/10 text-sky-300',
};

export function Badge({ tone = 'slate', children, className, dot = false }) {
  return (
    <span className={cx('badge border', TONES[tone] || TONES.slate, className)}>
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

const STATUS_TONE = {
  active: 'emerald',
  online: 'emerald',
  enabled: 'emerald',
  open: 'cyan',
  answered: 'violet',
  expired: 'amber',
  depleted: 'rose',
  disabled: 'slate',
  closed: 'slate',
  offline: 'rose',
  down: 'rose',
  up: 'emerald',
  unknown: 'slate',
  pending: 'amber',
};

export function StatusBadge({ status, label }) {
  const { t } = useI18n();
  const key = String(status || 'unknown').toLowerCase();
  const text = label || t(`common.${key}`) || key;
  return (
    <Badge tone={STATUS_TONE[key] || 'slate'} dot>
      {text}
    </Badge>
  );
}

export function UsageBar({ used, total, className, showLabel = false, compact = false }) {
  const { lang } = useI18n();
  const percent = pct(used, total);
  const value = percent === null ? 0 : percent;
  const tone = percent === null ? 'bg-gradient-to-r from-slate-500/60 to-slate-400/40' : percent >= 90
    ? 'bg-gradient-to-r from-rose-500 to-orange-400'
    : percent >= 70
      ? 'bg-gradient-to-r from-amber-400 to-yellow-300'
      : 'bg-gradient-to-r from-emerald-500 to-cyan-400';
  return (
    <div className={cx('w-full', className)}>
      <div className={cx('w-full overflow-hidden rounded-full bg-white/[0.07]', compact ? 'h-1.5' : 'h-2')}>
        <div className={cx('h-full rounded-full transition-all duration-500', tone)} style={{ width: `${percent === null ? 100 : Math.max(value, 1.5)}%` }} />
      </div>
      {showLabel ? (
        <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
          <span>{percent === null ? '∞' : `${formatNumber(percent, lang, 1)}%`}</span>
          {total ? <span>{formatNumber(total / 1024 ** 3, lang, 1)} GB</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function StatCard({ icon: Icon, label, value, hint, tone = 'emerald', trend, className, onClick }) {
  const tones = {
    emerald: ['bg-emerald-500/12 text-emerald-300', 'from-emerald-500/12'],
    cyan: ['bg-cyan-500/12 text-cyan-300', 'from-cyan-500/12'],
    violet: ['bg-violet-500/12 text-violet-300', 'from-violet-500/12'],
    amber: ['bg-amber-500/12 text-amber-300', 'from-amber-500/12'],
    rose: ['bg-rose-500/12 text-rose-300', 'from-rose-500/12'],
  };
  const [iconClass, glow] = tones[tone] || tones.emerald;
  return (
    <div
      onClick={onClick}
      className={cx(
        'card card-hover relative overflow-hidden p-4',
        onClick && 'cursor-pointer',
        className
      )}
    >
      <div className={cx('pointer-events-none absolute -top-14 end-0 h-28 w-28 rounded-full bg-gradient-to-br to-transparent blur-2xl', glow)} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-2 text-[11px] font-medium uppercase leading-tight tracking-wide text-slate-500">{label}</p>
          <p className="mt-2 truncate text-xl font-bold text-white sm:text-2xl">{value}</p>
          {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
        </div>
        {Icon ? (
          <span className={cx('kpi-icon', iconClass)}>
            <Icon className="h-5 w-5" />
          </span>
        ) : null}
      </div>
      {trend}
    </div>
  );
}

const MODAL_SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-6xl' };

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', bodyClass }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-6">
      <div className="fixed inset-0 bg-[#02040a]/75 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        className={cx('surface relative my-auto w-full rounded-2xl animate-fadeUp', MODAL_SIZES[size] || MODAL_SIZES.md)}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white">{title}</h3>
            {subtitle ? <p className="mt-1 text-[12px] text-slate-400">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white" aria-label="close">
            <X className="h-[18px] w-[18px]" />
          </button>
        </header>
        <div className={cx('max-h-[70vh] overflow-y-auto px-5 py-5', bodyClass)}>{children}</div>
        {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}

export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-xl' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[90] flex justify-end">
      <div className="absolute inset-0 bg-[#02040a]/70 backdrop-blur-sm animate-fadeIn" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        className={cx('surface relative flex h-full w-full flex-col border-s animate-fadeIn', width)}
        style={{ animation: 'drawerIn .28s cubic-bezier(.22,1,.36,1)' }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-white">{title}</h3>
            {subtitle ? <p className="mt-1 text-[12px] text-slate-400">{subtitle}</p> : null}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white" aria-label="close">
            <X className="h-[18px] w-[18px]" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}

export function EmptyState({ icon: Icon = Inbox, title, hint, action, className }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03] text-slate-500">
        <Icon className="h-7 w-7" />
        <span className="absolute inset-0 rounded-2xl bg-emerald-500/5 blur-xl" />
      </span>
      <h3 className="mt-4 text-sm font-semibold text-slate-200">{title}</h3>
      {hint ? <p className="mt-1.5 max-w-sm text-[12px] leading-6 text-slate-500">{hint}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Pagination({ page, pageSize = 20, total = 0, onChange }) {
  const { t, lang } = useI18n();
  const pages = Math.max(1, Math.ceil(Number(total) / Number(pageSize || 20)));
  if (pages <= 1) return null;
  const current = Math.min(pages, Math.max(1, Number(page || 1)));
  const items = [];
  const push = (value) => { if (!items.includes(value)) items.push(value); };
  push(1);
  for (let i = current - 1; i <= current + 1; i += 1) if (i > 1 && i < pages) push(i);
  push(pages);
  items.sort((a, b) => a - b);
  const nodes = [];
  items.forEach((value, index) => {
    if (index && value - items[index - 1] > 1) nodes.push(<span key={`gap-${value}`} className="px-1 text-slate-600">…</span>);
    nodes.push(
      <button
        key={value}
        type="button"
        onClick={() => onChange(value)}
        className={cx(
          'h-8 min-w-8 rounded-lg px-2 text-xs font-medium transition',
          value === current
            ? 'bg-gradient-to-r from-emerald-500/90 to-cyan-500/90 text-[#04120f] shadow-[0_6px_20px_-8px_rgba(16,185,129,.8)]'
            : 'text-slate-400 hover:bg-white/[0.07] hover:text-white'
        )}
      >
        {formatNumber(value, lang)}
      </button>
    );
  });
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-[11px] text-slate-500">
        {t('common.total')}: {formatNumber(total, lang)} · {t('common.page')} {formatNumber(current, lang)} / {formatNumber(pages, lang)}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={current <= 1}
          onClick={() => onChange(current - 1)}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4 rtl:block ltr:hidden" />
          <ChevronLeft className="h-4 w-4 ltr:block rtl:hidden" />
          {t('common.prev')}
        </button>
        {nodes.map((node) => (
          <React.Fragment key={node.key}>{node}</React.Fragment>
        ))}
        <button
          type="button"
          disabled={current >= pages}
          onClick={() => onChange(current + 1)}
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-slate-400 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40"
        >
          {t('common.next')}
          <ChevronLeft className="h-4 w-4 rtl:block ltr:hidden" />
          <ChevronRight className="h-4 w-4 ltr:block rtl:hidden" />
        </button>
      </div>
    </div>
  );
}

export function Tabs({ tabs, active, onChange, className }) {
  return (
    <div className={cx('flex flex-wrap gap-1 rounded-xl border border-white/[0.07] bg-white/[0.03] p-1', className)}>
      {tabs.map((tab) => {
        const value = typeof tab === 'string' ? tab : tab.value;
        const label = typeof tab === 'string' ? tab : tab.label;
        const Icon = typeof tab === 'object' ? tab.icon : null;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onChange(value)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200',
              active === value
                ? 'bg-gradient-to-r from-emerald-500/20 to-cyan-500/10 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(16,185,129,.25)]'
                : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, className }) {
  return (
    <span className={cx('relative block', className)}>
      <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" style={{ insetInlineStart: '0.85rem' }} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input"
        style={{ paddingInlineStart: '2.4rem' }}
      />
    </span>
  );
}

export function CopyButton({ value, label, className, size = 'sm', variant = 'secondary', iconOnly = false }) {
  const { t } = useI18n();
  const toast = useToast();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setDone(true);
      toast.success(t('common.copied'));
      setTimeout(() => setDone(false), 1600);
    } catch (_) {
      toast.error(t('errors.generic'));
    }
  };
  if (iconOnly) {
    return (
      <IconButton icon={done ? Check : Copy} label={label || t('common.copy')} variant={variant} onClick={copy} className={className} />
    );
  }
  return (
    <Button variant={variant} size={size} icon={done ? Check : Copy} onClick={copy} className={className}>
      {label || t('common.copy')}
    </Button>
  );
}

export function QrModal({ open, onClose, value, title, subtitle }) {
  const { t } = useI18n();
  return (
    <Modal open={open} onClose={onClose} title={title || t('common.qr')} subtitle={subtitle || t('configs.detail.qrHint')} size="sm">
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-2xl bg-white p-4 shadow-[0_20px_60px_-24px_rgba(16,185,129,.5)]">
          {value ? <QRCodeCanvas value={value} size={232} level="M" marginSize={1} bgColor="#ffffff" fgColor="#050811" /> : null}
        </div>
        {value ? <p className="w-full break-all rounded-xl bg-white/[0.04] p-3 text-center text-[11px] leading-5 text-slate-400">{value}</p> : null}
        <CopyButton value={value} label={t('common.copyLink')} className="w-full" />
      </div>
    </Modal>
  );
}

export function Skeleton({ className }) {
  return <div className={cx('skeleton', className)} />;
}

export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="space-y-2.5 p-4">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-3">
          {Array.from({ length: cols }).map((__, colIndex) => (
            <Skeleton key={colIndex} className={cx('h-8 flex-1', colIndex === 0 && 'max-w-[160px]')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-300">
        <AlertCircle className="h-6 w-6" />
      </span>
      <p className="text-sm text-slate-300">{message || t('errors.generic')}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={onRetry}>
          {t('common.refresh')}
        </Button>
      ) : null}
    </div>
  );
}

export function Avatar({ name, size = 'md', className }) {
  const initial = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  const gradients = [
    'from-emerald-500/80 to-cyan-500/80',
    'from-cyan-500/80 to-blue-500/80',
    'from-violet-500/80 to-fuchsia-500/80',
    'from-amber-500/80 to-orange-500/80',
    'from-sky-500/80 to-indigo-500/80',
  ];
  const hash = [...String(name || 'x')].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const sizes = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-base' };
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br font-bold text-[#04120f] shadow-inner',
        gradients[hash % gradients.length],
        sizes[size] || sizes.md,
        className
      )}
    >
      {initial}
    </span>
  );
}

export function InfoRow({ label, value, mono, className }) {
  return (
    <div className={cx('flex items-start justify-between gap-3 py-2 text-[12.5px]', className)}>
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={cx('min-w-0 break-all text-end font-medium text-slate-200', mono && 'font-mono text-[11.5px]')}>{value}</span>
    </div>
  );
}

export function BtnGroup({ children, className }) {
  return <div className={cx('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

export function Toolbar({ children, className }) {
  return <div className={cx('mb-4 flex flex-wrap items-center gap-2.5', className)}>{children}</div>;
}

export function useDebounced(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function Spinner({ className }) {
  return <Loader2 className={cx('h-5 w-5 animate-spin text-emerald-300', className)} />;
}

export function CountUp({ value, suffix }) {
  const { lang } = useI18n();
  const target = Number(value || 0);
  const [display, setDisplay] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const from = 0;
    const duration = 550;
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(from + (target - from) * eased);
      if (progress < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  return <span>{formatNumber(display, lang)}{suffix || ''}</span>;
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = (event) => setMatches(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return matches;
}
