import { useEffect, useState } from 'react';
import { Home, Swords, Trophy, User } from 'lucide-react';
import { COFR_LINE } from './cofr';
import { ROUTES, routeFromHash, type RoutePath } from './routes';

const ICONS: Record<RoutePath, typeof Home> = { home: Home, arena: Swords, boards: Trophy, profile: User };

export function App() {
  const [route, setRoute] = useState<RoutePath>(() => routeFromHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(routeFromHash(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const current = ROUTES.find((r) => r.path === route)!;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between px-4">
        <strong className="text-xs tracking-[.1em]">COFER</strong>
        <span className="text-xs text-[var(--muted)]">The Arena</span>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28">
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">{current.label}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">Being built.</p>
      </main>
      <footer className="px-4 pb-24 text-[11px] leading-relaxed break-all text-[var(--muted)]">{COFR_LINE}</footer>
      <nav className="fixed inset-x-0 bottom-0 flex justify-around border-t border-[var(--line)] bg-[var(--bg)] pb-[env(safe-area-inset-bottom)]">
        {ROUTES.map((r) => {
          const Icon = ICONS[r.path];
          return (
            <a key={r.path} href={`#/${r.path}`} aria-current={r.path === route ? 'page' : undefined} className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] ${r.path === route ? 'text-[var(--text)]' : 'text-[var(--muted)]'}`}>
              <Icon size={18} aria-hidden />
              {r.label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
