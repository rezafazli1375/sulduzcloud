import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bell,
  Boxes,
  ChevronDown,
  CreditCard,
  DatabaseBackup,
  Globe2,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Network,
  Plus,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatBytes, formatDate, relativeTime } from '../lib/format.js';
import { Avatar, Badge, ThemeToggle, cx } from './ui.jsx';
import { useConfirm, useToast } from './feedback.jsx';

const ADMIN_GROUPS = [
  {
    key: 'groupMain',
    items: [
      { to: '/', end: true, label: 'nav.overview', icon: LayoutDashboard, perm: 'stats' },
      { to: '/resellers', label: 'nav.resellers', icon: Users, perm: 'users' },
      { to: '/configs', label: 'nav.configs', icon: Boxes, perm: 'configs' },
      { to: '/inbounds', label: 'nav.inbounds', icon: Network, perm: 'inbounds' },
      { to: '/stats', label: 'nav.stats', icon: Activity, perm: 'stats' },
    ],
  },
  {
    key: 'groupManage',
    items: [
      { to: '/servers', label: 'nav.servers', icon: Server, perm: 'servers' },
      { to: '/tickets', label: 'nav.tickets', icon: MessageSquare, perm: 'tickets' },
      { to: '/broadcasts', label: 'nav.broadcasts', icon: Sparkles, perm: 'broadcasts' },
    ],
  },
  {
    key: 'groupSystem',
    items: [
      { to: '/backups', label: 'nav.backups', icon: DatabaseBackup, perm: 'backups' },
      { to: '/audit', label: 'nav.audit', icon: ScrollText, perm: 'audit' },
      { to: '/settings', label: 'nav.settings', icon: Settings, perm: 'settings' },
    ],
  },
];

const RESELLER_GROUPS = [
  {
    key: 'groupMain',
    items: [
      { to: '/', end: true, label: 'nav.overview', icon: LayoutDashboard },
      { to: '/configs', label: 'nav.configs', icon: Boxes },
      { to: '/stats', label: 'nav.stats', icon: Activity },
      { to: '/tickets', label: 'nav.tickets', icon: MessageSquare },
      { to: '/wallet', label: 'nav.wallet', icon: CreditCard },
    ],
  },
  {
    key: 'groupAccount',
    items: [
      { to: '/notifications', label: 'nav.notifications', icon: Bell },
      { to: '/profile', label: 'nav.profile', icon: ShieldCheck },
    ],
  },
];

function Logo({ compact = false }) {
  const { meta, isAdmin } = useAuth();
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3">
      <span className="relative flex h-10 w-10 items-center justify-center">
        <span className="absolute inset-0 rounded-xl bg-gradient-to-br from-emerald-400 via-cyan-400 to-violet-500 opacity-90 blur-[6px]" />
        <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 shadow-[0_8px_24px_-8px_rgba(16,185,129,.9)]">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-[#04120f]" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 11.2 4 4 0 0 0 7 19h10.5Z" />
          </svg>
        </span>
      </span>
      {!compact ? (
        <div className="min-w-0">
          <p className="truncate text-[15px] font-bold tracking-tight text-white">{meta?.panelName || 'Sulduz Cloud'}</p>
          <p className="truncate text-[10px] uppercase tracking-[0.18em] text-emerald-300/70">{isAdmin ? t('app.controlPanel') : t('app.resellerPanel')}</p>
        </div>
      ) : null}
    </div>
  );
}

