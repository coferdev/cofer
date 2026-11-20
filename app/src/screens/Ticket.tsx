import { useState } from 'react';
import type { PracticeGame, SeatState } from '../arena/api';
import { REASONS, price } from '../arena/format';
import { type OrderInput, units } from '../arena/order';
import { Button, Note, Panel, Segmented } from '../ui';

type Kind = 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT';
type SizeMode = 'pct' | 'notional' | 'qty';

/**
 * Trade (spec §6.5): product, side, size (% of free margin, chips or quantity), leverage capped by the rules, and
 * market, limit, stop or take-profit. Options arrive with the option chain.
 */
export function Ticket({ game, me, marks, send, disabled }: { game: PracticeGame; me: SeatState | null; marks: Record<string, string | null>; send: (o: OrderInput) => Promise<string | null>; disabled: string | null }) {
  const markets = game.rules.markets;
  const [symbol, setSymbol] = useState(markets[0] ?? 'BTC');
  const [product, setProduct] = useState<'PERP' | 'SPOT'>('PERP');
  const [kind, setKind] = useState<Kind>('MARKET');
  const [mode, setMode] = useState<SizeMode>('pct');
  const [size, setSize] = useState('20');
  const [lev, setLev] = useState(2);
  const [px, setPx] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'muted' | 'bad'; text: string } | null>(null);
  const cap = game.leverageCap[symbol] ?? 1;
  const leverage = Math.min(lev, cap);
  const trigger = kind === 'STOP' || kind === 'TAKE_PROFIT';
  const pos = me?.positions.find((p) => p.symbol === symbol && p.product === product);

  function build(side: 'BUY' | 'SELL'): OrderInput | string {
    const o: OrderInput = { kind, symbol, product, side };
    if (product === 'PERP') o.leverage = BigInt(leverage);
    if (!trigger) {
      if (mode === 'pct') {
        const n = Number(size);
        if (!Number.isInteger(n) || n < 1 || n > 100) return 'Pick 1 to 100 % of free margin.';
        o.pctFreeBps = BigInt(n * 100);
      } else {
        const v = units(size, mode === 'notional' ? 6 : 8);
        if (!v) return mode === 'notional' ? 'Type an amount in chips.' : 'Type a quantity.';
        if (mode === 'notional') o.notional = v;
        else o.qty = v;
      }
    }
    if (kind !== 'MARKET') {
      const p = units(px, 8);
      if (!p) return 'Type a price.';
      if (kind === 'LIMIT') o.limitPx = p;
      else o.triggerPx = p;
    }
    return o;
  }

  async function go(side: 'BUY' | 'SELL') {
    const o = build(side);
    if (typeof o === 'string') return setMsg({ tone: 'bad', text: o });
    setBusy(true);
    setMsg(null);
    const err = await send(o);
    setBusy(false);
    setMsg(err ? { tone: 'bad', text: REASONS[err] ?? err } : { tone: 'muted', text: kind === 'MARKET' ? 'Sent. It fills at the next price tick after it arrives.' : 'Sent. It waits for its price.' });
  }

  return (
    <Panel title="Trade">
      <div className="space-y-3">
        <div className="flex gap-2 overflow-x-auto">
          {markets.map((m) => (
            <button key={m} onClick={() => setSymbol(m)} aria-pressed={m === symbol} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs ${m === symbol ? 'border-[var(--text)]' : 'border-[var(--line)] text-[var(--muted)]'}`}>
              {m} <span className="tabular">{price(marks[m] ?? null)}</span>
            </button>
          ))}
        </div>
        <Segmented label="Product" value={product} onChange={setProduct} options={[{ v: 'PERP', label: 'Perp' }, { v: 'SPOT', label: 'Spot' }]} />
        <Segmented label="Order type" value={kind} onChange={setKind} options={[{ v: 'MARKET', label: 'Market' }, { v: 'LIMIT', label: 'Limit' }, { v: 'STOP', label: 'Stop' }, { v: 'TAKE_PROFIT', label: 'Take profit' }]} />
        {trigger ? (
          <Note>{pos ? `Closes your whole ${symbol} position when the price reaches it.` : `You have no ${symbol} ${product === 'PERP' ? 'perp' : 'spot'} position for this to close.`}</Note>
        ) : (
          <div className="space-y-2">
            <Segmented label="Size in" value={mode} onChange={(m) => (setMode(m), setSize(m === 'pct' ? '20' : ''))} options={[{ v: 'pct', label: '% free' }, { v: 'notional', label: 'Chips' }, { v: 'qty', label: 'Quantity' }]} />
            {mode === 'pct' ? (
              <label className="flex items-center gap-3 text-xs text-[var(--muted)]">
                <input type="range" min={1} max={100} value={Number(size) || 1} onChange={(e) => setSize(e.target.value)} className="flex-1" aria-label="Percent of free margin" />
                <span className="tabular w-10 text-right text-[var(--text)]">{size}%</span>
              </label>
            ) : (
              <input inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value)} placeholder={mode === 'notional' ? 'Chips, e.g. 2000' : `${symbol} quantity, e.g. 0.01`} className="min-h-11 w-full rounded-xl border border-[var(--line)] bg-transparent px-3 text-sm" aria-label="Size" />
            )}
          </div>
        )}
        {kind !== 'MARKET' && (
          <input inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} placeholder={kind === 'LIMIT' ? 'Limit price' : 'Trigger price'} className="min-h-11 w-full rounded-xl border border-[var(--line)] bg-transparent px-3 text-sm" aria-label="Price" />
        )}
        {product === 'PERP' && (
          <label className="flex items-center gap-3 text-xs text-[var(--muted)]">
            Leverage
            <input type="range" min={1} max={cap} value={leverage} onChange={(e) => setLev(Number(e.target.value))} className="flex-1" aria-label="Leverage" />
            <span className="tabular w-10 text-right text-[var(--text)]">{leverage}x</span>
          </label>
        )}
        {trigger ? (
          <Button className="w-full" disabled={busy || !!disabled || !pos} onClick={() => go(pos && BigInt(pos.qty) > 0n ? 'SELL' : 'BUY')}>
            {kind === 'STOP' ? 'Place stop' : 'Place take profit'}
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button kind="buy" disabled={busy || !!disabled} onClick={() => go('BUY')}>Buy</Button>
            <Button kind="sell" disabled={busy || !!disabled || (product === 'SPOT' && !pos)} onClick={() => go('SELL')}>Sell</Button>
          </div>
        )}
        {disabled && <Note tone="bad">{disabled}</Note>}
        {msg && <Note tone={msg.tone}>{msg.text}</Note>}
        <Note>Fills at the next price tick after it arrives, never at the price on screen. A position is held at least {game.rules.minHoldSec} seconds before it can be reduced or closed. Leverage cap here: {cap}x. Fee {game.rules.feeBps / 100}%.</Note>
      </div>
    </Panel>
  );
}
