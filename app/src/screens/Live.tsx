import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Wifi, WifiOff } from 'lucide-react';
import { call, type Board, type MarkMsg, type PracticeGame, type Result, type SeatState } from '../arena/api';
import { REASONS, chips, clock, left, price, qty, signedChips } from '../arena/format';
import { Live as LiveConn } from '../arena/live';
import { type OrderInput, signOrder } from '../arena/order';
import { type SeatKey, loadSeatKey } from '../arena/seatKey';
import { useSession } from '../arena/session';
import { Button, Note, Panel, SignInFirst } from '../ui';
import { Ticket } from './Ticket';

const SOURCES = ['Lighter', 'Arcus', 'Chainlink'];
const STATUS_TEXT: Record<string, string> = { DIVERGED: 'sources disagree', NO_QUORUM: 'not enough live sources', SUSPECT: 'price jump being checked', CLOSED: 'market closed' };

/** Arena · Live (spec §6.5) for a Practice game, with the trade ticket; Arena · Result when it ends. */
export function LiveScreen({ id }: { id: string }) {
  const { me: session, loading } = useSession();
  const [game, setGame] = useState<PracticeGame | null>(null);
  const [error, setError] = useState('');
  const [key, setKey] = useState<SeatKey | null | undefined>(undefined);
  const [board, setBoard] = useState<Board | null>(null);
  const [me, setMe] = useState<SeatState | null>(null);
  const [marks, setMarks] = useState<Record<string, MarkMsg>>({});
  const [halts, setHalts] = useState<Record<string, { status: string; since: number }>>({});
  const [curve, setCurve] = useState<[number, number][]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [events, setEvents] = useState<{ t: number; text: string; tone: 'muted' | 'bad' }[]>([]);
  const [conn, setConn] = useState<LiveConn['status']>('connecting');
  const [now, setNow] = useState(Date.now());
  const live = useRef<LiveConn | null>(null);

  useEffect(() => {
    if (!session) return;
    call<PracticeGame>('arena.practice.get', { id })
      .then((g) => {
        setGame(g);
        setBoard(g.board);
        setMe(g.me);
        setResult(g.result);
      })
      .catch((e: Error) => setError(e.message));
    loadSeatKey(id).then(setKey).catch(() => setKey(null));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [id, session]);

  const note = useCallback((text: string, tone: 'muted' | 'bad' = 'muted') => setEvents((e) => [{ t: Date.now(), text, tone }, ...e].slice(0, 6)), []);

  useEffect(() => {
    if (!game || game.result) return;
    const rooms = [...game.rules.markets.map((m) => `sym:${m}`), `t:${game.table}`, `t:${game.table}:${game.seat}`];
    const c = new LiveConn(rooms, (ev, data) => {
      if (ev === 'mark') setMarks((m) => ({ ...m, [data.s]: data }));
      else if (ev === 'halt') setHalts((h) => {
        const n = { ...h };
        if (data.since === null) delete n[data.s];
        else n[data.s] = { status: data.status, since: data.since };
        return n;
      });
      else if (ev === 'board') setBoard(data);
      else if (ev === 'me') {
        setMe(data);
        setCurve((c) => [...c.slice(-1199), [Date.now(), Number(BigInt(data.equity) / 10_000n) / 100]]);
      } else if (ev === 'fill') note(data.qty !== undefined ? `Filled ${qty(data.qty)} at ${price(data.px)} (${clock(data.tickTs)})` : `Option filled: ${data.contracts} contracts`);
      else if (ev === 'reject') note(REASONS[data.reason] ?? data.reason, 'bad');
      else if (ev === 'eliminated') note('Your seat was eliminated: equity fell to the maintenance margin.', 'bad');
      else if (ev === 'result') setResult(data);
    });
    c.onStatus = setConn;
    live.current = c;
    return () => c.close();
  }, [game, note]);

  const send = useCallback(async (o: OrderInput): Promise<string | null> => {
    if (!game || !key || !live.current) return 'SIGNATURE';
    try {
      const s = await signOrder(game.table, game.seat, key, o);
      await live.current.place(game.id, s.bytes, s.sig);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [game, key]);

  const lastPx = useMemo(() => Object.fromEntries(Object.entries(marks).map(([s, m]) => [s, m.px])), [marks]);
  if (loading) return null;
  if (!session) return <SignInFirst />;
  if (error) return <Panel><p className="text-sm">{error}</p></Panel>;
  if (!game) return <Note>Loading the game…</Note>;
  if (result) return <ResultView game={game} result={result} />;

  const started = now >= game.startAt;
  const disabled = key === null ? 'This device does not hold the key for your seat, so it can watch but not trade.' : !started ? 'The game has not started yet.' : me?.eliminatedAt ? 'Your seat is out of this game.' : conn !== 'open' ? 'Reconnecting…' : null;
  const haltList = Object.entries(halts);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="tabular">{started ? `${left(game.endAt - now)} left` : `Starts in ${left(game.startAt - now)}`}</span>
        <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
          {conn === 'open' ? <Wifi size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />}
          {conn === 'open' ? 'Live' : 'Reconnecting'}
        </span>
      </div>
      {haltList.map(([s, h]) => (
        <div key={s} role="status" className="flex items-start gap-2 rounded-xl border border-[var(--warn)] p-3 text-xs text-[var(--warn)]">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          {s}: {STATUS_TEXT[h.status] ?? h.status} since {clock(h.since)}. Orders in {s} wait for a good price.
        </div>
      ))}
      {me?.warn && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--down)] p-3 text-xs text-[var(--down)]">
          <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          Close to elimination: equity is under 1.5 × maintenance margin. Reduce or close a position.
        </div>
      )}

      <Panel title="You" right={<span className="tabular text-xs text-[var(--muted)]">rank {board?.top.find((r) => r.seat === game.seat)?.rank ?? board?.me?.rank ?? '–'} of {board?.n ?? game.seats.length}</span>}>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Stat label="Equity" value={chips(me?.equity)} />
          <Stat label="Free margin" value={chips(me?.free)} />
          <Stat label="Maintenance" value={chips(me?.mm)} />
        </div>
        <Curve points={curve} />
      </Panel>

      <Panel title="Marks">
        <ul className="space-y-2">
          {game.rules.markets.map((s) => {
            const m = marks[s];
            return (
              <li key={s} className="flex items-center justify-between gap-3 text-sm">
                <span className="w-14">{s}</span>
                <span className="tabular flex-1 text-right">{m?.status === 'CLOSED' ? 'closed' : price(m?.px ?? null)}</span>
                <span className="flex gap-1" aria-label={`${s} sources`}>
                  {SOURCES.map((name, i) => (
                    <span key={name} title={`${name}: ${m?.src[i] ? 'in the price' : 'stale or left out'}`} className={`h-2 w-2 rounded-full ${m?.src[i] ? 'bg-[var(--up)]' : 'bg-[var(--line)]'}`} />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
        <Note>The dots are Lighter, Arcus and Chainlink: green when that source is in the price, grey when it is stale or left out.</Note>
      </Panel>

      <Ticket game={game} me={me} marks={lastPx} send={send} disabled={disabled} />
      {events.length > 0 && (
        <ul className="space-y-1" aria-live="polite">
          {events.map((e) => <li key={e.t + e.text}><Note tone={e.tone}>{e.text}</Note></li>)}
        </ul>
      )}

      <Panel title="Positions">
        {me?.positions.length ? (
          <ul className="divide-y divide-[var(--line)]">
            {me.positions.map((p) => {
              const hold = p.holdUntil && p.holdUntil > now ? Math.ceil((p.holdUntil - now) / 1000) : 0;
              return (
                <li key={p.product + p.symbol} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {p.symbol} {p.product === 'PERP' ? `perp ${p.lev}x` : 'spot'}
                    <span className="block text-xs text-[var(--muted)] tabular">{BigInt(p.qty) > 0n ? 'long' : 'short'} {qty(p.qty.replace('-', ''))}{p.entry ? ` @ ${price(p.entry)}` : ''}</span>
                  </span>
                  <span className={`tabular ${p.upnl && BigInt(p.upnl) < 0n ? 'text-[var(--down)]' : 'text-[var(--up)]'}`}>{p.upnl ? signedChips(p.upnl) : ''}</span>
                  <Button kind="ghost" disabled={!!disabled || hold > 0} onClick={() => void send({ kind: 'CLOSE', symbol: p.symbol, product: p.product }).then((e) => e && note(REASONS[e] ?? e, 'bad'))}>
                    {hold > 0 ? `Hold ${hold}s` : 'Close'}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : <Note>No positions.</Note>}
      </Panel>

      <Panel title="Orders">
        {me?.orders.length ? (
          <ul className="divide-y divide-[var(--line)]">
            {me.orders.map((o) => (
              <li key={o.ref} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>{o.kind.replace('_', ' ').toLowerCase()} {o.side?.toLowerCase()} {o.symbol}<span className="block text-xs text-[var(--muted)] tabular">{o.limitPx ? `at ${price(o.limitPx)}` : o.triggerPx ? `trigger ${price(o.triggerPx)}${o.fired ? ', triggered' : ''}` : 'next tick'}</span></span>
                {o.kind !== 'MARKET' && <Button kind="ghost" disabled={!!disabled} onClick={() => void send({ kind: 'CANCEL', symbol: o.symbol, product: o.product as 'PERP', cancelRef: o.ref }).then((e) => e && note(REASONS[e] ?? e, 'bad'))}>Cancel</Button>}
              </li>
            ))}
          </ul>
        ) : <Note>No open orders.</Note>}
      </Panel>

      <BoardView board={board} seat={game.seat} />
      <Note>Rules hash {game.rulesHash.slice(0, 18)}… · Practice game {game.id}</Note>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-[var(--muted)]">{label}</div>
      <div className="tabular">{value}</div>
    </div>
  );
}

function Curve({ points }: { points: [number, number][] }) {
  if (points.length < 2) return <div className="mt-3 h-16" aria-hidden />;
  const ys = points.map((p) => p[1]);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${40 - ((p[1] - lo) / span) * 36 - 2}`).join(' ');
  const up = ys.at(-1)! >= ys[0]!;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-3 h-16 w-full" role="img" aria-label="Your equity during the game">
      <polyline points={d} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function BoardView({ board, seat }: { board: Board | null; seat: string }) {
  if (!board) return null;
  const rows = board.me ? [...board.top, board.me] : board.top;
  return (
    <Panel title="Board">
      <ol className="space-y-1">
        {rows.map((r) => (
          <li key={r.seat} className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-sm ${r.seat === seat ? 'bg-[var(--line)]' : ''}`}>
            <span className="tabular w-6 text-[var(--muted)]">{r.rank}</span>
            <span className="flex-1">{r.name}{r.out ? ' · out' : ''}</span>
            <span className="tabular">{chips(r.equity)}</span>
          </li>
        ))}
      </ol>
      <Note>Ranked by score: return with a penalty for drawdown, as in the rules.</Note>
    </Panel>
  );
}

function ResultView({ game, result }: { game: PracticeGame; result: Result }) {
  const mine = result.standings.find((s) => s.seat.toLowerCase() === game.seat);
  const podium = result.standings.slice(0, 3);
  return (
    <div className="space-y-4">
      <Panel title="Result">
        <ol className="grid grid-cols-3 gap-2 text-center">
          {podium.map((s) => (
            <li key={s.seat} className="rounded-xl border border-[var(--line)] p-3">
              <div className="text-2xl font-semibold">{s.rank}</div>
              <div className="text-sm">{s.name}</div>
              <div className="tabular text-xs text-[var(--muted)]">{chips(s.finalEquity)}</div>
            </li>
          ))}
        </ol>
        {mine && <p className="mt-4 text-sm">You finished #{mine.rank} of {result.standings.length} with {chips(mine.finalEquity)} chips{mine.activityOk ? '' : ' (below the activity minimum)'}.</p>}
      </Panel>
      <Panel title="Check it yourself">
        <Note>The game's log is hash-chained ({result.events} events, {result.ticks} ticks). Anyone can replay it from the log and the public price tape and get the same result.</Note>
        <p className="mt-2 break-all text-xs tabular">Final head {result.head}</p>
        <a href={`/arena/log/${result.id}`} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--line)] px-4 text-sm"><Download size={14} aria-hidden />Download the log</a>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--bg)] p-3 text-[11px] whitespace-pre-wrap break-all">{result.verify}</pre>
      </Panel>
      <Button className="w-full" onClick={() => (location.hash = '#/arena')}>Play again</Button>
    </div>
  );
}
