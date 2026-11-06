import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, CircleDollarSign, CircleEllipsis, CircleHelp, CreditCard, Grip, Layers, ListChecks, Map, MapPin, Network, RotateCcw, ShieldCheck, Users, Wallet, X } from 'lucide-react';
import DraggableWidgetGrid, { type WidgetItem, type WidgetSize } from '@/components/ui/draggable-widget-grid';
import InkOrbitFeatures from '@/components/ui/ink-orbit-features';
import { CoferProvider, Gate, StatusBar, Workspace, useCofer, usdg } from '@/cofer-store';
import { CardBeam, CombinedCardBorder, BeamButton, SmallBeam } from '@/components/ui/cofer-beam';
import { BOT_URL } from '@/lib/links';
import { botUrl } from '@/lib/dash-config';
import { describeActivity, hoursText, initial } from '@/lib/dash-text';
import { formatAmount, formatBps, maxAmount, ratio } from '@/lib/money';
import './styles/ui.css';
import './styles/dashboard.css';

/*
 * The dashboard pages. On the dashboard address (with its config.json) they show the signed-in
 * member's own group accounts, read-only, from the dashboard API. Without a config.json (the
 * getcofer.com copy of How it works) only that page is meant to be used, and nothing is fetched
 * beyond the missing config.json. The leaderboard stays hidden.
 */

type Page = 'accounts' | 'overview' | 'metrics' | 'how';
const pageFromPath = (path: string): Page => {
  const name = path.replace(/\.html$/, '').replace(/\/$/, '');
  return name.endsWith('/dashboard-overview') ? 'overview' : name.endsWith('/dashboard-metrics') ? 'metrics' : name.endsWith('/how-it-works') ? 'how' : 'accounts';
};
const dashboardRoutes = new Set(['', '/index', '/dashboard', '/dashboard-overview', '/dashboard-metrics', '/how-it-works']);
const nav = [
  { label: 'Overview', href: '/dashboard-overview.html', key: 'overview', icon: Layers },
  { label: 'Accounts', href: '/dashboard.html', key: 'accounts', icon: CreditCard },
  { label: 'Metrics', href: '/dashboard-metrics.html', key: 'metrics', icon: Activity },
] as const;
const widgets: WidgetItem[] = [
  { id: 'metrics', size: 'tall', label: 'Account metrics' },
  { id: 'map', size: 'wide', label: 'Shared account map' },
  { id: 'activity', size: 'wide', label: 'Account activity' },
];
const GREYS = ['#dadad8', '#a9aaa8', '#d0d0cd', '#949493', '#c3c3bf'];

function Avatars({ count = 5 }: { count?: number }) {
  const members = useCofer().pot?.members ?? [];
  return (
    <span className="avatars" aria-label={`${members.length} members`}>
      {members.slice(0, count).map((m, i) => (
        <span key={m.address} style={{ background: GREYS[i % 5] }}>
          {initial(m)}
        </span>
      ))}
    </span>
  );
}

