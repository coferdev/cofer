import { useCallback, useEffect, useState } from 'react';
import { Bot, Clock, Play } from 'lucide-react';
import { call, type PracticeCard } from '../arena/api';
import { left } from '../arena/format';
import { newSeatKey } from '../arena/seatKey';
import { useSession } from '../arena/session';
import { Button, Note, Panel, Segmented, SignInFirst } from '../ui';

type Tab = 'mine' | 'group' | 'freeroll' | 'practice';
const TABS: { v: Tab; label: string }[] = [
  { v: 'mine', label: 'Mine' },
  { v: 'group', label: 'Groups' },
  { v: 'freeroll', label: 'Freerolls' },
  { v: 'practice', label: 'Practice' },
];

/** Arena · Lobby (spec §6.5). Practice games start at once; Friend Tables and Freerolls arrive with Create and Join. */
export function Lobby() {
  const { me, loading } = useSession();
  const [tab, setTab] = useState<Tab>('practice');
  if (loading) return null;
  if (!me) return <SignInFirst />;
  return (
    <div className="space-y-4">
      <Segmented label="Lobby" value={tab} options={TABS} onChange={setTab} />
      {tab === 'practice' ? <Practice enabled={me.practice} /> : <Soon tab={tab} />}
    </div>
  );
}

function Soon({ tab }: { tab: Tab }) {
  const text = { mine: 'Tables you create or join show here.', group: "Your groups' tables show here.", freeroll: 'Free games with a posted prize show here.', practice: '' }[tab];
  return (
    <Panel>
      <p className="text-sm">{text}</p>
      <Note>Not open yet. Practice is open now.</Note>
    </Panel>
  );
}

function Practice({ enabled }: { enabled: boolean }) {
  const [games, setGames] = useState<PracticeCard[]>([]);
  const [minutes, setMinutes] = useState<'15' | '30' | '60'>('15');
  const [bots, setBots] = useState<'1' | '3' | '5' | '9'>('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const load = useCallback(() => call<PracticeCard[]>('arena.lobby.list', { tab: 'practice' }).then(setGames).catch(() => {}), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [load]);

  if (!enabled) return <Panel><p className="text-sm">Practice is switched off here.</p></Panel>;
  const running = games.find((g) => !g.finished);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const { key, save } = await newSeatKey();
      const r = await call<{ id: string }>('arena.practice.start', { pubkey: key.pubkey, minutes: Number(minutes), bots: Number(bots) });
      await save(r.id);
      location.hash = `#/live/${r.id}`;
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="Practice">
        <p className="text-sm leading-relaxed">A game on live prices with practice bots at the table. No money, no wallet: everyone starts with 10,000 chips, and the best score wins.</p>
        {running ? (
          <Button className="mt-4 w-full" onClick={() => (location.hash = `#/live/${running.id}`)}>Back to your game · {left(running.endAt - now)} left</Button>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-3"><Clock size={16} aria-hidden className="text-[var(--muted)]" /><Segmented label="Length" value={minutes} onChange={setMinutes} options={[{ v: '15', label: '15 min' }, { v: '30', label: '30 min' }, { v: '60', label: '1 hour' }]} /></div>
            <div className="flex items-center gap-3"><Bot size={16} aria-hidden className="text-[var(--muted)]" /><Segmented label="Practice bots" value={bots} onChange={setBots} options={[{ v: '1', label: '1 bot' }, { v: '3', label: '3 bots' }, { v: '5', label: '5 bots' }, { v: '9', label: '9 bots' }]} /></div>
            <Button className="w-full" onClick={start} disabled={busy}><Play size={14} aria-hidden className="mr-2 inline" />{busy ? 'Starting…' : 'Start now'}</Button>
            {error && <Note tone="bad">{error}</Note>}
            <Note>Your seat key is made on this device and never leaves it. Keep this device for the whole game.</Note>
          </div>
        )}
      </Panel>
      {games.length > 0 && (
        <Panel title="Your games">
          <ul className="divide-y divide-[var(--line)]">
            {games.map((g) => (
              <li key={g.id}>
                <a href={`#/live/${g.id}`} className="flex min-h-12 items-center justify-between gap-3 text-sm">
                  <span className="tabular">{new Date(g.startAt).toISOString().slice(11, 16)} UTC · {g.seats} seats</span>
                  <span className="text-[var(--muted)]">{g.finished ? (g.rank ? `Finished #${g.rank}` : 'Finished') : `${left(g.endAt - now)} left`}</span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
