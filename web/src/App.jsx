import React, { useEffect } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Home, LockKeyhole, ShieldAlert } from 'lucide-react';

import { LanguageProvider, useI18n } from './lib/i18n.jsx';
import { AuthProvider, useAuth } from './lib/auth.jsx';
import { ToastProvider, ConfirmProvider } from './components/feedback.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Shell from './components/Shell.jsx';

import Login from './pages/auth/Login.jsx';
import Overview from './pages/Overview.jsx';
import Configs from './pages/Configs.jsx';
import Stats from './pages/Stats.jsx';
import Tickets from './pages/Tickets.jsx';
import Notifications from './pages/Notifications.jsx';
import Profile from './pages/Profile.jsx';
import NotFound from './pages/NotFound.jsx';
import Resellers from './pages/admin/Resellers.jsx';
import Inbounds from './pages/admin/Inbounds.jsx';
import Servers from './pages/admin/Servers.jsx';
import Broadcasts from './pages/admin/Broadcasts.jsx';
import Backups from './pages/admin/Backups.jsx';
import Audit from './pages/admin/Audit.jsx';
import Settings from './pages/admin/Settings.jsx';
import Wallet from './pages/reseller/Wallet.jsx';
import ApiPage from './pages/reseller/ApiPage.jsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15000,
    },
    mutations: { retry: 0 },
  },
});

function BootScreen() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5">
      <div className="relative">
        <span className="absolute inset-0 rounded-2xl bg-emerald-500/30 blur-2xl" />
        <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-cyan-500 text-[#04120f] shadow-glow">
          <ShieldAlert className="h-6 w-6" />
        </span>
      </div>
      <div className="text-center">
        <p className="text-sm font-semibold text-white">{t('app.name')}</p>
        <p className="mt-1 text-[11px] text-slate-500">{t('common.loading')}</p>
      </div>
      <div className="h-1 w-40 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full w-1/2 animate-shimmer rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" style={{ backgroundSize: '200% 100%' }} />
      </div>
    </div>
  );
}



function NoAccess() {
  const { t } = useI18n();
  return (
    <div className="card mx-auto mt-10 max-w-md p-8 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-300">
        <LockKeyhole className="h-6 w-6" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-white">{t('common.noAccess')}</h2>
      <p className="mt-1.5 text-[12px] text-slate-500">{t('errors.forbidden')}</p>
      <Link to="/" className="btn btn-secondary mt-5 inline-flex">
        <Home className="h-4 w-4" />
        {t('nav.overview')}
      </Link>
    </div>
  );
}

function Protected({ children, adminOnly, resellerOnly, perm }) {
  const { loading, user, isAdmin, isReseller, can } = useAuth();
  if (loading) return <BootScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) return <NoAccess />;
  if (resellerOnly && !isReseller) return <NoAccess />;
  if (perm && !can(perm)) return <NoAccess />;
  return children;
}

function PublicRoute({ children }) {
  const { loading } = useAuth();
  if (loading) return <BootScreen />;
  return children;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [pathname]);
  return null;
}

function AppRoutes() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route element={<Protected><Shell /></Protected>}>
          <Route index element={<Overview />} />
          <Route path="configs" element={<Configs />} />
          <Route path="stats" element={<Stats />} />
          <Route path="tickets" element={<Tickets />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="profile" element={<Profile />} />

          <Route path="resellers" element={<Protected adminOnly perm="users"><Resellers /></Protected>} />
          <Route path="inbounds" element={<Protected adminOnly perm="inbounds"><Inbounds /></Protected>} />
          <Route path="servers" element={<Protected adminOnly perm="servers"><Servers /></Protected>} />
          <Route path="broadcasts" element={<Protected adminOnly perm="broadcasts"><Broadcasts /></Protected>} />
          <Route path="backups" element={<Protected adminOnly perm="backups"><Backups /></Protected>} />
          <Route path="audit" element={<Protected adminOnly perm="audit"><Audit /></Protected>} />
          <Route path="settings" element={<Protected adminOnly perm="settings"><Settings /></Protected>} />

          <Route path="wallet" element={<Protected resellerOnly><Wallet /></Protected>} />
          <Route path="api-keys" element={<Protected resellerOnly><ApiPage /></Protected>} />

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <BrowserRouter>
                <ErrorBoundary>
                  <AppRoutes />
                </ErrorBoundary>
              </BrowserRouter>
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}
