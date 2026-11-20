import { useEffect, useState } from 'react';
import { call, type PracticeCard } from '../arena/api';
import { left } from '../arena/format';
import { useSession } from '../arena/session';
import { Button, Note, Panel, SignInFirst } from '../ui';

/** Home (spec §6.5): the "Your move" strip. Group accounts join here once their screens move into the App. */
export function Home() {
  const { me, loading } = useSession();
  const [games, setGames] = useState<PracticeCard[]>([]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!me) return;
    call<PracticeCard[]>('arena.lobby.list', { tab: 'practice' }).then(setGames).catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [me]);
  if (loading) return null;
  if (!me) return <SignInFirst />;
  const running = games.filter((g) => !g.finished);
  return (
    <div className="space-y-4">
      <Panel title="Your move">
        {running.length ? (
          running.map((g) => (
            <a key={g.id} href={`#/live/${g.id}`} className="flex min-h-12 items-center justify-between text-sm">
              <span>Practice game</span>
              <span className="tabular text-[var(--muted)]">{now < g.startAt ? `starts in ${left(g.startAt - now)}` : `${left(g.endAt - now)} left`}</span>
            </a>
          ))
        ) : (
          <>
            <Note>Nothing waiting for you.</Note>
            <Button className="mt-3" onClick={() => (location.hash = '#/arena')}>Play Practice</Button>
          </>
        )}
      </Panel>
      <Note>Signed in{me.address ? ` as ${me.address.slice(0, 6)}…${me.address.slice(-4)}` : ''} until {new Date(me.expires * 1000).toISOString().slice(11, 16)} UTC.</Note>
    </div>
  );
}
