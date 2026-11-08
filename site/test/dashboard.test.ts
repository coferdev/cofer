// Dashboard logic without a browser: run with `npm test` (bun test) in site/.
import { describe, expect, test } from 'bun:test';
import { formatAmount, formatBps, maxAmount, ratio } from '../src/lib/money';
import { parseConfig } from '../src/lib/dash-config';
import { ApiError, apiClient } from '../src/lib/dash-api';
import { clearSession, isLive, linkFromHash, loadSession, saveSession } from '../src/lib/dash-session';
import { describeActivity, durationWords, memberLabel, retryDelay, POLL_MS, waitText } from '../src/lib/dash-text';
import { readFileSync } from 'node:fs';

describe('decimals: amounts are formatted from integers, never via JavaScript numbers', () => {
  test('USDG (6 dp) and an 18 dp token, cut not rounded up', () => {
    expect(formatAmount('1234567890', 6)).toBe('1,234.56');
    expect(formatAmount('1999999', 6)).toBe('1.99');
    expect(formatAmount('1000000', 6)).toBe('1');
    expect(formatAmount('1', 6, 6)).toBe('0.000001');
    expect(formatAmount('1234567890123456789', 18, 6)).toBe('1.234567');
    expect(formatAmount('0', 18)).toBe('0');
  });

  test('amounts past 2^53 keep every digit', () => {
    expect(formatAmount('9007199254740993', 0)).toBe('9,007,199,254,740,993');
    expect(formatAmount('123456789012345678901234567890', 18, 18)).toBe('123,456,789,012.34567890123456789');
    expect(formatAmount(10n ** 30n + 1n, 6, 6)).toBe('1,000,000,000,000,000,000,000,000.000001');
  });

  test('anything that is not a whole number of units shows a dash, not a wrong figure', () => {
    for (const bad of ['1.5', '1e6', 'NaN', '', ' 1', null, undefined]) expect(formatAmount(bad as never, 6)).toBe('—');
    expect(formatAmount('1', 99)).toBe('—');
  });

  test('percentages from basis points; bar heights from exact ratios', () => {
    expect([formatBps(3333), formatBps(5000), formatBps(10000), formatBps(5), formatBps(1.5)]).toEqual(['33.33', '50', '100', '0.05', '—']);
    expect(ratio('1', '3')).toBe(0.3333);
    expect(ratio('5', '0')).toBe(0);
    expect(ratio(10n ** 40n, 10n ** 40n * 2n)).toBe(0.5);
    expect(maxAmount(['5', '700000000000000000000', 'x' as never])).toBe(700000000000000000000n);
  });
});

describe('config.json: one build, the network comes from the server', () => {
  const ok = { chainId: 46630, chainName: 'Robinhood Chain Testnet', explorerUrl: 'https://explorer.testnet.chain.robinhood.com/', botUsername: 'cofer_test_bot', siteUrl: 'https://getcofer.com', apiBase: '/api/dashboard/' };

  test('a good config is accepted and tidied', () => {
    expect(parseConfig(ok)).toEqual({ ...ok, explorerUrl: 'https://explorer.testnet.chain.robinhood.com', apiBase: '/api/dashboard' });
  });

  test('the API must be on this same address (no other origin, so no CORS)', () => {
    for (const apiBase of ['https://api.example.com', '//evil.example/api', 'api/dashboard', '/api?x=1']) expect(() => parseConfig({ ...ok, apiBase })).toThrow(/apiBase/);
  });

  test('every missing or wrong field is named', () => {
    expect(() => parseConfig({})).toThrow(/chainId.*chainName.*explorerUrl.*botUsername.*siteUrl.*apiBase/);
    expect(() => parseConfig({ ...ok, explorerUrl: 'http://explorer' })).toThrow(/explorerUrl/);
    expect(() => parseConfig({ ...ok, botUsername: '@cofer' })).toThrow(/botUsername/);
  });

  test('the shipped examples: mainnet is complete; testnet refuses to start until its bot is filled in', () => {
    const main = parseConfig(JSON.parse(readFileSync(new URL('../dashboard/config.mainnet.json', import.meta.url), 'utf8')));
    expect(main.chainId).toBe(4663);
    expect(() => parseConfig(JSON.parse(readFileSync(new URL('../dashboard/config.testnet.json', import.meta.url), 'utf8')))).toThrow(/botUsername/);
  });
});

