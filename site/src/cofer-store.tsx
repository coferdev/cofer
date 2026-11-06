/**
 * Dashboard data, read-only. Everything shown comes from the services' dashboard API (indexer
 * tables and live feed prices), for the signed-in member's own group accounts only. Nothing is
 * seeded, nothing is computed locally as a source of truth, and nothing is stored in localStorage.
 * Amounts stay raw integers with their decimals (lib/money.ts). Changes are made in Telegram.
 *
 * Phases: starting -> (no-config | signing-in -> signed-out | loading -> ready | wrong-network).
 * A failed refresh keeps the last data on screen, says so, and retries with growing waits.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clock, X } from 'lucide-react';
import { ApiError, apiClient, type PotSummary, type PotView, type Proposal } from '@/lib/dash-api';
import { addressUrl, botUrl, parseConfig, txUrl, type DashConfig } from '@/lib/dash-config';
import { clearSession, isLive, linkFromHash, loadSession, saveSession, type Session } from '@/lib/dash-session';
import { describeActivity, hoursText, POLL_MS, periodText, retryDelay, shortAddress } from '@/lib/dash-text';
import { formatAmount, formatBps } from '@/lib/money';

export type Phase = 'starting' | 'no-config' | 'signing-in' | 'signed-out' | 'loading' | 'ready' | 'wrong-network';

interface Store {
  phase: Phase;
  config: DashConfig | null;
  message: string | null; // why signed out, or the current refresh problem (data kept)
  linked: boolean;
  pots: PotSummary[];
  selected: string | null;
  pot: PotView | null;
  potLoading: boolean;
  lastOk: Date | null;
  failures: number;
  select: (address: string) => void;
  refresh: () => void;
}

const Context = createContext<Store | null>(null);

/** USDG amounts: two decimals; token quantities: up to six. */
export const usdg = (raw: string | null | undefined, decimals = 6) => formatAmount(raw ?? null, decimals, 2);

