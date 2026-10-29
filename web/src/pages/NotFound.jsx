import React from 'react';
import { Link } from 'react-router-dom';
import { Compass, Home } from 'lucide-react';
import { useI18n } from '../lib/i18n.jsx';

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="card relative w-full max-w-md overflow-hidden p-8 text-center">
        <div className="pointer-events-none absolute -top-16 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full bg-emerald-500/20 blur-3xl" />
        <span className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03] text-emerald-300">
          <Compass className="h-7 w-7" />
        </span>
        <p className="relative mt-6 font-mono text-4xl font-bold tracking-tight text-white">404</p>
        <p className="relative mt-2 text-[13px] text-slate-400">{t('errors.notFound')}</p>
        <Link to="/" className="btn btn-primary relative mt-6 inline-flex">
          <Home className="h-4 w-4" />
          {t('nav.overview')}
        </Link>
      </div>
    </div>
  );
}