describe('the API client: errors become states the page knows, backend down and recovery', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('calls stay on the configured path, send the session, never send cookies, never cache', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const api = apiClient('/api/dashboard', async (url, init) => (seen.push({ url, init }), res(200, { chainId: 1, linked: true, pots: [] })));
    await api.pots('S');
    expect(seen[0]!.url).toBe('/api/dashboard/pots');
    expect((seen[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer S');
    expect([seen[0]!.init!.credentials, seen[0]!.init!.cache]).toEqual(['omit', 'no-store']);
  });

  test('401 -> signed out (with the server text), 404 -> not found, 5xx -> down, no network -> offline, junk -> bad response', async () => {
    const kind = async (f: () => Promise<Response>) => {
      try {
        await apiClient('/a', f).pots('S');
        return 'ok';
      } catch (e) {
        return e instanceof ApiError ? `${e.kind}:${e.message}` : String(e);
      }
    };
    expect(await kind(async () => res(401, { error: 'ended' }))).toBe('signed-out:ended');
    expect(await kind(async () => res(404, { error: 'x' }))).toStartWith('not-found:');
    expect(await kind(async () => res(503, { error: 'x' }))).toStartWith('down:');
    expect(await kind(async () => res(502, 'Bad gateway'))).toStartWith('down:');
    expect(await kind(async () => Promise.reject(new TypeError('Failed to fetch')))).toStartWith('offline:');
    expect(await kind(async () => new Response('<html>', { status: 200 }))).toStartWith('bad-response:');
  });

  test('the backend goes down, then comes back: the next read works with no new sign-in', async () => {
    let up = false;
    const api = apiClient('/a', async () => (up ? res(200, { chainId: 1, linked: true, pots: [] }) : Promise.reject(new TypeError('down'))));
    await expect(api.pots('S')).rejects.toBeInstanceOf(ApiError);
    up = true;
    expect((await api.pots('S')).linked).toBe(true);
  });

  test('a pot address that is not an address is never requested', async () => {
    let called = false;
    const api = apiClient('/a', async () => ((called = true), res(200, {})));
    await expect(api.pot('S', '../../session')).rejects.toBeInstanceOf(ApiError);
    expect(called).toBe(false);
  });

  test('retry waits grow, then stay at a minute; a healthy page reads every 20 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([POLL_MS, 5000, 10000, 20000, 40000, 60000, 60000]);
  });
});

describe('sign-in link and session', () => {
  test('the one-time link is read from the fragment only, and must look like a link', () => {
    expect(linkFromHash('#t=abc_-.DEF-_')).toBe('abc_-.DEF-_');
    expect(linkFromHash('')).toBeNull();
    expect(linkFromHash('#t=<script>')).toBeNull();
    expect(linkFromHash(`#t=a.${'b'.repeat(3000)}`)).toBeNull();
  });

  test('a session is used only while it has time left; it lives in this tab only', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    expect(isLive({ session: 's', expiresAt: '2026-11-06T12:10:00Z' }, now)).toBe(true);
    expect(isLive({ session: 's', expiresAt: '2026-11-06T12:00:03Z' }, now)).toBe(false);
    expect(isLive(null, now)).toBe(false);
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    saveSession({ session: 's', expiresAt: 'x' }, store);
    expect(loadSession(store)).toEqual({ session: 's', expiresAt: 'x' });
    clearSession(store);
    expect(loadSession(store)).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(loadSession(broken)).toBeNull();
    expect(() => saveSession({ session: 's', expiresAt: 'x' }, broken)).not.toThrow();
  });
});

