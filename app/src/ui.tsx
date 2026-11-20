/** Small shared pieces, in the site's look: dark panels, thin lines, muted labels. */
export function Panel({ title, right, children, className = '' }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-xs font-medium tracking-[.08em] text-[var(--muted)] uppercase">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ children, onClick, disabled, kind = 'primary', className = '', type = 'button' }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' | 'buy' | 'sell'; className?: string; type?: 'button' | 'submit' }) {
  const look = {
    primary: 'bg-[var(--pill)] text-[#0b0b0b]',
    ghost: 'border border-[var(--line)] text-[var(--text)]',
    buy: 'bg-[var(--up)] text-[#04140b]',
    sell: 'bg-[var(--down)] text-[#1a0505]',
  }[kind];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`min-h-11 rounded-full px-5 text-sm font-medium disabled:opacity-40 ${look} ${className}`}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-full border border-[var(--line)] p-1">
      {options.map((o) => (
        <button key={o.v} role="radio" aria-checked={o.v === value} onClick={() => onChange(o.v)} className={`min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-xs ${o.v === value ? 'bg-[var(--text)] text-[var(--bg)]' : 'text-[var(--muted)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' | 'bad' }) {
  const c = { muted: 'text-[var(--muted)]', warn: 'text-[var(--warn)]', bad: 'text-[var(--down)]' }[tone];
  return <p className={`text-xs leading-relaxed ${c}`}>{children}</p>;
}

export function SignInFirst() {
  return (
    <Panel>
      <p className="text-sm">Open the App from the bot to sign in.</p>
      <Note>In your group or in a private chat with the bot, send /table (or tap an App button on a card). The link signs you in on this device for 12 hours.</Note>
    </Panel>
  );
}