/** Bars per member. Heights are ratios of exact amounts; every figure shown as text is exact. */
function Chart({ kind, title, sub }: { kind: 'share' | 'allowance'; title: string; sub: string }) {
  const p = useCofer().pot;
  const members = (p?.members ?? []).slice(0, 12);
  const dec = p?.usdg.decimals ?? 6;
  const values = members.map((m) => (kind === 'share' ? BigInt(m.shareBps) : BigInt(m.allowance)));
  const max = maxAmount(values);
  const label = (v: bigint) => (kind === 'share' ? `${formatBps(Number(v))}%` : formatAmount(v, dec, 0));
  const step = 232 / Math.max(values.length, 1);
  return (
    <section className={`metric-chart chart-${kind === 'share' ? 'bars' : 'range'}`} aria-label={`${title}. ${sub}`}>
      <div className="chart-heading">
        <span>
          {kind === 'share' ? <BarChart3 size={15} /> : <CircleDollarSign size={15} />} {title}
        </span>
        <span>{sub}</span>
      </div>
      <svg viewBox="0 0 280 136" role="img" aria-label={`${title} by member`}>
        {[20, 55, 90, 120].map((y, i) => (
          <g key={y}>
            <text x="0" y={y + 3} fontSize="9" fill="#858589">
              {label((max * BigInt(3 - i)) / 3n)}
            </text>
            <line x1="35" x2="276" y1={y} y2={y} stroke="#343438" strokeDasharray="2 5" />
          </g>
        ))}
        {values.map((v, i) => {
          const x = 40 + i * step + step / 2;
          const y = 120 - ratio(v, max) * 90;
          return <rect className="chart-mark" key={members[i]!.address} x={x - 4} y={y} width="8" height={Math.max(0, 120 - y)} rx="4" fill={kind === 'share' ? '#dfdfdc' : '#aaa'} />;
        })}
        {members.map((m, i) => (
          <text key={m.address} x={40 + i * step + step / 2} y="135" fontSize="8" fill="#88888c" textAnchor="middle">
            {m.you ? 'You' : initial(m)}
          </text>
        ))}
      </svg>
    </section>
  );
}

function MetricsPanel() {
  const p = useCofer().pot;
  return (
    <div className="panel metrics-panel">
      <CombinedCardBorder />
      <div className="panel-head">
        <span className="round-icon">
          <BarChart3 size={16} />
        </span>
        <strong>Metrics</strong>
        <div className="head-spacer" />
        <span className="muted small">By member</span>
      </div>
      <Chart kind="share" title="Share of the account" sub={`${p?.members.length ?? 0} members`} />
      <Chart kind="allowance" title="Allowances" sub="USDG per period" />
    </div>
  );
}

function ring(i: number) {
  const cx = 250, cy = 40 + i * 6.05, rx = 8 + i * 6.7, ry = 4 + i * 1.18;
  let d = '';
  for (let k = 0; k <= 120; k++) {
    const a = (k / 120) * Math.PI * 2, dist = 1 + 0.027 * Math.sin(a * 7 + i * 0.65) + 0.015 * Math.sin(a * 13 - i * 0.27);
    d += `${k ? 'L' : 'M'}${(cx + Math.cos(a) * rx * dist).toFixed(1)} ${(cy + Math.sin(a) * ry * dist).toFixed(1)} `;
  }
  return d + 'Z';
}
const pins = [{ x: 129, y: 115, n: 'A' }, { x: 168, y: 82, n: 'B' }, { x: 205, y: 51, n: 'C' }, { x: 257, y: 38, n: 'D' }, { x: 329, y: 176, n: 'E' }, { x: 379, y: 120, n: 'F' }];

