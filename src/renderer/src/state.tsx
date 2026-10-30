import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, SessionInfo } from '../../shared/types';
import type { Permission } from '../../shared/permissions';
import { ApiClientError, call, getToken, setToken } from './api';
import { Toasts, type ToastMessage } from './components/ui';

interface AppContextValue {
  state: AppState | null;
  session: SessionInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<AppState | null>;
  signIn: (username: string, password: string) => Promise<SessionInfo>;
  signOut: () => Promise<void>;
  notify: (message: string, tone?: ToastMessage['tone']) => void;
  notifyError: (error: unknown) => void;
  can: (permission: Permission) => boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const idRef = useRef(0);

  const notify = useCallback((message: string, tone: ToastMessage['tone'] = 'info') => {
    const id = ++idRef.current;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const notifyError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiClientError) {
        if (err.code === 'UNAUTHENTICATED') {
          setToken(null);
          void refreshState();
        }
        notify(err.message, 'error');
        return;
      }
      notify(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notify]
  );

  const refreshState = useCallback(async (): Promise<AppState | null> => {
    try {
      const next = await call<AppState>('app.state');
      setState(next);
      if (next.session) setToken(next.session.token);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the Infoflex service.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  /**
   * Idle auto sign-out. The main process enforces the same limit on every call,
   * so a renderer that ignores this timer still loses the session; this just
   * returns the user to the login screen politely.
   */
  useEffect(() => {
    if (!state?.session) return;
    const minutes = Math.max(1, state.idleTimeoutMinutes || 15);
    const limit = minutes * 60_000;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const events: Array<keyof WindowEventMap> = [
      'mousedown',
      'keydown',
      'touchstart',
      'mousemove',
      'scroll',
      'wheel'
    ];
    for (const event of events) window.addEventListener(event, bump, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last >= limit) {
        notify(`Signed out after ${minutes} minutes of inactivity.`, 'info');
        void signOut();
      }
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      for (const event of events) window.removeEventListener(event, bump);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.session?.token, state?.idleTimeoutMinutes]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const session = await call<SessionInfo>('auth.login', { username, password });
      setToken(session.token);
      await refreshState();
      return session;
    },
    [refreshState]
  );

  const signOut = useCallback(async () => {
    try {
      await call('auth.logout');
    } catch {
      /* ignore */
    }
    setToken(null);
    await refreshState();
  }, [refreshState]);

  const can = useCallback(
    (permission: Permission) => Boolean(state?.session?.permissions.includes(permission)),
    [state]
  );

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      session: state?.session ?? null,
      loading,
      error,
      refresh: refreshState,
      signIn,
      signOut,
      notify,
      notifyError,
      can
    }),
    [state, loading, error, refreshState, signIn, signOut, notify, notifyError, can]
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <Toasts toasts={toasts} />
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

export function useSession(): SessionInfo {
  const { session } = useApp();
  if (!session) throw new Error('No active session');
  return session;
}

export function useApi() {
  const { notifyError } = useApp();
  const run = useCallback(
    async <T,>(channel: string, payload: Record<string, unknown> = {}): Promise<T | null> => {
      try {
        return await call<T>(channel, payload);
      } catch (error) {
        notifyError(error);
        return null;
      }
    },
    [notifyError]
  );
  return run;
}

export function useToken(): string | null {
  return getToken();
}