describe('activity wording', () => {
  const members = [
    { address: '0x000000000000000000000000000000000000a11c', you: true, username: 'alice', shares: '1', shareBps: 5000, allowance: '0', period: 0 },
    { address: '0x00000000000000000000000000000000000b0b00', you: false, username: 'bob', shares: '1', shareBps: 5000, allowance: '0', period: 0 },
  ];
  const assets = { '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168': { symbol: 'USDG', decimals: 6 }, '0x322F0929c4625eD5bAd873c95208D54E1c003b2d': { symbol: 'TSLA', decimals: 18 } };
  const base = { id: '1', at: '2026-11-06T00:00:00Z', block: '1', txHash: '0x1' };

  test('names members as You, @username, or a short address', () => {
    expect(memberLabel(members[0]!.address.toUpperCase().replace('0X', '0x'), members)).toBe('You');
    expect(memberLabel(members[1]!.address, members)).toBe('@bob');
    expect(memberLabel('0x1111111111111111111111111111111111111111', members)).toBe('0x1111…1111');
  });

  test('a deposit and a swap read correctly with exact amounts', () => {
    expect(describeActivity({ ...base, type: 'deposit', member: members[1]!.address, asset: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', amount: '25500000' }, assets, members)).toEqual({ title: 'Contribution added', detail: '@bob · 25.5 USDG' });
    expect(
      describeActivity({ ...base, type: 'swap', assetIn: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', amountIn: '100000000', assetOut: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', amountOut: '412345678901234567' }, assets, members).detail,
    ).toBe('100 USDG → 0.412345 TSLA');
  });
});

// ---------------------------------------------------------------- phase 2a: action buttons
import { isSafeLink, openSignerTab } from '../src/lib/dash-open';

describe('action buttons hand off to the signer page; the dashboard never signs', () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const POT = '0x2D3365a056074f6cd35C943EDcE644FAE7Eb8A45';
  const PROP = `0x${'ab'.repeat(32)}`;

  test('the link request names only the pot, the action and (to approve) the proposal', async () => {
    const bodies: unknown[] = [];
    const api = apiClient('/api/dashboard', async (url, init) => {
      expect(url).toBe('/api/dashboard/links');
      expect(init!.method).toBe('POST');
      bodies.push(JSON.parse(String(init!.body)));
      return res(200, { url: 'https://sign.test/s/a.b', expiresAt: 'x' });
    });
    await api.link('S', POT, 'deposit');
    await api.link('S', POT, 'approve', PROP);
    expect(bodies).toEqual([{ pot: POT, action: 'deposit' }, { pot: POT, action: 'approve', proposal: PROP }]);
  });

  test("a refusal (409) carries the server's plain reason", async () => {
    const api = apiClient('/a', async () => res(409, { error: 'Deposits are closed by the group. A group vote can open them again.' }));
    const e = await api.link('S', POT, 'deposit').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.kind, e.message]).toEqual(['refused', 'Deposits are closed by the group. A group vote can open them again.']);
  });

  function fakeWindow(block = false) {
    const tabs: { opener: unknown; location: { href: string }; closed: boolean; close(): void }[] = [];
    return {
      tabs,
      open() {
        if (block) return null;
        const t = { opener: 'dashboard' as unknown, location: { href: 'about:blank' }, closed: false, close() { t.closed = true; } };
        tabs.push(t);
        return t;
      },
    };
  }

  test('the tab opens on the click, before the server answers, cut off from the dashboard, then goes to the link', async () => {
    const w = fakeWindow();
    let release!: (u: string) => void;
    const pending = openSignerTab(() => new Promise<string>((r) => (release = r)), w);
    expect(w.tabs.length).toBe(1); // opened at once, so the browser allows it
    expect(w.tabs[0]!.opener).toBeNull();
    release('https://sign.test/s/abc.def');
    expect(await pending).toEqual({ ok: true });
    expect(w.tabs[0]!.location.href).toBe('https://sign.test/s/abc.def');
  });

  test('a refusal or a failure closes the tab and shows the reason', async () => {
    const w = fakeWindow();
    const r = await openSignerTab(async () => Promise.reject(new ApiError('refused', 'You already approved this proposal.')), w);
    expect(r).toEqual({ ok: false, message: 'You already approved this proposal.' });
    expect(w.tabs[0]!.closed).toBe(true);
  });

  test('only a signer-page address is ever opened (never javascript: or another kind of page)', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://sign.test/other', 'http://sign.test/s/a.b', 'https://sign.test/s/a b']) {
      expect(isSafeLink(bad)).toBe(false);
      const w = fakeWindow();
      expect((await openSignerTab(async () => bad, w)).ok).toBe(false);
      expect(w.tabs[0]!.closed).toBe(true);
      expect(w.tabs[0]!.location.href).toBe('about:blank');
    }
    expect(isSafeLink('https://sign.getcofer.com/s/eyJ0Zy.abc_-')).toBe(true);
    expect(isSafeLink('http://localhost:8443/s/a.b')).toBe(true);
  });

  test('a blocked new tab: the one-time link is offered to tap instead', async () => {
    const r = await openSignerTab(async () => 'https://sign.test/s/a.b', fakeWindow(true));
    expect(r).toEqual({ ok: false, message: 'Your browser blocked the new tab. Use this link instead (it works once):', url: 'https://sign.test/s/a.b' });
  });

  test('two opens at the same moment: two tabs, each with its own link', async () => {
    const w = fakeWindow();
    let n = 0;
    const results = await Promise.all([1, 2].map(() => openSignerTab(async () => `https://sign.test/s/link${++n}.x`, w)));
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(new Set(w.tabs.map((t) => t.location.href)).size).toBe(2);
  });
});

describe('proposal row: when an approved vote will be done', () => {
  const at = new Date(Date.UTC(2026, 10, 8, 11, 6)).toISOString();
  test('same wording as the vote card, with the group exit window', () => {
    expect(waitText(21600, at)).toBe('It will be done in 6 hours, at 11:06 UTC on 8 Nov 2026');
    expect(waitText(1800, at)).toBe('It will be done in 30 minutes, at 11:06 UTC on 8 Nov 2026');
    expect(waitText(172800, at)).toBe('It will be done in 2 days, at 11:06 UTC on 8 Nov 2026');
    expect(durationWords(86400 + 7200)).toBe('1 day 2 hours');
    expect(waitText(21600, new Date(Date.UTC(2026, 10, 8, 11, 6, 1)).toISOString())).toBe('It will be done in 6 hours, at 11:07 UTC on 8 Nov 2026');
  });
  test('the row uses the group setting, not a fixed number, and the old text is gone', () => {
    const src = readFileSync(new URL('../src/cofer-store.tsx', import.meta.url), 'utf8');
    expect(src).toContain("{x.executeAfter ? ` · ${waitText(p.rules.exitWindowSec, x.executeAfter)}` : ''}");
    expect(src).not.toContain('exit window until');
  });
});