function NavSection({ groupKey, items, onNavigate }) {
  const { t } = useI18n();
  return (
    <div className="mb-5">
      <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">{t(`nav.${groupKey}`)}</p>
      <nav className="space-y-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) => cx('sidebar-item', isActive && 'active')}
          >
            {({ isActive }) => (
              <>
                <item.icon className={cx('h-[18px] w-[18px] transition', isActive ? 'text-emerald-300' : 'text-slate-500')} />
                <span className="truncate">{t(item.label)}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function NotificationBell() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const { data } = useQuery({
    queryKey: ['notifications', 'bell'],
    queryFn: () => api.get('/notifications?pageSize=8'),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const markRead = useMutation({
    mutationFn: (id) => api.post('/notifications/read', { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = Number(data?.unread || 0);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-slate-300 transition hover:border-emerald-400/30 hover:text-white"
        aria-label={t('notifications.title')}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 ? (
          <span className="absolute -top-1 -end-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gradient-to-r from-rose-500 to-orange-500 px-1 text-[9px] font-bold text-white shadow-[0_0_12px_rgba(244,63,94,.8)]">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute end-0 top-11 z-50 w-[min(92vw,360px)] overflow-hidden rounded-2xl border border-white/10 bg-[#070c17]/98 shadow-[0_30px_80px_-24px_#000] backdrop-blur-xl animate-fadeUp">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <p className="text-sm font-semibold text-white">{t('notifications.title')}</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => markRead.mutate(0)}
                className="text-[11px] font-medium text-emerald-300 transition hover:text-emerald-200"
              >
                {t('notifications.markAll')}
              </button>
            ) : null}
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            {(data?.rows || []).length ? (
              data.rows.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (!item.readAt) markRead.mutate(item.id);
                    setOpen(false);
                    if (item.link) navigate(item.link);
                  }}
                  className={cx(
                    'block w-full border-b border-white/[0.04] px-4 py-3 text-start transition hover:bg-white/[0.04]',
                    !item.readAt && 'bg-emerald-500/[0.045]'
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <span className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', item.readAt ? 'bg-slate-600' : 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,.9)]')} />
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-slate-200">{item.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-5 text-slate-500">{item.body}</p>
                      <p className="mt-1 text-[10px] text-slate-600">{relativeTime(item.createdAt, lang)}</p>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <p className="px-4 py-10 text-center text-[12px] text-slate-500">{t('notifications.empty')}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setOpen(false); navigate('/notifications'); }}
            className="block w-full border-t border-white/[0.06] px-4 py-2.5 text-center text-[11px] font-medium text-emerald-300 transition hover:bg-white/[0.04]"
          >
            {t('common.viewAll')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const { user, logout, meta } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const doLogout = async () => {
    setOpen(false);
    const ok = await confirm({ title: t('auth.logoutConfirm'), confirmText: t('nav.logout'), danger: true });
    if (ok) {
      await logout();
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] py-1.5 pe-2.5 ps-1.5 transition hover:border-emerald-400/30"
      >
        <Avatar name={user?.name || user?.username} size="sm" />
        <span className="hidden text-start sm:block">
          <span className="block max-w-[140px] truncate text-[12px] font-semibold text-slate-200">{user?.name || user?.username}</span>
          <span className="block text-[9.5px] uppercase tracking-wide text-slate-500">{user?.role === 'admin' ? t('common.admin') : t('common.reseller')}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
      </button>
      {open ? (
        <div className="absolute end-0 top-12 z-50 w-64 overflow-hidden rounded-2xl border border-white/10 bg-[#070c17]/98 shadow-[0_30px_80px_-24px_#000] backdrop-blur-xl animate-fadeUp">
          <div className="border-b border-white/[0.06] px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <Avatar name={user?.name || user?.username} />
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white">{user?.name || user?.username}</p>
                <p className="truncate text-[10.5px] text-slate-500">@{user?.username}</p>
              </div>
            </div>
            {user?.balance !== undefined ? (
              <div className="mt-3 flex items-center justify-between rounded-lg bg-emerald-500/[0.07] px-2.5 py-1.5">
                <span className="text-[10.5px] text-emerald-200/80">{t('common.balance')}</span>
                <span className="text-[11.5px] font-semibold text-emerald-300">
                  {Number(user.balance || 0).toLocaleString()} {meta?.billing?.currency || ''}
                </span>
              </div>
            ) : null}
          </div>
          <div className="p-1.5">
            <button
              type="button"
              onClick={() => { setOpen(false); navigate('/profile'); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <ShieldCheck className="h-4 w-4 text-slate-500" />
              {t('profile.title')}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); navigate('/notifications'); }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <Bell className="h-4 w-4 text-slate-500" />
              {t('notifications.title')}
            </button>
            <button
              type="button"
              onClick={doLogout}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-rose-300 transition hover:bg-rose-500/10"
            >
              <LogOut className="h-4 w-4" />
              {t('nav.logout')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === 'fa' ? 'en' : 'fa')}
      className="flex h-9 items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-300 transition hover:border-cyan-400/30 hover:text-white"
      title="Language"
    >
      <Globe2 className="h-3.5 w-3.5" />
      {lang === 'fa' ? 'EN' : 'FA'}
    </button>
  );
}

function SidebarFooter() {
  const { meta, isAdmin } = useAuth();
  const { t } = useI18n();
  return (
    <div className="mt-auto space-y-3 px-3 pb-4 pt-3">
      {isAdmin ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <span className="text-[10.5px] font-medium text-slate-400">{t('servers.panel')}</span>
            <Badge tone="emerald" className="ms-auto">v{meta?.version || '1.0.0'}</Badge>
          </div>
        </div>
      ) : null}
      <a
        href={meta?.supportUrl || 'https://t.me/sulduzserver'}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-lg px-1 py-1 text-[10.5px] text-slate-600 transition hover:text-slate-300"
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {t('app.footer')}
      </a>
    </div>
  );
}

export default function Shell() {
  const { user, isAdmin, can } = useAuth();
  const { t, lang } = useI18n();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const groups = useMemo(() => {
    if (!isAdmin) return RESELLER_GROUPS;
    return ADMIN_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.perm || can(item.perm)),
    })).filter((group) => group.items.length);
  }, [isAdmin, can]);

  const currentLabel = useMemo(() => {
    const all = groups.flatMap((group) => group.items);
    const match = all.find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)));
    return match ? t(match.label) : t('nav.overview');
  }, [groups, location.pathname, t]);

  // Pages that already render their own "New config" action keep the header clean.
  const showQuickCreate = !(location.pathname === '/' || location.pathname.startsWith('/configs'));

  return (
    <div className="min-h-screen">
      {sidebarOpen ? (
        <div className="fixed inset-0 z-40 bg-[#02040a]/70 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      ) : null}

      <aside
        className={cx(
          'fixed inset-y-0 start-0 z-50 flex w-[268px] flex-col border-e border-white/[0.06] bg-[#060a14]/92 backdrop-blur-2xl transition-transform duration-300 lg:z-30 lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : 'max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full'
        )}
      >
        <div className="flex h-[68px] items-center justify-between border-b border-white/[0.06] px-5">
          <Link to="/" className="flex items-center">
            <Logo />
          </Link>
          <button
            type="button"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 pt-5">
          {groups.map((group) => (
            <NavSection key={group.key} groupKey={group.key} items={group.items} onNavigate={() => setSidebarOpen(false)} />
          ))}
        </div>

        <SidebarFooter />
      </aside>

      <div className="flex min-h-screen flex-col lg:ps-[268px]">
        <header className="sticky top-0 z-30 flex h-[68px] items-center gap-3 border-b border-white/[0.06] bg-[#050811]/72 px-4 backdrop-blur-xl sm:px-6">
          <button
            type="button"
            className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-2 text-slate-300 transition hover:text-white lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            <span className="text-[11px] uppercase tracking-[0.16em] text-slate-600">{t('app.nameEn')}</span>
            <span className="text-slate-700">/</span>
            <span className="truncate text-[13px] font-semibold text-slate-200">{currentLabel}</span>
          </div>

          <div className="ms-auto flex items-center gap-2">
            {showQuickCreate ? (
              <Link
                to="/configs?new=1"
                className="btn btn-primary hidden h-9 px-3 text-[11.5px] sm:inline-flex"
              >
                <Plus className="h-4 w-4" />
                {t('dash.createConfig')}
              </Link>
            ) : null}
            <ThemeToggle />
            <LangToggle />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>

        <footer className="border-t border-white/[0.05] px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-slate-600">
            <span>© {new Date().getFullYear()} Sulduz Cloud · {t('app.tagline')}</span>
            <span className="flex items-center gap-1.5">
              <span className={cx('h-1.5 w-1.5 rounded-full', user?.status === 'active' ? 'bg-emerald-400' : 'bg-rose-400')} />
              {user?.username} · {formatDate(Date.now(), lang)}
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