export function CoferProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [config, setConfig] = useState<DashConfig | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [linked, setLinked] = useState(true);
  const [pots, setPots] = useState<PotSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [pot, setPot] = useState<PotView | null>(null);
  const [potLoading, setPotLoading] = useState(false);
  const [lastOk, setLastOk] = useState<Date | null>(null);
  const [failures, setFailures] = useState(0);
  const [tick, setTick] = useState(0);

  const session = useRef<Session | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const api = useMemo(() => (config ? apiClient(config.apiBase) : null), [config]);

  const signOut = useCallback((text: string) => {
    clearSession();
    session.current = null;
    setMessage(text);
    setPhase('signed-out');
  }, []);

  // 1. settings, then sign-in (a one-time link in the fragment, or this tab's session)
  useEffect(() => {
    let stop = false;
    (async () => {
      let cfg: DashConfig;
      try {
        const r = await fetch('/config.json', { cache: 'no-store', credentials: 'omit' });
        if (!r.ok) throw new Error('missing');
        cfg = parseConfig(await r.json());
      } catch {
        if (!stop) setPhase('no-config');
        return;
      }
      if (stop) return;
      setConfig(cfg);
      const link = linkFromHash(location.hash);
      if (location.hash) history.replaceState(null, '', location.pathname + location.search); // never leave the link in the address bar
      if (link) {
        setPhase('signing-in');
        try {
          const s = await apiClient(cfg.apiBase).exchange(link);
          saveSession(s);
          session.current = s;
        } catch (e) {
          if (!stop) signOut(e instanceof ApiError ? e.message : 'Could not sign in. Open the dashboard again from Telegram.');
          return;
        }
      } else {
        const s = loadSession();
        if (!isLive(s)) {
          if (!stop) signOut('Open the dashboard from Telegram: send /me to the bot and tap “Open dashboard”.');
          return;
        }
        session.current = s;
      }
      if (!stop) setPhase('loading');
    })();
    return () => {
      stop = true;
    };
  }, [signOut]);

  // 2. read the member's pots and the selected pot; on a schedule, and again on refresh()
  useEffect(() => {
    if (!api || !config || (phase !== 'loading' && phase !== 'ready')) return;
    const s = session.current;
    if (!isLive(s)) {
      signOut('Your dashboard session has ended. Open it again from Telegram: send /me to the bot.');
      return;
    }
    let stop = false;
    let timer = 0;
    (async () => {
      try {
        const list = await api.pots(s.session);
        if (stop) return;
        if (list.chainId !== config.chainId) {
          setPhase('wrong-network');
          setMessage(`This dashboard is set up for ${config.chainName}, but its server is on a different network. Nothing is shown.`);
          return;
        }
        setLinked(list.linked);
        setPots(list.pots);
        const keep = list.pots.find((p) => p.address.toLowerCase() === selectedRef.current?.toLowerCase());
        const target = keep?.address ?? list.pots[0]?.address ?? null;
        if (target !== selectedRef.current) setSelected(target);
        if (target) {
          setPotLoading(!pot || pot.address !== target);
          const view = await api.pot(s.session, target);
          if (stop) return;
          setPot(view);
        } else setPot(null);
        setPotLoading(false);
        setFailures(0);
        setMessage(null);
        setLastOk(new Date());
        setPhase('ready');
        timer = window.setTimeout(() => setTick((t) => t + 1), POLL_MS);
      } catch (e) {
        if (stop) return;
        setPotLoading(false);
        if (e instanceof ApiError && e.kind === 'signed-out') return signOut(e.message);
        if (e instanceof ApiError && e.kind === 'not-found') {
          // the member left this pot (or it is gone): read the list again and pick another
          setSelected(null);
          setPot(null);
          timer = window.setTimeout(() => setTick((t) => t + 1), 0);
          return;
        }
        const n = failures + 1;
        setFailures(n);
        setMessage(e instanceof ApiError ? e.message : "Couldn't load the data just now. Retrying.");
        timer = window.setTimeout(() => setTick((t) => t + 1), retryDelay(n));
      }
    })();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // pot and failures are read, not watched: a new read starts on tick, phase or selection only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, config, phase === 'loading' || phase === 'ready', selected, tick, signOut]);

  // 3. end the session on time, and read again when the tab comes back
  useEffect(() => {
    const s = session.current;
    if (!s || (phase !== 'ready' && phase !== 'loading')) return;
    const left = Date.parse(s.expiresAt) - Date.now();
    const t = window.setTimeout(() => signOut('Your dashboard session has ended. Open it again from Telegram: send /me to the bot.'), Math.max(0, left));
    const back = () => document.visibilityState === 'visible' && setTick((x) => x + 1);
    document.addEventListener('visibilitychange', back);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', back);
    };
  }, [phase, signOut]);

  const store: Store = {
    phase,
    config,
    message,
    linked,
    pots,
    selected,
    pot,
    potLoading,
    lastOk,
    failures,
    select: (a) => {
      setSelected(a);
      setPot(null);
    },
    refresh: () => setTick((t) => t + 1),
  };
  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useCofer() {
  const v = useContext(Context);
  if (!v) throw Error('Missing Cofer provider');
  return v;
}

// ---------------------------------------------------------------- shared pieces

/** Notices above the data: signed out, refresh problems, indexer behind, paused prices. */
export function StatusBar() {
  const c = useCofer();
  const notes: { tone: 'info' | 'warn' | 'error'; text: string }[] = [];
  if (c.phase === 'ready' && c.message) notes.push({ tone: 'warn', text: `${c.message}${c.lastOk ? ` Showing data from ${c.lastOk.toLocaleTimeString()}.` : ''}` });
  if (c.pot?.indexer.behind) notes.push({ tone: 'warn', text: 'The data may be a few minutes behind the chain. Exits and the contracts are not affected.' });
  if (c.pot?.value.partial) notes.push({ tone: 'info', text: 'Some prices are paused (for example while a market is closed). The total leaves those holdings out.' });
  if (!notes.length) return null;
  return (
    <div className="dash-notes" role="status">
      {notes.map((n) => (
        <p key={n.text} className={`dash-note dash-note-${n.tone}`}>
          {n.text}
        </p>
      ))}
    </div>
  );
}

/** The whole-page states before there is data: setting up, signing in, signed out, wrong network. */
export function Gate({ children }: { children: React.ReactNode }) {
  const c = useCofer();
  const bot = c.config ? botUrl(c.config) : null;
  const card = (title: string, text: string | null, action = true) => (
    <section className="dash-gate" aria-live="polite">
      <span className="workspace-kicker">COFER / DASHBOARD</span>
      <h1>{title}</h1>
      {text && <p>{text}</p>}
      {action && bot && (
        <a className="outline-action" href={bot}>
          Open in Telegram <ArrowUpRight size={15} />
        </a>
      )}
    </section>
  );
  if (c.phase === 'starting' || c.phase === 'signing-in') return card(c.phase === 'starting' ? 'Loading…' : 'Signing you in…', null, false);
  if (c.phase === 'no-config') return card('The dashboard is not set up here', 'This address has no dashboard settings. Open the dashboard from Telegram: send /me to the bot.', false);
  if (c.phase === 'signed-out') return card('Open the dashboard from Telegram', c.message);
  if (c.phase === 'wrong-network') return card('Network mismatch', c.message, false);
  if (c.phase === 'loading' && !c.pot) return card('Loading your group accounts…', c.message, false);
  if (c.phase === 'ready' && !c.linked) return card('Set up your key first', 'Your Telegram account has no Cofer key yet. Send /start to the bot to set one up.');
  if (c.phase === 'ready' && !c.pots.length) return card('No group accounts yet', 'You are not a member of any group account. Ask the group to add you, or start one with /newpot in your group.');
  return <>{children}</>;
}

function StateBadge({ p }: { p: Proposal }) {
  const Icon = p.state === 'confirmed' ? Check : p.state === 'failed' ? X : Clock;
  return (
    <span className={`proposal-state state-${p.state}`}>
      <Icon size={11} /> {p.state}
    </span>
  );
}

// ---------------------------------------------------------------- the account panel (read-only)

export function Workspace() {
  const c = useCofer();
  const p = c.pot;
  const cfg = c.config;
  if (!p || !cfg) {
    return (
      <section className="workspace" aria-label="Group account" aria-busy="true">
        <p className="workspace-empty">{c.potLoading ? 'Loading the group account…' : 'Choose a group account.'}</p>
      </section>
    );
  }
  const dec = p.usdg.decimals;
  const required = p.rules.approvalsRequired;
  return (
    <section className="workspace" aria-label="Group account" aria-busy={c.potLoading}>
      <div className="workspace-top">
        <div>
          <span className="workspace-kicker">GROUP ACCOUNT · READ-ONLY</span>
          <h2>{p.title}</h2>
          <p>
            Live from {cfg.chainName}. To propose, approve, deposit or exit, use the bot in Telegram.{' '}
            <a href={botUrl(cfg)}>Open in Telegram</a>
          </p>
        </div>
        {c.pots.length > 1 && (
          <label className="workspace-select">
            Group account
            <div className="select-beam">
              <select value={c.selected ?? ''} onChange={(e) => c.select(e.target.value)}>
                {c.pots.map((x) => (
                  <option key={x.address} value={x.address}>
                    {x.title}
                  </option>
                ))}
              </select>
            </div>
          </label>
        )}
      </div>
      <StatusBar />
      <div className="workspace-stats">
        <div>
          <span>Account value</span>
          <strong>
            {p.value.totalUsdg === null ? 'Price paused' : usdg(p.value.totalUsdg, dec)} <small>USDG{p.value.partial ? ' · partial' : ''}</small>
          </strong>
        </div>
        <div>
          <span>Your share</span>
          <strong>
            {formatBps(p.you.shareBps)}
            <small>% · {p.you.valueUsdg === null ? '—' : usdg(p.you.valueUsdg, dec)} USDG</small>
          </strong>
        </div>
        <div>
          <span>Allowance remaining</span>
          <strong>
            {p.you.allowanceLeft === null ? '—' : usdg(p.you.allowanceLeft, dec)} <small>USDG / {periodText(p.you.period)}</small>
          </strong>
        </div>
        <div>
          <span>Approvals required</span>
          <strong>
            {required ?? '—'} <small>of {p.rules.membersCount} members</small>
          </strong>
        </div>
      </div>
      <div className="workspace-columns">
        <div className="workspace-panel">
          <div className="workspace-heading">
            <h3>Holdings</h3>
            <span>
              {cfg.chainName} · {cfg.chainId}
            </span>
          </div>
          {!p.holdings.length && <p className="workspace-empty">No holdings yet.</p>}
          {p.holdings.map((h) => (
            <div className="holding-row" key={h.asset}>
              <strong>
                <a href={addressUrl(cfg, h.asset)} target="_blank" rel="noreferrer">
                  {h.symbol}
                </a>
              </strong>
              <span>
                {h.shownQuantity} {h.symbol === 'USDG' ? '' : 'units '}·{' '}
                {h.pricePaused ? 'price paused' : `${usdg(h.valueUsdg, dec)} USDG`}
                {!h.pricePaused && h.symbol !== 'USDG' && h.unitPriceUsdg !== null && <small> · {usdg(h.unitPriceUsdg, dec)} per unit</small>}
              </span>
            </div>
          ))}
          <div className="workspace-heading spaced">
            <h3>Members</h3>
            <span>{p.rules.membersCount} members</span>
          </div>
          {p.members.map((m) => (
            <div className="holding-row" key={m.address}>
              <strong>{m.you ? 'You' : m.username ? `@${m.username}` : shortAddress(m.address)}</strong>
              <span>
                {formatBps(m.shareBps)}% · allowance {usdg(m.allowance, dec)} USDG / {periodText(m.period)}
              </span>
            </div>
          ))}
          <div className="workspace-heading spaced">
            <h3>Rules</h3>
          </div>
          <div className="holding-row">
            <strong>Exit window</strong>
            <span>{hoursText(p.rules.exitWindowSec)} for non-unanimous proposals</span>
          </div>
          <div className="holding-row">
            <strong>Deposits</strong>
            <span>{p.rules.depositsOpen ? 'Open' : 'Closed by the group'}</span>
          </div>
          <div className="holding-row">
            <strong>Group plan</strong>
            <span>{p.rules.planPaidUntil && Date.parse(p.rules.planPaidUntil) > Date.now() ? `Paid through ${new Date(p.rules.planPaidUntil).toLocaleDateString()}` : 'No active plan'}</span>
          </div>
        </div>
        <div className="workspace-panel">
          <div className="workspace-heading">
            <h3>Proposals</h3>
            <span>
              {required ?? '—'} of {p.rules.membersCount} approvals · {hoursText(p.rules.exitWindowSec)} window
            </span>
          </div>
          {!p.proposals.length ? (
            <p className="workspace-empty">No proposals yet. Proposals are made in the group chat with the bot.</p>
          ) : (
            p.proposals.map((x) => (
              <article className="proposal" key={x.id}>
                <div>
                  <strong>{x.summary}</strong>
                  <small>
                    {x.stateText}
                    {x.state === 'pending' && x.status !== 'queued' ? ` · ${x.approvals} of ${x.required} approvals${x.signedByYou ? ' · you approved' : ''}` : ''}
                    {x.executeAfter ? ` · exit window until ${new Date(x.executeAfter).toLocaleString()}` : ''}
                  </small>
                </div>
                <div className="proposal-actions">
                  {x.txHash && (
                    <a className="proposal-link" href={txUrl(cfg, x.txHash)} target="_blank" rel="noreferrer" aria-label="View the transaction">
                      <ArrowUpRight size={13} />
                    </a>
                  )}
                  <StateBadge p={x} />
                </div>
              </article>
            ))
          )}
          <div className="workspace-heading spaced">
            <h3>Recent activity</h3>
          </div>
          {!p.activity.length && <p className="workspace-empty">No activity yet.</p>}
          {p.activity.slice(0, 8).map((e) => {
            const d = describeActivity(e, p.assets, p.members);
            return (
              <div className="workspace-log" key={e.id}>
                <span>
                  <strong>{d.title}</strong>
                  <small>{d.detail}</small>
                </span>
                <time dateTime={e.at}>
                  <a href={txUrl(cfg, e.txHash)} target="_blank" rel="noreferrer">
                    {new Date(e.at).toLocaleDateString()}
                  </a>
                </time>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
