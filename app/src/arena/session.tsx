import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, call, type Me } from './api';

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({ me: null, loading: true, refresh: async () => {} });
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await call<Me>('session.me'));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.warn(e);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh }}>{children}</Ctx.Provider>;
}