/** Decorative: one pin per member (up to six). */
function MapPanel() {
  const members = useCofer().pot?.members ?? [];
  return (
    <div className="panel map-panel">
      <CardBeam radius={30} />
      <div className="panel-head">
        <span className="round-icon">
          <Network size={16} />
        </span>
        <strong>Account overview</strong>
        <span className="divider" />
        <span className="light">Shared view</span>
        <div className="head-spacer" />
        <span className="muted map-head-icon"><Layers size={15} /></span>
        <span className="muted map-head-icon"><ArrowUpRight size={15} /></span>
        <span className="muted map-head-icon"><Map size={15} /></span>
        <CircleEllipsis size={16} className="muted" />
      </div>
      <div className="map-stage">
        <svg className="topo" viewBox="0 0 500 310" role="img" aria-label="Topographic view of the shared account and its members">
          <ellipse cx="250" cy="226" rx="218" ry="66" fill="none" stroke="#a5a5a2" strokeWidth="1.2" />
          {Array.from({ length: 96 }, (_, i) => {
            const a = (i / 96) * 2 * Math.PI;
            return <line key={i} x1={250 + Math.cos(a) * 228} y1={226 + Math.sin(a) * 72} x2={250 + Math.cos(a) * (i % 4 === 0 ? 237 : 233)} y2={226 + Math.sin(a) * (i % 4 === 0 ? 78 : 75)} stroke="#737375" strokeWidth=".75" />;
          })}
          {Array.from({ length: 29 }, (_, i) => (
            <path key={i} className="contour" d={ring(i)} fill="none" stroke="#777779" strokeWidth=".9" opacity=".9" style={{ '--i': i } as React.CSSProperties} />
          ))}
          <path className="map-route" d="M126 200 C145 170 185 182 193 132 S202 105 221 80 S254 77 259 48 M260 48 C283 78 300 105 317 143 S357 181 333 235" fill="none" stroke="#eee" strokeWidth="1.8" strokeDasharray="4 3" />
          {pins.slice(0, members.length).map((pin, i) => (
            <g className="map-pin" key={pin.n}>
              <line x1={pin.x} x2={pin.x} y1={pin.y + 12} y2={pin.y + 66} stroke="#aaa" />
              <circle cx={pin.x} cy={pin.y} r="11" fill={members[i]?.you ? '#f2f2f0' : '#b8b9b6'} />
              <text x={pin.x} y={pin.y + 3} fill="#191919" textAnchor="middle" fontSize="8" fontWeight="700">
                {members[i] ? initial(members[i]!) : ''}
              </text>
            </g>
          ))}
          <text x="54" y="163" fill="#ddd" fontSize="12" fontWeight="700">W</text>
          <text x="414" y="163" fill="#ddd" fontSize="12" fontWeight="700">N</text>
          <text x="68" y="264" fill="#ddd" fontSize="12" fontWeight="700">S</text>
          <text x="411" y="264" fill="#ddd" fontSize="12" fontWeight="700">E</text>
        </svg>
      </div>
    </div>
  );
}

