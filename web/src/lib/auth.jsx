import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, onUnauthorized, setCsrfToken } from './api.js';

const AuthContext = createContext(null);

const EMPTY = {
  loading: true,
  user: null,
  meta: null,
  error: null,
};

export function AuthProvider({ children }) {
  const [state, setState] = useState(EMPTY);

  const applySession = useCallback((payload) => {
    if (payload?.csrf) setCsrfToken(payload.csrf);
    setState((prev) => ({
      loading: false,
      user: payload?.user || null,
      meta: payload?.meta || prev.meta,
      error: null,
    }));
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      applySession(data);
    } catch (_) {
      try {
        const meta = await api.get('/meta');
        if (meta?.csrf) setCsrfToken(meta.csrf);
        setState({ loading: false, user: null, meta, error: null });
      } catch (err) {
        setState({ loading: false, user: null, meta: null, error: err });
      }
    }
  }, [applySession]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => onUnauthorized(() => {
    setState((prev) => ({ ...prev, user: null, loading: false }));
  }), []);

  const login = useCallback(async (username, password) => {
    const data = await api.post('/auth/login', { username, password });
    applySession(data);
    return data;
  }, [applySession]);

  const setup = useCallback(async (payload) => {
    const data = await api.post('/setup', payload);
    applySession(data);
    return data;
  }, [applySession]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch (_) {
      /* session may already be expired */
    }
    setState((prev) => ({ ...prev, user: null }));
  }, []);

  const refresh = useCallback(async () => {
    const data = await api.get('/auth/me');
    applySession(data);
    return data;
  }, [applySession]);

  const patchUser = useCallback((patch) => {
    setState((prev) => ({ ...prev, user: prev.user ? { ...prev.user, ...patch } : prev.user }));
  }, []);

  const value = useMemo(() => {
    const user = state.user;
    const isAdmin = user?.role === 'admin';
    const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
    const isOwner = Boolean(user?.isOwner);
    const can = (perm) => {
      if (!isAdmin) return false;
      if (isOwner || permissions.includes('*')) return true;
      return permissions.includes(perm);
    };
    return {
      ...state,
      setupRequired: Boolean(state.meta?.setupRequired),
      isAdmin,
      isReseller: user?.role === 'reseller',
      isOwner,
      can,
      login,
      setup,
      logout,
      refresh,
      patchUser,
      setMeta: (meta) => setState((prev) => ({ ...prev, meta })),
    };
  }, [state, login, setup, logout, refresh, patchUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
