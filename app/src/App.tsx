import { useEffect, useState } from 'react';
import { Home as HomeIcon, Swords, Trophy, User } from 'lucide-react';
import { COFR_LINE } from './cofr';
import { ROUTES, screenFromHash, type RoutePath, type Screen } from './routes';
import { SessionProvider } from './arena/session';
import { Home } from './screens/Home';
import { LiveScreen } from './screens/Live';
import { Lobby } from './screens/Lobby';
import { Login } from './screens/Login';
import { Note } from './ui';

const ICONS: Record<RoutePath, typeof HomeIcon> = { home: HomeIcon, arena: Swords, boards: Trophy, profile: User };
const TITLES: Record<Screen['name'], string> = { home: 'Home', arena: 'Arena', boards: 'Boards', profile: 'Profile', login: 'Sign in', live: 'Practice' };

export function App() {
  const [screen, setScreen] = useState<Screen>(() => screenFromHash(location.hash));
  useEffect(() => {
    const on = () => setScreen(screenFromHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const nav: RoutePath = screen.name === 'live' ? 'arena' : screen.name === 'login' ? 'home' : screen.name;
  return (
    <SessionProvider>
      <div className="flex min-h-dvh flex-col">
        <header className="flex h-16 items-center justify-between px-4">
          <strong className="text-xs tracking-[.1em]">COFER</strong>
          <span className="text-xs text-[var(--muted)]">The Arena</span>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28">
          <h1 className="mt-6 mb-5 text-3xl font-semibold tracking-tight">{TITLES[screen.name]}</h1>
          {screen.name === 'login' && <Login token={screen.token} />}
          {screen.name === 'home' && <Home />}
          {screen.name === 'arena' && <Lobby />}
          {screen.name === 'live' && <LiveScreen key={screen.game} id={screen.game} />}
          {(screen.name === 'boards' || screen.name === 'profile') && <Note>Being built.</Note>}
        </main>
        <footer className="px-4 pb-24 text-[11px] leading-relaxed break-all text-[var(--muted)]">
          <p>{COFR_LINE}</p>
          <p className="mt-1">
            <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">IP Geolocation by DB-IP</a> (CC BY 4.0)
          </p>
        </footer>
        <nav className="fixed inset-x-0 bottom-0 flex justify-around border-t border-[var(--line)] bg-[var(--bg)] pb-[env(safe-area-inset-bottom)]">
          {ROUTES.map((r) => {
            const Icon = ICONS[r.path];
            return (
              <a key={r.path} href={`#/${r.path}`} aria-current={r.path === nav ? 'page' : undefined} className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] ${r.path === nav ? 'text-[var(--text)]' : 'text-[var(--muted)]'}`}>
                <Icon size={18} aria-hidden />
                {r.label}
              </a>
            );
          })}
        </nav>
      </div>
    </SessionProvider>
  );
}