function ActivityPanel() {
  const p = useCofer().pot;
  const items = p?.activity.slice(0, 5) ?? [];
  return (
    <div className="panel activity-panel">
      <CardBeam radius={30} />
      <div className="panel-head">
        <span className="round-icon">
          <ListChecks size={16} />
        </span>
        <strong>Account activity</strong>
        <span className="divider" />
        <span className="muted">Recent</span>
        <div className="head-spacer" />
      </div>
      <div className="activity-list">
        {!items.length && <p className="workspace-empty">No activity yet.</p>}
        {p &&
          items.map((e, i) => {
            const d = describeActivity(e, p.assets, p.members);
            return (
              <div className="activity-row" key={e.id}>
                <span className="timeline-node">{i === 0 ? 'S' : i}</span>
                <div>
                  <strong>{d.title}</strong>
                  <small>{new Date(e.at).toLocaleString()}</small>
                  {i === 0 && <Avatars />}
                </div>
                <div className="activity-detail">
                  <span>Activity</span>
                  <strong>{d.detail}</strong>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

function RulesDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const p = useCofer().pot;
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="rules-modal" aria-labelledby="dialog-title" onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
      <button className="close-rules" aria-label="Close" onClick={() => ref.current?.close()}>
        <X size={18} />
      </button>
      <span className="modal-label">COFER / ACCOUNT RULES</span>
      <h2 id="dialog-title">Shared by design.</h2>
      {p ? (
        <p>
          {p.rules.approvalsRequired ?? '—'} of {p.rules.membersCount} members must approve a proposal
          {p.rules.thresholdBps ? ` (${formatBps(p.rules.thresholdBps)}%, rounded up)` : ''}. Non-unanimous proposals, swaps included, wait {hoursText(p.rules.exitWindowSec)}; unanimous proposals do not wait.
        </p>
      ) : (
        <p>Rules appear once a group account is loaded.</p>
      )}
      <p>Each member can exit in kind, without a vote. Issuer restrictions can affect individual asset transfers. Groups can hold up to 12 assets and include up to 50 members.</p>
      <button className="modal-done" onClick={() => ref.current?.close()}>
        Done
      </button>
    </dialog>
  );
}

function Strip({ onRules }: { onRules: () => void }) {
  const c = useCofer();
  return (
    <div className="group-strip">
      <span className="group-icon">
        <CircleDollarSign size={19} />
      </span>
      <label className="strip-account">
        <span className="sr-only">Group account</span>
        <select value={c.selected ?? ''} onChange={(e) => c.select(e.target.value)}>
          {c.pots.map((a) => (
            <option key={a.address} value={a.address}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      <span className="divider" />
      <span className="muted">Shared account</span>
      <span className="head-spacer" />
      <span className="strip-network">
        <MapPin size={15} /> {c.config?.chainName}
      </span>
      <span className="divider" />
      <span className="strip-balance">
        <Wallet size={15} /> {c.pot ? (c.pot.value.totalUsdg === null ? 'Price paused' : `${usdg(c.pot.value.totalUsdg, c.pot.usdg.decimals)} USDG`) : '…'}
      </span>
      <BeamButton radius={24} className="member-chip" onClick={onRules} aria-label="View account rules">
        <Users size={15} />
        <Avatars />
      </BeamButton>
    </div>
  );
}

function AccountView() {
  const [edit, setEdit] = useState(false), [key, setKey] = useState(0);
  // the widget order is a display preference for this browser only (no account data)
  const initialOrder = useMemo(() => {
    try {
      const s = JSON.parse(localStorage.getItem('cofer-widget-order-v2') || 'null') as WidgetItem[] | null;
      return s?.length === 3 && widgets.every((w) => s.some((x) => x.id === w.id && x.size === w.size)) ? s : widgets;
    } catch {
      return widgets;
    }
  }, [key]);
  const [order, setOrder] = useState(initialOrder);
  const render = (w: WidgetItem, _s: WidgetSize) => (w.id === 'metrics' ? <MetricsPanel /> : w.id === 'map' ? <MapPanel /> : <ActivityPanel />);
  const changed = order.some((w, i) => w.id !== widgets[i]!.id);
  const save = (items: WidgetItem[]) => {
    setOrder(items);
    try {
      localStorage.setItem('cofer-widget-order-v2', JSON.stringify(items));
    } catch {
      /* not saved: the order resets next time */
    }
  };
  return (
    <div className="account-layout">
      <div className="account-visuals">
        {edit && (
          <div className="custom-heading">
            <div>
              <strong>Arrange your widgets</strong>
              <p>Drag the cards or use Alt and the arrow keys.</p>
            </div>
            <button onClick={() => { try { localStorage.removeItem('cofer-widget-order-v2'); } catch { /* nothing saved */ } setOrder(widgets); setKey((v) => v + 1); }}>
              <RotateCcw size={14} /> Reset
            </button>
          </div>
        )}
        {edit || changed ? (
          <div className="custom-area">
            <DraggableWidgetGrid key={key} items={initialOrder} onChange={save} renderItem={render} editable={edit} maxColumns={3} cellSize={300} gap={8} radius={30} />
          </div>
        ) : (
          <div className="account-grid">
            <div className="metrics-slot"><MetricsPanel /></div>
            <div className="map-slot"><MapPanel /></div>
            <div className="activity-slot"><ActivityPanel /></div>
          </div>
        )}
        <div className="layout-controls">
          <span>Account activity</span>
          <BeamButton beam onClick={() => setEdit((v) => !v)}>
            <Grip size={14} />
            {edit ? 'Done' : 'Customize widgets'}
          </BeamButton>
        </div>
      </div>
      <Workspace />
    </div>
  );
}

function Overview() {
  const c = useCofer();
  const p = c.pot;
  return (
    <div className="account-layout overview-layout">
      <div className="subpage-heading overview-heading">
        <div>
          <span className="eyebrow">COFER / GROUP ACCOUNT</span>
          <h1>Overview</h1>
          <p>A view of the accounts and decisions your group shares.</p>
        </div>
        <div className="nav-pill">
          <a href="/dashboard.html" className="outline-action">
            Account view <ArrowUpRight size={15} />
          </a>
        </div>
      </div>
      <div className="account-visuals subpage overview-visual">
        <StatusBar />
        <div className="summary-grid">
          <div>
            <CardBeam radius={26} />
            <span>Account value</span>
            <strong>
              {p ? (p.value.totalUsdg === null ? 'Paused' : usdg(p.value.totalUsdg, p.usdg.decimals)) : '…'} <small>USDG</small>
            </strong>
            <p>{p?.title}</p>
          </div>
          <div>
            <CombinedCardBorder />
            <span>Members</span>
            <strong>{p?.rules.membersCount ?? '…'}</strong>
            <p>Group members</p>
          </div>
          <div>
            <CardBeam radius={26} />
            <span>Approvals required</span>
            <strong>{p?.rules.approvalsRequired ?? '…'}</strong>
            <p>{p?.rules.thresholdBps ? `${formatBps(p.rules.thresholdBps)}% of members, rounded up` : 'Fixed number of members'}</p>
          </div>
        </div>
        <div className="overview-columns">
          <section className="data-panel">
            <CombinedCardBorder />
            <div className="section-heading">
              <h2>Your group accounts</h2>
              <a href="/dashboard.html">
                View account <ArrowRight size={14} />
              </a>
            </div>
            {c.pots.map((a) => (
              <button className="account-row account-switch" key={a.address} onClick={() => c.select(a.address)} aria-pressed={a.address === c.selected}>
                <span className="account-badge">
                  <Wallet size={16} />
                </span>
                <div>
                  <strong>{a.title}</strong>
                  <small>{a.members} members</small>
                </div>
                <b>
                  {a.totalUsdg === null ? 'Price paused' : `${usdg(a.totalUsdg)} USDG`}
                  {a.partial ? ' · partial' : ''}
                </b>
              </button>
            ))}
          </section>
          <section className="data-panel">
            <CardBeam radius={26} />
            <div className="section-heading">
              <h2>Recent activity</h2>
              <span>{p?.title}</span>
            </div>
            {!p?.activity.length && <p className="workspace-empty">No activity yet.</p>}
            {p?.activity.slice(0, 4).map((e, i) => {
              const d = describeActivity(e, p.assets, p.members);
              return (
                <div className="simple-row" key={e.id}>
                  <span className="timeline-node">{i + 1}</span>
                  <div>
                    <strong>{d.title}</strong>
                    <small>{d.detail}</small>
                  </div>
                </div>
              );
            })}
          </section>
        </div>
      </div>
      <Workspace />
    </div>
  );
}

function MetricsPage() {
  const p = useCofer().pot;
  const pending = p?.proposals.filter((x) => x.state === 'pending').length ?? 0;
  return (
    <div className="subpage">
      <div className="subpage-heading">
        <div>
          <span className="eyebrow">{p?.title.toUpperCase()}</span>
          <h1>Metrics</h1>
          <p>Your group’s shared account, by member.</p>
        </div>
        <div className="nav-pill">
          <a className="outline-action" href="/dashboard.html">
            Account view <ArrowUpRight size={15} />
          </a>
        </div>
      </div>
      <StatusBar />
      <div className="metrics-page-grid">
        <MetricsPanel />
        <div className="data-panel wide-metrics">
          <CardBeam radius={26} />
          <div className="section-heading">
            <h2>Share of the account by member</h2>
            <span>{p?.members.length ?? 0} members</span>
          </div>
          <Chart kind="share" title="Share of the account" sub="Percent of all shares" />
          <div className="metric-details">
            <span>
              Group members <b>{p?.rules.membersCount ?? '…'}</b>
            </span>
            <span>
              Account value <b>{p ? (p.value.totalUsdg === null ? 'Paused' : `${usdg(p.value.totalUsdg, p.usdg.decimals)} USDG`) : '…'}</b>
            </span>
            <span>
              Open proposals <b>{pending}</b>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  const cfg = useCofer().config;
  const bot = cfg ? botUrl(cfg) : BOT_URL; // no config.json: the getcofer.com copy of this page
  return (
    <div className="subpage how-page">
      <div className="subpage-heading">
        <div>
          <span className="eyebrow">COFER / HOW IT WORKS</span>
          <h1>Your group. One account.</h1>
          <p>From a group chat to shared decisions, Cofer is designed to keep everyone in the loop.</p>
        </div>
        {bot && (
          <div className="nav-pill">
            <a className="outline-action" href={bot}>
              Open in Telegram <ArrowUpRight size={15} />
            </a>
          </div>
        )}
      </div>
      <div className="steps-grid">
        {[
          { n: '01', t: 'Create', d: 'Start a group account and invite the people you plan with.' },
          { n: '02', t: 'Contribute', d: 'Members contribute and receive shares based on account value.' },
          { n: '03', t: 'Decide', d: 'Review proposals and sign with your own key.' },
          { n: '04', t: 'Exit', d: 'Leave with a proportional share of each held asset.' },
        ].map((s) => (
          <div className="step-card" key={s.n}>
            <CombinedCardBorder />
            <span>{s.n}</span>
            <h2>{s.t}</h2>
            <p>{s.d}</p>
          </div>
        ))}
      </div>
      <section className="protocol-details">
        <div className="workspace-heading">
          <h2>Account rules and safeguards</h2>
        </div>
        <div className="protocol-grid">
          <article><CombinedCardBorder /><strong>Shares and deposits</strong><p>Shares are non-transferable and minted at current account value. When the account holds stocks, a 0.5% entry spread stays in the account.</p></article>
          <article><CombinedCardBorder /><strong>Approvals and timing</strong><p>Members approve proposals with their own keys. The default is 60% rounded up; non-unanimous proposals, swaps included, wait six hours. Unanimous proposals do not wait.</p></article>
          <article><CombinedCardBorder /><strong>Exiting in kind</strong><p>Members can leave without a vote and receive a proportional share of every asset. If an issuer blocks a transfer, that asset can be claimed later.</p></article>
          <article><CombinedCardBorder /><strong>Stock Token swaps</strong><p>Stock buys require eligible member regions, listed assets, an approved route and healthy price feeds. The group swap fee is 0.30% of the input.</p></article>
          <article><CombinedCardBorder /><strong>Account limits</strong><p>Each group can have up to 50 members and hold up to 12 assets. The signer interface has a 5,000 USDG beta limit.</p></article>
          <article><CombinedCardBorder /><strong>Changes and fees</strong><p>Feed, swap route and swap-fee changes use a 48-hour timelock. The optional group plan is 9 USDG per 30 days, prepaid by group vote.</p></article>
        </div>
      </section>
      <div className="ink-section">
        <InkOrbitFeatures
          theme="dark"
          brand="Cofer"
          tag="THE ACCOUNT FLOW"
          title={'Your group. *One account.*'}
          collaboration={{ title: 'A shared account', description: 'Members contribute and receive shares based on the account’s value.' }}
          reports={{ title: 'Decisions together', description: 'Members review and sign proposals with their own keys.' }}
          integrations={{ title: 'The account flow', description: 'A proposed flow from chat to review, signing and an on-chain account.', tools: ['Chat', 'Review', 'Passkey', 'Account'] }}
          insights={{ title: 'Account activity', description: 'Follow the group account across contributions and decisions.', values: [12, 20, 18, 27, 24, 31, 29, 34, 32, 36, 39, 42], forecastFrom: 10 }}
        />
      </div>
    </div>
  );
}

function App() {
  const c = useCofer();
  const [rules, setRules] = useState(false);
  const [page, setPage] = useState<Page>(() => pageFromPath(location.pathname));
  const live = !!c.config; // the dashboard address (it has a config.json)
  const bot = c.config ? botUrl(c.config) : BOT_URL;
  const site = c.config ? c.config.siteUrl : '/';
  useEffect(() => {
    const move = () => {
      const next = pageFromPath(location.pathname);
      setPage(next);
      document.title = `Cofer — ${next === 'accounts' ? 'Dashboard' : next === 'how' ? 'How it works' : next[0]!.toUpperCase() + next.slice(1)}`;
      window.scrollTo({ top: 0, behavior: 'instant' });
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.download) return;
      const u = new URL(a.href, location.href), path = u.pathname.replace(/\.html$/, '').replace(/\/$/, '');
      if (u.origin !== location.origin || !dashboardRoutes.has(path) || u.pathname === location.pathname) return;
      e.preventDefault();
      history.pushState(null, '', u.pathname + u.search + u.hash);
      move();
    };
    window.addEventListener('popstate', move);
    document.addEventListener('click', click);
    return () => {
      window.removeEventListener('popstate', move);
      document.removeEventListener('click', click);
    };
  }, []);
  const body = page === 'how' ? <HowItWorks /> : (
    <Gate>
      {page === 'accounts' ? (
        <>
          <Strip onRules={() => setRules(true)} />
          <AccountView />
        </>
      ) : page === 'overview' ? (
        <Overview />
      ) : (
        <MetricsPage />
      )}
    </Gate>
  );
  return (
    <main className="dashboard-page" data-dashboard-ready>
      <div className="dashboard-shell">
        <header className="dash-header">
          <a href={live ? '/dashboard.html' : '/'} className="dash-brand">
            <img src="/assets/cofer-mark.png" alt="" />
            <span>
              COFER <span className="brand-project">PROJECT</span>
            </span>
          </a>
          {live ? (
            <>
              <nav className="dash-nav" aria-label="Dashboard navigation">
                {nav.map(({ label, href, key, icon: Icon }) => (
                  <div className="nav-pill" key={key}>
                    <a href={href} className={page === key ? 'active' : ''} aria-current={page === key ? 'page' : undefined}>
                      <Icon size={15} />
                      <span>{label}</span>
                    </a>
                    <SmallBeam radius={22} />
                  </div>
                ))}
              </nav>
              <div className="header-right">
                <a className="header-telegram" href={bot}>
                  Open in Telegram <ArrowUpRight size={14} />
                </a>
                <a className="header-help" href="/how-it-works.html" aria-label="How it works" title="How it works">
                  <CircleHelp size={18} />
                </a>
                <span className="header-divider" />
                <button className="header-rules" onClick={() => setRules(true)} aria-label="Account rules" title="Account rules">
                  <ShieldCheck size={18} />
                </button>
                <a className="back-home" href={site} title="Back to site">
                  <ArrowLeft size={14} />
                  <span>Site</span>
                </a>
              </div>
            </>
          ) : (
            <div className="header-right">
              {bot && (
                <a className="header-telegram" href={bot}>
                  Open in Telegram <ArrowUpRight size={14} />
                </a>
              )}
              <a className="back-home" href="/" title="Back to site">
                <ArrowLeft size={14} />
                <span>Site</span>
              </a>
            </div>
          )}
        </header>
        <div className={`dash-body${page === 'accounts' || page === 'overview' ? ' is-accounts' : ''}`} key={page}>
          {body}
        </div>
      </div>
      {rules && <RulesDialog onClose={() => setRules(false)} />}
    </main>
  );
}

createRoot(document.getElementById('dashboard-root')!).render(
  <CoferProvider>
    <App />
  </CoferProvider>,
);
