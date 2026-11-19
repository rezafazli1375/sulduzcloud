import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Bell,
  Boxes,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  DatabaseBackup,
  FlaskConical,
  Globe2,
  HelpCircle,
  Layers,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Network,
  Plus,
  Receipt,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';
import { api } from '../lib/api.js';
import { formatBytes, formatDate, formatMoney, formatNumber, relativeTime } from '../lib/format.js';
import { Avatar, Badge, ThemeToggle, cx } from './ui.jsx';
import { useConfirm, useToast } from './feedback.jsx';

// v1.5.8: «پلن‌های آماده» سه زیرشاخهٔ همیشگی دارد — تست / عمومی / اختصاصی.
// هر شاخه یک مسیر واقعی است (/plans/test …) تا رفرش و لینک مستقیم هم کار کند.
const PLAN_CHILDREN = [
  { to: '/plans/test', label: 'nav.plansTest', icon: FlaskConical },
  { to: '/plans/public', label: 'nav.plansPublic', icon: Globe2 },
  { to: '/plans/exclusive', label: 'nav.plansExclusive', icon: Lock },
];

const ADMIN_GROUPS = [
  {
    key: 'groupMain',
    items: [
      { to: '/', end: true, label: 'nav.overview', icon: LayoutDashboard, perm: 'stats' },
      { to: '/resellers', label: 'nav.resellers', icon: Users, perm: 'users' },
      { to: '/configs', label: 'nav.configs', icon: Boxes, perm: 'configs' },
      { to: '/plans', end: true, label: 'nav.plans', icon: Layers, perm: 'configs', children: PLAN_CHILDREN },
      { to: '/inbounds', label: 'nav.inbounds', icon: Network, perm: 'inbounds' },
      { to: '/stats', label: 'nav.stats', icon: Activity, perm: 'stats' },
    ],
  },
  {
    key: 'groupManage',
    items: [
      { to: '/servers', label: 'nav.servers', icon: Server, perm: 'servers' },
      { to: '/tickets', label: 'nav.tickets', icon: MessageSquare, perm: 'tickets' },
      { to: '/topups', label: 'nav.topups', icon: Receipt, perm: 'users' },
      { to: '/node-search', label: 'nav.nodeSearch', icon: Search, perm: 'configs' },
      // v2.1.0: «زباله‌دان» — every package deleted outright lands here with the
      // email, uuid and subscribe token it had, and can be rebuilt from that.
      { to: '/trash', label: 'nav.trash', icon: Trash2, perm: 'configs' },
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
      { to: '/plans', end: true, label: 'nav.plans', icon: Layers, children: PLAN_CHILDREN },
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

function NavSection({ groupKey, items, onNavigate, showBroadcastBadge = false }) {
  const { t } = useI18n();
  const location = useLocation();
  // When a shelf child is the current page, the parent «پلن‌های آماده» stays lit too.
  const childActive = (item) => Boolean(item.children?.some((child) => location.pathname === child.to || location.pathname.startsWith(`${child.to}/`)));

  // v1.5.4, item 5: the red number in front of «اعلان‌ها». It counts ONLY the
  // owner's own messages (type 'broadcast' — the /broadcast endpoint is the only
  // thing that writes it), not every unread row, because the reseller asked to
  // know when the OWNER wrote to him. The query shares the bell's cache key, so
  // the badge and the dropdown are the same request, not two.
  const { data } = useQuery({
    queryKey: ['notifications', 'bell'],
    queryFn: () => api.get('/notifications?pageSize=8'),
    enabled: showBroadcastBadge,
    refetchInterval: 30000,
    staleTime: 15000,
  });
  const ownerUnread = Number(data?.unreadBroadcast || 0);

  return (
    <div className="mb-5">
      <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">{t(`nav.${groupKey}`)}</p>
      <nav className="space-y-1">
        {items.map((item) => (
          <div key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) => cx('sidebar-item', (isActive || childActive(item)) && 'active')}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cx('h-[18px] w-[18px] transition', isActive || childActive(item) ? 'text-emerald-300' : 'text-slate-500')} />
                  <span className="truncate">{t(item.label)}</span>
                  {showBroadcastBadge && item.to === '/notifications' && ownerUnread > 0 ? (
                    <span
                      dir="ltr"
                      title={t('notifications.ownerUnread')}
                      className="ms-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gradient-to-r from-rose-500 to-red-600 px-1.5 text-[9.5px] font-bold text-white shadow-[0_0_12px_rgba(244,63,94,.85)]"
                    >
                      {ownerUnread > 99 ? '99+' : ownerUnread}
                    </span>
                  ) : null}
                </>
              )}
            </NavLink>
            {item.children ? (
              <div className="mt-0.5 space-y-0.5 border-s border-white/[0.06] ps-3 ms-5">
                {item.children.map((child) => (
                  <NavLink
                    key={child.to}
                    to={child.to}
                    onClick={onNavigate}
                    className={({ isActive }) => cx('sidebar-item !py-1.5 !text-[12px]', isActive && 'active')}
                  >
                    {({ isActive }) => (
                      <>
                        <child.icon className={cx('h-3.5 w-3.5 transition', isActive ? 'text-emerald-300' : 'text-slate-500')} />
                        <span className="truncate">{t(child.label)}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            ) : null}
          </div>
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

/**
 * v1.5.3: the reseller's balance, live in the header.
 *
 * The wallet used to appear only on the wallet page, so after paying through the
 * Telegram bot the reseller had to reload and hunt for the new number. This chip
 * reads /reseller/balance — a one-row query — every 20 s, when the tab comes back
 * to the foreground, and right after the panel itself spent or earned money (the
 * wallet mutation invalidates this key). A change flashes emerald or rose for a
 * moment, so a charge that lands while he is working is seen, not guessed.
 *
 * It renders for resellers only: an admin has no wallet of his own to watch.
 */
function LiveBalance() {
  const { t, lang } = useI18n();
  const { isReseller } = useAuth();
  const queryClient = useQueryClient();
  const [flash, setFlash] = useState('');
  const previous = useRef(null);

  const { data } = useQuery({
    queryKey: ['wallet', 'live'],
    queryFn: () => api.get('/reseller/balance'),
    enabled: isReseller,
    refetchInterval: 20000,
    staleTime: 10000,
  });

  // A tab that was in the background is read again the moment it is seen: the bot
  // charges wallets while nobody is looking at the panel.
  useEffect(() => {
    if (!isReseller) return undefined;
    const onWake = () => {
      if (document.visibilityState === 'visible') queryClient.invalidateQueries({ queryKey: ['wallet', 'live'] });
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [isReseller, queryClient]);

  // Navigating is the moment a purchase has already happened: the configs page
  // spent wallet money, so the chip re-reads the balance instead of showing the
  // number from before the click.
  const pagePath = useLocation().pathname;
  useEffect(() => {
    if (!isReseller) return;
    queryClient.invalidateQueries({ queryKey: ['wallet', 'live'] });
  }, [pagePath, isReseller, queryClient]);

  const balance = data ? Number(data.balance || 0) : null;
  useEffect(() => {
    if (balance === null) return undefined;
    const before = previous.current;
    previous.current = balance;
    if (before === null || before === balance) return undefined;
    setFlash(balance > before ? 'up' : 'down');
    const timer = setTimeout(() => setFlash(''), 2200);
    return () => clearTimeout(timer);
  }, [balance]);

  if (!isReseller) return null;

  return (
    <Link
      to="/wallet"
      title={t('wallet.liveBalanceHint')}
      className={cx(
        'flex h-9 items-center gap-2 rounded-xl border px-3 text-[11.5px] font-semibold transition',
        flash === 'up'
          ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_18px_-6px_rgba(16,185,129,.9)]'
          : flash === 'down'
            ? 'border-rose-400/50 bg-rose-500/15 text-rose-200'
            : 'border-white/[0.08] bg-white/[0.04] text-slate-200 hover:border-emerald-400/30 hover:text-white'
      )}
    >
      <Wallet className="h-[15px] w-[15px] text-emerald-300" />
      <span dir="ltr" className="tabular-nums">
        {balance === null ? '—' : formatMoney(balance, lang, data.currency)}
      </span>
      {Number(data?.pending || 0) > 0 ? (
        <span className="hidden rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-200 sm:inline-block">
          {t('wallet.receiptPending')} {formatNumber(data.pending, lang)}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * v1.5.4, item 1: «افزایش موجودی» next to the balance.
 *
 * The reseller asked for the top-up action where he already looks for his money,
 * not two clicks deeper. This is a link to the wallet page with ?topup=1, which
 * opens the payment section there — the button does not take money by itself, and
 * it must not pretend to: every path still ends in a pending topup_requests row
 * that the owner or the schedule decides.
 *
 * Renders for resellers only, for the same reason as the balance chip: an admin
 * has no wallet of his own to top up.
 */
function TopUpButton() {
  const { t } = useI18n();
  const { isReseller } = useAuth();

  if (!isReseller) return null;

  return (
    <Link
      to="/wallet?topup=1"
      title={t('wallet.topUp')}
      className="flex h-9 items-center gap-1.5 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-2.5 text-[11.5px] font-semibold text-emerald-200 transition hover:border-emerald-400/50 hover:bg-emerald-500/20 hover:text-white"
    >
      <Plus className="h-[15px] w-[15px]" />
      <span className="hidden sm:inline">{t('wallet.topUp')}</span>
    </Link>
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
      {meta?.supportUrl ? (
        <a
          href={meta.supportUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg px-1 py-1 text-[10.5px] text-slate-600 transition hover:text-slate-300"
        >
          <HelpCircle className="h-3.5 w-3.5" />
          {t('app.footer')}
        </a>
      ) : (
        <p className="flex items-center gap-2 px-1 py-1 text-[10.5px] text-slate-600">
          <HelpCircle className="h-3.5 w-3.5" />
          {t('app.footer')}
        </p>
      )}
      <p className="flex items-center justify-between gap-2 border-t border-white/[0.05] px-1 pt-2.5 text-[9.5px] text-slate-600">
        <span dir="ltr">{t('app.version')} {meta?.version || '1.4.1'}</span>
        <span>{t('app.author')}: {t('app.authorName')}</span>
      </p>
    </div>
  );
}

/**
 * v2.1.0 — «نوار اطلاع‌رسانی», the owner's banner.
 *
 * His ask: in an emergency — a node down, the internet cut — a line of his own
 * words appears above every page of the reseller panel, in green or in red, for
 * everyone or only for the resellers he picked. The example he gave was an offer
 * («تخفیف ویژه برای حساب کاربری شما اعمال شد»), so this is a notice, not an alarm.
 *
 * The whole decision of who sees what lives in services/banner.js; this component
 * only asks GET /api/banner, which answers `null` when there is nothing to show —
 * switched off, no text, outside its window, or this account is not one of the
 * ones he picked. That is why there is no logic here beyond rendering: the server
 * already said whether THIS account should see it.
 *
 * Refetched every minute on purpose («در شرایط بحرانی»). A notice that only
 * appears after the reseller reloads the page is a notice nobody gets during an
 * outage, and one small GET a minute per open panel is what makes it arrive.
 */
function BroadcastBanner() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState('');

  const banner = useQuery({
    queryKey: ['banner'],
    queryFn: () => api.get('/banner'),
    refetchInterval: 60000,
    retry: false,
  });

  const data = banner.data;
  // A new message is a new message: an earlier dismissal must not hide it.
  if (!data?.text || dismissed === data.text) return null;

  const red = data.tone === 'red';
  return (
    <div
      role="status"
      dir="rtl"
      className={
        red
          ? 'flex items-center gap-3 border-b border-rose-400/30 bg-rose-600/90 px-4 py-2.5 text-[12.5px] font-medium text-white sm:px-6'
          : 'flex items-center gap-3 border-b border-emerald-400/30 bg-emerald-600/90 px-4 py-2.5 text-[12.5px] font-medium text-white sm:px-6'
      }
    >
      {red ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}
      <p className="min-w-0 flex-1 leading-6">{data.text}</p>
      <button
        type="button"
        onClick={() => setDismissed(data.text)}
        aria-label={t('banner.dismiss')}
        title={t('banner.dismiss')}
        className="shrink-0 rounded-lg p-1 text-white/80 transition hover:bg-white/15 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
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

  // v1.5.5, item 3: on a phone the drawer covers the page, so the page behind it
  // must stop scrolling and Escape must close it — the two things a desktop
  // pointer gives you for free. Locking document overflow is what the panel's own
  // Drawer (ui.jsx) already does for every modal here, so the sidebar behaves
  // like the rest of the app instead of a half-open column.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [sidebarOpen]);

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

      {/*
        v1.5.5, item 3 — why the column is shown with `display` and not with a
        transform. The old rule slid it away with `max-lg:rtl:translate-x-full`,
        and `max-lg:` is the ONLY media-range variant in the whole app: it compiles
        to `@media (width <= 1023px)`, which Chrome below 104 and the WebView that
        ships with older Androids throw away. On such a phone the closed state had
        no rule at all, so the drawer sat over the page with nothing to hide it and
        the button looked dead — the owner's «درست باز نمیشه و ناپدید…».
        `hidden` / `lg:flex` are plain class toggles, so the drawer is either on
        screen or not on screen, exactly like the panel's own Drawer component.
      */}
      <aside
        className={cx(
          'fixed inset-y-0 start-0 z-50 w-[268px] flex-col border-e border-white/[0.06] bg-[#060a14]/92 backdrop-blur-2xl lg:z-30 lg:flex',
          sidebarOpen ? 'flex' : 'hidden'
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

        {/* On a phone the header has no room left for these two, so they live
            here instead; from 640px up the header carries them again. */}
        <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3 sm:hidden">
          <ThemeToggle />
          <LangToggle />
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 pt-5">
          {groups.map((group) => (
            <NavSection key={group.key} groupKey={group.key} items={group.items} onNavigate={() => setSidebarOpen(false)} showBroadcastBadge={!isAdmin} />
          ))}
        </div>

        <SidebarFooter />
      </aside>

      <div className="flex min-h-screen flex-col lg:ps-[268px]">
        <header className="sticky top-0 z-30 flex h-[68px] items-center gap-3 border-b border-white/[0.06] bg-[#050811]/72 px-4 backdrop-blur-xl sm:px-6">
          <button
            type="button"
            className="shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.04] p-2 text-slate-300 transition hover:text-white lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="menu"
            aria-expanded={sidebarOpen}
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="hidden min-w-0 items-center gap-2 sm:flex">
            <span className="text-[11px] uppercase tracking-[0.16em] text-slate-600">{t('app.nameEn')}</span>
            <span className="text-slate-700">/</span>
            <span className="truncate text-[13px] font-semibold text-slate-200">{currentLabel}</span>
          </div>

          <div className="ms-auto flex min-w-0 items-center gap-2">
            {showQuickCreate ? (
              <Link
                to="/configs?new=1"
                className="btn btn-primary hidden h-9 px-3 text-[11.5px] sm:inline-flex"
              >
                <Plus className="h-4 w-4" />
                {t('dash.createConfig')}
              </Link>
            ) : null}
            {/* v1.5.3: the reseller's wallet, always in reach; renders for him only. */}
            <LiveBalance />
            {/* v1.5.4, item 1: the top-up button, right beside that balance. */}
            <TopUpButton />
            {/*
              v1.5.5, item 3: these two need ~96px of a 390px row that is already
              full, and a flex row does not wrap what it cannot shrink — it pushes
              the FIRST item off the edge, which in RTL is the menu button itself.
              Below 640px they move into the drawer instead, so the button that
              opens the menu is always on screen.
            */}
            <div className="hidden items-center gap-2 sm:flex">
              <ThemeToggle />
              <LangToggle />
            </div>
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        {/*
          v2.1.0: the owner's broadcast. It sits between the header and the page so
          it is the first thing the reseller sees, and it is OUTSIDE <main>, which
          means an admin page that scrolls cannot push it away.
        */}
        <BroadcastBanner />

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
